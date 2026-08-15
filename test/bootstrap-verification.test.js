const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { runBootstrapVerificationCli } = require(
  path.resolve(__dirname, '../dist/cli/utils/bootstrap-verify-core.js')
);

const VALIDATION_URL = 'postgresql://verify:secret@validator:5433/disposable';

const createProject = (sql = 'CREATE TABLE "Item" ("id" TEXT PRIMARY KEY);\n') => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-sharding-verify-'));
  const migration = '20260101000000_init';
  const migrationDirectory = path.join(project, 'prisma', 'migrations', migration);
  fs.mkdirSync(migrationDirectory, { recursive: true });
  fs.writeFileSync(path.join(migrationDirectory, 'migration.sql'), sql);
  fs.writeFileSync(
    path.join(project, 'prisma', 'schema.prisma'),
    'datasource db { provider = "postgresql" }\nmodel Item { id String @id }\n'
  );
  return project;
};

const emptyDatabase = {
  reachable: true,
  empty: true,
  hasMigrationsTable: false,
  databaseMissing: false,
  userTableCount: 0,
  userObjectCount: 0,
  applied: [],
};

const recordPrisma = ({ deployFails = false, drift = false } = {}) => {
  const commands = [];
  const fn = async (args, options = {}) => {
    commands.push({ command: args.join(' '), url: options.env?.DATABASE_URL });
    if (args.join(' ') === 'migrate deploy' && deployFails) {
      return { success: false, exitCode: 1, stdout: '', stderr: '', error: 'P3018 delta failed' };
    }
    if (args[0] === 'migrate' && args[1] === 'diff' && drift) {
      return { success: false, exitCode: 2, stdout: '', stderr: '' };
    }
    return { success: true, exitCode: 0, stdout: '', stderr: '' };
  };
  fn.commands = commands;
  return fn;
};

test('verification requires explicit disposable-environment acknowledgement', async () => {
  const project = createProject();
  const runPrisma = recordPrisma();
  try {
    const code = await runBootstrapVerificationCli({
      argv: [],
      cwd: project,
      env: { PRISMA_SHARDING_BOOTSTRAP_DATABASE_URL: VALIDATION_URL },
      introspect: async () => emptyDatabase,
      runPrisma,
    });
    assert.equal(code, 1);
    assert.equal(runPrisma.commands.length, 0);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('verification refuses a PostgreSQL server shared with a runtime target', async () => {
  const project = createProject();
  const runPrisma = recordPrisma();
  try {
    const code = await runBootstrapVerificationCli({
      argv: ['--yes', '--disposable'],
      cwd: project,
      env: {
        PRISMA_SHARDING_BOOTSTRAP_DATABASE_URL: VALIDATION_URL,
        SHARD_COUNT: '1',
        SHARD_1_URL: 'postgresql://app:secret@validator:5433/production',
      },
      introspect: async () => emptyDatabase,
      runPrisma,
    });
    assert.equal(code, 1);
    assert.equal(runPrisma.commands.length, 0);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('a delta-only chain cannot produce a verified bootstrap contract', async () => {
  const project = createProject('ALTER TABLE "Item" ADD COLUMN "name" TEXT;\n');
  const runPrisma = recordPrisma({ deployFails: true });
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => lines.push(args.map(String).join(' '));
  try {
    const code = await runBootstrapVerificationCli({
      argv: ['--yes', '--disposable'],
      cwd: project,
      env: { PRISMA_SHARDING_BOOTSTRAP_DATABASE_URL: VALIDATION_URL },
      introspect: async () => emptyDatabase,
      runPrisma,
    });
    assert.equal(code, 1);
    assert.equal(runPrisma.commands[0].command, 'migrate deploy');
    assert.doesNotMatch(lines.join('\n'), /"verified": true/);
  } finally {
    console.log = originalLog;
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('successful isolated verification emits migration and datamodel fingerprints', async () => {
  const project = createProject();
  const runPrisma = recordPrisma();
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => lines.push(args.map(String).join(' '));
  try {
    const code = await runBootstrapVerificationCli({
      argv: ['--yes', '--disposable'],
      cwd: project,
      env: { PRISMA_SHARDING_BOOTSTRAP_DATABASE_URL: VALIDATION_URL },
      introspect: async () => emptyDatabase,
      runPrisma,
    });
    assert.equal(code, 0);
    assert.deepEqual(
      runPrisma.commands.map(({ command, url }) => [command.startsWith('migrate diff') ? 'migrate diff' : command, url]),
      [
        ['migrate deploy', VALIDATION_URL],
        ['migrate diff', VALIDATION_URL],
      ]
    );
    const output = lines.join('\n');
    assert.match(output, /"initialMigration": "20260101000000_init"/);
    assert.match(output, /"historyDigest": "[a-f0-9]{64}"/);
    assert.match(output, /"schemaDigest": "[a-f0-9]{64}"/);
    assert.match(output, /"verified": true/);
  } finally {
    console.log = originalLog;
    fs.rmSync(project, { recursive: true, force: true });
  }
});
