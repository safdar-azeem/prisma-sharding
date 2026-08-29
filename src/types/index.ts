export interface ShardConfig {
  id: string;
  url: string;
  weight?: number;
  isReadReplica?: boolean;
}

export interface PoolConfig {
  maxConnections?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
}

export interface ShardHealth {
  shardId: string;
  isHealthy: boolean;
  latencyMs: number;
  lastChecked: Date;
  errorCount: number;
  consecutiveFailures: number;
}

export type ShardHealthStatus = 'healthy' | 'unhealthy' | 'unknown';

export interface ShardInspection {
  shardId: string;
  status: ShardHealthStatus;
  latencyMs: number | null;
}

export interface ShardInstance<TClient> {
  config: ShardConfig;
  client: TClient;
  health: ShardHealth;
}

export interface ShardResult<TClient> {
  shardId: string;
  client: TClient;
}

export interface CrossShardResult<T> {
  shardId: string;
  result: T | null;
  error?: Error;
}

export interface FindFirstResult<T, TClient> {
  result: T | null;
  shardId: string | null;
  client: TClient | null;
}

export interface ShardFindResult<T, TClient> {
  data: T | null;
  shardId: string | null;
  client: TClient | null;
}

export interface ShardRunResult<T> {
  shardId: string;
  data: T | null;
  error: Error | null;
}

export type RoutingStrategy = 'modulo' | 'consistent-hash';

export interface ShardingConfig<TClient> {
  shards: ShardConfig[];
  strategy?: RoutingStrategy;
  createClient: (url: string, shardId: string) => TClient;
  pool?: PoolConfig;
  healthCheckIntervalMs?: number;
  circuitBreakerThreshold?: number;
  logger?: ShardingLogger;
}

export interface ShardingLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export type ClientFactory<TClient> = (url: string, shardId: string) => TClient;
