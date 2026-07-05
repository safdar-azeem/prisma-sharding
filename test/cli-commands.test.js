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
    if (key.startsWith('SHARD_') || key === 'DATABASE_URL') {
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

const runCli = (cliName, env, args = []) => {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(DIST_CLI_DIRECTORY, cliName), ...args], {
      env: createTestEnv(env),
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
    "const shouldFail = process.env.DATABASE_URL?.includes('/fail') || (process.env.FAKE_NPX_STATUS_FAIL === 'true' && process.argv.includes('status'));",
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

test('update output is compact by default', async () => {
  const fakeBin = createFakeNpx();

  try {
    const result = await runCli('update.js', {
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
    });

    assert.equal(result.code, 0);
    assert.equal(
      result.stdout,
      [
        '🔄 Prisma Sharding Update',
        '',
        '✅ client  Generated',
        '✅ shard_1  Synced',
        '✅ shard_2  Synced',
        '',
      ].join('\n')
    );
    assert.equal(result.stderr, '');
    assert.doesNotMatch(result.stdout, /NOISY|Loaded Prisma config|Datasource/);
  } finally {
    fs.rmSync(fakeBin, { recursive: true, force: true });
  }
});

test('update keeps partial failures compact and exits non-zero', async () => {
  const fakeBin = createFakeNpx();

  try {
    const result = await runCli('update.js', {
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
      SHARD_2_URL: 'postgresql://user:secret@localhost/fail',
    });

    assert.equal(result.code, 1);
    assert.match(result.stdout, /✅ shard_1  Synced/);
    assert.match(result.stdout, /❌ shard_2  Failed/);
    assert.match(result.stdout, /SHARD_CLI_VERBOSE=true/);
    assert.doesNotMatch(result.stdout, /NOISY/);
    assert.equal(result.stderr, '');
  } finally {
    fs.rmSync(fakeBin, { recursive: true, force: true });
  }
});

test('verbose update streams Prisma output and masks database passwords', async () => {
  const fakeBin = createFakeNpx();

  try {
    const result = await runCli('update.js', {
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
      SHARD_COUNT: '1',
      SHARD_CLI_VERBOSE: ' true ',
      FAKE_NPX_ECHO_SECRETS: 'true',
    });

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
  }
});

test('migrate uses the same compact shard format without generating the client', async () => {
  const fakeBin = createFakeNpx();
  const commandLog = path.join(fakeBin, 'commands.log');

  try {
    const result = await runCli('migrate.js', {
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
      SHARD_COUNT: '1',
      FAKE_NPX_LOG: commandLog,
    });

    assert.equal(result.code, 0);
    assert.equal(
      result.stdout,
      [
        '🔄 Prisma Sharding Migrate',
        '',
        '✅ shard_1  Synced',
        '',
      ].join('\n')
    );
    assert.doesNotMatch(result.stdout, /client|NOISY/);
    assert.equal(result.stderr, '');
    const commands = fs.readFileSync(commandLog, 'utf8');
    assert.match(commands, /prisma migrate status/);
    assert.match(commands, /prisma migrate deploy/);
    assert.doesNotMatch(commands, /db push|accept-data-loss/);
  } finally {
    fs.rmSync(fakeBin, { recursive: true, force: true });
  }
});

test('update preserves force-reset and never injects accept-data-loss', async () => {
  const fakeBin = createFakeNpx();
  const commandLog = path.join(fakeBin, 'commands.log');

  try {
    const env = {
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
      SHARD_COUNT: '1',
      FAKE_NPX_LOG: commandLog,
    };
    const defaultResult = await runCli('update.js', env);
    assert.equal(defaultResult.code, 0);
    assert.doesNotMatch(fs.readFileSync(commandLog, 'utf8'), /accept-data-loss/);

    fs.writeFileSync(commandLog, '');
    const explicitResult = await runCli('update.js', env, ['--force-reset']);
    assert.equal(explicitResult.code, 0);
    const explicitCommands = fs.readFileSync(commandLog, 'utf8');
    assert.match(explicitCommands, /db push --force-reset/);
    assert.doesNotMatch(explicitCommands, /accept-data-loss/);
  } finally {
    fs.rmSync(fakeBin, { recursive: true, force: true });
  }
});

for (const cliName of ['update.js', 'migrate.js']) {
  test(`${cliName} fails compactly when a declared shard URL is missing`, async () => {
    const result = await runCli(cliName, {
      SHARD_COUNT: '2',
      SHARD_2_URL: undefined,
    });

    assert.equal(result.code, 1);
    assert.match(result.stdout, /❌ config  Missing shard URLs: shard_2/);
    assert.doesNotMatch(result.stdout, /Generated|Synced/);
    assert.equal(result.stderr, '');
  });
}

test('migrate exposes a failed shard in compact output and exits non-zero', async () => {
  const fakeBin = createFakeNpx();
  const commandLog = path.join(fakeBin, 'commands.log');

  try {
    const result = await runCli('migrate.js', {
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
      SHARD_2_URL: 'postgresql://user:secret@localhost/fail',
      FAKE_NPX_LOG: commandLog,
    });

    assert.equal(result.code, 1);
    assert.match(result.stdout, /✅ shard_1  Synced/);
    assert.match(result.stdout, /❌ shard_2  Failed/);
    assert.match(result.stdout, /SHARD_CLI_VERBOSE=true/);
    assert.equal(result.stderr, '');
    const commands = fs.readFileSync(commandLog, 'utf8');
    assert.equal(commands.match(/prisma migrate status/g)?.length, 2);
    assert.equal(commands.match(/prisma migrate deploy/g)?.length, 1);
  } finally {
    fs.rmSync(fakeBin, { recursive: true, force: true });
  }
});

test('migrate status failure marks the shard failed and skips deploy', async () => {
  const fakeBin = createFakeNpx();
  const commandLog = path.join(fakeBin, 'commands.log');

  try {
    const result = await runCli('migrate.js', {
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
      SHARD_COUNT: '1',
      FAKE_NPX_LOG: commandLog,
      FAKE_NPX_STATUS_FAIL: 'true',
    });

    assert.equal(result.code, 1);
    assert.match(result.stdout, /❌ shard_1  Failed/);
    const commands = fs.readFileSync(commandLog, 'utf8');
    assert.match(commands, /prisma migrate status/);
    assert.doesNotMatch(commands, /prisma migrate deploy/);
  } finally {
    fs.rmSync(fakeBin, { recursive: true, force: true });
  }
});
