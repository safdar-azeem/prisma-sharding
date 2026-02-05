# Prisma Sharding

Lightweight database sharding library for Prisma with connection pooling, health monitoring, and CLI tools.

## Installation

```bash
yarn add prisma-sharding
# or
npm install prisma-sharding
```

> Don't forget to follow me on [GitHub](https://github.com/safdar-azeem)!

## Quick Start

```typescript
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
| `getShard(key)`              | Get client for a given key                    |
| `getShardById(shardId)`      | Get client by shard ID                        |
| `getRandomShard()`           | Get random shard (for new records)            |
| `findFirst(fn)`              | Search across all shards, return first result |
| `runOnAll(fn)`               | Execute on all shards                         |
| `getHealth()`                | Get health status of all shards               |
| `connect()` / `disconnect()` | Lifecycle methods                             |

## CLI Tools

The package includes CLI tools for common sharding operations. No need to write custom scripts!

### Setup

Add to your `package.json`:

```json
{
  "scripts": {
    "db:studio:all": "prisma-sharding-studio",
    "migrate:shards": "prisma-sharding-migrate",
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
```

### Commands

#### `prisma-sharding-migrate`

Push schema to all shards using `prisma db push`.

```bash
yarn migrate:shards
```

#### `prisma-sharding-studio`

Start Prisma Studio for all shards on sequential ports.

```bash
yarn db:studio:all
# Opens shard_1 on :51212, shard_2 on :51213, etc.
```

#### `prisma-sharding-test`

Test connections to all shards.

```bash
yarn test:shards
```

## Configuration

| Option                    | Type                            | Default    | Description                       |
| ------------------------- | ------------------------------- | ---------- | --------------------------------- |
| `shards`                  | `ShardConfig[]`                 | Required   | Array of shard configurations     |
| `strategy`                | `'modulo' \| 'consistent-hash'` | `'modulo'` | Routing algorithm                 |
| `createClient`            | `(url, shardId) => TClient`     | Required   | Factory to create Prisma clients  |
| `healthCheckIntervalMs`   | `number`                        | `30000`    | Health check frequency            |
| `circuitBreakerThreshold` | `number`                        | `3`        | Failures before marking unhealthy |

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

## Author

[safdar-azeem](https://github.com/safdar-azeem)

## License

MIT
