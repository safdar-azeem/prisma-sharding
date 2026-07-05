import type {
  ShardingConfig,
  ShardHealth,
  FindFirstResult,
  CrossShardResult,
  ShardingLogger,
  ShardResult,
} from '../types';
import { ShardRouter } from './router';
import { ShardManager } from './manager';
import { ConfigError, ShardingError } from './errors';
import { DEFAULTS, ERROR_MESSAGES } from '../constants';
import { createDefaultLogger, validateUrl } from '../utils';

export class PrismaSharding<TClient> {
  private manager: ShardManager<TClient> | null = null;
  private router: ShardRouter | null = null;
  private config: ShardingConfig<TClient>;
  private logger: ShardingLogger;
  private connected = false;

  constructor(config: ShardingConfig<TClient>) {
    this.validateConfig(config);
    this.config = config;
    this.logger = config.logger || createDefaultLogger();
  }

  private validateConfig(config: ShardingConfig<TClient>): void {
    if (!config.shards || config.shards.length === 0) {
      throw new ConfigError(ERROR_MESSAGES.NO_SHARDS);
    }

    if (typeof config.createClient !== 'function') {
      throw new ConfigError(ERROR_MESSAGES.MISSING_CLIENT_FACTORY);
    }

    const shardIds = new Set<string>();
    for (const shard of config.shards) {
      if (!shard.id || shard.id.trim().length === 0) {
        throw new ConfigError('Shard ID must not be empty');
      }
      if (shardIds.has(shard.id)) {
        throw new ConfigError(`Duplicate shard ID: "${shard.id}"`);
      }
      shardIds.add(shard.id);

      if (!shard.url || !validateUrl(shard.url)) {
        throw new ConfigError(ERROR_MESSAGES.INVALID_SHARD_URL(shard.id));
      }
      if (shard.weight !== undefined && (!Number.isFinite(shard.weight) || shard.weight <= 0)) {
        throw new ConfigError(`Weight for shard "${shard.id}" must be positive`);
      }
    }

    if (config.strategy && config.strategy !== 'modulo' && config.strategy !== 'consistent-hash') {
      throw new ConfigError(ERROR_MESSAGES.INVALID_STRATEGY(config.strategy));
    }

    if (
      config.healthCheckIntervalMs !== undefined &&
      (!Number.isFinite(config.healthCheckIntervalMs) || config.healthCheckIntervalMs <= 0)
    ) {
      throw new ConfigError('healthCheckIntervalMs must be positive');
    }

    if (
      config.circuitBreakerThreshold !== undefined &&
      (!Number.isFinite(config.circuitBreakerThreshold) || config.circuitBreakerThreshold <= 0)
    ) {
      throw new ConfigError('circuitBreakerThreshold must be positive');
    }
  }

  async connect(): Promise<void> {
    if (this.connected) {
      this.logger.warn(ERROR_MESSAGES.ALREADY_CONNECTED);
      return;
    }

    this.manager = new ShardManager<TClient>({
      shards: this.config.shards,
      createClient: this.config.createClient,
      healthCheckIntervalMs: this.config.healthCheckIntervalMs ?? DEFAULTS.HEALTH_CHECK_INTERVAL_MS,
      circuitBreakerThreshold:
        this.config.circuitBreakerThreshold ?? DEFAULTS.CIRCUIT_BREAKER_THRESHOLD,
      logger: this.logger,
    });

    try {
      await this.manager.initialize();
    } catch (error) {
      this.manager = null;
      this.router = null;
      this.connected = false;
      throw error;
    }

    this.router = new ShardRouter({
      strategy: this.config.strategy ?? 'modulo',
      shardIds: this.manager.getShardIds(),
      shardWeights: new Map(
        this.config.shards.map((shard) => [shard.id, shard.weight ?? 1])
      ),
      logger: this.logger,
    });

    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (!this.connected || !this.manager) {
      return;
    }

    await this.manager.shutdown();
    this.manager = null;
    this.router = null;
    this.connected = false;
  }

  private ensureConnected(): void {
    if (!this.connected || !this.manager || !this.router) {
      throw new ShardingError(ERROR_MESSAGES.NOT_CONNECTED);
    }
  }

  getShard(key: string): TClient {
    this.ensureConnected();
    const shardId = this.router!.getShardId(key);
    return this.manager!.getClient(shardId);
  }

  getShardById(shardId: string): TClient {
    this.ensureConnected();
    return this.manager!.getClient(shardId);
  }

  getShardWithInfo(key: string): ShardResult<TClient> {
    this.ensureConnected();
    const shardId = this.router!.getShardId(key);
    return {
      shardId,
      client: this.manager!.getClient(shardId),
    };
  }

  getRandomShard(): TClient {
    this.ensureConnected();
    const shardId = this.router!.getRandomShardId();
    return this.manager!.getClient(shardId);
  }

  /**
   * Returns both the random shard client and its shardId.
   * Used when the shardId must be stored on the user record for future routing.
   */
  getRandomShardWithInfo(): ShardResult<TClient> {
    this.ensureConnected();
    const shardId = this.router!.getRandomShardId();
    return {
      shardId,
      client: this.manager!.getClient(shardId),
    };
  }

  async findFirst<T>(
    finder: (client: TClient) => Promise<T | null>
  ): Promise<FindFirstResult<T, TClient>> {
    this.ensureConnected();

    const { result, shardId } = await this.manager!.findFirst(finder);

    if (result !== null && shardId !== null) {
      return {
        result,
        shardId,
        client: this.manager!.getClient(shardId),
      };
    }

    return { result: null, shardId: null, client: null };
  }

  async runOnAll<T>(operation: (client: TClient, shardId: string) => Promise<T>): Promise<T[]> {
    this.ensureConnected();

    const results = await this.manager!.executeOnAll(operation);
    return results.filter((r) => r.result !== null && !r.error).map((r) => r.result as T);
  }

  async runOnAllWithDetails<T>(
    operation: (client: TClient, shardId: string) => Promise<T>
  ): Promise<CrossShardResult<T>[]> {
    this.ensureConnected();
    return this.manager!.executeOnAll(operation);
  }

  getHealth(): ShardHealth[] {
    this.ensureConnected();
    return this.manager!.getAllHealth();
  }

  getHealthByShard(shardId: string): ShardHealth | undefined {
    this.ensureConnected();
    return this.manager!.getHealth(shardId);
  }

  getAllClients(): TClient[] {
    this.ensureConnected();
    return this.manager!.getAllClients();
  }

  getHealthyClients(): TClient[] {
    this.ensureConnected();
    return this.manager!.getHealthyClients();
  }

  getShardCount(): number {
    this.ensureConnected();
    return this.manager!.getShardCount();
  }

  getShardIds(): string[] {
    this.ensureConnected();
    return this.manager!.getShardIds();
  }

  isConnected(): boolean {
    return this.connected;
  }
}
