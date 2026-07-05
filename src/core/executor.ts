import { INTERNAL_DEFAULTS } from '../constants/internal';
import type { CrossShardResult } from '../types';

export interface CrossShardTarget<TClient> {
  shardId: string;
  client: TClient;
  isHealthy: boolean;
  latencyMs: number;
}

interface ExecutorConfig {
  concurrency?: number;
  timeoutMs?: number;
}

interface ExecutorMetrics {
  operationCount: number;
  timeoutCount: number;
  failuresByShard: Map<string, number>;
}

const timeoutError = (shardId: string, timeoutMs: number): Error =>
  new Error(`Shard ${shardId} operation timed out after ${timeoutMs}ms`);

export class CrossShardExecutor<TClient> {
  private readonly concurrency: number;
  private readonly timeoutMs: number;
  private readonly metrics: ExecutorMetrics = {
    operationCount: 0,
    timeoutCount: 0,
    failuresByShard: new Map(),
  };

  constructor(config: ExecutorConfig = {}) {
    this.concurrency = config.concurrency ?? INTERNAL_DEFAULTS.CROSS_SHARD_CONCURRENCY;
    this.timeoutMs = config.timeoutMs ?? INTERNAL_DEFAULTS.CROSS_SHARD_TIMEOUT_MS;
  }

  private orderedTargets(targets: CrossShardTarget<TClient>[]): CrossShardTarget<TClient>[] {
    return targets
      .map((target, index) => ({ target, index }))
      .sort((left, right) => {
        if (left.target.isHealthy !== right.target.isHealthy) {
          return left.target.isHealthy ? -1 : 1;
        }

        const leftLatency =
          left.target.latencyMs >= 0 ? left.target.latencyMs : Number.POSITIVE_INFINITY;
        const rightLatency =
          right.target.latencyMs >= 0 ? right.target.latencyMs : Number.POSITIVE_INFINITY;
        return leftLatency - rightLatency || left.index - right.index;
      })
      .map(({ target }) => target);
  }

  private recordFailure(shardId: string, error: Error): void {
    this.metrics.failuresByShard.set(
      shardId,
      (this.metrics.failuresByShard.get(shardId) ?? 0) + 1
    );
    if (error.message.includes('timed out')) {
      this.metrics.timeoutCount++;
    }
  }

  private withTimeout<T>(shardId: string, operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const timer = setTimeout(() => {
        finish(() => reject(timeoutError(shardId, this.timeoutMs)));
      }, this.timeoutMs);

      Promise.resolve()
        .then(operation)
        .then(
          (result) => finish(() => resolve(result)),
          (error: unknown) => finish(() => reject(error))
        );
    });
  }

  async executeAll<T>(
    targets: CrossShardTarget<TClient>[],
    operation: (client: TClient, shardId: string) => Promise<T>
  ): Promise<CrossShardResult<T>[]> {
    this.metrics.operationCount++;
    const originalIndexes = new Map(targets.map((target, index) => [target.shardId, index]));
    const ordered = this.orderedTargets(targets);
    const results = new Array<CrossShardResult<T>>(targets.length);
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
      while (nextIndex < ordered.length) {
        const target = ordered[nextIndex++];
        const resultIndex = originalIndexes.get(target.shardId)!;

        try {
          const result = await this.withTimeout(target.shardId, () =>
            operation(target.client, target.shardId)
          );
          results[resultIndex] = { shardId: target.shardId, result, error: undefined };
        } catch (error) {
          const normalizedError = error instanceof Error ? error : new Error(String(error));
          this.recordFailure(target.shardId, normalizedError);
          results[resultIndex] = {
            shardId: target.shardId,
            result: null,
            error: normalizedError,
          };
        }
      }
    };

    const workerCount = Math.min(this.concurrency, ordered.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
  }

  findFirst<T>(
    targets: CrossShardTarget<TClient>[],
    operation: (client: TClient) => Promise<T | null>
  ): Promise<{ result: T | null; shardId: string | null }> {
    this.metrics.operationCount++;
    const ordered = this.orderedTargets(targets);

    return new Promise((resolve) => {
      if (ordered.length === 0) {
        resolve({ result: null, shardId: null });
        return;
      }

      let nextIndex = 0;
      let active = 0;
      let completed = 0;
      let found = false;

      const launch = () => {
        while (!found && active < this.concurrency && nextIndex < ordered.length) {
          const target = ordered[nextIndex++];
          active++;

          this.withTimeout(target.shardId, () => operation(target.client))
            .then((result) => {
              if (!found && result !== null && result !== undefined) {
                found = true;
                resolve({ result, shardId: target.shardId });
              }
            })
            .catch((error: unknown) => {
              const normalizedError = error instanceof Error ? error : new Error(String(error));
              this.recordFailure(target.shardId, normalizedError);
            })
            .finally(() => {
              active--;
              completed++;

              if (!found && completed === ordered.length) {
                resolve({ result: null, shardId: null });
                return;
              }

              launch();
            });
        }
      };

      launch();
    });
  }
}
