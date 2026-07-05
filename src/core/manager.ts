import { INTERNAL_DEFAULTS } from '../constants/internal';
import { sanitizeDatabaseText } from '../utils/sanitize';
import type {
  ShardConfig,
  ShardInstance,
  ShardHealth,
  CrossShardResult,
  ShardingLogger,
  ClientFactory,
} from '../types';
import { ConnectionError } from './errors';
import { CrossShardExecutor, CrossShardTarget } from './executor';

interface ManagerConfig<TClient> {
  shards: ShardConfig[];
  createClient: ClientFactory<TClient>;
  healthCheckIntervalMs: number;
  circuitBreakerThreshold: number;
  logger: ShardingLogger;
}

interface ConnectableClient {
  $connect: () => Promise<unknown> | unknown;
}

interface DisconnectableClient {
  $disconnect: () => Promise<unknown> | unknown;
}

interface QueryableClient {
  $queryRaw: (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<unknown> | unknown;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isConnectable = (client: unknown): client is ConnectableClient =>
  isObject(client) && typeof client.$connect === 'function';

const isDisconnectable = (client: unknown): client is DisconnectableClient =>
  isObject(client) && typeof client.$disconnect === 'function';

const isQueryable = (client: unknown): client is QueryableClient =>
  isObject(client) && typeof client.$queryRaw === 'function';

const withTimeout = <T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(timeoutMessage));
      }
    }, timeoutMs);

    operation.then(
      (result) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(result);
        }
      },
      (error: unknown) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      }
    );
  });

export class ShardManager<TClient> {
  private readonly instances: Map<string, ShardInstance<TClient>> = new Map();
  private readonly config: ManagerConfig<TClient>;
  private readonly executor: CrossShardExecutor<TClient>;
  private readonly unhealthyAccessWarnings = new Set<string>();
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private healthCheckInFlight = false;
  private healthCheckPromise: Promise<void> | null = null;

  constructor(config: ManagerConfig<TClient>) {
    this.config = config;
    this.executor = new CrossShardExecutor<TClient>();
  }

  async initialize(): Promise<void> {
    this.config.logger.info(`Initializing ${this.config.shards.length} shard(s)...`);

    try {
      for (const shardConfig of this.config.shards) {
        this.initializeShard(shardConfig);
      }
    } catch (error) {
      await this.disconnectInstances();
      this.instances.clear();
      throw error;
    }

    void this.performHealthChecks(true).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.config.logger.error(`Initial shard health verification failed: ${message}`);
    });
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
      const message = sanitizeDatabaseText(String(error), [shardConfig.url]);
      this.config.logger.error(`Failed to initialize shard ${shardConfig.id}: ${message}`);
      throw new ConnectionError(`Failed to initialize shard ${shardConfig.id}`, shardConfig.id);
    }
  }

  private startHealthChecks(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    this.healthCheckInterval = setInterval(() => {
      if (!this.healthCheckInFlight) {
        void this.performHealthChecks(false);
      }
    }, this.config.healthCheckIntervalMs);
    this.healthCheckInterval.unref?.();
  }

  private async verifyShard(
    instance: ShardInstance<TClient>,
    warmConnection: boolean
  ): Promise<void> {
    const startTime = Date.now();
    const previousHealth = instance.health;

    try {
      const verification = async () => {
        if (warmConnection && isConnectable(instance.client)) {
          await instance.client.$connect();
        }
        if (isQueryable(instance.client)) {
          await instance.client.$queryRaw`SELECT 1`;
        }
      };

      await withTimeout(
        verification(),
        INTERNAL_DEFAULTS.HEALTH_CHECK_TIMEOUT_MS,
        `Health check timed out for shard ${instance.config.id}`
      );

      instance.health = {
        ...previousHealth,
        isHealthy: true,
        latencyMs: Date.now() - startTime,
        lastChecked: new Date(),
        consecutiveFailures: 0,
      };
      this.unhealthyAccessWarnings.delete(instance.config.id);
      if (!previousHealth.isHealthy && previousHealth.consecutiveFailures > 0) {
        this.config.logger.info(`Shard ${instance.config.id} recovered`);
      }
    } catch (error) {
      const consecutiveFailures = previousHealth.consecutiveFailures + 1;
      const wasVerifiedHealthy = previousHealth.isHealthy;
      const isHealthy = warmConnection
        ? false
        : wasVerifiedHealthy && consecutiveFailures < this.config.circuitBreakerThreshold;

      instance.health = {
        ...previousHealth,
        isHealthy,
        latencyMs: -1,
        lastChecked: new Date(),
        errorCount: previousHealth.errorCount + 1,
        consecutiveFailures,
      };

      const message = sanitizeDatabaseText(
        error instanceof Error ? error.message : String(error),
        [instance.config.url]
      );
      const isFirstFailure = previousHealth.errorCount === 0;
      const becameUnhealthy = previousHealth.isHealthy && !isHealthy;
      if (isFirstFailure || becameUnhealthy) {
        this.config.logger.error(
          `Health check failed for ${instance.config.id}: ${message}${
            !isHealthy ? '; shard marked unhealthy' : ''
          }`
        );
      }
    }
  }

  private performHealthChecks(warmConnections: boolean): Promise<void> {
    if (this.healthCheckInFlight) {
      return this.healthCheckPromise ?? Promise.resolve();
    }

    this.healthCheckInFlight = true;
    const operation = this.executor
      .executeAll(this.getExecutionTargets(), async (_client, shardId) => {
        const instance = this.instances.get(shardId);
        if (instance) {
          await this.verifyShard(instance, warmConnections);
        }
        return null;
      })
      .then(() => undefined)
      .finally(() => {
        this.healthCheckInFlight = false;
        this.healthCheckPromise = null;
      });

    this.healthCheckPromise = operation;
    return operation;
  }

  private getExecutionTargets(): CrossShardTarget<TClient>[] {
    return Array.from(this.instances.values()).map((instance) => ({
      shardId: instance.config.id,
      client: instance.client,
      isHealthy: instance.health.isHealthy,
      latencyMs: instance.health.latencyMs,
    }));
  }

  getClient(shardId: string): TClient {
    const instance = this.instances.get(shardId);
    if (!instance) {
      throw new ConnectionError(`Shard ${shardId} not found`, shardId);
    }

    if (!instance.health.isHealthy && !this.unhealthyAccessWarnings.has(shardId)) {
      this.unhealthyAccessWarnings.add(shardId);
      this.config.logger.warn(`Accessing unhealthy shard ${shardId}`);
    }

    return instance.client;
  }

  getClientByIndex(index: number): TClient {
    const shardId = this.getShardIds()[index];
    if (!shardId) {
      throw new ConnectionError(`Shard index ${index} not found`, String(index));
    }
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

  executeOnAll<T>(
    operation: (client: TClient, shardId: string) => Promise<T>
  ): Promise<CrossShardResult<T>[]> {
    return this.executor.executeAll(this.getExecutionTargets(), operation);
  }

  findFirst<T>(
    operation: (client: TClient) => Promise<T | null>
  ): Promise<{ result: T | null; shardId: string | null }> {
    return this.executor.findFirst(this.getExecutionTargets(), operation);
  }

  private async disconnectInstances(): Promise<void> {
    const disconnects = Array.from(this.instances.values()).map(async (instance) => {
      try {
        if (isDisconnectable(instance.client)) {
          await instance.client.$disconnect();
        }
        this.config.logger.info(`Shard ${instance.config.id} disconnected`);
      } catch (error) {
        const message = sanitizeDatabaseText(String(error), [instance.config.url]);
        this.config.logger.error(`Error disconnecting shard ${instance.config.id}: ${message}`);
      }
    });

    await Promise.allSettled(disconnects);
  }

  async shutdown(): Promise<void> {
    this.config.logger.info('Shutting down...');

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    if (this.healthCheckPromise) {
      await this.healthCheckPromise;
    }

    await this.disconnectInstances();
    this.instances.clear();
    this.unhealthyAccessWarnings.clear();

    this.config.logger.info('Shutdown complete');
  }
}
