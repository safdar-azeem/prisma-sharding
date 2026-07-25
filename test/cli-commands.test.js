const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const DIST_CLI_DIRECTORY = path.resolve(__dirname, '../dist/cli');

const createTestEnv = (overrides = {}) => {
  const env = { ...process.env };

  for (const key of Object.keys(env)) {
    if (key.startsWith('SHARD_') || key === 'DATABASE_URL' || key === 'NODE_ENV') {
      delete env[key];
    }
  }

  return {
    ...env,
    SHARD_COUNT: '2',
    SHARD_1_URL: 'postgresql://user:secret@localhost/one',
    SHARD_2_URL: 'postgresql://user:secret@localhost/two',
    ...overrides,
  };
};

const runCli = (cliName, env, args = [], cwd = undefined) => {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(DIST_CLI_DIRECTORY, cliName), ...args], {
      env: createTestEnv(env),
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
};

const createFakeNpx = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-sharding-cli-'));
  const executable = path.join(directory, process.platform === 'win32' ? 'npx.cmd' : 'npx');
  const script = [
    process.platform === 'win32' ? '@echo off' : '#!/usr/bin/env node',
    process.platform === 'win32' ? 'node "%~dp0\\fake-npx.js" %*' : '',
  ]
    .filter(Boolean)
    .join('\n');
  const nodeScript = [
    "const fs = require('node:fs');",
    "const isGenerate = process.argv.includes('generate');",
    "console.log(isGenerate ? 'NOISY GENERATE OUTPUT' : 'NOISY PUSH OUTPUT');",
    "console.error('NOISY PRISMA STDERR');",
    "if (process.env.FAKE_NPX_LOG) fs.appendFileSync(process.env.FAKE_NPX_LOG, process.argv.slice(2).join(' ') + '\\n');",
    "if (process.env.FAKE_NPX_ECHO_SECRETS) { console.log(`URL=${process.env.DATABASE_URL}`); console.error('password=secret'); }",
    "const shouldFail = process.env.DATABASE_URL?.includes('/fail');",
    'process.exit(shouldFail ? 1 : 0);',
  ].join('\n');

  if (process.platform === 'win32') {
    fs.writeFileSync(executable, script);
    fs.writeFileSync(path.join(directory, 'fake-npx.js'), nodeScript);
  } else {
    fs.writeFileSync(executable, `${script}\n${nodeScript}\n`, { mode: 0o755 });
  }

  return directory;
};

/** A project directory with no committed migrations (development bootstrap). */
const createEmptyProject = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-sharding-project-'));

/** A project directory with committed migrations, like erp-api. */
const createMigrationsProject = (migrationNames = ['20260101000000_init']) => {
  const directory = createEmptyProject();
  for (const name of migrationNames) {
    const migrationDirectory = path.join(directory, 'prisma', 'migrations', name);
    fs.mkdirSync(migrationDirectory, { recursive: true });
    fs.writeFileSync(path.join(migrationDirectory, 'migration.sql'), '-- test migration\n');
  }
  return directory;
};

const readLog = (logPath) => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '');

test('update refuses --force-reset before touching any database', async () => {
  const fakeBin = createFakeNpx();
  const commandLog = path.join(fakeBin, 'commands.log');
  const project = createMigrationsProject();

  try {
    const result = await runCli(
      'update.js',
      { PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`, FAKE_NPX_LOG: commandLog },
      ['--force-reset'],
      project
    );

    assert.equal(result.code, 1);
    assert.match(result.stdout, /Refusing --force-reset/);
    assert.match(result.stdout, /never resets a database/);
    assert.equal(readLog(commandLog), '');
  } finally {
    fs.rmSync(fakeBin, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('update refuses --accept-data-loss before touching any database', async () => {
  const fakeBin = createFakeNpx();
  const commandLog = path.join(fakeBin, 'commands.log');
  const project = createMigrationsProject();

  try {
    const result = await runCli(
      'update.js',
      { PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`, FAKE_NPX_LOG: commandLog },
      ['--accept-data-loss'],
      project
    );

    assert.equal(result.code, 1);
    assert.match(result.stdout, /Refusing --accept-data-loss/);
    assert.equal(readLog(commandLog), '');
  } finally {
    fs.rmSync(fakeBin, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('update never defaults to db push when committed migrations exist', async () => {
  const fakeBin = createFakeNpx();
  const commandLog = path.join(fakeBin, 'commands.log');
  const project = createMigrationsProject(['20260724000200_pmp_task_ticket_number']);

  try {
    // Unreachable shard ports: the run must stop at preflight, before any
    // migrate deploy, and must never fall back to db push.
    const result = await runCli(
      'update.js',
      {
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
        FAKE_NPX_LOG: commandLog,
        SHARD_1_URL: 'postgresql://user:secret@127.0.0.1:1/one',
        SHARD_2_URL: 'postgresql://user:secret@127.0.0.1:1/two',
      },
      [],
      project
    );

    assert.equal(result.code, 1);
    assert.match(result.stdout, /✅ client {2}Generated/);
    assert.match(result.stdout, /❌ shard_1 {2}Not reachable/);
    assert.match(result.stdout, /No database was modified\./);
    const commands = readLog(commandLog);
    assert.match(commands, /generate/);
    assert.doesNotMatch(commands, /db push/);
    assert.doesNotMatch(commands, /migrate deploy/);
    assert.doesNotMatch(commands, /force-reset|accept-data-loss/);
  } finally {
    fs.rmSync(fakeBin, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('update uses the development push fallback only when no migrations exist', async () => {
  const fakeBin = createFakeNpx();
  const commandLog = path.join(fakeBin, 'commands.log');
  const project = createEmptyProject();

  try {
    const result = await runCli(
      'update.js',
      { PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`, FAKE_NPX_LOG: commandLog },
      [],
      project
    );

    assert.equal(result.code, 0);
    assert.match(result.stdout, /✅ client {2}Generated/);
    assert.match(result.stdout, /✅ shard_1 {2}Synced/);
    assert.match(result.stdout, /✅ shard_2 {2}Synced/);
    assert.doesNotMatch(result.stdout, /development only|Schema synchronised/);
    assert.doesNotMatch(result.stdout, /NOISY/);
    const commands = readLog(commandLog);
    assert.match(commands, /generate/);
    assert.match(commands, /db push/);
    assert.doesNotMatch(commands, /migrate deploy/);
    assert.doesNotMatch(commands, /force-reset|accept-data-loss/);
  } finally {
    fs.rmSync(fakeBin, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('update refuses the push fallback in production', async () => {
  const fakeBin = createFakeNpx();
  const commandLog = path.join(fakeBin, 'commands.log');
  const project = createEmptyProject();

  try {
    const result = await runCli(
      'update.js',
      {
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
        FAKE_NPX_LOG: commandLog,
        NODE_ENV: 'production',
      },
      [],
      project
    );

    assert.equal(result.code, 1);
    assert.match(result.stdout, /NODE_ENV=production/);
    assert.doesNotMatch(readLog(commandLog), /db push/);
  } finally {
    fs.rmSync(fakeBin, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('update push fallback keeps partial failures compact and exits non-zero', async () => {
  const fakeBin = createFakeNpx();
  const project = createEmptyProject();

  try {
    const result = await runCli(
      'update.js',
      {
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
        SHARD_1_URL: 'postgresql://user:secret@localhost/fail',
      },
      [],
      project
    );

    assert.equal(result.code, 1);
    assert.match(result.stdout, /❌ shard_1 {2}Failed/);
    assert.match(result.stdout, /shard_2/);
    assert.match(result.stdout, /SHARD_CLI_VERBOSE=true/);
    assert.doesNotMatch(result.stdout, /NOISY/);
  } finally {
    fs.rmSync(fakeBin, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('verbose update streams Prisma output and masks database passwords', async () => {
  const fakeBin = createFakeNpx();
  const project = createEmptyProject();

  try {
    const result = await runCli(
      'update.js',
      {
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
        SHARD_COUNT: '1',
        SHARD_CLI_VERBOSE: ' true ',
        FAKE_NPX_ECHO_SECRETS: 'true',
      },
      [],
      project
    );

    assert.equal(result.code, 0);
    assert.match(result.stdout, /NOISY GENERATE OUTPUT/);
    assert.match(result.stdout, /NOISY PUSH OUTPUT/);
    assert.match(result.stdout, /Database: postgresql:\/\/user:\*\*\*@localhost\/one/);
    assert.doesNotMatch(result.stdout, /user:secret/);
    assert.doesNotMatch(result.stdout, /\bsecret\b/);
    assert.match(result.stderr, /NOISY PRISMA STDERR/);
    assert.doesNotMatch(result.stderr, /\bsecret\b/);
  } finally {
    fs.rmSync(fakeBin, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('migrate alias runs the shared pipeline without generating the client', async () => {
  const fakeBin = createFakeNpx();
  const commandLog = path.join(fakeBin, 'commands.log');
  const project = createEmptyProject();

  try {
    const result = await runCli(
      'migrate.js',
      { PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`, FAKE_NPX_LOG: commandLog },
      [],
      project
    );

    assert.equal(result.code, 0);
    assert.doesNotMatch(result.stdout, /Prisma Sharding Migrate/);
    assert.match(result.stdout, /✅ shard_1 {2}Synced/);
    assert.doesNotMatch(result.stdout, /Generated|Schema synchronised/);
    const commands = readLog(commandLog);
    assert.doesNotMatch(commands, /generate/);
    assert.doesNotMatch(commands, /force-reset|accept-data-loss/);
  } finally {
    fs.rmSync(fakeBin, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

for (const cliName of ['update.js', 'migrate.js']) {
  test(`${cliName} fails compactly when a declared shard URL is missing`, async () => {
    const result = await runCli(cliName, {
      SHARD_COUNT: '2',
      SHARD_2_URL: undefined,
    });

    assert.equal(result.code, 1);
    assert.match(result.stdout, /❌ config {2}Missing shard URLs: shard_2/);
    assert.doesNotMatch(result.stdout, /Generated|Synced|synchronised/);
    assert.equal(result.stderr, '');
  });
}

test('explicit push CLI is blocked without the opt-in environment variable', async () => {
  const fakeBin = createFakeNpx();
  const commandLog = path.join(fakeBin, 'commands.log');

  try {
    const result = await runCli('push.js', {
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
      FAKE_NPX_LOG: commandLog,
    });

    assert.equal(result.code, 1);
    assert.match(result.stdout, /bypasses committed migrations/);
    assert.equal(readLog(commandLog), '');
  } finally {
    fs.rmSync(fakeBin, { recursive: true, force: true });
  }
});

test('explicit push CLI refuses to run in production even when opted in', async () => {
  const fakeBin = createFakeNpx();
  const commandLog = path.join(fakeBin, 'commands.log');

  try {
    const result = await runCli('push.js', {
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
      FAKE_NPX_LOG: commandLog,
      SHARD_ALLOW_UNSAFE_PUSH: 'true',
      NODE_ENV: 'production',
    });

    assert.equal(result.code, 1);
    assert.match(result.stdout, /NODE_ENV=production/);
    assert.equal(readLog(commandLog), '');
  } finally {
    fs.rmSync(fakeBin, { recursive: true, force: true });
  }
});

test('baseline prints a reviewable plan and changes nothing without --yes', async () => {
  const project = createMigrationsProject([
    '20260101000000_init',
    '20260102000000_second',
  ]);

  try {
    const result = await runCli(
      'baseline.js',
      {},
      ['--until', '20260101000000_init'],
      project
    );

    assert.equal(result.code, 0);
    assert.match(result.stdout, /applied {3}20260101000000_init/);
    assert.match(result.stdout, /PENDING {3}20260102000000_second/);
    assert.match(result.stdout, /Nothing was changed\. Re-run with --yes to execute\./);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('baseline refuses --yes without --verified before touching any database', async () => {
  const fakeBin = createFakeNpx();
  const commandLog = path.join(fakeBin, 'commands.log');
  const project = createMigrationsProject([
    '20260101000000_init',
    '20260102000000_second',
  ]);

  try {
    const result = await runCli(
      'baseline.js',
      { PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`, FAKE_NPX_LOG: commandLog },
      ['--until', '20260101000000_init', '--yes'],
      project
    );

    assert.equal(result.code, 1);
    assert.match(result.stdout, /Refusing to execute without --verified/);
    assert.match(result.stdout, /--yes --verified/);
    assert.equal(readLog(commandLog), '', 'nothing may be recorded without verification');
  } finally {
    fs.rmSync(fakeBin, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});
