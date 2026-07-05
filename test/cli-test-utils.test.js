const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { parsePostgresUrl, postgresEndpoint } = require(
  path.resolve(__dirname, '../dist/cli/utils/postgres.js')
);
const { runCommand } = require(path.resolve(__dirname, '../dist/cli/utils/command.js'));

test('internal command runner terminates commands that exceed their deadline', async () => {
  const startedAt = Date.now();
  const result = await runCommand(
    process.execPath,
    [
      '-e',
      [
        "process.on('SIGTERM', () => process.stderr.write('SIGTERM received\\n'));",
        "process.stdout.write('x'.repeat(100000));",
        'setInterval(() => undefined, 1000);',
      ].join(''),
    ],
    { timeoutMs: 250, forceKillGraceMs: 100, maxOutputLength: 1024 }
  );

  assert.equal(result.success, false);
  assert.equal(result.exitCode, null);
  assert.match(result.error, /timed out after 250ms/);
  assert.ok(result.stdout.length <= 1024);
  assert.match(result.stdout, /\[output truncated\]/);
  if (process.platform !== 'win32') {
    assert.match(result.stderr, /SIGTERM received/);
    assert.ok(Date.now() - startedAt >= 330);
  }
  assert.ok(Date.now() - startedAt < 1000);
});

test('PostgreSQL URL parsing handles defaults, encoded credentials, IPv6, and query params', () => {
  assert.deepEqual(
    parsePostgresUrl('postgresql://user:p%40ss@localhost/example?schema=app'),
    {
      host: 'localhost',
      port: 5432,
      database: 'example',
      socketPath: undefined,
    }
  );
  assert.deepEqual(parsePostgresUrl('postgres://user:pass@[::1]:6432/db%20name'), {
    host: '::1',
    port: 6432,
    database: 'db name',
    socketPath: undefined,
  });
});

test('PostgreSQL URL parsing recognizes Unix socket hosts without exposing credentials', () => {
  const parsed = parsePostgresUrl(
    'postgresql://private:super-secret@localhost/database?host=%2Fvar%2Frun%2Fpostgresql'
  );

  assert.deepEqual(parsed, {
    host: 'localhost',
    port: 5432,
    database: 'database',
    socketPath: '/var/run/postgresql',
  });
  assert.equal(postgresEndpoint(parsed), '/var/run/postgresql');
  assert.doesNotMatch(JSON.stringify(parsed), /private|super-secret/);
});

test('PostgreSQL URL parsing rejects unsupported or incomplete URLs', () => {
  assert.equal(parsePostgresUrl('mysql://user:pass@localhost/db'), null);
  assert.equal(parsePostgresUrl('postgresql://user:pass@localhost'), null);
  assert.equal(parsePostgresUrl('not a url'), null);
});
