const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { DESTRUCTIVE_FLAGS, runDatabaseUpdate } = require(
  path.resolve(__dirname, '../dist/cli/utils/pipeline.js')
);
const {
  readLocalMigrationChecksums,
  readLocalMigrationHistory,
  readLocalMigrationHistoryDigest,
  readPrismaSchemaDigest,
  resolveSchemaPath,
} = require(path.resolve(__dirname, '../dist/cli/utils/migrations.js'));
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

const bootstrapProjectConfig = (project, initialMigration) => ({
  migrations: {
    bootstrap: {
      initialMigration,
      historyDigest: readLocalMigrationHistoryDigest(
        path.join(project, 'prisma', 'migrations')
      ),
      schemaDigest: resolveSchemaPath(project, {})
        ? readPrismaSchemaDigest(resolveSchemaPath(project, {}))
        : '0'.repeat(64),
      verified: true,
    },
  },
});

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

const recordingEnsureExtensions = ({ failUrl } = {}) => {
  const calls = [];
  const fn = async (url, extensions) => {
    calls.push({ url, extensions });
    return url === failUrl
      ? { success: false, error: 'permission denied to create extension pg_trgm' }
      : { success: true };
  };
  fn.calls = calls;
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
  const project = createProject([INIT_MIGRATION, TICKET_MIGRATION], true);
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
  const project = createProject([TICKET_MIGRATION], true);
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
    assert.equal(
      runPrisma.commands.filter(({ command }) => command === 'migrate deploy').length,
      0,
      'an up-to-date database must not deploy migrations'
    );
    assert.equal(
      runPrisma.commands.filter(({ command }) => command.startsWith('db push')).length,
      0,
      'an up-to-date migration-managed database must never fall through to db push'
    );
    assert.ok(
      runPrisma.commands.every(({ command }) => command.startsWith('migrate diff')),
      'only read-only schema verification may run'
    );
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

test('empty primary DATABASE_URL is skipped when shards are configured', async () => {
  const project = createProject([INIT_MIGRATION, TICKET_MIGRATION], true);
  const urls = {
    'postgresql://u:p@localhost/main': states.emptyDatabase(),
    'postgresql://u:p@localhost/s1': states.pushBuilt(),
    'postgresql://u:p@localhost/s2': states.pushBuilt(),
  };
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => {
    lines.push(args.map(String).join(' '));
  };

  try {
    fs.writeFileSync(
      path.join(project, 'prisma-sharding.config.json'),
      JSON.stringify({
        migrations: { legacyBaseline: { until: INIT_MIGRATION, verified: true } },
      })
    );

    const runPrisma = recordingRunPrisma();
    const summary = await runDatabaseUpdate({
      targets: [
        target('primary', 'postgresql://u:p@localhost/main', true),
        target('shard_1', 'postgresql://u:p@localhost/s1'),
        target('shard_2', 'postgresql://u:p@localhost/s2'),
      ],
      verbose: true,
      cwd: project,
      env: {},
      introspect: fakeIntrospect(urls),
      runPrisma,
    });

    assert.equal(summary.success, true);
    const stdout = lines.join('\n');
    assert.match(stdout, /⏭️ primary {2}Skipped \(DATABASE_URL empty; shards configured\)/);
    assert.match(stdout, /✅ shard_1/);
    assert.match(stdout, /✅ shard_2/);
    assert.equal(
      summary.results.find((result) => result.id === 'primary')?.message,
      'Skipped - empty DATABASE_URL while shards are configured'
    );
    assert.equal(
      runPrisma.commands.filter((command) => command.url.endsWith('/main')).length,
      0,
      'empty primary must never receive migrate deploy'
    );
  } finally {
    console.log = originalLog;
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('an empty shard is deployed only after the complete history passes bootstrap validation', async () => {
  const project = createProject([INIT_MIGRATION, TICKET_MIGRATION], true);
  const url = 'postgresql://u:p@localhost/s1?schema=tenant_one';
  const runPrisma = recordingRunPrisma();

  try {
    const summary = await runDatabaseUpdate({
      targets: [target('shard_1', url)],
      cwd: project,
      env: {},
      introspect: fakeIntrospect({ [url]: states.emptyDatabase() }),
      runPrisma,
      projectConfig: bootstrapProjectConfig(project, INIT_MIGRATION),
    });

    assert.equal(summary.success, true);
    assert.deepEqual(
      runPrisma.commands.filter(({ command }) => command === 'migrate deploy').map(({ url }) => url),
      [url]
    );
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('bootstrap contract validation performs no extra migration execution on a real database', async () => {
  const project = createProject([INIT_MIGRATION], true);
  const targetUrl = 'postgresql://u:p@localhost/s1?schema=tenant_one';
  const runPrisma = recordingRunPrisma();

  try {
    const summary = await runDatabaseUpdate({
      targets: [target('shard_1', targetUrl)],
      cwd: project,
      env: {},
      introspect: fakeIntrospect({ [targetUrl]: states.emptyDatabase() }),
      runPrisma,
      projectConfig: bootstrapProjectConfig(project, INIT_MIGRATION),
    });

    assert.equal(summary.success, true);
    assert.deepEqual(
      runPrisma.commands.map(({ command, url }) => [command, url]),
      [
        ['migrate deploy', targetUrl],
        [
          'migrate diff --from-config-datasource --to-schema ' +
            path.join(project, 'prisma', 'schema.prisma') +
            ' --exit-code',
          targetUrl,
        ],
      ]
    );
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('an empty database without bootstrap configuration keeps the compatible deploy flow', async () => {
  const project = createProject([INIT_MIGRATION], true);
  const urls = {
    'postgresql://u:p@localhost/s1': states.emptyDatabase(),
    'postgresql://u:p@localhost/s2': states.emptyDatabase(),
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
    assert.equal(summary.strategy, 'migrate');
    assert.equal(
      runPrisma.commands.filter(({ command }) => command === 'migrate deploy').length,
      2
    );
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('strict bootstrap mode blocks every empty shard when no contract is configured', async () => {
  const project = createProject([INIT_MIGRATION], true);
  const urls = {
    'postgresql://u:p@localhost/s1': states.emptyDatabase(),
    'postgresql://u:p@localhost/s2': states.emptyDatabase(),
  };
  const runPrisma = recordingRunPrisma();

  try {
    const summary = await runDatabaseUpdate({
      targets: [
        target('shard_1', 'postgresql://u:p@localhost/s1'),
        target('shard_2', 'postgresql://u:p@localhost/s2'),
      ],
      cwd: project,
      env: { SHARD_STRICT_BOOTSTRAP: 'true' },
      introspect: fakeIntrospect(urls),
      runPrisma,
    });

    assert.equal(summary.success, false);
    assert.equal(summary.strategy, 'blocked');
    assert.ok(summary.results.every((result) => result.kind === 'bootstrap-invalid'));
    assert.ok(summary.results.every((result) => result.attempted === false));
    assert.match(summary.results[0].message, /verified bootstrap contract/);
    assert.equal(runPrisma.commands.length, 0);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('default mode deploys an empty database when optional schema verification is unavailable', async () => {
  const project = createProject([INIT_MIGRATION]);
  const url = 'postgresql://u:p@localhost/s1';
  const runPrisma = recordingRunPrisma();

  try {
    const summary = await runDatabaseUpdate({
      targets: [target('shard_1', url)],
      cwd: project,
      env: {},
      introspect: fakeIntrospect({ [url]: states.emptyDatabase() }),
      runPrisma,
    });

    assert.equal(summary.success, true);
    assert.equal(
      runPrisma.commands.filter(({ command }) => command === 'migrate deploy').length,
      1
    );
    assert.deepEqual(
      summary.warnings.filter(({ kind }) => kind === 'verify').map(({ id }) => id),
      ['shard_1']
    );
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('strict drift mode blocks an unverifiable empty database before migration SQL', async () => {
  const project = createProject([INIT_MIGRATION]);
  const url = 'postgresql://u:p@localhost/s1';
  const runPrisma = recordingRunPrisma();

  try {
    const summary = await runDatabaseUpdate({
      targets: [target('shard_1', url)],
      cwd: project,
      env: { SHARD_STRICT_DRIFT: 'true' },
      introspect: fakeIntrospect({ [url]: states.emptyDatabase() }),
      runPrisma,
    });

    assert.equal(summary.success, false);
    assert.equal(summary.results[0].kind, 'verification-error');
    assert.match(summary.results[0].message, /strict drift verification/i);
    assert.equal(runPrisma.commands.length, 0);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('an explicit bootstrap contract requires a resolvable schema fingerprint', async () => {
  const project = createProject([INIT_MIGRATION]);
  const url = 'postgresql://u:p@localhost/s1';
  const runPrisma = recordingRunPrisma();

  try {
    const summary = await runDatabaseUpdate({
      targets: [target('shard_1', url)],
      cwd: project,
      env: {},
      introspect: fakeIntrospect({ [url]: states.emptyDatabase() }),
      runPrisma,
      projectConfig: bootstrapProjectConfig(project, INIT_MIGRATION),
    });

    assert.equal(summary.success, false);
    assert.equal(summary.results[0].kind, 'bootstrap-invalid');
    assert.match(summary.results[0].message, /schema path could not be resolved/i);
    assert.equal(runPrisma.commands.length, 0);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('a changed migration invalidates the verified bootstrap contract before deployment', async () => {
  const project = createProject([INIT_MIGRATION], true);
  const url = 'postgresql://u:p@localhost/s1';
  const runPrisma = recordingRunPrisma();
  const config = bootstrapProjectConfig(project, INIT_MIGRATION);
  config.migrations.bootstrap.historyDigest = '0'.repeat(64);

  try {
    const summary = await runDatabaseUpdate({
      targets: [target('shard_1', url)],
      cwd: project,
      env: {},
      introspect: fakeIntrospect({ [url]: states.emptyDatabase() }),
      runPrisma,
      projectConfig: config,
    });

    assert.equal(summary.success, false);
    assert.match(summary.results[0].message, /changed after bootstrap validation/i);
    assert.equal(runPrisma.commands.length, 0);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('a changed Prisma datamodel invalidates the bootstrap contract before deployment', async () => {
  const project = createProject([INIT_MIGRATION], true);
  const url = 'postgresql://u:p@localhost/s1';
  const runPrisma = recordingRunPrisma();
  const config = bootstrapProjectConfig(project, INIT_MIGRATION);
  fs.writeFileSync(path.join(project, 'prisma', 'schema.prisma'), '// changed schema\n');

  try {
    const summary = await runDatabaseUpdate({
      targets: [target('shard_1', url)],
      cwd: project,
      env: {},
      introspect: fakeIntrospect({ [url]: states.emptyDatabase() }),
      runPrisma,
      projectConfig: config,
    });

    assert.equal(summary.success, false);
    assert.match(summary.results[0].message, /datamodel changed/i);
    assert.equal(runPrisma.commands.length, 0);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('a new empty shard joins a current fleet through the same validated history', async () => {
  const project = createProject([INIT_MIGRATION, TICKET_MIGRATION], true);
  const urls = {
    'postgresql://u:p@localhost/s1': states.applied([INIT_MIGRATION, TICKET_MIGRATION]),
    'postgresql://u:p@localhost/s2': states.emptyDatabase(),
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
      projectConfig: bootstrapProjectConfig(project, INIT_MIGRATION),
    });

    assert.equal(summary.success, true);
    assert.deepEqual(
      runPrisma.commands.filter(({ command }) => command === 'migrate deploy').map(({ url }) => url),
      ['postgresql://u:p@localhost/s2']
    );
    assert.equal(summary.results[0].message, 'Already up to date');
  } finally {
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

test('the push fallback provisions configured extensions before each database push', async () => {
  const project = createProject();
  const runPrisma = recordingRunPrisma();
  const ensureExtensions = recordingEnsureExtensions();
  const extensions = [{ name: 'pg_trgm', schema: 'public' }];

  try {
    const summary = await runDatabaseUpdate({
      targets: [
        target('shard_1', 'postgresql://u:p@localhost/s1'),
        target('shard_2', 'postgresql://u:p@localhost/s2'),
      ],
      cwd: project,
      env: {},
      runPrisma,
      ensureExtensions,
      projectConfig: { postgresql: { extensions } },
    });

    assert.equal(summary.success, true);
    assert.deepEqual(ensureExtensions.calls, [
      { url: 'postgresql://u:p@localhost/s1', extensions },
      { url: 'postgresql://u:p@localhost/s2', extensions },
    ]);
    assert.deepEqual(
      runPrisma.commands.map(({ command }) => command),
      ['db push', 'db push']
    );
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('the migration path provisions configured extensions before migrate deploy', async () => {
  const project = createProject([INIT_MIGRATION, TICKET_MIGRATION]);
  const url = 'postgresql://u:p@localhost/s1';
  const runPrisma = recordingRunPrisma();
  const ensureExtensions = recordingEnsureExtensions();
  const extensions = [{ name: 'pg_trgm', schema: 'public' }];

  try {
    const summary = await runDatabaseUpdate({
      targets: [target('shard_1', url)],
      cwd: project,
      env: {},
      introspect: fakeIntrospect({ [url]: states.applied([INIT_MIGRATION]) }),
      runPrisma,
      ensureExtensions,
      projectConfig: { postgresql: { extensions } },
    });

    assert.equal(summary.success, true);
    assert.deepEqual(ensureExtensions.calls, [{ url, extensions }]);
    assert.equal(
      runPrisma.commands.filter(({ command }) => command === 'migrate deploy').length,
      1
    );
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('extension setup failure blocks migrate deploy and later shards', async () => {
  const project = createProject([INIT_MIGRATION, TICKET_MIGRATION]);
  const firstUrl = 'postgresql://u:p@localhost/s1';
  const secondUrl = 'postgresql://u:p@localhost/s2';
  const runPrisma = recordingRunPrisma();
  const ensureExtensions = recordingEnsureExtensions({ failUrl: firstUrl });

  try {
    const summary = await runDatabaseUpdate({
      targets: [target('shard_1', firstUrl), target('shard_2', secondUrl)],
      cwd: project,
      env: {},
      introspect: fakeIntrospect({
        [firstUrl]: states.applied([INIT_MIGRATION]),
        [secondUrl]: states.applied([INIT_MIGRATION]),
      }),
      runPrisma,
      ensureExtensions,
      projectConfig: {
        postgresql: { extensions: [{ name: 'pg_trgm', schema: 'public' }] },
      },
    });

    assert.equal(summary.success, false);
    assert.equal(runPrisma.commands.length, 0);
    assert.equal(summary.results[1].attempted, false);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('extension setup failure stops the push fleet before Prisma changes that target', async () => {
  const project = createProject();
  const runPrisma = recordingRunPrisma();
  const ensureExtensions = recordingEnsureExtensions({
    failUrl: 'postgresql://u:p@localhost/s1',
  });

  try {
    const summary = await runDatabaseUpdate({
      targets: [
        target('shard_1', 'postgresql://u:p@localhost/s1'),
        target('shard_2', 'postgresql://u:p@localhost/s2'),
      ],
      cwd: project,
      env: {},
      runPrisma,
      ensureExtensions,
      projectConfig: {
        postgresql: { extensions: [{ name: 'pg_trgm', schema: 'public' }] },
      },
    });

    assert.equal(summary.success, false);
    assert.equal(runPrisma.commands.length, 0);
    assert.match(summary.results[0].message, /permission denied/);
    assert.equal(summary.results[1].attempted, false);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('force-reset remains supported when configured extensions survive the reset push', async () => {
  const project = createProject();
  const runPrisma = recordingRunPrisma();
  const ensureExtensions = recordingEnsureExtensions();

  try {
    const summary = await runDatabaseUpdate({
      targets: [target('shard_1', 'postgresql://u:p@localhost/s1')],
      extraArgs: ['--force-reset'],
      cwd: project,
      env: { NODE_ENV: 'production' },
      runPrisma,
      ensureExtensions,
      projectConfig: {
        postgresql: { extensions: [{ name: 'pg_trgm', schema: 'public' }] },
      },
    });

    assert.equal(summary.success, true);
    assert.equal(summary.strategy, 'push');
    assert.equal(ensureExtensions.calls.length, 1);
    assert.deepEqual(
      runPrisma.commands.map(({ command }) => command),
      ['db push --force-reset']
    );
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('force-reset retries once without resetting after restoring dropped extensions', async () => {
  const project = createProject();
  const runPrisma = recordingRunPrisma({
    failWhen: (command) => command === 'db push --force-reset',
  });
  const ensureExtensions = recordingEnsureExtensions();

  try {
    const summary = await runDatabaseUpdate({
      targets: [target('shard_1', 'postgresql://u:p@localhost/s1')],
      extraArgs: ['--force-reset'],
      cwd: project,
      env: {},
      runPrisma,
      ensureExtensions,
      projectConfig: {
        postgresql: { extensions: [{ name: 'pg_trgm', schema: 'public' }] },
      },
    });

    assert.equal(summary.success, true);
    assert.equal(ensureExtensions.calls.length, 1);
    assert.deepEqual(
      runPrisma.commands.map(({ command }) => command),
      ['db push --force-reset', 'db push --accept-data-loss']
    );
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

test('fresh databases fail when deployed history differs from the current datamodel', async () => {
  const project = createProject([INIT_MIGRATION], true);
  const firstUrl = 'postgresql://u:p@localhost/s1';
  const secondUrl = 'postgresql://u:p@localhost/s2';
  const runPrisma = driftRunPrisma();

  try {
    const summary = await runDatabaseUpdate({
      targets: [target('shard_1', firstUrl), target('shard_2', secondUrl)],
      cwd: project,
      env: {},
      introspect: fakeIntrospect({
        [firstUrl]: states.emptyDatabase(),
        [secondUrl]: states.emptyDatabase(),
      }),
      runPrisma,
    });

    assert.equal(summary.success, false);
    assert.equal(summary.results[0].kind, 'drift');
    assert.match(summary.results[0].message, /differs from the Prisma datamodel/);
    assert.equal(summary.results[1].attempted, false);
    assert.equal(
      runPrisma.commands.filter((command) => command === 'migrate deploy').length,
      1,
      'a fresh-schema verification failure must halt later shards'
    );
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('fresh verification command errors warn in compatible mode instead of blocking deployment', async () => {
  const project = createProject([INIT_MIGRATION], true);
  const url = 'postgresql://u:p@localhost/s1';
  const commands = [];
  const runPrisma = async (args) => {
    const command = args.join(' ');
    commands.push(command);
    if (command.startsWith('migrate diff')) {
      return {
        success: false,
        stdout: '',
        stderr: 'Prisma schema comparison unavailable',
        exitCode: 1,
        error: 'Prisma schema comparison unavailable',
      };
    }
    return { success: true, stdout: '', stderr: '', exitCode: 0 };
  };

  try {
    const summary = await runDatabaseUpdate({
      targets: [target('shard_1', url)],
      cwd: project,
      env: {},
      introspect: fakeIntrospect({ [url]: states.emptyDatabase() }),
      runPrisma,
    });

    assert.equal(summary.success, true);
    assert.ok(commands.includes('migrate deploy'));
    assert.match(
      summary.warnings.find(({ kind }) => kind === 'verify')?.message || '',
      /comparison unavailable/i
    );
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('an opted-in bootstrap contract makes fresh verification errors blocking', async () => {
  const project = createProject([INIT_MIGRATION], true);
  const url = 'postgresql://u:p@localhost/s1';
  const runPrisma = async (args) => {
    if (args.join(' ').startsWith('migrate diff')) {
      return {
        success: false,
        stdout: '',
        stderr: 'Prisma schema comparison unavailable',
        exitCode: 1,
        error: 'Prisma schema comparison unavailable',
      };
    }
    return { success: true, stdout: '', stderr: '', exitCode: 0 };
  };

  try {
    const summary = await runDatabaseUpdate({
      targets: [target('shard_1', url)],
      cwd: project,
      env: {},
      introspect: fakeIntrospect({ [url]: states.emptyDatabase() }),
      runPrisma,
      projectConfig: bootstrapProjectConfig(project, INIT_MIGRATION),
    });

    assert.equal(summary.success, false);
    assert.equal(summary.results[0].kind, 'verify');
    assert.match(summary.results[0].message, /comparison unavailable/i);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

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
    assert.equal(summary.results[0].kind, 'schema-drift');
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

test('a verified baseline safely records a newly restored bootstrap before existing history', async () => {
  const BOOTSTRAP = '20251231000000_bootstrap';
  const project = createProject([BOOTSTRAP, INIT_MIGRATION, TICKET_MIGRATION]);
  const url = 'postgresql://u:p@localhost/s1';
  const runPrisma = recordingRunPrisma();

  try {
    const summary = await runDatabaseUpdate({
      targets: [target('shard_1', url)],
      cwd: project,
      env: {},
      projectConfig: {
        migrations: { legacyBaseline: { until: INIT_MIGRATION, verified: true } },
      },
      introspect: fakeIntrospect({ [url]: states.applied([INIT_MIGRATION]) }),
      runPrisma,
    });

    assert.equal(summary.success, true);
    assert.deepEqual(
      runPrisma.commands.map(({ command }) => command),
      [`migrate resolve --applied ${BOOTSTRAP}`, 'migrate deploy']
    );
    assert.equal(summary.results[0].message, 'Baselined 1, 1 migration applied');

    const rerunPrisma = recordingRunPrisma();
    const rerun = await runDatabaseUpdate({
      targets: [target('shard_1', url)],
      cwd: project,
      env: {},
      projectConfig: {
        migrations: { legacyBaseline: { until: INIT_MIGRATION, verified: true } },
      },
      introspect: fakeIntrospect({
        [url]: states.applied([BOOTSTRAP, INIT_MIGRATION, TICKET_MIGRATION]),
      }),
      runPrisma: rerunPrisma,
    });

    assert.equal(rerun.success, true);
    assert.equal(rerun.results[0].message, 'Already up to date');
    assert.deepEqual(
      rerunPrisma.commands,
      [],
      'the adopted bootstrap and later migrations must not execute twice'
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

test('an unfinished migration is blocked and only offers explicit Prisma recovery', () => {
  const state = classifyMigrationState({
    targetId: 'shard_1',
    introspection: introspectionWith([
      row(INIT_MIGRATION),
      row(TICKET_MIGRATION, { finishedAt: null, rolledBackAt: null }),
    ]),
    localMigrations: [INIT_MIGRATION, TICKET_MIGRATION],
  });

  assert.equal(state.kind, 'failed-migration');
  assert.equal(isBlockingState(state.kind), true);
  assert.match(state.summary, /started but never finished/);
  assert.match(state.reconciliation.join('\n'), /resolve --rolled-back/);
  assert.match(state.reconciliation.join('\n'), /ONLY if you manually completed/);
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

test('all checksum differences still block because edited history is never guessed safe', () => {
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

  assert.equal(state.kind, 'history-mismatch');
  assert.equal(isBlockingState(state.kind), true);
  assert.match(state.summary, /3 applied migrations differ/);
});

test('a missing migration before recorded history requires explicit baseline adoption', () => {
  const BOOTSTRAP = '20251231000000_bootstrap';
  const state = classifyMigrationState({
    targetId: 'shard_1',
    introspection: introspectionWith([row(INIT_MIGRATION), row(TICKET_MIGRATION)]),
    localMigrations: [BOOTSTRAP, INIT_MIGRATION, TICKET_MIGRATION],
  });

  assert.equal(state.kind, 'baseline-required');
  assert.deepEqual(state.baselineCandidates, [BOOTSTRAP]);
  assert.equal(isBlockingState(state.kind), true);
});

test('an unknown rolled-back migration remains divergent history', () => {
  const state = classifyMigrationState({
    targetId: 'shard_1',
    introspection: introspectionWith([
      row(INIT_MIGRATION),
      row('20260102000000_missing_locally', {
        finishedAt: null,
        rolledBackAt: new Date(),
      }),
    ]),
    localMigrations: [INIT_MIGRATION],
  });

  assert.equal(state.kind, 'unknown-migrations');
  assert.equal(isBlockingState(state.kind), true);
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

test('bootstrap history digest is CRLF-stable and changes with migration content', () => {
  const project = createProject([INIT_MIGRATION]);
  const migrationFile = path.join(
    project,
    'prisma',
    'migrations',
    INIT_MIGRATION,
    'migration.sql'
  );

  try {
    fs.writeFileSync(migrationFile, 'SELECT 1;\r\nSELECT 2;\r\n');
    const crlf = readLocalMigrationHistoryDigest(path.join(project, 'prisma', 'migrations'));
    fs.writeFileSync(migrationFile, 'SELECT 1;\nSELECT 2;\n');
    const lf = readLocalMigrationHistoryDigest(path.join(project, 'prisma', 'migrations'));
    fs.writeFileSync(migrationFile, 'SELECT 1;\nSELECT 3;\n');
    const edited = readLocalMigrationHistoryDigest(path.join(project, 'prisma', 'migrations'));

    assert.equal(crlf, lf);
    assert.notEqual(lf, edited);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('migration history ordering is deterministic and malformed directories are reported', () => {
  const project = createProject([]);
  const root = path.join(project, 'prisma', 'migrations');
  fs.mkdirSync(path.join(root, '20260102000000_B'), { recursive: true });
  fs.writeFileSync(path.join(root, '20260102000000_B', 'migration.sql'), 'SELECT 2;\n');
  fs.mkdirSync(path.join(root, '20260101000000_a'), { recursive: true });
  fs.writeFileSync(path.join(root, '20260101000000_a', 'migration.sql'), 'SELECT 1;\n');
  fs.mkdirSync(path.join(root, '20260103000000_missing_sql'), { recursive: true });

  try {
    const history = readLocalMigrationHistory(root);
    assert.deepEqual(history.migrations, [
      '20260101000000_a',
      '20260102000000_B',
    ]);
    assert.match(history.errors.join('\n'), /has no migration.sql/);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('custom Prisma schema paths are resolved from prisma.config.ts literals', () => {
  const project = createProject([INIT_MIGRATION]);
  const customSchema = path.join(project, 'database', 'prisma-schema');
  fs.mkdirSync(customSchema, { recursive: true });
  fs.writeFileSync(path.join(customSchema, 'base.prisma'), '// custom schema\n');
  fs.writeFileSync(
    path.join(project, 'prisma.config.ts'),
    `export default { schema: 'database/prisma-schema' }\n`
  );

  try {
    assert.equal(resolveSchemaPath(project, {}), customSchema);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('a missing configured schema path does not silently fall back to prisma/schema', () => {
  const project = createProject([INIT_MIGRATION], true);
  fs.writeFileSync(
    path.join(project, 'prisma.config.ts'),
    `export default { schema: 'missing/schema.prisma' }\n`
  );

  try {
    assert.equal(resolveSchemaPath(project, {}), undefined);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('a dynamic configured schema path is reported unresolved unless explicitly overridden', () => {
  const project = createProject([INIT_MIGRATION], true);
  const override = path.join(project, 'prisma', 'schema.prisma');
  fs.writeFileSync(
    path.join(project, 'prisma.config.ts'),
    `export default { schema: process.env.CUSTOM_SCHEMA }\n`
  );

  try {
    assert.equal(resolveSchemaPath(project, {}), undefined);
    assert.equal(resolveSchemaPath(project, { PRISMA_SCHEMA_PATH: override }), override);
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
