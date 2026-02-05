# Prisma Sharding

Lightweight database sharding library for Prisma with connection pooling, health monitoring, and circuit breaker support.

## Installation

```bash
yarn add prisma-sharding
# or
npm install prisma-sharding
```

## Quick Start

```typescript
import { PrismaSharding } from 'prisma-sharding';
import { PrismaClient } from '@/generated/prisma';
import { PrismaPg } from '@prisma/adapter-pg';

const sharding = new PrismaSharding<PrismaClient>({
  shards: [
    { id: 'shard_1', url: process.env.SHARD_1_URL! },
    { id: 'shard_2', url: process.env.SHARD_2_URL! },
    { id: 'shard_3', url: process.env.SHARD_3_URL! },
  ],
  strategy: 'modulo', // 'modulo' | 'consistent-hash'
  createClient: (url) => {
    const adapter = new PrismaPg({ connectionString: url, max: 10 });
    return new PrismaClient({ adapter });
  },
});

// Initialize connections
await sharding.connect();
```

## Usage

### Get Shard by Key

```typescript
// Get client for existing user (routed by user ID)
const client = sharding.getShard(userId);
const user = await client.user.findUnique({ where: { id: userId } });

// Get shard with metadata
const { client, shardId } = sharding.getShardWithInfo(userId);
```

### Random Shard (New Records)

```typescript
// Get random shard for creating new user (ensures even distribution)
const client = sharding.getRandomShard();
const newUser = await client.user.create({ data: { email, username } });
```

### Cross-Shard Search

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

### Execute on All Shards

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

## Configuration

| Option                    | Type                            | Default    | Description                               |
| ------------------------- | ------------------------------- | ---------- | ----------------------------------------- |
| `shards`                  | `ShardConfig[]`                 | Required   | Array of shard configurations             |
| `strategy`                | `'modulo' \| 'consistent-hash'` | `'modulo'` | Routing algorithm                         |
| `createClient`            | `(url, shardId) => TClient`     | Required   | Factory function to create Prisma clients |
| `healthCheckIntervalMs`   | `number`                        | `30000`    | Health check frequency                    |
| `circuitBreakerThreshold` | `number`                        | `3`        | Failures before marking unhealthy         |
| `logger`                  | `ShardingLogger`                | Console    | Custom logger                             |

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
import { ShardingError, ConfigError, ConnectionError, RoutingError } from 'prisma-sharding';

try {
  const client = sharding.getShard(userId);
} catch (error) {
  if (error instanceof ConnectionError) {
    console.error(`Shard ${error.shardId} unavailable`);
  }
}
```

## Custom Logger

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

## License

MIT
