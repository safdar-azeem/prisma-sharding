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

Add to your `package.json`:

```json
{
  "scripts": {
    "db:update": "prisma-sharding-update",
    "migrate:shards": "prisma-sharding-migrate",
    "db:studio": "prisma-sharding-studio",
    "test:shards": "prisma-sharding-test"
  }
}
```

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
```

### Commands

#### `prisma-sharding-update` (Recommended)

The "All-in-One" development command generates Prisma Client types and synchronizes local/dev
shards. Use this whenever you change `schema.prisma` during development. It is not a production
migration workflow.

1. Runs `prisma generate` (Updates TypeScript types)
2. Runs `prisma db push` on all shards (Synchronizes development databases)

```bash
yarn db:update

```

Default output stays compact:

```text
🔄 Prisma Sharding Update

✅ client  Generated
✅ shard_1  Synced
✅ shard_2  Synced
✅ shard_3  Synced
```

Interactive terminals show a single inline loader while Prisma Client generation and each shard
sync are running. The loader is replaced by the completed row and is disabled for piped or CI logs.

Set `SHARD_CLI_VERBOSE=true` or `SHARD_UPDATE_VERBOSE=true` to include Prisma command
output, masked database URLs, and detailed diagnostics.

Existing flags remain unchanged and are forwarded as provided. For example:

```bash
yarn db:update --force-reset

```

The command does not inject `--accept-data-loss` automatically.

#### `prisma-sharding-migrate`

This is the production/staging path. For each shard it checks migration status and runs
`prisma migrate deploy`, applying committed migration artifacts without generating the client,
resetting the database, or using `db push`.

```bash
yarn migrate:shards

```

Any failed shard makes the command exit non-zero and remains visible in the compact results.
This command uses the same compact shard rows as `db:update`. Set
`SHARD_CLI_VERBOSE=true` or `SHARD_MIGRATE_VERBOSE=true` for Prisma command output.

Do not use `prisma db push` as a production migration strategy. Commit and review the Prisma
migration directory, then run `prisma-sharding-migrate` during deployment. Verbose mode includes
sanitized status/deploy commands, masked database URLs, exit codes, shard IDs, and next-step hints.

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

Studio startup is safe to run from multiple local APIs. Before starting a shard Studio,
the CLI checks whether the target port is already active. If it finds an existing Prisma
Studio on that port, it reuses it instead of spawning another process:

```text
🗄️ Prisma Sharding Studio

♻️ shard_1  http://localhost:51212
♻️ shard_2  http://localhost:51213
♻️ shard_3  http://localhost:51214
```

If a port is occupied by another process that does not look like Prisma Studio, the shard
is marked with a warning and the CLI continues with the remaining shards. It will not kill,
restart, or claim ownership of processes it did not start.

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
- `SHARD_STUDIO_VERBOSE`: print detailed Studio startup diagnostics. Defaults to `false`.
- `SHARD_STUDIO_DEBUG`: alias for `SHARD_STUDIO_VERBOSE`.

When multiple APIs use the same shard configuration locally, the first API starts the Studio
processes and later APIs reuse the existing Studio ports. Reused-only commands stay quietly
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

## Author

[safdar-azeem](https://github.com/safdar-azeem)

## License

MIT
