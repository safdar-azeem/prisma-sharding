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

| Method                       | Description                                   |
| ---------------------------- | --------------------------------------------- |
| `getShard(key)`              | Get Prisma client for a given key             |
| `getShardById(shardId)`      | Get Prisma client by shard ID                 |
| `getRandomShard()`           | Get random shard (for new records)            |
| `findFirst(fn)`              | Search across all shards, return first result |
| `runOnAll(fn)`               | Execute on all shards                         |
| `getHealth()`                | Get health status of all shards               |
| `connect()` / `disconnect()` | Lifecycle methods                             |

### Step 2: Create a User (Assign to a Shard)

New records should be created on a random shard for even distribution.

```ts
import { sharding } from '@/config/prisma';

const client = sharding.getRandomShard();

const user = await client.user.create({
  data: {
    email: 'user@example.com',
    username: 'new_user',
  },
});
```

## Step 3: Access User by ID (Shard Routing)

When you have a user ID, Prisma Sharding routes you to the correct shard automatically.

```ts
const userId = 'abc123';

const client = sharding.getShard(userId);

const user = await client.user.findUnique({
  where: { id: userId },
});
```

`Important rule:`

Once you get the shard client using a user ID, **all future operations for that user must use this same client**.

That includes:

- Reading user data
- Updating user data
- Creating related records (profiles, posts, settings, etc)

Every user belongs to exactly one shard. Their entire data lives on that shard only.

Do **not** switch shards or use a random shard for user related actions.

Always do this:

```ts
const client = sharding.getShard(userId);
```

This guarantees all user data stays on the correct shard and avoids cross shard bugs.

### Step 4: Find User Without ID (Cross Shard Search)

If you do not have the user ID, search all shards in parallel.
Use this only when necessary.

```typescript
// Find user by email across ALL shards (parallel execution)
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

## Step 5: Run on All Shards (Admin or Analytics)

```typescript
// Get counts from all shards
const counts = await sharding.runOnAll(async (client) => client.user.count());
const totalUsers = counts.reduce((sum, count) => sum + count, 0);

// With detailed results (includes errors)
const results = await sharding.runOnAllWithDetails(async (client, shardId) => {
  return { shardId, count: await client.user.count() };
});
```

### Health Monitoring

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

The "All-in-One" command. It generates Prisma Client types and migrates all shards.
**Use this whenever you change `schema.prisma`.**

1. Runs `prisma generate` (Updates TypeScript types)
2. Runs `prisma db push` on all shards (Updates Databases)

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

**With Flags:**
You can pass flags like `--force-reset` if you need to wipe data due to schema conflicts.

```bash
yarn db:update --force-reset

```

#### `prisma-sharding-migrate`

Only pushes schema to all shards (skips type generation). Useful for production deployment pipelines.

```bash
yarn migrate:shards

```

This command uses the same compact shard rows as `db:update`. Set
`SHARD_CLI_VERBOSE=true` or `SHARD_MIGRATE_VERBOSE=true` for Prisma command output.

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
| `healthCheckIntervalMs`   | `number`                        | `30000`    | Health check frequency            |
| `circuitBreakerThreshold` | `number`                        | `3`        | Failures before marking unhealthy |

### Shard Config

```typescript
interface ShardConfig {
  id: string; // Unique identifier (e.g., 'shard_1')
  url: string; // PostgreSQL connection string
  weight?: number; // Optional weight for distribution
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

Minimizes data movement when adding/removing shards.

```typescript
strategy: 'consistent-hash';
```

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
