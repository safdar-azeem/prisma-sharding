export const DEFAULTS = {
  POOL_MAX_CONNECTIONS: 10,
  POOL_IDLE_TIMEOUT_MS: 10000,
  POOL_CONNECTION_TIMEOUT_MS: 5000,
  HEALTH_CHECK_INTERVAL_MS: 30000,
  CIRCUIT_BREAKER_THRESHOLD: 3,
  CONSISTENT_HASH_VIRTUAL_NODES: 150,
} as const;

export const ERROR_MESSAGES = {
  NO_SHARDS: 'At least one shard must be configured',
  SHARD_NOT_FOUND: (id: string) => `Shard "${id}" not found`,
  NO_HEALTHY_SHARDS: 'No healthy shards available',
  INVALID_STRATEGY: (s: string) =>
    `Invalid routing strategy: "${s}". Use "modulo" or "consistent-hash"`,
  NOT_CONNECTED: 'Sharding not connected. Call connect() first',
  ALREADY_CONNECTED: 'Sharding already connected',
  MISSING_CLIENT_FACTORY: 'createClient function is required',
  INVALID_SHARD_URL: (id: string) => `Invalid or missing URL for shard "${id}"`,
} as const;
