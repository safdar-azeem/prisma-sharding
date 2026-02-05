import type {
  ShardConfig,
  ShardInstance,
  ShardHealth,
  CrossShardResult,
  ShardingLogger,
  ClientFactory,
} from '../types';
import { DEFAULTS } from '../constants';
import { ConnectionError } from './errors';

interface ManagerConfig<TClient> {
  shards: ShardConfig[];
  createClient: ClientFactory<TClient>;
  healthCheckIntervalMs: number;
  circuitBreakerThreshold: number;
  logger: ShardingLogger;
}

export class ShardManager<TClient> {
  private instances: Map<string, ShardInstance<TClient>> = new Map();
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private config: ManagerConfig<TClient>;

  constructor(config: ManagerConfig<TClient>) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    this.config.logger.info(`Initializing ${this.config.shards.length} shard(s)...`);

    for (const shardConfig of this.config.shards) {
      this.initializeShard(shardConfig);
    }

    this.startHealthChecks();
    this.config.logger.info('All shards initialized successfully');
  }

  private initializeShard(shardConfig: ShardConfig): void {
    try {
      const client = this.config.createClient(shardConfig.url, shardConfig.id);

      const health: ShardHealth = {
        shardId: shardConfig.id,
        isHealthy: true,
        latencyMs: 0,
        lastChecked: new Date(),
        errorCount: 0,
        consecutiveFailures: 0,
      };

      this.instances.set(shardConfig.id, {
        config: shardConfig,
        client,
        health,
      });

      this.config.logger.info(`Shard ${shardConfig.id} initialized`);
    } catch (error) {
      this.config.logger.error(`Failed to initialize shard ${shardConfig.id}: ${error}`);
      throw new ConnectionError(`Failed to initialize shard ${shardConfig.id}`, shardConfig.id);
    }
  }

  private startHealthChecks(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    this.healthCheckInterval = setInterval(async () => {
      await this.performHealthChecks();
    }, this.config.healthCheckIntervalMs);
  }

  private async performHealthChecks(): Promise<void> {
    const checks = Array.from(this.instances.values()).map(async (instance) => {
      const startTime = Date.now();
      try {
        const client = instance.client as any;
        if (typeof client.$queryRaw === 'function') {
          await client.$queryRaw`SELECT 1`;
        }
        const latencyMs = Date.now() - startTime;

        instance.health = {
          ...instance.health,
          isHealthy: true,
          latencyMs,
          lastChecked: new Date(),
          consecutiveFailures: 0,
        };
      } catch (error) {
        const consecutiveFailures = instance.health.consecutiveFailures + 1;
        const isHealthy = consecutiveFailures < this.config.circuitBreakerThreshold;

        instance.health = {
          ...instance.health,
          isHealthy,
          latencyMs: -1,
          lastChecked: new Date(),
          errorCount: instance.health.errorCount + 1,
          consecutiveFailures,
        };

        if (!isHealthy) {
          this.config.logger.error(
            `Shard ${instance.config.id} marked unhealthy after ${consecutiveFailures} consecutive failures`
          );
        }
      }
    });

    await Promise.allSettled(checks);
  }

  getClient(shardId: string): TClient {
    const instance = this.instances.get(shardId);
    if (!instance) {
      throw new ConnectionError(`Shard ${shardId} not found`, shardId);
    }

    if (!instance.health.isHealthy) {
      this.config.logger.warn(`Accessing unhealthy shard ${shardId}`);
    }

    return instance.client;
  }

  getClientByIndex(index: number): TClient {
    const shardId = `shard_${index + 1}`;
    return this.getClient(shardId);
  }

  getAllClients(): TClient[] {
    return Array.from(this.instances.values()).map((instance) => instance.client);
  }

  getHealthyClients(): TClient[] {
    return Array.from(this.instances.values())
      .filter((instance) => instance.health.isHealthy)
      .map((instance) => instance.client);
  }

  getShardCount(): number {
    return this.instances.size;
  }

  getShardIds(): string[] {
    return Array.from(this.instances.keys());
  }

  getHealth(shardId: string): ShardHealth | undefined {
    return this.instances.get(shardId)?.health;
  }

  getAllHealth(): ShardHealth[] {
    return Array.from(this.instances.values()).map((instance) => instance.health);
  }

  async executeOnAll<T>(
    operation: (client: TClient, shardId: string) => Promise<T>
  ): Promise<CrossShardResult<T>[]> {
    const results = await Promise.allSettled(
      Array.from(this.instances.entries()).map(async ([shardId, instance]) => {
        try {
          const result = await operation(instance.client, shardId);
          return { shardId, result, error: undefined };
        } catch (error) {
          return { shardId, result: null, error: error as Error };
        }
      })
    );

    return results.map((result) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      return {
        shardId: 'unknown',
        result: null,
        error: result.reason as Error,
      };
    });
  }

  async findFirst<T>(
    operation: (client: TClient) => Promise<T | null>
  ): Promise<{ result: T | null; shardId: string | null }> {
    const results = await this.executeOnAll(operation);

    for (const res of results) {
      if (res.result !== null && res.result !== undefined) {
        return { result: res.result, shardId: res.shardId };
      }
    }

    return { result: null, shardId: null };
  }

  async shutdown(): Promise<void> {
    this.config.logger.info('Shutting down...');

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    const disconnects = Array.from(this.instances.values()).map(async (instance) => {
      try {
        const client = instance.client as any;
        if (typeof client.$disconnect === 'function') {
          await client.$disconnect();
        }
        this.config.logger.info(`Shard ${instance.config.id} disconnected`);
      } catch (error) {
        this.config.logger.error(`Error disconnecting shard ${instance.config.id}: ${error}`);
      }
    });

    await Promise.allSettled(disconnects);
    this.instances.clear();

    this.config.logger.info('Shutdown complete');
  }
}
