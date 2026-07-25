/**
 * Real-PostgreSQL integration test for the legacy-adoption workflow:
 *
 *   db-push-built database with populated tables and no _prisma_migrations
 *   → verified baseline → migrate deploy of a required-column backfill migration
 *   → data preserved and backfilled → second run reports up to date.
 *
 * Opt-in: set PS_INTEGRATION_DATABASE_URL to a *scratch* PostgreSQL database URL
 * (for example postgresql://postgres:postgres@localhost:5432/prisma_sharding_it).
 * The test creates and drops its own uniquely-named schema inside that database;
 * it never touches other schemas. Requires the `prisma` devDependency
 * (yarn install) so the real Prisma CLI is used.
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

const INIT = '20260101000000_init';
const TICKET = '20260724000200_task_ticket_number';

const INIT_SQL = `
CREATE TABLE "PmProject" (
    "id" TEXT NOT NULL,
    "nextTaskNumber" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "PmProject_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PmpTask" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PmpTask_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PmpTask" ADD CONSTRAINT "PmpTask_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "PmProject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
`;

const TICKET_SQL = `
-- Required column on a populated table: nullable first, backfill, then NOT NULL.
ALTER TABLE "PmpTask" ADD COLUMN "ticketNumber" INTEGER;

WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY "projectId" ORDER BY "createdAt" ASC, id ASC
  ) AS rn
  FROM "PmpTask"
)
UPDATE "PmpTask" AS t
SET "ticketNumber" = ordered.rn
FROM ordered
WHERE t.id = ordered.id;

UPDATE "PmProject" AS p
SET "nextTaskNumber" = GREATEST(p."nextTaskNumber", COALESCE(src.next_number, 1))
FROM (
  SELECT "projectId", MAX("ticketNumber") + 1 AS next_number
  FROM "PmpTask"
  GROUP BY "projectId"
) AS src
WHERE p.id = src."projectId";

ALTER TABLE "PmpTask" ALTER COLUMN "ticketNumber" SET NOT NULL;

CREATE UNIQUE INDEX "PmpTask_projectId_ticketNumber_key" ON "PmpTask"("projectId", "ticketNumber");
`;

const SCHEMA_PRISMA = `
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model PmProject {
  id             String    @id
  nextTaskNumber Int       @default(1)
  tasks          PmpTask[]
}

model PmpTask {
  id           String    @id
  projectId    String
  createdAt    DateTime  @default(now())
  ticketNumber Int
  project      PmProject @relation(fields: [projectId], references: [id])

  @@unique([projectId, ticketNumber])
}
`;

const PRISMA_CONFIG = `
import { defineConfig } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env['DATABASE_URL'],
  },
})
`;

const withSchemaParam = (url, schemaName) => {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', schemaName);
  return parsed.toString();
};

const runCli = (cliName, env, args, cwd) =>
  new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(DIST_CLI_DIRECTORY, cliName), ...args],
      {
        cwd,
        env: {
          ...process.env,
          PATH: `${path.join(REPO_ROOT, 'node_modules', '.bin')}${path.delimiter}${
            process.env.PATH || ''
          }`,
          ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });

test('legacy db-push shard adopts migrations, keeps data, backfills tickets, and reruns idempotently', { skip }, async () => {
  const { Client } = require('pg');
  const schemaName = `ps_it_${Date.now()}`;
  const shardUrl = withSchemaParam(BASE_URL, schemaName);

  // Project fixture with the committed migrations and Prisma 7 config.
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-sharding-it-'));
  fs.mkdirSync(path.join(project, 'prisma', 'migrations', INIT), { recursive: true });
  fs.mkdirSync(path.join(project, 'prisma', 'migrations', TICKET), { recursive: true });
  fs.writeFileSync(path.join(project, 'prisma', 'migrations', INIT, 'migration.sql'), INIT_SQL);
  fs.writeFileSync(path.join(project, 'prisma', 'migrations', TICKET, 'migration.sql'), TICKET_SQL);
  fs.writeFileSync(path.join(project, 'prisma', 'schema.prisma'), SCHEMA_PRISMA);
  fs.writeFileSync(path.join(project, 'prisma.config.ts'), PRISMA_CONFIG);
  // Let the Prisma CLI resolve `prisma/config` and its engines from the repo.
  fs.symlinkSync(
    path.join(REPO_ROOT, 'node_modules'),
    path.join(project, 'node_modules'),
    'junction'
  );

  const admin = new Client({ connectionString: BASE_URL });
  await admin.connect();

  const cliEnv = {
    SHARD_COUNT: '1',
    SHARD_1_URL: shardUrl,
    DATABASE_URL: '',
  };

  try {
    // 1. Simulate the legacy state: schema built by `db push` (no migration
    //    history) and populated with 43 tasks across 3 projects.
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    await admin.query(`SET search_path TO "${schemaName}"`);
    await admin.query(INIT_SQL);

    const projects = [
      ['p1', 15],
      ['p2', 20],
      ['p3', 8],
    ];
    for (const [projectId, taskCount] of projects) {
      await admin.query(`INSERT INTO "PmProject" ("id") VALUES ($1)`, [projectId]);
      for (let i = 0; i < taskCount; i++) {
        await admin.query(
          `INSERT INTO "PmpTask" ("id", "projectId", "createdAt")
           VALUES ($1, $2, NOW() + ($3 || ' seconds')::interval)`,
          [`${projectId}-t${String(i).padStart(2, '0')}`, projectId, String(i)]
        );
      }
    }

    // 2. The update pipeline must refuse to touch it (no history, no verified
    //    baseline configured) with one concise message and must not push.
    //    migrate.js is the same shared pipeline as db:update minus
    //    `prisma generate` (the fixture schema has no generator block).
    const refused = await runCli('migrate.js', cliEnv, [], project);
    assert.equal(refused.code, 1);
    assert.match(refused.stdout, /Legacy database detected/);
    assert.match(refused.stdout, /No database was modified\./);

    const before = await admin.query(`SELECT COUNT(*)::int AS count FROM "PmpTask"`);
    assert.equal(before.rows[0].count, 43, 'the refused run must not modify data');

    // 3. Declare the verified baseline in source-controlled config; ONE command
    //    then adopts the legacy history AND applies the pending ticket
    //    migration in the same run.
    fs.writeFileSync(
      path.join(project, 'prisma-sharding.config.json'),
      JSON.stringify({
        migrations: { legacyBaseline: { until: INIT, verified: true } },
      })
    );

    const updated = await runCli('migrate.js', cliEnv, [], project);
    assert.equal(updated.code, 0, `update failed:\n${updated.stdout}\n${updated.stderr}`);
    assert.match(updated.stdout, /Synced/);
    assert.doesNotMatch(updated.stdout, /Baselined|1 migration applied|Complete/);
    assert.doesNotMatch(updated.stdout, /db push/i);

    // 5. Data preserved and backfilled correctly.
    const after = await admin.query(`SELECT COUNT(*)::int AS count FROM "PmpTask"`);
    assert.equal(after.rows[0].count, 43, 'every existing row survives');

    for (const [projectId, taskCount] of projects) {
      const tickets = await admin.query(
        `SELECT "ticketNumber" FROM "PmpTask" WHERE "projectId" = $1 ORDER BY "ticketNumber"`,
        [projectId]
      );
      assert.deepEqual(
        tickets.rows.map((row) => row.ticketNumber),
        Array.from({ length: taskCount }, (_, i) => i + 1),
        `${projectId} tickets must be 1..${taskCount}`
      );

      const counter = await admin.query(
        `SELECT "nextTaskNumber" FROM "PmProject" WHERE "id" = $1`,
        [projectId]
      );
      assert.equal(counter.rows[0].nextTaskNumber, taskCount + 1);
    }

    const notNull = await admin.query(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'PmpTask' AND column_name = 'ticketNumber'`,
      [schemaName]
    );
    assert.equal(notNull.rows[0].is_nullable, 'NO');

    const uniqueIndex = await admin.query(
      `SELECT 1 FROM pg_indexes
        WHERE schemaname = $1 AND indexname = 'PmpTask_projectId_ticketNumber_key'`,
      [schemaName]
    );
    assert.equal(uniqueIndex.rowCount, 1);

    // 6. Rerunning is idempotent: nothing deployed, one concise line per shard.
    const rerun = await runCli('migrate.js', cliEnv, [], project);
    assert.equal(rerun.code, 0, `rerun failed:\n${rerun.stdout}\n${rerun.stderr}`);
    assert.match(rerun.stdout, /Synced/);
    assert.doesNotMatch(rerun.stdout, /Already up to date|Complete/);
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch(() => undefined);
    await admin.end().catch(() => undefined);
    fs.rmSync(project, { recursive: true, force: true });
  }
});
