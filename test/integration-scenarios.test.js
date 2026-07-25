/**
 * Real-PostgreSQL scenario matrix for the update pipeline. Opt-in locally, and
 * mandatory in CI (the workflow provides PS_INTEGRATION_DATABASE_URL and a
 * postgres service).
 *
 * Scenarios: empty database, invalid migration SQL surfaced with the exact
 * migration name, incomplete migration blocking, rolled-back redeployment,
 * second-shard failure with safe retry, edited-migration checksum mismatch,
 * equivalent-drift warning vs strict mode, and 20-shard compact logging with
 * consecutive idempotent runs.
 */
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const BASE_URL = process.env.PS_INTEGRATION_DATABASE_URL;
const skip = BASE_URL
  ? false
  : 'set PS_INTEGRATION_DATABASE_URL to a scratch PostgreSQL database to run';

const DIST_CLI_DIRECTORY = path.resolve(__dirname, '../dist/cli');
const REPO_ROOT = path.resolve(__dirname, '..');
const SHARD_FLEET_SIZE = parseInt(process.env.PS_IT_SHARDS || '20', 10);

const SCHEMA_PRISMA = `
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Item {
  id   String @id
  name String
}
`;

const PRISMA_CONFIG = `
import { defineConfig } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env['DATABASE_URL'] },
})
`;

const INIT = '20260101000000_init';
const INIT_SQL = `
CREATE TABLE "Item" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Item_pkey" PRIMARY KEY ("id")
);
`;

const withSchemaParam = (url, schemaName) => {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', schemaName);
  return parsed.toString();
};

const makeProject = (migrations, config) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-sharding-its-'));
  for (const [name, sql] of Object.entries(migrations)) {
    const dir = path.join(project, 'prisma', 'migrations', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'migration.sql'), sql);
  }
  fs.writeFileSync(path.join(project, 'prisma', 'schema.prisma'), SCHEMA_PRISMA);
  fs.writeFileSync(path.join(project, 'prisma.config.ts'), PRISMA_CONFIG);
  if (config) {
    fs.writeFileSync(
      path.join(project, 'prisma-sharding.config.json'),
      JSON.stringify(config)
    );
  }
  fs.symlinkSync(
    path.join(REPO_ROOT, 'node_modules'),
    path.join(project, 'node_modules'),
    'junction'
  );
  return project;
};

const spawnCollect = (command, args, options) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });

const pathWithRepoBin = () =>
  `${path.join(REPO_ROOT, 'node_modules', '.bin')}${path.delimiter}${process.env.PATH || ''}`;

const runUpdate = (project, shardUrls, extraEnv = {}) => {
  const env = {
    ...process.env,
    PATH: pathWithRepoBin(),
    DATABASE_URL: '',
    SHARD_COUNT: String(shardUrls.length),
    ...Object.fromEntries(shardUrls.map((url, i) => [`SHARD_${i + 1}_URL`, url])),
    ...extraEnv,
  };
  return spawnCollect(
    process.execPath,
    [path.join(DIST_CLI_DIRECTORY, 'migrate.js')],
    { cwd: project, env }
  );
};

const runPrismaDirect = (project, url, args) =>
  spawnCollect(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['prisma', ...args],
    {
      cwd: project,
      env: { ...process.env, PATH: pathWithRepoBin(), DATABASE_URL: url },
    }
  );

const withSchemas = async (count, fn) => {
  const { Client } = require('pg');
  const admin = new Client({ connectionString: BASE_URL });
  await admin.connect();
  const names = Array.from(
    { length: count },
    (_, i) => `ps_its_${Date.now()}_${Math.floor(Math.random() * 1e6)}_${i}`
  );
  try {
    for (const name of names) {
      await admin.query(`CREATE SCHEMA "${name}"`);
    }
    await fn(admin, names, names.map((name) => withSchemaParam(BASE_URL, name)));
  } finally {
    for (const name of names) {
      await admin.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`).catch(() => undefined);
    }
    await admin.end().catch(() => undefined);
  }
};

test('an empty database receives every migration and reports success', { skip }, async () => {
  const project = makeProject({ [INIT]: INIT_SQL });
  try {
    await withSchemas(1, async (admin, [schemaName], [url]) => {
      const run = await runUpdate(project, [url]);
      assert.equal(run.code, 0, run.stdout + run.stderr);
      assert.match(run.stdout, /1 migration applied/);
      assert.match(run.stdout, /Complete/);

      const table = await admin.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'Item'`,
        [schemaName]
      );
      assert.equal(table.rowCount, 1);
    });
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('invalid migration SQL fails with the exact migration name, then recovers via rolled-back', { skip }, async () => {
  const BAD = '20260102000000_bad';
  const project = makeProject({
    [INIT]: INIT_SQL,
    [BAD]: 'ALTER TABLE "Item" ADD COLUMN "broken" SOMETYPE_THAT_DOES_NOT_EXIST;\n',
  });
  try {
    await withSchemas(1, async (admin, [schemaName], [url]) => {
      // 1. The bad migration fails; the good one before it is applied.
      const failed = await runUpdate(project, [url]);
      assert.equal(failed.code, 1);
      assert.match(failed.stdout, new RegExp(`${BAD} failed`));
      assert.match(failed.stdout, /No database was reset\./);
      assert.match(failed.stdout, /rerun: yarn db:update/);

      const table = await admin.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'Item'`,
        [schemaName]
      );
      assert.equal(table.rowCount, 1, 'the applied init migration is preserved');

      // 2. The incomplete migration blocks the next run instead of being retried blindly.
      const blocked = await runUpdate(project, [url]);
      assert.equal(blocked.code, 1);
      assert.match(blocked.stdout, /never finished/);

      // 3. Fix the SQL, mark the failed attempt rolled back, rerun: it redeploys.
      fs.writeFileSync(
        path.join(project, 'prisma', 'migrations', BAD, 'migration.sql'),
        'ALTER TABLE "Item" ADD COLUMN "fixed" TEXT;\n'
      );
      const resolved = await runPrismaDirect(project, url, [
        'migrate',
        'resolve',
        '--rolled-back',
        BAD,
      ]);
      assert.equal(resolved.code, 0, resolved.stdout + resolved.stderr);

      const recovered = await runUpdate(project, [url]);
      assert.equal(recovered.code, 0, recovered.stdout + recovered.stderr);
      assert.match(recovered.stdout, /1 migration applied/);

      const column = await admin.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'Item' AND column_name = 'fixed'`,
        [schemaName]
      );
      assert.equal(column.rowCount, 1, 'the rolled-back migration was re-applied for real');
    });
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('a second-shard failure preserves completed shards and retries cleanly', { skip }, async () => {
  const UNIQUE = '20260103000000_unique_names';
  const project = makeProject({ [INIT]: INIT_SQL });
  try {
    await withSchemas(3, async (admin, schemaNames, urls) => {
      // Establish migration history everywhere, then poison shard_2 with data
      // that the next migration cannot accept.
      const first = await runUpdate(project, urls);
      assert.equal(first.code, 0, first.stdout + first.stderr);

      await admin.query(
        `INSERT INTO "${schemaNames[1]}"."Item" ("id", "name") VALUES ('a', 'dup'), ('b', 'dup')`
      );

      const uniqueDir = path.join(project, 'prisma', 'migrations', UNIQUE);
      fs.mkdirSync(uniqueDir, { recursive: true });
      fs.writeFileSync(
        path.join(uniqueDir, 'migration.sql'),
        'CREATE UNIQUE INDEX "Item_name_key" ON "Item"("name");\n'
      );

      const partial = await runUpdate(project, urls);
      assert.equal(partial.code, 1);
      assert.match(partial.stdout, /✅ shard_1 {2}1 migration applied/);
      assert.match(partial.stdout, new RegExp(`❌ shard_2 {2}${UNIQUE} failed`));
      assert.match(partial.stdout, /⏭️ shard_3 {2}Not attempted/);

      const rows = await admin.query(
        `SELECT COUNT(*)::int AS count FROM "${schemaNames[1]}"."Item"`
      );
      assert.equal(rows.rows[0].count, 2, 'failed shard data is untouched');

      // Fix the data, mark the failed attempt rolled back, rerun the same command.
      await admin.query(`DELETE FROM "${schemaNames[1]}"."Item" WHERE "id" = 'b'`);
      const resolved = await runPrismaDirect(project, urls[1], [
        'migrate',
        'resolve',
        '--rolled-back',
        UNIQUE,
      ]);
      assert.equal(resolved.code, 0, resolved.stdout + resolved.stderr);

      const retried = await runUpdate(project, urls);
      assert.equal(retried.code, 0, retried.stdout + retried.stderr);
      assert.match(retried.stdout, /✅ shard_1 {2}Already up to date/);
      assert.match(retried.stdout, /✅ shard_2 {2}1 migration applied/);
      assert.match(retried.stdout, /✅ shard_3 {2}1 migration applied/);
      assert.match(retried.stdout, /Complete/);
    });
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('editing an applied migration is caught by checksum validation', { skip }, async () => {
  const project = makeProject({ [INIT]: INIT_SQL });
  const migrationFile = path.join(project, 'prisma', 'migrations', INIT, 'migration.sql');
  try {
    await withSchemas(1, async (admin, _names, [url]) => {
      const first = await runUpdate(project, [url]);
      assert.equal(first.code, 0, first.stdout + first.stderr);

      fs.writeFileSync(migrationFile, `${INIT_SQL}\n-- edited after being applied\n`);
      const blocked = await runUpdate(project, [url]);
      assert.equal(blocked.code, 1);
      assert.match(blocked.stdout, /differ/);
      assert.match(blocked.stdout, /No database was modified\./);

      fs.writeFileSync(migrationFile, INIT_SQL);
      const restored = await runUpdate(project, [url]);
      assert.equal(restored.code, 0, restored.stdout + restored.stderr);
      assert.match(restored.stdout, /Already up to date/);
    });
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('equivalent or manual drift warns without blocking, and strict mode enforces it', { skip }, async () => {
  const project = makeProject({ [INIT]: INIT_SQL });
  try {
    await withSchemas(1, async (admin, [schemaName], [url]) => {
      const first = await runUpdate(project, [url]);
      assert.equal(first.code, 0, first.stdout + first.stderr);

      await admin.query(
        `CREATE INDEX "Item_extra_idx" ON "${schemaName}"."Item" ("name")`
      );

      const relaxed = await runUpdate(project, [url]);
      assert.equal(relaxed.code, 0, 'drift must not block routine startup');
      assert.match(relaxed.stdout, /Already up to date/);
      assert.match(relaxed.stdout, /drift/);
      assert.match(relaxed.stdout, /Complete/);

      const strict = await runUpdate(project, [url], { SHARD_STRICT_DRIFT: 'true' });
      assert.equal(strict.code, 1, 'strict mode turns drift into a failure');
    });
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test(`a ${SHARD_FLEET_SIZE}-shard fleet logs one line per shard and reruns idempotently`, { skip }, async () => {
  const project = makeProject({ [INIT]: INIT_SQL });
  try {
    await withSchemas(SHARD_FLEET_SIZE, async (_admin, _names, urls) => {
      const first = await runUpdate(project, urls);
      assert.equal(first.code, 0, first.stdout + first.stderr);
      const appliedLines = first.stdout
        .split('\n')
        .filter((line) => line.includes('1 migration applied'));
      assert.equal(appliedLines.length, SHARD_FLEET_SIZE, 'exactly one line per shard');
      assert.equal(first.stdout.split('\n').filter((l) => l.includes('Complete')).length, 1);

      const second = await runUpdate(project, urls);
      assert.equal(second.code, 0, second.stdout + second.stderr);
      const upToDateLines = second.stdout
        .split('\n')
        .filter((line) => line.includes('Already up to date'));
      assert.equal(upToDateLines.length, SHARD_FLEET_SIZE);
      assert.match(second.stdout, /Complete/);
    });
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});
