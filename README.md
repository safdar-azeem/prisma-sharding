# Prisma Sharding

Lightweight database sharding library for Prisma with connection pooling, health monitoring, and CLI tools.

## Installation

```bash
yarn add prisma-sharding
# or
npm install prisma-sharding
```

> Don't forget to follow me on [GitHub](https://github.com/safdar-azeem)!

## Step 1: Create Sharding Connection

```typescript
// src/config/prisma.ts

import { PrismaSharding } from 'prisma-sharding';
import { PrismaClient } from '@/generated/prisma';
import { PrismaPg } from '@prisma/adapter-pg';

const sharding = new PrismaSharding<PrismaClient>({
  shards: [
    { id: 'shard_1', url: process.env.SHARD_1_URL! },
    { id: 'shard_2', url: process.env.SHARD_2_URL! },
  ],
  strategy: 'modulo', // 'modulo' | 'consistent-hash'
  createClient: (url) => {
    const adapter = new PrismaPg({ connectionString: url, max: 10 });
    return new PrismaClient({ adapter });
  },
});

await sharding.connect();
```

## API

| Method                       | Description                                    |
| ---------------------------- | ---------------------------------------------- |
| `getShard(key)`              | Deterministic client for a routing key         |
| `getShardById(shardId)`      | Client for a persisted shard owner             |
| `getRandomShard()`           | Random assignment; ownership must be recorded  |
| `findFirst(fn)`              | Bounded exception-path search across shards    |
| `runOnAll(fn)`               | Bounded admin/analytics execution              |
| `getHealth()`                | Health status using the existing output shape  |
| `connect()` / `disconnect()` | Lifecycle methods                              |

## Shard Ownership

Every record needs one authoritative shard owner. Choose one of these patterns and use it
consistently. Cross-shard search is a recovery path, not an ownership strategy.

### Pattern A: Deterministic Ownership

Generate or obtain the routing key before inserting the record, then use the same key for every
future operation:

```typescript
import { sharding } from '@/config/prisma';

const userId = crypto.randomUUID();
const client = sharding.getShard(userId);
const user = await client.user.create({
  data: { id: userId, email: 'user@example.com', username: 'new_user' },
});

const sameUser = await sharding.getShard(userId).user.findUnique({
  where: { id: userId },
});
```

Modulo routing uses the existing `hashString(key) % shardCount` placement. The hash function and
configured shard order are data-placement contracts: changing either can move existing records and
requires an explicit migration or dual-read plan. Consistent hashing also preserves configured
shard IDs and supports custom IDs such as `tenant-east`.

### Pattern B: Assigned Ownership

Random assignment can distribute new records, but the application must persist the assigned shard
ID in a directory table, tenant registry, or equivalent ownership metadata:

```typescript
const { client, shardId } = sharding.getRandomShardWithInfo();
const user = await client.user.create({ data: { email, username } });

await shardDirectory.create({ data: { recordId: user.id, shardId } });

const ownership = await shardDirectory.findUniqueOrThrow({
  where: { recordId: user.id },
});
const sameUser = await sharding
  .getShardById(ownership.shardId)
  .user.findUnique({ where: { id: user.id } });
```

The existing `getRandomShard()` method still returns only a client. Calling it for a write and
later calling `getShard(record.id)` is **not guaranteed to select the same shard**. If you use
`getRandomShard()`, your application needs another reliable way to record which shard was selected.
`weight` affects random assignment only; it never changes deterministic `getShard(key)` placement.

### Find Without Ownership Metadata

`findFirst()` is bounded, timed, health-aware, and returns when the first non-null result arrives.
Even so, one call can create work on multiple databases. Treat it as an exception, recovery, or
administrative path. At high traffic it should not be the normal login, email lookup, user lookup,
or tenant lookup path; maintain shard ownership metadata instead.

```typescript
const { result: user, client } = await sharding.findFirst(async (c) =>
  c.user.findFirst({ where: { email } })
);

if (user && client) {
  // Continue operations on the found shard
  await client.user.update({
    where: { id: user.id },
    data: { lastLogin: new Date() },
  });
}
```

### Run on All Shards

```typescript
// Appropriate for bounded admin or analytics work, not a normal request path.
const counts = await sharding.runOnAll(async (client) => client.user.count());
const totalUsers = counts.reduce((sum, count) => sum + count, 0);

// With detailed results (includes errors)
const results = await sharding.runOnAllWithDetails(async (client, shardId) => {
  return { shardId, count: await client.user.count() };
});
```

### Health Monitoring

`connect()` initializes all clients and starts background warmup for clients that implement
`$connect()`, followed by an initial `SELECT 1` when `$queryRaw` is available. Warmup does not delay
client availability, preserving existing startup behavior. Periodic checks have a deadline, cannot
overlap, and update the existing `ShardHealth` shape. Deterministic routing still returns the
record's owner when it is marked unhealthy; cross-shard work schedules healthy, lower-latency
shards first.

```typescript
// Get health of all shards
const health = sharding.getHealth();
// Returns: [{ shardId, isHealthy, latencyMs, lastChecked, ... }]

// Get specific shard health
const shard1Health = sharding.getHealthByShard('shard_1');
```

### Lifecycle

```typescript
// Graceful shutdown
await sharding.disconnect();

// Check connection status
if (sharding.isConnected()) {
  // ...
}
```

## CLI Tools

The package includes CLI tools for common sharding operations. No need to write custom scripts!

### Setup

One script is all developers need. Add to your `package.json`:

```json
{
  "scripts": {
    "db:update": "prisma-sharding-update",
    "db:studio": "prisma-sharding-studio",
    "test:shards": "prisma-sharding-test"
  }
}
```

`yarn db:update` handles the complete database update: it validates the configuration,
generates the Prisma Client once, and applies committed migrations to the primary database
and every shard. Separate `migrate:shards`-style scripts are no longer needed;
`prisma-sharding-migrate` remains available as a backward-compatible alias that runs the
same shared pipeline.

### Environment Variables

```bash
SHARD_COUNT=3
SHARD_1_URL=postgresql://user:pass@host:5432/db1
SHARD_2_URL=postgresql://user:pass@host:5432/db2
SHARD_3_URL=postgresql://user:pass@host:5432/db3
SHARD_ROUTING_STRATEGY=modulo  # or consistent-hash
SHARD_STUDIO_BASE_PORT=51212   # optional, for studio
SHARD_STUDIO_REUSE_EXISTING=true # optional, defaults to true
SHARD_STUDIO_STRICT_PORT_CHECK=false # optional, defaults to false
SHARD_STUDIO_START_TIMEOUT_MS=15000 # optional, defaults to 15000
SHARD_STUDIO_VERBOSE=false # optional, defaults to false
SHARD_CLI_VERBOSE=false # optional, verbose update/migrate output
PRISMA_SHARDING_VERBOSE=false # optional, library lifecycle logs
SHARD_STRICT_DRIFT=false # optional, make schema drift fail the run (CI/production)
SHARD_DISABLE_PUSH_FALLBACK=false # optional, forbid the dev-only push fallback entirely
SHARD_ALLOW_UNSAFE_PUSH=false # optional, required opt-in for prisma-sharding-push
PRISMA_MIGRATIONS_PATH= # optional, migrations directory override
PRISMA_SCHEMA_PATH= # optional, schema path override for post-apply verification
```

The primary `DATABASE_URL` is also updated when it uses the same Prisma schema. If it points
at the same physical database as a shard URL, it is processed once, not twice; if it was never
created and real shards are configured, it is treated as a CLI datasource placeholder and
skipped.

### Commands

#### `prisma-sharding-update` (the one command: `yarn db:update`)

The single database-update workflow for development, Docker, CI, staging and production.
Every entry point (including the legacy `prisma-sharding-migrate` alias) runs the same shared
pipeline:

1. Validates the configured `DATABASE_URL` and shard URLs, de-duplicating any that point at
   the same physical database so nothing is migrated twice.
2. Runs `prisma generate` once for the whole run.
3. Detects committed Prisma migrations (`prisma/migrations`, `prisma.config.*`, or
   `PRISMA_MIGRATIONS_PATH`).
4. Silently preflights the real migration state of every database and shard **before
   changing any of them** (read-only, honours the URL's `?schema=` parameter) and validates
   recorded migration checksums against the local SQL files.
5. Adopts a source-controlled, verified legacy baseline when one is configured (see
   "Legacy databases" below).
6. Applies pending migrations per database with `prisma migrate deploy`, in migration order.
   Already-applied migrations are never re-run; migrations resolved with
   `migrate resolve --rolled-back` are re-applied, exactly as Prisma documents.
7. Verifies each database against the Prisma datamodel with `prisma migrate diff
   --exit-code` (Prisma v7 arguments, pre-v7 fallback). Because Prisma can format a
   semantically equivalent object differently (index operator classes, for example),
   drift is a **concise grouped warning by default and never blocks startup**; set
   `SHARD_STRICT_DRIFT=true` (CI/production) to make drift and unverifiable schemas fail.
8. Prints **one final line per database** and one outcome line, and exits non-zero if
   any database failed.

```bash
yarn db:update
```

```text
🔄 Prisma Sharding Update

✅ client  Generated
✅ shard_1  1 migration applied
✅ shard_2  Already up to date
✅ shard_3  Already up to date

✅ Complete  All 3 databases are up to date
```

A failed migration always fails the run, names the migration, and shows Prisma's real error:

```text
✅ shard_1  Already up to date
❌ shard_2  20260724000200_pmp_task_ticket_number failed
⏭️ shard_3  Not attempted

P3018: <Prisma's error>

No database was reset.
Fix the issue and rerun: yarn db:update
```

Because the command only exits zero when every database succeeded, chaining is safe:

```bash
yarn db:update && yarn dev
```

**Committed migrations are always authoritative.** When migration files exist, `db push` is
never used - a required column on a populated table must be handled inside the migration
(add nullable → backfill → set NOT NULL), and `migrate deploy` runs that SQL as committed.
Only when the project has *no* migration files at all does the command fall back to a plain,
development-only `prisma db push` (never in `NODE_ENV=production`, and never with data-loss
flags; disable entirely with `SHARD_DISABLE_PUSH_FALLBACK=true`).

Safety guarantees, in all modes:

- `--force-reset` and `--accept-data-loss` are refused outright, never injected or forwarded.
- A failed or partially-applied migration stops the run; the command never continues to
  `db push` after a migration failure and never marks a failed migration as applied.
- Databases already migrated stay migrated; rerunning `yarn db:update` is idempotent and is
  the standard retry after a partial failure.
- Databases with data but no `_prisma_migrations` history are never reset. The command stops
  and prints explicit baseline instructions (see `prisma-sharding-baseline`).
- A database ahead of the local migrations directory (unknown migrations) blocks the run
  with reconciliation guidance instead of guessing.
- An applied migration whose local `migration.sql` was edited afterwards (checksum mismatch)
  blocks the run: the SQL that ran is not the SQL in the working tree. A systemic difference
  affecting every checksum (line endings, checksum format) is reported as a warning instead
  of a false block.
- Schema drift is a grouped warning by default — a semantically equivalent object must never
  produce a false failure — and becomes a hard failure with `SHARD_STRICT_DRIFT=true`.
  Real migration failures, checksum mismatches, and incomplete migrations always fail.
- A migration marked `--rolled-back` is redeployed by the next update (per Prisma's
  documented failed-migration workflow); it is never blocked and the tool never advises
  `--applied` for SQL that still needs to run.
- Credentials are masked in every URL and command line the CLI prints; detailed Prisma
  output and manual recovery commands appear only under `SHARD_CLI_VERBOSE=true`.

#### Legacy databases (`db push`-built, no migration history)

A generic library cannot guess which historical migrations a legacy database already
represents — recording the wrong one would permanently skip its backfills. So the decision
lives in a small, source-controlled config file, and `yarn db:update` handles the rest in
one run:

```json
// prisma-sharding.config.json (also: .cjs / .js with a default export)
{
  "migrations": {
    "legacyBaseline": {
      "until": "20260724000100_pmp_project_feature_settings",
      "verified": true
    }
  }
}
```

`until` is the newest migration whose schema **and** data effects (backfills, corrections,
custom SQL) you verified are already present in every legacy database; `verified: true` is
that explicit attestation, reviewed like any other code. On the next `yarn db:update`, any
database with tables but no `_prisma_migrations` history is preflighted together with all
others, gets the baseline recorded (history rows only — no SQL runs), and the remaining
migrations are applied normally:

```text
✅ shard_1  Baselined 24, 1 migration applied
```

Without a verified config, the run stops with one concise message and touches nothing:

```text
❌ shard_1  Legacy database detected: 168 tables exist without Prisma migration history.

ℹ️ next  Configure migrations.legacyBaseline (prisma-sharding.config.json) before running yarn db:update.
No database was modified.
```

Set `SHARD_CLI_VERBOSE=true` (or `SHARD_UPDATE_VERBOSE=true`) for masked database URLs,
per-database `prisma migrate status` output, exact commands, exit codes, and next-step hints.

#### `prisma-sharding-migrate` (legacy alias)

Kept for backward compatibility. It runs exactly the same shared pipeline as
`prisma-sharding-update`, skipping only the `prisma generate` step. New projects should just
use `yarn db:update`.

#### `prisma-sharding-baseline` (recovery tool — not the normal path)

The normal way to adopt a legacy database is the `migrations.legacyBaseline` project
configuration above, which runs inside plain `yarn db:update`. This standalone CLI exists
for exceptional, operator-driven recovery (partial adoptions, per-shard cutoffs via
`--only`). It records existing migrations as applied (`prisma migrate resolve --applied`)
without running any SQL, altering any schema, or deleting any data:

```bash
# Print the plan (changes nothing, opens no connections):
npx prisma-sharding-baseline --until <cutoff_migration>

# Execute it (both flags required):
npx prisma-sharding-baseline --until <cutoff_migration> --yes --verified
```

A baselined migration **never has its SQL executed**, so the cutoff must be verified, not
guessed: every migration up to and including `--until` must already be fully represented in
every target database — its schema changes *and* its data effects (backfills, corrections,
custom SQL). `--verified` is your explicit confirmation of that; without it, `--yes` is
refused. Schema effects can be probed via `information_schema`; data effects require reading
each migration.

Execution is two-phase: first a **read-only preflight of every selected database** (state,
history consistency, checksums) — if any target is unreachable or inconsistent, nothing is
recorded anywhere — then the history rows are written. Rerunning after a partial failure is
safe: already-recorded migrations are skipped. Empty databases are skipped entirely
(`db:update` builds them from the full history), and an uncreated primary `DATABASE_URL` is
treated as a CLI datasource placeholder, not a failure.

Migrations after `--until` stay pending so the next `yarn db:update` runs their SQL,
including backfills. Use `--only shard_1,shard_2` to restrict targets.

#### `prisma-sharding-push` (unsafe, explicit opt-in)

A deliberate escape hatch for a disposable local database only. It bypasses migration
history, so it is blocked unless `SHARD_ALLOW_UNSAFE_PUSH=true` is set, and always refuses
to run with `NODE_ENV=production`. The normal workflow never needs it.

#### `prisma-sharding-studio`

Start Prisma Studio for all shards on sequential ports.

```bash
yarn db:studio
```

By default, ports are assigned from `SHARD_STUDIO_BASE_PORT`:

```text
shard_1 -> http://localhost:51212
shard_2 -> http://localhost:51213
shard_3 -> http://localhost:51214
```

Set `SHARD_STUDIO_BASE_PORT` to move the whole range:

```bash
SHARD_STUDIO_BASE_PORT=52000 yarn db:studio
# shard_1 -> :52000, shard_2 -> :52001, etc.
```

Studio is fully project-isolated. Every instance is resolved from the project that ran the
command — its working directory, `.env`, `prisma.config.*`, schema and shard URLs — and each
spawned Studio runs with that project as its working directory and receives exactly that
shard's `DATABASE_URL`. Nothing is resolved from the installed library's own directory.

Reuse is identity-verified, never port-guessed. When the CLI starts a Studio it records a
credential-free fingerprint (SHA-256 of project root, schema path, shard ID, and the
database target with credentials stripped) in a per-user registry. An occupied port is only
reused when that registry entry matches the current project **and** database, the recorded
process is alive, and the port answers like Prisma Studio:

```text
🗄️ Prisma Sharding Studio

♻️ shard_1  http://localhost:51212   ← same project, same database: safe reuse
```

Anything else on the port — another project's Studio, an unknown service — is left
completely untouched (never reused, never killed) and the CLI automatically starts on the
next free port, printing the actual assigned URL. Two projects with identical shard names
can run side by side:

```text
Project A: shard_1 → http://localhost:51212
Project B: shard_1 → http://localhost:51213   (51212 belonged to Project A)
```

Stopping one project's Studio command only stops the processes that command started; other
projects' Studios and their registry entries are untouched.

Default output is intentionally compact:

```text
🗄️ Prisma Sharding Studio

✅ shard_1  http://localhost:51212
✅ shard_2  http://localhost:51213
✅ shard_3  http://localhost:51214
```

Run with `SHARD_STUDIO_VERBOSE=true` to print port checks, masked database URLs, Prisma
Studio child-process output, startup timings, and detailed failure diagnostics.

Useful Studio environment variables:

- `SHARD_STUDIO_BASE_PORT`: first port in the shard Studio range. Defaults to `51212`.
- `SHARD_STUDIO_REUSE_EXISTING`: reuse already-running Prisma Studio ports. Defaults to `true`.
- `SHARD_STUDIO_STRICT_PORT_CHECK`: when `true`, any failed shard makes the command exit
  non-zero after stopping Studio processes started by that run. Defaults to `false`.
- `SHARD_STUDIO_START_TIMEOUT_MS`: maximum time to wait for a newly spawned Studio to become
  reachable. Defaults to `15000`.
- `SHARD_STUDIO_STABILITY_MS`: short window a newly-ready Studio process must survive before
  it is reported as started. Defaults to `500`.
- `SHARD_STUDIO_SHUTDOWN_TIMEOUT_MS`: time to wait for owned Studio processes to close during
  shutdown before sending a force-stop signal. Defaults to `5000`.
- `SHARD_STUDIO_PORT_SCAN_LIMIT`: how many ports above the preferred one to try when ports
  are held by other projects or processes. Defaults to `100`.
- `SHARD_STUDIO_REGISTRY_DIR`: location of the per-user Studio identity registry. Defaults
  to a `prisma-sharding-studio` directory in the OS temp dir. Entries contain only
  credential-free fingerprints, ports, pids and project roots.
- `SHARD_STUDIO_VERBOSE`: print detailed Studio startup diagnostics. Defaults to `false`.
- `SHARD_STUDIO_DEBUG`: alias for `SHARD_STUDIO_VERBOSE`.

When the same project runs `db:studio` from multiple terminals, the first run starts the
Studio processes and later runs reuse them after verifying the identity fingerprint.
Different projects never share Studio processes, even when they point at the same databases —
each project gets its own instances on its own ports. Reused-only commands stay quietly
attached, preventing process supervisors from printing a normal child-exit message. Pressing
Ctrl+C only stops Studio processes started by the current CLI run; reused processes are left running.

If you run Studio beside `nodemon`, prefer an explicit watch scope for the API process. Prisma
Studio does not need to write to your app source, but broad nodemon defaults can restart on
generated TypeScript or JSON files produced by other dev tooling:

```bash
nodemon --watch src --ext ts,json \
  --ignore 'src/types/*.generated.ts' \
  --exec tsx --env-file=.env --no-warnings src/server.ts
```

#### `prisma-sharding-test`

Test connections to all shards.

```bash
yarn test:shards
```

```
================================
📋 User Distribution Test
================================
Creating 24 test users across 3 shards...

User 1/24: "testuser_0" → shard_3
User 2/24: "testuser_1" → shard_1
User 3/24: "testuser_2" → shard_2
User 4/24: "testuser_3" → shard_3
User 5/24: "testuser_4" → shard_1
User 6/24: "testuser_5" → shard_2
User 7/24: "testuser_6" → shard_3
User 8/24: "testuser_7" → shard_1
User 9/24: "testuser_8" → shard_2
User 10/24: "testuser_9" → shard_3
User 11/24: "testuser_10" → shard_2
User 12/24: "testuser_11" → shard_1
User 13/24: "testuser_12" → shard_3
User 14/24: "testuser_13" → shard_2
User 15/24: "testuser_14" → shard_1
User 16/24: "testuser_15" → shard_3
User 17/24: "testuser_16" → shard_2
User 18/24: "testuser_17" → shard_1
User 19/24: "testuser_18" → shard_3
User 20/24: "testuser_19" → shard_2
User 21/24: "testuser_20" → shard_1
User 22/24: "testuser_21" → shard_3
User 23/24: "testuser_22" → shard_2
User 24/24: "testuser_23" → shard_1
✅ Created 24/24 test users
```

```
================================
📋 Read Verification
================================
✓ User "test_user_1770289330292_0" found on shard_3
✓ User "test_user_1770289330292_1" found on shard_1
✓ User "test_user_1770289330292_2" found on shard_2
✓ User "test_user_1770289330292_3" found on shard_3
✓ User "test_user_1770289330292_4" found on shard_1
Verified 5/5 users on correct shards
✅ Verify users exist on correct shards (136ms)
```

## Configuration

| Option                    | Type                            | Default    | Description                       |
| ------------------------- | ------------------------------- | ---------- | --------------------------------- |
| `shards`                  | `ShardConfig[]`                 | Required   | Array of shard configurations     |
| `strategy`                | `'modulo' \| 'consistent-hash'` | `'modulo'` | Routing algorithm                 |
| `createClient`            | `(url, shardId) => TClient`     | Required   | Factory to create Prisma clients  |
| `healthCheckIntervalMs`   | `number`                        | `30000`    | Positive health check frequency   |
| `circuitBreakerThreshold` | `number`                        | `3`        | Failures before marking unhealthy |

### Shard Config

```typescript
interface ShardConfig {
  id: string; // Unique identifier (e.g., 'shard_1')
  url: string; // PostgreSQL connection string
  weight?: number; // Positive random-assignment weight only
  isReadReplica?: boolean;
}
```

## Routing Strategies

### Modulo (Default)

Simple and fast. Uses `hash(key) % shardCount` for routing.

```typescript
strategy: 'modulo';
```

### Consistent Hash

Uses a precomputed virtual-node ring and binary search. Custom and non-sequential shard IDs are
supported. Adding or removing shards still changes ownership for part of the keyspace, so plan data
movement before changing a production shard list.

```typescript
strategy: 'consistent-hash';
```

## Architecture and Scaling

The public `PrismaSharding` layer validates and delegates without changing its established surface.
Internally, the router owns key placement, the manager owns clients and health state, and one
cross-shard executor owns concurrency, deadlines, health-aware scheduling, stable result ordering,
and failure isolation. CLI commands share one shard parser and one sanitized child-process runner.

| Layer | Responsibility |
| --- | --- |
| Public API | Validate, delegate, and preserve existing result shapes |
| Router | Stable deterministic placement and weighted random assignment |
| Shard manager | Client lifecycle, initial verification, health, and shutdown |
| Cross-shard executor | Shared concurrency, deadlines, ordering, and failure isolation |
| CLI | Safe migration/update/test/Studio orchestration with compact output |

Low-level execution behavior is intentionally internal: fan-out concurrency and deadlines are
central defaults, the hash function is unchanged, health checks use typed Prisma-like capability
guards, successful `runOnAll()` results retain configured shard order, and errors stay isolated in
the existing detailed result shape.

Normal request flow should be:

```text
routing key or directory lookup -> one shard -> one Prisma operation
```

`findFirst()` and `runOnAll()` use bounded concurrency and per-shard deadlines, but they still
multiply database work and tail-latency exposure. Reserve them for recovery, administration, and
analytics. Pending Prisma queries may not be cancellable after an early `findFirst()` result, so
the caller can resolve before all already-started database work has physically stopped.

The executor deadline limits how long the package waits; it does **not** cancel the underlying
Prisma or PostgreSQL query. Configure a database-level deadline as well, such as PostgreSQL
`statement_timeout` or the equivalent adapter/provider query timeout, so timed-out work cannot
continue consuming database resources indefinitely.

### Connection Pool Budgeting

Each shard client owns or uses a connection pool. Budget the fleet-wide maximum as:

```text
application instances × shards per instance × connections per shard pool
```

For example, 20 application instances × 8 shards × 10 connections can attempt 1,600 database
connections. Set the adapter's pool limit and connection timeout deliberately per application
instance and per shard. At larger fleet sizes, use PgBouncer or provider-managed pooling and verify
that the database's total connection budget includes migrations, administration, and failover
headroom. The sharding package does not create hidden extra Prisma clients.

## Error Handling

```typescript
import { ShardingError, ConfigError, ConnectionError } from 'prisma-sharding';

try {
  const client = sharding.getShard(userId);
} catch (error) {
  if (error instanceof ConnectionError) {
    console.error(`Shard ${error.shardId} unavailable`);
  }
}
```

## Custom Logger

The default logger prints warnings and errors only. Set `PRISMA_SHARDING_VERBOSE=true` to include
initialization, shard connection, and shutdown lifecycle messages.

```typescript
const sharding = new PrismaSharding({
  // ...config,
  logger: {
    info: (msg) => myLogger.info(msg),
    warn: (msg) => myLogger.warn(msg),
    error: (msg) => myLogger.error(msg),
  },
});
```

---

### `getAllClients()`

Get all Prisma client instances.

```typescript
const clients = sharding.getAllClients();

console.log(`Managing ${clients.length} shard clients`);
```

**Returns:** `PrismaClient[]`

---

### `getShardCount()`

Get total number of configured shards.

```typescript
const count = sharding.getShardCount();
console.log(`Running on ${count} shards`);
// Output: Running on 3 shards
```

---

### `getShardIds()`

Get array of all shard IDs.

```typescript
const shardIds = sharding.getShardIds();
console.log(shardIds);
// Output: ['shard_1', 'shard_2', 'shard_3']
```

**Returns:** `string[]`

---

## Testing

`yarn test` builds the package and runs the unit and CLI test suites (no database needed —
migration state, checksum handling, verification, and baseline flows are covered with
injected fakes).

One end-to-end test runs against a real PostgreSQL database and is opt-in:

```bash
PS_INTEGRATION_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/prisma_sharding_it" yarn test
```

It creates a uniquely-named schema inside that scratch database, simulates a legacy
`db push`-built shard with 43 populated rows, performs a verified baseline, deploys a
required-column backfill migration through the real Prisma CLI, asserts every row survived
with correct ticket numbers, reruns for idempotency, and drops the schema. It exercises the
`?schema=` handling and the real `_prisma_migrations` checksums end to end.

## Author

[safdar-azeem](https://github.com/safdar-azeem)

## License

MIT
