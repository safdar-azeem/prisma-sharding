import type { Executor } from './studioHostExecutorTypes';
import { StudioHostTarget } from './studioHostTargets';

/**
 * Creates the database client and Studio executor for one shard.
 *
 * Injected so the pool can be exercised without a real database, and so the
 * `postgres` / `prisma-studio-next` imports stay at the edge of the host.
 */
export type StudioHostConnectionFactory = (target: StudioHostTarget) => Promise<{
  executor: Executor;
  dispose: () => Promise<void>;
}>;

export interface StudioHostConnectionPoolOptions {
  createConnection: StudioHostConnectionFactory;
  /**
   * How many shards may hold an open connection at once. Studio only ever
   * queries the selected shard, so a small bound keeps a 40-shard project from
   * holding 40 idle pools open.
   */
  maxOpenConnections?: number;
  /** Idle connections are disposed after this long. */
  idleTimeoutMs?: number;
  now?: () => number;
  setTimer?: (handler: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
  onError?: (message: string, error: unknown) => void;
}

interface PooledConnection {
  executor: Executor;
  dispose: () => Promise<void>;
  lastUsedAt: number;
  inFlight: number;
}

export interface StudioHostConnectionPool {
  /** Resolves (creating if needed) the executor bound to one shard. */
  acquire(target: StudioHostTarget): Promise<Executor>;
  /** Marks a request against a shard as finished, making it evictable again. */
  release(shardId: string): void;
  /** Closes one shard's connection; used when configuration drops a shard. */
  evict(shardId: string): Promise<void>;
  /** Closes everything. Safe to call repeatedly. */
  dispose(): Promise<void>;
  readonly openShardIds: string[];
}

const DEFAULT_MAX_OPEN_CONNECTIONS = 3;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

/**
 * Lazy, bounded, idle-expiring connection cache keyed by shard.
 *
 * Nothing is opened until a shard is actually queried, so starting Studio for
 * a project with many shards costs one HTTP server and zero database
 * connections. Reuse keeps switching back and forth responsive; the bound and
 * the idle timer keep the host from accumulating pools it no longer needs.
 */
export const createStudioHostConnectionPool = (
  options: StudioHostConnectionPoolOptions
): StudioHostConnectionPool => {
  const {
    createConnection,
    maxOpenConnections = DEFAULT_MAX_OPEN_CONNECTIONS,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    now = () => Date.now(),
    setTimer = (handler, ms) => setTimeout(handler, ms),
    clearTimer = (timer) => clearTimeout(timer),
    onError,
  } = options;

  const connections = new Map<string, PooledConnection>();
  const pending = new Map<string, Promise<PooledConnection>>();
  let sweepTimer: NodeJS.Timeout | undefined;
  let isDisposed = false;

  const reportError = (message: string, error: unknown): void => {
    if (onError) {
      onError(message, error);
    }
  };

  const closeConnection = async (shardId: string, connection: PooledConnection): Promise<void> => {
    connections.delete(shardId);

    try {
      await connection.dispose();
    } catch (error) {
      reportError(`Failed to close the ${shardId} database connection`, error);
    }
  };

  const stopSweep = (): void => {
    if (sweepTimer) {
      clearTimer(sweepTimer);
      sweepTimer = undefined;
    }
  };

  const sweepIdleConnections = (): void => {
    const cutoff = now() - idleTimeoutMs;

    for (const [shardId, connection] of [...connections.entries()]) {
      if (connection.inFlight === 0 && connection.lastUsedAt <= cutoff) {
        void closeConnection(shardId, connection);
      }
    }

    if (connections.size === 0) {
      stopSweep();
    }
  };

  const scheduleSweep = (): void => {
    if (sweepTimer || isDisposed || idleTimeoutMs <= 0) {
      return;
    }

    sweepTimer = setTimer(() => {
      sweepTimer = undefined;
      sweepIdleConnections();
      scheduleSweep();
    }, idleTimeoutMs);

    // A sweep timer must never be the reason the process stays alive.
    sweepTimer.unref?.();
  };

  /** Closes the least recently used idle connection to stay within the bound. */
  const enforceBound = async (): Promise<void> => {
    while (connections.size >= maxOpenConnections) {
      const evictable = [...connections.entries()]
        .filter(([, connection]) => connection.inFlight === 0)
        .sort(([, left], [, right]) => left.lastUsedAt - right.lastUsedAt)[0];

      if (!evictable) {
        // Everything open is mid-request; the bound is advisory, not a reason
        // to fail a legitimate query.
        return;
      }

      await closeConnection(evictable[0], evictable[1]);
    }
  };

  return {
    get openShardIds() {
      return [...connections.keys()];
    },

    async acquire(target) {
      if (isDisposed) {
        throw new Error('The Studio host connection pool has been disposed.');
      }

      const existing = connections.get(target.id);

      if (existing) {
        existing.inFlight += 1;
        existing.lastUsedAt = now();
        return existing.executor;
      }

      // Two concurrent requests for a cold shard must open one connection, not
      // two, and the loser must not leak the connection it did not win. The
      // shared promise is therefore registered synchronously, before the first
      // await: any suspension between the lookup and the registration would
      // let every concurrent caller start its own connection.
      let createPromise = pending.get(target.id);

      if (!createPromise) {
        createPromise = (async (): Promise<PooledConnection> => {
          await enforceBound();

          const created = await createConnection(target);

          return {
            executor: created.executor,
            dispose: created.dispose,
            lastUsedAt: now(),
            inFlight: 0,
          };
        })();

        pending.set(target.id, createPromise);
      } else {
        const connection = await createPromise;
        connection.inFlight += 1;
        connection.lastUsedAt = now();
        return connection.executor;
      }

      const connection = await createPromise.finally(() => {
        // Cleared whether the connection opened or failed, so a database that
        // was down when first queried can be retried on the next request.
        pending.delete(target.id);
      });

      if (isDisposed) {
        await connection.dispose().catch((error) => {
          reportError(`Failed to close the ${target.id} database connection`, error);
        });
        throw new Error('The Studio host connection pool has been disposed.');
      }

      connections.set(target.id, connection);
      connection.inFlight += 1;
      connection.lastUsedAt = now();
      scheduleSweep();

      return connection.executor;
    },

    release(shardId) {
      const connection = connections.get(shardId);

      if (!connection) {
        return;
      }

      connection.inFlight = Math.max(0, connection.inFlight - 1);
      connection.lastUsedAt = now();
    },

    async evict(shardId) {
      const connection = connections.get(shardId);

      if (connection) {
        await closeConnection(shardId, connection);
      }
    },

    async dispose() {
      isDisposed = true;
      stopSweep();

      const open = [...connections.entries()];
      connections.clear();

      await Promise.all(
        open.map(async ([shardId, connection]) => {
          try {
            await connection.dispose();
          } catch (error) {
            reportError(`Failed to close the ${shardId} database connection`, error);
          }
        })
      );
    },
  };
};
