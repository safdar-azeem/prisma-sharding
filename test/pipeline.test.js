const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { DESTRUCTIVE_FLAGS, runDatabaseUpdate } = require(
  path.resolve(__dirname, '../dist/cli/utils/pipeline.js')
);
const { runUpdateCli } = require(path.resolve(__dirname, '../dist/cli/utils/update-cli.js'));
const {
  getDatabaseTargets,
  maskShardUrl,
  normalizeDatabaseUrl,
} = require(path.resolve(__dirname, '../dist/cli/utils/shards.js'));
const { sanitizeCommandOutput } = require(
  path.resolve(__dirname, '../dist/cli/utils/command.js')
);
const compat = require(path.resolve(__dirname, '../dist/cli/utils/prisma.js'));

const INIT_MIGRATION = '20260101000000_init';
const TICKET_MIGRATION = '20260724000200_pmp_task_ticket_number';

const target = (id, url, isPrimary = false) => ({
  id,
  url,
  sources: [isPrimary ? 'DATABASE_URL' : `${id.toUpperCase()}_URL`],
  isPrimary,
});

const createProject = (migrationNames = [], withSchema = false) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-sharding-pipeline-'));
  for (const name of migrationNames) {
    const migrationDirectory = path.join(directory, 'prisma', 'migrations', name);
    fs.mkdirSync(migrationDirectory, { recursive: true });
    fs.writeFileSync(path.join(migrationDirectory, 'migration.sql'), '-- test migration\n');
  }
  if (withSchema) {
    fs.mkdirSync(path.join(directory, 'prisma'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'prisma', 'schema.prisma'), '// schema\n');
  }
  return directory;
};

/** Introspection fixtures. */
const states = {
  emptyDatabase: () => ({
    reachable: true,
    empty: true,
    hasMigrationsTable: false,
    databaseMissing: false,
    userTableCount: 0,
    applied: [],
  }),
  applied: (names) => ({
    reachable: true,
    empty: false,
    hasMigrationsTable: true,
    databaseMissing: false,
    userTableCount: 40,
    applied: names.map((name) => ({
      name,
      finishedAt: new Date('2026-07-01T00:00:00Z'),
      rolledBackAt: null,
    })),
  }),
  pushBuilt: () => ({
    reachable: true,
    empty: false,
    hasMigrationsTable: false,
    databaseMissing: false,
    userTableCount: 40,
    applied: [],
  }),
  missing: () => ({
    reachable: false,
    empty: false,
    hasMigrationsTable: false,
    databaseMissing: true,
    userTableCount: 0,
    applied: [],
    error: 'database "erp_main" does not exist',
  }),
  unreachable: () => ({
    reachable: false,
    empty: false,
    hasMigrationsTable: false,
    databaseMissing: false,
    userTableCount: 0,
    applied: [],
    error: 'connection refused',
  }),
};

const fakeIntrospect = (byUrl) => {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const state = byUrl[url];
    if (!state) {
      throw new Error(`Unexpected introspection of ${url}`);
    }
    return typeof state === 'function' ? state() : state;
  };
  fn.calls = calls;
  return fn;
};

const recordingRunPrisma = ({ failWhen } = {}) => {
  const commands = [];
  const fn = async (args, options = {}) => {
    const url = options.env?.DATABASE_URL || '';
    const command = args.join(' ');
    commands.push({ command, url });

    if (failWhen && failWhen(command, url)) {
      return {
        success: false,
        stdout: '',
        stderr: '',
        exitCode: 1,
        error: `P3018: migration failed against ${maskShardUrl(url)}`,
      };
    }

    // `migrate diff --exit-code` reports "no difference" with exit code 0.
    return { success: true, stdout: '', stderr: '', exitCode: 0 };
  };
  fn.commands = commands;
  return fn;
};

const assertNoDestructiveFlags = (runPrisma) => {
  for (const { command } of runPrisma.commands) {
    for (const flag of DESTRUCTIVE_FLAGS) {
      assert.doesNotMatch(command, new RegExp(flag), `unexpected ${flag} in: ${command}`);
    }
  }
};

test('a pending migration is deployed to every shard in order', async () => {
  const project = createProject([INIT_MIGRATION, TICKET_MIGRATION]);
  const urls = {
    'postgresql://u:p@localhost/s1': states.applied([INIT_MIGRATION]),
    'postgresql://u:p@localhost/s2': states.applied([INIT_MIGRATION]),
    'postgresql://u:p@localhost/s3': states.applied([INIT_MIGRATION]),
  };
  const runPrisma = recordingRunPrisma();

  try {
    const summary = await runDatabaseUpdate({
      targets: [
        target('shard_1', 'postgresql://u:p@localhost/s1'),
        target('shard_2', 'postgresql://u:p@localhost/s2'),
        target('shard_3', 'postgresql://u:p@localhost/s3'),
      ],
      cwd: project,
      env: {},
      introspect: fakeIntrospect(urls),
      runPrisma,
    });

    assert.equal(summary.success, true);
    assert.equal(summary.strategy, 'migrate');
    const deploys = runPrisma.commands.filter(({ command }) => command === 'migrate deploy');
    assert.equal(deploys.length, 3);
    assert.deepEqual(
      deploys.map(({ url }) => url),
      [
        'postgresql://u:p@localhost/s1',
        'postgresql://u:p@localhost/s2',
        'postgresql://u:p@localhost/s3',
      ]
    );
    assert.ok(runPrisma.commands.every(({ command }) => !command.startsWith('db push')));
    assertNoDestructiveFlags(runPrisma);
    assert.deepEqual(
      summary.results.map((result) => [result.id, result.success, result.attempted]),
      [
        ['shard_1', true, true],
        ['shard_2', true, true],
        ['shard_3', true, true],
      ]
    );
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('the ticket-number migration path: populated tables use migrate deploy, never db push', async () => {
  // Shards already migrated up to the previous migration, with 43 PmpTask rows.
  // The required-column migration must go through `migrate deploy` so its own
  // nullable → backfill → NOT NULL sequence runs, with no destructive flags.
  const history = ['20260202130606_init', '20260724000100_pmp_project_feature_settings'];
  const project = createProject([...history, TICKET_MIGRATION]);
  const urls = {
    'postgresql://u:p@localhost/s1': states.applied(history),
    'postgresql://u:p@localhost/s2': states.applied(history),
    'postgresql://u:p@localhost/s3': states.applied(history),
  };
  const runPrisma = recordingRunPrisma();

  try {
    const summary = await runDatabaseUpdate({
      targets: [
        target('shard_1', 'postgresql://u:p@localhost/s1'),
        target('shard_2', 'postgresql://u:p@localhost/s2'),
        target('shard_3', 'postgresql://u:p@localhost/s3'),
      ],
      cwd: project,
      env: {},
      introspect: fakeIntrospect(urls),
      runPrisma,
    });

    assert.equal(summary.success, true);
    assert.equal(summary.strategy, 'migrate');
    assert.equal(
      runPrisma.commands.filter(({ command }) => command === 'migrate deploy').length,
      3
    );
    assert.ok(runPrisma.commands.every(({ command }) => !command.includes('db push')));
    assertNoDestructiveFlags(runPrisma);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('no pending migrations reports every database as up to date without deploying', async () => {
  const project = createProject([TICKET_MIGRATION]);
  const urls = {
    'postgresql://u:p@localhost/s1': states.applied([TICKET_MIGRATION]),
    'postgresql://u:p@localhost/s2': states.applied([TICKET_MIGRATION]),
  };
  const runPrisma = recordingRunPrisma();

  try {
    const summary = await runDatabaseUpdate({
      targets: [
        target('shard_1', 'postgresql://u:p@localhost/s1'),
        target('shard_2', 'postgresql://u:p@localhost/s2'),
      ],
      cwd: project,
      env: {},
      introspect: fakeIntrospect(urls),
      runPrisma,
    });

    assert.equal(summary.success, true);
    assert.equal(runPrisma.commands.length, 0);
    assert.deepEqual(
      summary.results.map((result) => result.message),
      ['Already up to date', 'Already up to date']
    );
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('normal update output stays quiet: Synced only, skipped primary hidden', async () => {
  const project = createProject([TICKET_MIGRATION]);
  const urls = {
    'postgresql://u:p@localhost/missing': states.missing(),
    'postgresql://u:p@localhost/s1': states.applied([TICKET_MIGRATION]),
    'postgresql://u:p@localhost/s2': states.applied([TICKET_MIGRATION]),
  };
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => {
    lines.push(args.map(String).join(' '));
  };

  try {
    const summary = await runDatabaseUpdate({
      targets: [
        target('primary', 'postgresql://u:p@localhost/missing', true),
        target('shard_1', 'postgresql://u:p@localhost/s1'),
        target('shard_2', 'postgresql://u:p@localhost/s2'),
      ],
      cwd: project,
      env: {},
      introspect: fakeIntrospect(urls),
      runPrisma: recordingRunPrisma(),
    });

    assert.equal(summary.success, true);
    const stdout = lines.join('\n');
    assert.match(stdout, /✅ shard_1 {2}Synced/);
    assert.match(stdout, /✅ shard_2 {2}Synced/);
    assert.doesNotMatch(stdout, /primary|Skipped|Already up to date|Complete/);
    assert.equal(
      summary.results.filter((result) => result.message.startsWith('Skipped')).length,
      1
    );
  } finally {
    console.log = originalLog;
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('verbose update output keeps skip reasons, detailed statuses, and the Complete line', async () => {
  const project = createProject([TICKET_MIGRATION]);
  const urls = {
    'postgresql://u:p@localhost/missing': states.missing(),
    'postgresql://u:p@localhost/s1': states.applied([TICKET_MIGRATION]),
    'postgresql://u:p@localhost/s2': states.applied([TICKET_MIGRATION]),
  };
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => {
    lines.push(args.map(String).join(' '));
  };

  try {
    const summary = await runDatabaseUpdate({
      targets: [
        target('primary', 'postgresql://u:p@localhost/missing', true),
        target('shard_1', 'postgresql://u:p@localhost/s1'),
        target('shard_2', 'postgresql://u:p@localhost/s2'),
      ],
      verbose: true,
      cwd: project,
      env: {},
      introspect: fakeIntrospect(urls),
      runPrisma: recordingRunPrisma(),
    });

    assert.equal(summary.success, true);
    const stdout = lines.join('\n');
    assert.match(stdout, /⏭️ primary {2}Skipped \(DATABASE_URL not created\)/);
    assert.match(stdout, /✅ shard_1 {2}Already up to date/);
    assert.match(stdout, /✅ shard_2 {2}Already up to date/);
    assert.match(stdout, /✅ Complete {2}All 2 databases are up to date/);
    assert.doesNotMatch(stdout, /All 3 databases/);
  } finally {
    console.log = originalLog;
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('one failed shard exits non-zero, leaves completed shards safe, and never falls back to push', async () => {
  const project = createProject([INIT_MIGRATION, TICKET_MIGRATION]);
  const urls = {
    'postgresql://u:p@localhost/s1': states.applied([INIT_MIGRATION]),
    'postgresql://u:p@localhost/s2': states.applied([INIT_MIGRATION]),
    'postgresql://u:p@localhost/s3': states.applied([INIT_MIGRATION]),
  };
  const runPrisma = recordingRunPrisma({
    failWhen: (command, url) => command === 'migrate deploy' && url.endsWith('/s2'),
  });

  try {
    const summary = await runDatabaseUpdate({
      targets: [
        target('shard_1', 'postgresql://u:p@localhost/s1'),
        target('shard_2', 'postgresql://u:p@localhost/s2'),
        target('shard_3', 'postgresql://u:p@localhost/s3'),
      ],
      cwd: project,
      env: {},
      introspect: fakeIntrospect(urls),
      runPrisma,
    });

    assert.equal(summary.success, false);
    const byId = Object.fromEntries(summary.results.map((result) => [result.id, result]));
    assert.deepEqual(
      [byId.shard_1.success, byId.shard_1.attempted],
      [true, true],
      'the shard migrated before the failure stays successfully migrated'
    );
    assert.deepEqual([byId.shard_2.success, byId.shard_2.attempted], [false, true]);
    assert.deepEqual(
      [byId.shard_3.success, byId.shard_3.attempted],
      [false, false],
      'databases after the failure are reported as never attempted'
    );
    assert.match(byId.shard_3.message, /an earlier database failed/);

    const deploys = runPrisma.commands.filter(({ command }) => command === 'migrate deploy');
    assert.equal(deploys.length, 2, 'no deploy is attempted after the failure');
    assert.ok(runPrisma.commands.every(({ command }) => !command.includes('db push')));
    assertNoDestructiveFlags(runPrisma);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('retrying after a partial failure is idempotent and skips already-migrated shards', async () => {
  const project = createProject([INIT_MIGRATION, TICKET_MIGRATION]);
  // shard_1 succeeded on the previous run; shard_2 and shard_3 are still pending.
  const urls = {
    'postgresql://u:p@localhost/s1': states.applied([INIT_MIGRATION, TICKET_MIGRATION]),
    'postgresql://u:p@localhost/s2': states.applied([INIT_MIGRATION]),
    'postgresql://u:p@localhost/s3': states.applied([INIT_MIGRATION]),
  };
  const runPrisma = recordingRunPrisma();

  try {
    const summary = await runDatabaseUpdate({
      targets: [
        target('shard_1', 'postgresql://u:p@localhost/s1'),
        target('shard_2', 'postgresql://u:p@localhost/s2'),
        target('shard_3', 'postgresql://u:p@localhost/s3'),
      ],
      cwd: project,
      env: {},
      introspect: fakeIntrospect(urls),
      runPrisma,
    });

    assert.equal(summary.success, true);
    const deploys = runPrisma.commands.filter(({ command }) => command === 'migrate deploy');
    assert.deepEqual(
      deploys.map(({ url }) => url),
      ['postgresql://u:p@localhost/s2', 'postgresql://u:p@localhost/s3'],
      'the already-migrated shard is not deployed to again'
    );
    assert.equal(summary.results[0].message, 'Already up to date');
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('destructive flags from the caller are forwarded to db push, in any environment', async () => {
  const project = createProject([TICKET_MIGRATION]);

  try {
    for (const flag of ['--force-reset', '--accept-data-loss']) {
      for (const env of [{}, { NODE_ENV: 'production' }]) {
        const runPrisma = recordingRunPrisma();
        const summary = await runDatabaseUpdate({
          targets: [target('shard_1', 'postgresql://u:p@localhost/s1')],
          extraArgs: [flag],
          cwd: project,
          env,
          introspect: fakeIntrospect({}),
          runPrisma,
        });

        assert.equal(summary.success, true);
        assert.equal(summary.strategy, 'push');
        assert.equal(summary.results[0].attempted, true);
        assert.deepEqual(
          runPrisma.commands.map(({ command }) => command),
          [`db push ${flag}`],
          'the migration pipeline is skipped and the flag is passed straight through'
        );
      }
    }
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('a populated database without migration history is blocked, never reset', async () => {
  const project = createProject([INIT_MIGRATION, TICKET_MIGRATION]);
  const urls = {
    'postgresql://u:p@localhost/s1': states.pushBuilt(),
    'postgresql://u:p@localhost/s2': states.applied([INIT_MIGRATION]),
  };
  const runPrisma = recordingRunPrisma();

  try {
    const summary = await runDatabaseUpdate({
      targets: [
        target('shard_1', 'postgresql://u:p@localhost/s1'),
        target('shard_2', 'postgresql://u:p@localhost/s2'),
      ],
      cwd: project,
      env: {},
      introspect: fakeIntrospect(urls),
      runPrisma,
    });

    assert.equal(summary.success, false);
    assert.equal(summary.strategy, 'blocked');
    assert.equal(runPrisma.commands.length, 0, 'nothing is applied anywhere');
    assert.match(summary.results[0].message, /Legacy database detected/);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

const driftRunPrisma = () => {
  const commands = [];
  const fn = async (args) => {
    const command = args.join(' ');
    commands.push(command);
    if (command.startsWith('migrate diff')) {
      // Exit code 2 from `migrate diff --exit-code` means "differences found".
      return { success: false, stdout: '', stderr: '', exitCode: 2 };
    }
    return { success: true, stdout: '', stderr: '', exitCode: 0 };
  };
  fn.commands = commands;
  return fn;
};

test('schema drift is a grouped warning by default, never a false failure', async () => {
  const project = createProject([INIT_MIGRATION, TICKET_MIGRATION], true);
  const urls = { 'postgresql://u:p@localhost/s1': states.applied([INIT_MIGRATION]) };
  const runPrisma = driftRunPrisma();

  try {
    const summary = await runDatabaseUpdate({
      targets: [target('shard_1', 'postgresql://u:p@localhost/s1')],
      cwd: project,
      env: {},
      introspect: fakeIntrospect(urls),
      runPrisma,
    });

    assert.equal(summary.success, true, 'equivalent-object drift must not block startup');
    assert.equal(summary.results[0].success, true);
    assert.match(summary.results[0].message, /1 migration applied/);
    assert.deepEqual(
      summary.warnings.filter((w) => w.kind === 'drift').map((w) => w.id),
      ['shard_1']
    );
    assert.ok(runPrisma.commands.some((command) => command.startsWith('migrate diff')));
    assert.ok(runPrisma.commands.some((command) => command === 'migrate deploy'));
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('SHARD_STRICT_DRIFT=true turns drift into a failing run', async () => {
  const project = createProject([INIT_MIGRATION, TICKET_MIGRATION], true);
  const urls = {
    'postgresql://u:p@localhost/s1': states.applied([INIT_MIGRATION, TICKET_MIGRATION]),
  };
  const runPrisma = driftRunPrisma();

  try {
    const summary = await runDatabaseUpdate({
      targets: [target('shard_1', 'postgresql://u:p@localhost/s1')],
      cwd: project,
      env: { SHARD_STRICT_DRIFT: 'true' },
      introspect: fakeIntrospect(urls),
      runPrisma,
    });

    assert.equal(summary.success, false);
    assert.equal(summary.results[0].kind, 'drift');
    assert.equal(summary.results[0].attempted, false, 'nothing was deployed');
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('a verification command failure is a warning by default and fails only in strict mode', async () => {
  const project = createProject([INIT_MIGRATION, TICKET_MIGRATION], true);
  const urls = { 'postgresql://u:p@localhost/s1': states.applied([INIT_MIGRATION]) };
  const runPrisma = async (args) => {
    const command = args.join(' ');
    if (command.startsWith('migrate diff')) {
      return {
        success: false,
        stdout: '',
        stderr: "P1001: Can't reach database server",
        exitCode: 1,
        error: "P1001: Can't reach database server",
      };
    }
    return { success: true, stdout: '', stderr: '', exitCode: 0 };
  };

  try {
    const relaxed = await runDatabaseUpdate({
      targets: [target('shard_1', 'postgresql://u:p@localhost/s1')],
      cwd: project,
      env: {},
      introspect: fakeIntrospect(urls),
      runPrisma,
    });
    assert.equal(relaxed.success, true);
    assert.match(
      relaxed.warnings.find((w) => w.kind === 'verify')?.message || '',
      /P1001/
    );

    const strict = await runDatabaseUpdate({
      targets: [target('shard_1', 'postgresql://u:p@localhost/s1')],
      cwd: project,
      env: { SHARD_STRICT_DRIFT: 'true' },
      introspect: fakeIntrospect(urls),
      runPrisma,
    });
    assert.equal(strict.success, false);
    assert.equal(strict.results[0].kind, 'verify');
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('a verified legacyBaseline config adopts legacy shards inside one run', async () => {
  const project = createProject([INIT_MIGRATION, TICKET_MIGRATION]);
  fs.writeFileSync(
    path.join(project, 'prisma-sharding.config.json'),
    JSON.stringify({
      migrations: { legacyBaseline: { until: INIT_MIGRATION, verified: true } },
    })
  );
  const urls = {
    'postgresql://u:p@localhost/s1': states.pushBuilt(),
    'postgresql://u:p@localhost/s2': states.pushBuilt(),
  };
  const runPrisma = recordingRunPrisma();

  try {
    const summary = await runDatabaseUpdate({
      targets: [
        target('shard_1', 'postgresql://u:p@localhost/s1'),
        target('shard_2', 'postgresql://u:p@localhost/s2'),
      ],
      cwd: project,
      env: {},
      introspect: fakeIntrospect(urls),
      runPrisma,
    });

    assert.equal(summary.success, true);
    assert.deepEqual(
      summary.results.map((result) => result.message),
      ['Baselined 1, 1 migration applied', 'Baselined 1, 1 migration applied']
    );
    assert.deepEqual(
      runPrisma.commands.map(({ command }) => command),
      [
        `migrate resolve --applied ${INIT_MIGRATION}`,
        'migrate deploy',
        `migrate resolve --applied ${INIT_MIGRATION}`,
        'migrate deploy',
      ],
      'baseline is recorded, later migrations run their real SQL'
    );
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('an unverified or missing legacyBaseline blocks legacy shards with one concise message', async () => {
  const project = createProject([INIT_MIGRATION, TICKET_MIGRATION]);
  const urls = { 'postgresql://u:p@localhost/s1': states.pushBuilt() };
  const runPrisma = recordingRunPrisma();

  try {
    const summary = await runDatabaseUpdate({
      targets: [target('shard_1', 'postgresql://u:p@localhost/s1')],
      cwd: project,
      env: {},
      introspect: fakeIntrospect(urls),
      runPrisma,
    });

    assert.equal(summary.success, false);
    assert.equal(summary.strategy, 'blocked');
    assert.match(summary.results[0].message, /Legacy database detected/);
    assert.equal(runPrisma.commands.length, 0, 'nothing is recorded or applied');
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('a legacyBaseline pointing at an unknown migration is a config error', async () => {
  const project = createProject([INIT_MIGRATION, TICKET_MIGRATION]);
  fs.writeFileSync(
    path.join(project, 'prisma-sharding.config.json'),
    JSON.stringify({
      migrations: { legacyBaseline: { until: 'does_not_exist', verified: true } },
    })
  );
  const runPrisma = recordingRunPrisma();

  try {
    const summary = await runDatabaseUpdate({
      targets: [target('shard_1', 'postgresql://u:p@localhost/s1')],
      cwd: project,
      env: {},
      introspect: fakeIntrospect({}),
      runPrisma,
    });

    assert.equal(summary.success, false);
    assert.match(summary.results[0].message, /Invalid legacyBaseline/);
    assert.equal(runPrisma.commands.length, 0);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('verification tries Prisma v7 diff arguments first and falls back to pre-v7 forms', async () => {
  const project = createProject([INIT_MIGRATION, TICKET_MIGRATION], true);
  const urls = {
    'postgresql://u:p@localhost/s1': states.applied([INIT_MIGRATION]),
    'postgresql://u:p@localhost/s2': states.applied([INIT_MIGRATION]),
  };
  const commands = [];
  const runPrisma = async (args) => {
    const command = args.join(' ');
    commands.push(command);
    if (command.includes('--from-config-datasource')) {
      // Simulate a pre-v7 Prisma CLI that does not know the new arguments.
      return {
        success: false,
        stdout: '',
        stderr: '! Unknown argument: --from-config-datasource',
        exitCode: 1,
        error: '! Unknown argument: --from-config-datasource',
      };
    }
    return { success: true, stdout: '', stderr: '', exitCode: 0 };
  };

  try {
    const summary = await runDatabaseUpdate({
      targets: [
        target('shard_1', 'postgresql://u:p@localhost/s1'),
        target('shard_2', 'postgresql://u:p@localhost/s2'),
      ],
      cwd: project,
      env: {},
      introspect: fakeIntrospect(urls),
      runPrisma,
    });

    assert.equal(summary.success, true);
    assert.equal(summary.results[0].success, true);
    assert.equal(summary.warnings.length, 0, 'a clean verification produces no warnings');
    const modernAttempts = commands.filter((c) => c.includes('--from-config-datasource'));
    const legacyAttempts = commands.filter((c) => c.includes('--from-schema-datasource'));
    assert.equal(modernAttempts.length, 1, 'the unsupported form is only attempted once per run');
    assert.equal(legacyAttempts.length, 2, 'the working form is used for every target');
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('an absent primary database is skipped when real shards are configured', async () => {
  const project = createProject([INIT_MIGRATION, TICKET_MIGRATION]);
  const urls = {
    'postgresql://u:p@localhost/main': states.missing(),
    'postgresql://u:p@localhost/s1': states.applied([INIT_MIGRATION]),
  };
  const runPrisma = recordingRunPrisma();

  try {
    const summary = await runDatabaseUpdate({
      targets: [
        target('primary', 'postgresql://u:p@localhost/main', true),
        target('shard_1', 'postgresql://u:p@localhost/s1'),
      ],
      cwd: project,
      env: {},
      introspect: fakeIntrospect(urls),
      runPrisma,
    });

    assert.equal(summary.success, true);
    const deploys = runPrisma.commands.filter(({ command }) => command === 'migrate deploy');
    assert.deepEqual(deploys.map(({ url }) => url), ['postgresql://u:p@localhost/s1']);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('an unreachable shard blocks the run before anything is applied', async () => {
  const project = createProject([INIT_MIGRATION, TICKET_MIGRATION]);
  const urls = {
    'postgresql://u:p@localhost/s1': states.applied([INIT_MIGRATION]),
    'postgresql://u:p@localhost/s2': states.unreachable(),
  };
  const runPrisma = recordingRunPrisma();

  try {
    const summary = await runDatabaseUpdate({
      targets: [
        target('shard_1', 'postgresql://u:p@localhost/s1'),
        target('shard_2', 'postgresql://u:p@localhost/s2'),
      ],
      cwd: project,
      env: {},
      introspect: fakeIntrospect(urls),
      runPrisma,
    });

    assert.equal(summary.success, false);
    assert.equal(summary.strategy, 'blocked');
    assert.equal(runPrisma.commands.length, 0);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('a failed client generation stops the run before any database work', async () => {
  const project = createProject([TICKET_MIGRATION]);
  const runPrisma = recordingRunPrisma({
    failWhen: (command) => command === 'generate',
  });

  try {
    const summary = await runDatabaseUpdate({
      targets: [target('shard_1', 'postgresql://u:p@localhost/s1')],
      generateClient: true,
      cwd: project,
      env: {},
      introspect: fakeIntrospect({}),
      runPrisma,
    });

    assert.equal(summary.success, false);
    assert.equal(summary.strategy, 'blocked');
    assert.equal(runPrisma.commands.length, 1, 'only generate was attempted');
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('primary and shard URLs pointing at the same database are processed once', () => {
  const env = {
    DATABASE_URL: 'postgresql://postgres:pw@localhost:5432/erp_shard1?schema=public',
    SHARD_COUNT: '3',
    SHARD_1_URL: 'postgres://postgres:pw@LOCALHOST/erp_shard1',
    SHARD_2_URL: 'postgresql://postgres:pw@localhost:5432/erp_shard2?schema=public',
    SHARD_3_URL: 'postgresql://postgres:pw@localhost:5432/erp_shard3?schema=public',
  };

  const { targets, missingShardIds, duplicates } = getDatabaseTargets(env);

  assert.equal(missingShardIds.length, 0);
  assert.deepEqual(targets.map((entry) => entry.id), ['primary', 'shard_2', 'shard_3']);
  assert.deepEqual(duplicates, [{ source: 'SHARD_1_URL', sameAs: 'primary' }]);
  assert.equal(
    normalizeDatabaseUrl('postgres://u:p@HOST/db'),
    normalizeDatabaseUrl('postgresql://u:p@host:5432/db?schema=public')
  );
});

test('runUpdateCli drives the shared pipeline and returns a non-zero code on failure', async () => {
  const project = createProject([INIT_MIGRATION, TICKET_MIGRATION]);
  const env = {
    SHARD_COUNT: '2',
    SHARD_1_URL: 'postgresql://u:p@localhost/s1',
    SHARD_2_URL: 'postgresql://u:p@localhost/s2',
  };
  const urls = {
    'postgresql://u:p@localhost/s1': states.applied([INIT_MIGRATION]),
    'postgresql://u:p@localhost/s2': states.applied([INIT_MIGRATION]),
  };

  const okPrisma = recordingRunPrisma();
  const okCode = await runUpdateCli({
    title: 'Test Update',
    generateClient: false,
    verboseEnvNames: ['SHARD_CLI_VERBOSE'],
    argv: [],
    env,
    cwd: project,
    introspect: fakeIntrospect(urls),
    runPrisma: okPrisma,
  });
  assert.equal(okCode, 0);
  assert.equal(
    okPrisma.commands.filter(({ command }) => command === 'migrate deploy').length,
    2
  );

  const failPrisma = recordingRunPrisma({
    failWhen: (command) => command === 'migrate deploy',
  });
  const failCode = await runUpdateCli({
    title: 'Test Update',
    generateClient: false,
    verboseEnvNames: ['SHARD_CLI_VERBOSE'],
    argv: [],
    env,
    cwd: project,
    introspect: fakeIntrospect(urls),
    runPrisma: failPrisma,
  });
  assert.equal(failCode, 1);

  fs.rmSync(project, { recursive: true, force: true });
});

test('legacy helpers are thin wrappers over the shared pipeline', () => {
  assert.equal(
    compat.syncShardSchemas,
    compat.deployShardMigrations,
    'syncShardSchemas must be the same function as deployShardMigrations'
  );
  assert.equal(typeof compat.deployShardMigrations, 'function');
  assert.equal(typeof compat.runDatabaseUpdate, 'function');
});

const { classifyMigrationState, isBlockingState } = require(
  path.resolve(__dirname, '../dist/cli/utils/migration-state.js')
);
const { readLocalMigrationChecksums } = require(
  path.resolve(__dirname, '../dist/cli/utils/migrations.js')
);
const crypto = require('node:crypto');

const row = (name, overrides = {}) => ({
  name,
  checksum: null,
  finishedAt: new Date('2026-07-01T00:00:00Z'),
  rolledBackAt: null,
  ...overrides,
});

const introspectionWith = (applied) => ({
  reachable: true,
  empty: false,
  hasMigrationsTable: true,
  databaseMissing: false,
  userTableCount: 40,
  applied,
});

test('a rolled-back migration stays deployable instead of being blocked', () => {
  const state = classifyMigrationState({
    targetId: 'shard_1',
    introspection: introspectionWith([
      row(INIT_MIGRATION),
      row(TICKET_MIGRATION, { finishedAt: null, rolledBackAt: new Date() }),
    ]),
    localMigrations: [INIT_MIGRATION, TICKET_MIGRATION],
  });

  assert.equal(state.kind, 'pending', 'migrate deploy re-applies rolled-back migrations');
  assert.equal(isBlockingState(state.kind), false);
  assert.deepEqual(state.pending, [TICKET_MIGRATION]);
  assert.match(state.warnings.join('\n'), /will be re-applied/);
  assert.doesNotMatch(state.reconciliation.join('\n'), /--applied/);
});

test('an edited applied migration is detected by checksum and blocks the run', () => {
  const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
  const state = classifyMigrationState({
    targetId: 'shard_1',
    introspection: introspectionWith([
      row(INIT_MIGRATION, { checksum: sha('original init sql') }),
      row(TICKET_MIGRATION, { checksum: sha('original ticket sql') }),
    ]),
    localMigrations: [INIT_MIGRATION, TICKET_MIGRATION],
    localChecksums: {
      [INIT_MIGRATION]: [sha('original init sql')],
      [TICKET_MIGRATION]: [sha('EDITED ticket sql')],
    },
  });

  assert.equal(state.kind, 'history-mismatch');
  assert.equal(isBlockingState(state.kind), true);
  assert.match(state.summary, new RegExp(TICKET_MIGRATION));
  assert.match(state.reconciliation.join('\n'), /edited after/);
});

test('a systemic checksum difference is a warning, not a false block', () => {
  const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
  const names = ['20260101000000_a', '20260102000000_b', '20260103000000_c'];
  const state = classifyMigrationState({
    targetId: 'shard_1',
    introspection: introspectionWith(
      names.map((name) => row(name, { checksum: sha(`db:${name}`) }))
    ),
    localMigrations: names,
    localChecksums: Object.fromEntries(names.map((name) => [name, [sha(`local:${name}`)]])),
  });

  assert.equal(state.kind, 'up-to-date');
  assert.match(state.warnings.join('\n'), /checksum validation was skipped/);
});

test('local checksums include an LF-normalised variant for CRLF files', () => {
  const project = createProject([]);
  const name = '20260101000000_crlf';
  const dir = path.join(project, 'prisma', 'migrations', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'migration.sql'), 'SELECT 1;\r\nSELECT 2;\r\n');

  try {
    const checksums = readLocalMigrationChecksums(path.join(project, 'prisma', 'migrations'));
    const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
    assert.equal(checksums[name].length, 2);
    assert.ok(checksums[name].includes(sha('SELECT 1;\r\nSELECT 2;\r\n')));
    assert.ok(checksums[name].includes(sha('SELECT 1;\nSELECT 2;\n')));
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('database credentials stay masked in URLs and command output', () => {
  assert.equal(
    maskShardUrl('postgresql://user:secret@localhost:5432/db'),
    'postgresql://user:***@localhost:5432/db'
  );

  const env = {
    DATABASE_URL: 'postgresql://user:secret@localhost:5432/db',
    SHARD_1_URL: 'postgresql://user:topsecret@localhost:5432/s1',
  };
  const sanitized = sanitizeCommandOutput(
    'connecting to postgresql://user:secret@localhost:5432/db and postgresql://user:topsecret@localhost:5432/s1 password=secret',
    env
  );

  assert.doesNotMatch(sanitized, /secret/);
  assert.match(sanitized, /user:\*\*\*@localhost/);
});
