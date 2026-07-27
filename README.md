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
    "db:studio": "prisma-studio-next",
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
SHARD_STUDIO_BASE_PORT=51212   # optional, preferred port for the single Studio host
SHARD_STUDIO_REUSE_EXISTING=true # optional, defaults to true
SHARD_STUDIO_STRICT_PORT_CHECK=false # optional, defaults to false
SHARD_STUDIO_START_TIMEOUT_MS=15000 # optional, defaults to 15000
SHARD_STUDIO_HOST=127.0.0.1 # optional, interface the Studio host binds to
SHARD_STUDIO_MAX_OPEN_CONNECTIONS=3 # optional, shards holding a connection at once
SHARD_STUDIO_IDLE_CONNECTION_TIMEOUT_MS=60000 # optional, idle connection lifetime
SHARD_STUDIO_TABLE_GROUPING=false # optional, group the sidebar table list by prefix
SHARD_STUDIO_VERBOSE=false # optional, defaults to false
SHARD_CLI_VERBOSE=false # optional, verbose update/migrate output
PRISMA_SHARDING_VERBOSE=false # optional, library lifecycle logs
SHARD_STRICT_DRIFT=false # optional, make schema drift fail the run (CI/production)
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
8. Prints **one quiet `Synced` line per active database** (detailed statuses and the
   Complete summary appear only in verbose mode), and exits non-zero if any database
   failed.

```bash
yarn db:update
```

```text
✅ client   Generated
✅ shard_1  Synced
✅ shard_2  Synced
✅ shard_3  Synced
```

Skipped placeholder databases, migration counts, drift warnings, and other diagnostics stay quiet unless `SHARD_CLI_VERBOSE=true` (or `SHARD_UPDATE_VERBOSE=true`) is set.

A failed migration always fails the run, names the migration, and shows Prisma's real error:

```text
✅ shard_1  Synced
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

**Committed migrations are the default.** When migration files exist, `db push` is not used
on its own - a required column on a populated table should be handled inside the migration
(add nullable → backfill → set NOT NULL), and `migrate deploy` runs that SQL as committed.
When the project has *no* migration files at all, the command falls back to a plain
`prisma db push`. The fallback works in every environment; there is no env gate on it.

**Destructive flags are honoured, not refused.** Passing `--force-reset` or
`--accept-data-loss` switches the run to a direct `prisma db push` with that flag forwarded
verbatim to every configured database and shard:

```bash
yarn db:update --force-reset        # resets and re-pushes every shard
yarn db:update --accept-data-loss   # pushes and accepts the data loss Prisma reports
```

Neither flag is ever *injected* on your behalf, and neither is gated by `NODE_ENV` or an
opt-in environment variable — an explicit flag is treated as an explicit instruction.

What still applies when you do not pass a destructive flag:

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

# Execute it:
npx prisma-sharding-baseline --until <cutoff_migration> --yes
```

A baselined migration **never has its SQL executed**, so the cutoff should be verified, not
guessed: every migration up to and including `--until` must already be fully represented in
every target database — its schema changes *and* its data effects (backfills, corrections,
custom SQL). Adding `--verified` acknowledges that and silences the reminder; it is not a
gate — `--yes` alone executes. Schema effects can be probed via `information_schema`; data
effects require reading each migration.

Execution is two-phase: first a **read-only preflight of every selected database** (state,
history consistency, checksums) — if any target is unreachable or inconsistent, nothing is
recorded anywhere — then the history rows are written. Rerunning after a partial failure is
safe: already-recorded migrations are skipped. Empty databases are skipped entirely
(`db:update` builds them from the full history), and an uncreated primary `DATABASE_URL` is
treated as a CLI datasource placeholder, not a failure.

Migrations after `--until` stay pending so the next `yarn db:update` runs their SQL,
including backfills. Use `--only shard_1,shard_2` to restrict targets.

#### `prisma-sharding-push`

A direct `prisma db push` against every configured database and shard, forwarding any flags
you pass (`--force-reset`, `--accept-data-loss`, …). It bypasses migration history, so
`yarn db:update` remains the normal workflow — but it needs no opt-in environment variable
and runs in any `NODE_ENV`.

#### `prisma-studio-next`

Open **one** Studio for **all** shards, and switch between them in the UI.

```bash
yarn db:studio
```

```text
📦 Studio  http://localhost:51212
```

Database counts, reuse details, and startup diagnostics appear only with `SHARD_STUDIO_VERBOSE=true`.

One command, one URL, one browser tab. The database picker sits in the Studio header;
every table view, filter, edit, SQL statement, transaction and refresh runs against the
selected database only.

##### Which databases appear

Discovery uses the same shard parser as every other command, so Studio and `db:update`
never disagree about what exists:

- `SHARD_COUNT` + `SHARD_N_URL` define the shards.
- `DATABASE_URL` is used **only** when no shards are configured at all. It is not added as
  an extra entry when shards exist.
- Two variables pointing at the same physical database are shown **once**. The folded-away
  ID still resolves, so an old deep link keeps working.
- A shard declared by `SHARD_COUNT` but missing its URL is not selectable, and Studio says so.

##### Switching databases

Selecting another database:

1. Re-checks that it is still configured on the server.
2. Asks you to keep editing or discard, if you have staged inserts or edits.
3. Cancels in-flight requests for the previous database.
4. Rebuilds the adapter and clears every connection-bound cache — fetched rows, introspection
   metadata, in-flight requests and SQL results.
5. Introspects the newly selected database and updates the shard in the URL.

Data from one shard can never be displayed as another's, even when both databases have
identical schemas and table names: Studio is remounted with a new adapter, and a response
that arrives after a switch is discarded rather than applied.

**Where you are is preserved.** Only the `shard` query parameter changes; the view, schema,
table, filters, sorting and pagination in the URL hash are left untouched, so switching keeps
you on the same table in the new database:

```text
http://localhost:51212/?shard=shard_1#view=table&schema=public&table=Appointment
                       ↓ select Shard 2
http://localhost:51212/?shard=shard_2#view=table&schema=public&table=Appointment
```

On a homogeneous shard set — the normal case, since every shard runs the same Prisma schema —
that is exactly what you want when comparing a table across databases. If the new shard
genuinely lacks the selected schema or table, Studio falls back to the first available one
rather than showing a broken view.

Theme, navigation width and page size are presentation preferences and are also preserved.

Refreshing keeps your shard. Two tabs can sit on two different shards without interfering.
A link naming a shard that has since been removed falls back to the default and tells you.
Switching uses `replaceState`, so the back button follows your actual path rather than
stepping back through databases.

##### Security boundary

- Connection strings and credentials are resolved **server-side only** and never reach the
  browser, the page source or any bundled asset.
- The browser sends a shard **identifier**; the server resolves it against its own
  configuration before any query runs.
- A request carrying an unknown, stale or malformed shard ID is rejected before database
  execution.
- A request that tries to supply its own connection URL is rejected outright.
- The CLI binds to `127.0.0.1`. Set `SHARD_STUDIO_HOST` only if you understand the exposure.

##### Project isolation and reuse

Everything resolves from the project that ran the command — its working directory, `.env`,
`prisma.config.*`, schema and shard URLs. Nothing resolves from the installed library.

Reuse is identity-verified, never port-guessed. The CLI records a credential-free
fingerprint (SHA-256 of project root, schema path, and every configured shard ID paired
with its credential-stripped database target) in a per-user registry. An occupied port is
reused only when the registry entry matches, the recorded process is alive, **and** the
host confirms the same fingerprint from its own identity endpoint:

```text
♻️ Studio  http://localhost:51212   ← same project, same shard set: safe reuse
```

Because the fingerprint covers the whole shard set, adding, removing or repointing a shard
starts a fresh host instead of attaching to one serving a stale configuration.

Anything else on the port — another project's host, an unknown service — is left completely
untouched (never reused, never terminated) and the CLI moves to the next free port:

```text
Project A → http://localhost:51212
Project B → http://localhost:51213   (51212 belonged to Project A)
```

Ctrl+C stops only what the current run started. A reused host and its registry entry are
left running for the command that owns them. On shutdown the server closes, every open
database connection is disposed, and no timers or watchers are left behind.

##### The Studio package

Studio's UI, adapters and BFF contract come from `prisma-studio-next`, published to npm
alongside this package:

| Package               | Role                                              |
| --------------------- | ------------------------------------------------- |
| `prisma-sharding`     | Sharding library, CLI, and the Studio host        |
| `prisma-studio-next`  | The embedded Studio UI, adapters and BFF contract |

It is a fork of Prisma's `@prisma/studio-core`, renamed so it is never published under or
confused with the official package. It carries the two generic host extension points this
integration needs (`headerEndContent` and `onPendingChangesChange`); everything else is
upstream behaviour, and upstream attribution is preserved in its `NOTICE` and `LICENSE`.

Note that `@prisma/studio-core` may still appear in your lockfile: the `prisma` CLI depends
on it. That is Prisma's own copy and is unrelated to this one.

To develop against a local checkout of the fork rather than a published version:

```bash
# in the studio fork
pnpm build && pnpm link --global

# in prisma-sharding
yarn link prisma-studio-next
```

##### Grouping the table list

Schemas with hundreds of tables produce a very long flat sidebar. Set one variable to have
Studio organise it into expandable groups:

```bash
SHARD_STUDIO_TABLE_GROUPING=true
```

That is the whole configuration. Studio reads your actual table names and groups the ones
sharing a leading word:

```text
Accounting (10)   AccountingAsset, AccountingConfig, AccountingVoucher, …
Crm (3)           CrmCall, CrmContact, CrmCustomer
Hrm (3)           HrmAttendance, HrmEmployee, HrmPayroll
Product (3)       _ProductPurchaseTaxes, _ProductSalesTaxes, _ProductToCategory
Other (7)         ActivityLog, Appointment, Conversation, _prisma_migrations, …
```

Nothing is listed, mapped or maintained by hand, and no prefixes are built into the library:
groups come from the names in your schema, and labels use the casing you wrote, so
`HRMEmployee` shows `HRM` and `hrm_employee` shows `Hrm`. A project with entirely different
conventions groups just as well.

- Tables with no shared prefix are collected under `Other`. Nothing is hidden.
- A schema with no repeated prefixes stays flat instead of gaining a pointless wrapper.
- Searching returns the flat filtered list, so a result is never inside a collapsed group.
- Collapse state persists, and the group holding the open table is always expanded.
- Leave the variable unset and the sidebar behaves exactly as before.

##### Prisma connection-string arguments

Studio connects through `postgres.js` rather than Prisma's engine, and `postgres.js` forwards
any query parameter it does not recognise to the server as a startup parameter. A stock
Prisma URL would therefore be refused outright:

```text
unrecognized configuration parameter "schema"
```

So Prisma's driver arguments are consumed before the connection is opened:

| Argument                                                            | Handling                                     |
| ------------------------------------------------------------------- | -------------------------------------------- |
| `schema`                                                             | Becomes the connection's default `search_path` |
| `connection_limit`                                                   | Becomes the pool size, capped by the host limit |
| `host=/var/run/postgresql`                                           | Becomes the unix socket path                  |
| `application_name`                                                   | Passed as a connection parameter              |
| `pgbouncer`, `pool_timeout`, `socket_timeout`, `statement_cache_size` | Dropped; they describe Prisma engine behaviour |
| `sslidentity`, `sslaccept`                                           | Dropped; use `sslcert`/`sslkey`/`sslrootcert` |
| `sslmode`, `sslrootcert`, `sslcert`, `sslkey`, `sslpassword`         | Handled by Studio's own SSL support           |
| anything else                                                        | Passed through as a genuine PostgreSQL setting |

No change to your `.env` is needed — `?schema=public` keeps working and now also selects the
default schema inside Studio.

##### Connections

Nothing connects until you actually query a database. Connections are opened lazily per
shard, reused while you work, bounded by `SHARD_STUDIO_MAX_OPEN_CONNECTIONS`, and closed
after `SHARD_STUDIO_IDLE_CONNECTION_TIMEOUT_MS` of inactivity. Starting Studio for a
40-shard project costs one HTTP server and zero database connections.

##### Environment variables

All previous Studio variables still work and now apply to the single host.

- `SHARD_STUDIO_BASE_PORT`: preferred port for the host. Defaults to `51212`. Scanning
  starts here, exactly as before; shards no longer consume a port each.
- `SHARD_STUDIO_REUSE_EXISTING`: reuse a running host with a matching identity. Defaults to `true`.
- `SHARD_STUDIO_STRICT_PORT_CHECK`: when `true`, a host that could not start makes the
  command exit non-zero. Defaults to `false`.
- `SHARD_STUDIO_START_TIMEOUT_MS`: maximum time to wait for the host to accept connections.
  Defaults to `15000`.
- `SHARD_STUDIO_STABILITY_MS`: window the host must keep listening before it is reported as
  started. Defaults to `500`.
- `SHARD_STUDIO_SHUTDOWN_TIMEOUT_MS`: time to wait for the server and its connections to
  close during shutdown. Defaults to `5000`.
- `SHARD_STUDIO_PORT_SCAN_LIMIT`: how many ports above the preferred one to try. Defaults to `100`.
- `SHARD_STUDIO_REGISTRY_DIR`: per-user host identity registry. Defaults to a
  `prisma-studio-next` directory in the OS temp dir. Entries hold only credential-free
  fingerprints, ports, pids and project roots.
- `SHARD_STUDIO_HOST`: interface to bind. Defaults to `127.0.0.1`.
- `SHARD_STUDIO_MAX_OPEN_CONNECTIONS`: shards allowed to hold an open connection at once.
  Defaults to `3`.
- `SHARD_STUDIO_IDLE_CONNECTION_TIMEOUT_MS`: how long an unused shard connection is kept.
  Defaults to `60000`.
- `SHARD_STUDIO_TABLE_GROUPING`: group the sidebar table list by detected prefix. Defaults
  to `false`. See below.
- `SHARD_STUDIO_VERBOSE`: print detailed startup diagnostics. Defaults to `false`.
- `SHARD_STUDIO_DEBUG`: alias for `SHARD_STUDIO_VERBOSE`.

##### Embedding Studio in your own application

The CLI is just one embedder. The same discovery, validation, routing and execution
services can be mounted behind your app's own authenticated route:

```typescript
import { createServer } from 'node:http';
import {
  createStudioHostPostgresConnectionFactory,
  createStudioHostRequestHandler,
  createStudioHostService,
} from 'prisma-sharding/studio-host';

const studio = createStudioHostService({
  createConnection: createStudioHostPostgresConnectionFactory(),
  // REQUIRED for any network-reachable endpoint. Without it every caller that
  // can reach the route can read and write every configured database.
  authorize: async ({ auth, shardId }) => {
    const session = auth as Session | undefined;

    if (!session?.isAdmin) {
      return { allowed: false, status: 401, message: 'Sign in required' };
    }

    return session.allowedShardIds.includes(shardId);
  },
});

const handleStudio = createStudioHostRequestHandler({
  service: studio,
  createContext: (request) => ({
    headers: request.headers,
    auth: getSessionFromRequest(request),
  }),
});

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');

  if (url.pathname.startsWith('/internal/studio')) {
    const handled = await handleStudio(
      request,
      response,
      url.pathname.slice('/internal/studio'.length) || '/'
    );

    if (handled) {
      return;
    }
  }

  // ... your own routes
});

// On shutdown, so no pool outlives the process.
process.on('SIGTERM', () => void studio.dispose());
```

Routes, relative to your mount path:

| Route            | Method | Purpose                                             |
| ---------------- | ------ | --------------------------------------------------- |
| `/shards`        | GET    | Sanitized, credential-free list of databases         |
| `/shards/status` | POST   | On-demand availability check for one shard           |
| `/bff`           | POST   | Studio BFF: query, sequence, transaction, sql-lint   |
| `/identity`      | GET    | Credential-free host identity, used for safe reuse   |

Responsibilities split cleanly: **you** own routing, authentication, tenancy and TLS.
**Prisma Sharding** owns shard discovery, identifier validation, credential resolution,
connection routing and lifecycle. **Studio** owns the UI, adapters, introspection and the
BFF contract.

##### Troubleshooting

- **`unrecognized configuration parameter "..."`.** A connection-string argument reached the
  server as a startup parameter. Prisma's own arguments are translated automatically (see
  above); if you hit this with a custom argument, remove it from the URL.
- **A database shows as unreachable.** Only that entry is affected; the others stay usable.
  Re-select it to retry. Run with `SHARD_STUDIO_VERBOSE=true` for the underlying error
  class — connection strings are never printed.
- **A database is missing from the list.** Its `SHARD_N_URL` is unset, or it points at the
  same physical database as another shard and was folded into it. Both cases are reported
  in Studio.
- **The picker is above Studio rather than in its header.** The installed
  `prisma-studio-next` predates the host extension points. Upgrade it to move the picker
  into the header and re-enable the unsaved-edits guard.
- **A port other than 51212.** The preferred port was taken by something the CLI refused to
  disturb. The printed URL is always the real one.

If you run Studio beside `nodemon`, prefer an explicit watch scope for the API process:

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
