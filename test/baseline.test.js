const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { parseBaselineArgs, runBaselineCli } = require(
  path.resolve(__dirname, '../dist/cli/utils/baseline-core.js')
);

const INIT = '20260101000000_init';
const TICKET = '20260724000200_pmp_task_ticket_number';

const createProject = (migrationNames = [INIT, TICKET]) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-sharding-baseline-'));
  for (const name of migrationNames) {
    const migrationDirectory = path.join(directory, 'prisma', 'migrations', name);
    fs.mkdirSync(migrationDirectory, { recursive: true });
    fs.writeFileSync(path.join(migrationDirectory, 'migration.sql'), `-- ${name}\n`);
  }
  return directory;
};

const ENV = {
  SHARD_COUNT: '2',
  SHARD_1_URL: 'postgresql://u:p@localhost/s1',
  SHARD_2_URL: 'postgresql://u:p@localhost/s2',
};

const states = {
  pushBuilt: {
    reachable: true,
    empty: false,
    hasMigrationsTable: false,
    databaseMissing: false,
    userTableCount: 168,
    applied: [],
  },
  emptyDatabase: {
    reachable: true,
    empty: true,
    hasMigrationsTable: false,
    databaseMissing: false,
    userTableCount: 0,
    applied: [],
  },
  unreachable: {
    reachable: false,
    empty: false,
    hasMigrationsTable: false,
    databaseMissing: false,
    userTableCount: 0,
    applied: [],
    error: 'connection refused',
  },
  partiallyRecorded: {
    reachable: true,
    empty: false,
    hasMigrationsTable: true,
    databaseMissing: false,
    userTableCount: 168,
    applied: [
      {
        name: INIT,
        checksum: null,
        finishedAt: new Date('2026-07-01T00:00:00Z'),
        rolledBackAt: null,
      },
    ],
  },
  failedOnEmptySchema: {
    reachable: true,
    empty: true,
    hasMigrationsTable: true,
    databaseMissing: false,
    userTableCount: 0,
    applied: [
      {
        name: INIT,
        checksum: null,
        finishedAt: null,
        rolledBackAt: null,
      },
    ],
  },
};

const fakeIntrospect = (byUrl) => {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    if (!byUrl[url]) {
      throw new Error(`Unexpected introspection of ${url}`);
    }
    return byUrl[url];
  };
  fn.calls = calls;
  return fn;
};

const recordingRunPrisma = ({ failWhen } = {}) => {
  const commands = [];
  const fn = async (args, options = {}) => {
    const command = args.join(' ');
    const url = options.env?.DATABASE_URL || '';
    commands.push({ command, url });
    if (failWhen && failWhen(command, url)) {
      return { success: false, stdout: '', stderr: '', exitCode: 1, error: 'resolve failed' };
    }
    return { success: true, stdout: '', stderr: '', exitCode: 0 };
  };
  fn.commands = commands;
  return fn;
};

test('parseBaselineArgs understands every accepted form', () => {
  assert.deepEqual(
    parseBaselineArgs(['--until=x', '--only=a,b', '--yes', '--verified']),
    { until: 'x', only: ['a', 'b'], confirm: true, verified: true }
  );
  assert.deepEqual(parseBaselineArgs(['--until', 'x', '--only', 'a, b', '-y']), {
    until: 'x',
    only: ['a', 'b'],
    confirm: true,
    verified: false,
  });
});

test('dry run prints the plan without touching any database', async () => {
  const project = createProject();
  const introspect = fakeIntrospect({});
  const runPrisma = recordingRunPrisma();

  try {
    const code = await runBaselineCli({
      argv: ['--until', INIT],
      env: ENV,
      cwd: project,
      introspect,
      runPrisma,
    });

    assert.equal(code, 0);
    assert.equal(introspect.calls.length, 0, 'dry run must not open connections');
    assert.equal(runPrisma.commands.length, 0);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('--yes without --verified is rejected before database preflight', async () => {
  const project = createProject();
  const introspect = fakeIntrospect({
    'postgresql://u:p@localhost/s1': states.pushBuilt,
    'postgresql://u:p@localhost/s2': states.pushBuilt,
  });
  const runPrisma = recordingRunPrisma();

  try {
    const code = await runBaselineCli({
      argv: ['--until', INIT, '--yes'],
      env: ENV,
      cwd: project,
      introspect,
      runPrisma,
    });

    assert.equal(code, 1);
    assert.equal(introspect.calls.length, 0);
    assert.equal(runPrisma.commands.length, 0);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('an unknown cutoff is rejected before anything runs', async () => {
  const project = createProject();
  const runPrisma = recordingRunPrisma();

  try {
    const code = await runBaselineCli({
      argv: ['--until', 'does_not_exist', '--yes', '--verified'],
      env: ENV,
      cwd: project,
      introspect: fakeIntrospect({}),
      runPrisma,
    });

    assert.equal(code, 1);
    assert.equal(runPrisma.commands.length, 0);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('executes only after preflighting every target, and records the cutoff on each', async () => {
  const project = createProject();
  const introspect = fakeIntrospect({
    'postgresql://u:p@localhost/s1': states.pushBuilt,
    'postgresql://u:p@localhost/s2': states.pushBuilt,
  });
  const runPrisma = recordingRunPrisma();

  try {
    const code = await runBaselineCli({
      argv: ['--until', INIT, '--yes', '--verified'],
      env: ENV,
      cwd: project,
      introspect,
      runPrisma,
    });

    assert.equal(code, 0);
    assert.equal(introspect.calls.length, 2, 'both targets are preflighted');
    assert.deepEqual(
      runPrisma.commands.map(({ command, url }) => [command, url]),
      [
        [`migrate resolve --applied ${INIT}`, 'postgresql://u:p@localhost/s1'],
        [`migrate resolve --applied ${INIT}`, 'postgresql://u:p@localhost/s2'],
      ],
      'only the verified cutoff is recorded; the ticket migration stays pending'
    );
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('one unreachable target aborts the run before any history is written anywhere', async () => {
  const project = createProject();
  const introspect = fakeIntrospect({
    'postgresql://u:p@localhost/s1': states.pushBuilt,
    'postgresql://u:p@localhost/s2': states.unreachable,
  });
  const runPrisma = recordingRunPrisma();

  try {
    const code = await runBaselineCli({
      argv: ['--until', INIT, '--yes', '--verified'],
      env: ENV,
      cwd: project,
      introspect,
      runPrisma,
    });

    assert.equal(code, 1);
    assert.equal(introspect.calls.length, 2, 'preflight still inspects every target');
    assert.equal(
      runPrisma.commands.length,
      0,
      'no _prisma_migrations row is written when any target fails preflight'
    );
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('rerunning after a partial baseline is idempotent', async () => {
  const project = createProject();
  const introspect = fakeIntrospect({
    'postgresql://u:p@localhost/s1': states.partiallyRecorded,
    'postgresql://u:p@localhost/s2': states.pushBuilt,
  });
  const runPrisma = recordingRunPrisma();

  try {
    const code = await runBaselineCli({
      argv: ['--until', INIT, '--yes', '--verified'],
      env: ENV,
      cwd: project,
      introspect,
      runPrisma,
    });

    assert.equal(code, 0);
    assert.deepEqual(
      runPrisma.commands.map(({ url }) => url),
      ['postgresql://u:p@localhost/s2'],
      'the already-recorded shard is not written to again'
    );
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('empty databases are skipped so db:update builds them from the full history', async () => {
  const project = createProject();
  const introspect = fakeIntrospect({
    'postgresql://u:p@localhost/s1': states.emptyDatabase,
    'postgresql://u:p@localhost/s2': states.pushBuilt,
  });
  const runPrisma = recordingRunPrisma();

  try {
    const code = await runBaselineCli({
      argv: ['--until', INIT, '--yes', '--verified'],
      env: ENV,
      cwd: project,
      introspect,
      runPrisma,
    });

    assert.equal(code, 0);
    assert.deepEqual(runPrisma.commands.map(({ url }) => url), [
      'postgresql://u:p@localhost/s2',
    ]);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('an empty schema with an unfinished migration blocks baseline writes everywhere', async () => {
  const project = createProject();
  const introspect = fakeIntrospect({
    'postgresql://u:p@localhost/s1': states.failedOnEmptySchema,
    'postgresql://u:p@localhost/s2': states.pushBuilt,
  });
  const runPrisma = recordingRunPrisma();

  try {
    const code = await runBaselineCli({
      argv: ['--until', INIT, '--yes', '--verified'],
      env: ENV,
      cwd: project,
      introspect,
      runPrisma,
    });

    assert.equal(code, 1);
    assert.equal(runPrisma.commands.length, 0);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('a resolve failure stops the run and reports a safe retry', async () => {
  const project = createProject();
  const introspect = fakeIntrospect({
    'postgresql://u:p@localhost/s1': states.pushBuilt,
    'postgresql://u:p@localhost/s2': states.pushBuilt,
  });
  const runPrisma = recordingRunPrisma({
    failWhen: (command, url) => url.endsWith('/s1'),
  });

  try {
    const code = await runBaselineCli({
      argv: ['--until', INIT, '--yes', '--verified'],
      env: ENV,
      cwd: project,
      introspect,
      runPrisma,
    });

    assert.equal(code, 1);
    assert.equal(runPrisma.commands.length, 1, 'no further writes after the failure');
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});
