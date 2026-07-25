import type { StudioHostConnectionFactory } from './studioHostConnectionPool';
import { normalizeStudioHostConnectionString } from './studioHostConnectionString';
import type { Executor } from './studioHostExecutorTypes';

/**
 * Real database wiring for the Studio host.
 *
 * This is the only module in the host that sees a connection string, and it
 * receives it from server-owned configuration exclusively. Everything above it
 * addresses databases by shard ID.
 *
 * The executor itself comes from `@prisma-sharding/studio`; the host does not
 * reimplement query execution, transactions, cancellation or SQL linting.
 */

interface PostgresJsModule {
  default?: (connectionString: string, options?: Record<string, unknown>) => PostgresSql;
  (connectionString: string, options?: Record<string, unknown>): PostgresSql;
}

interface PostgresSql {
  end(options?: { timeout?: number }): Promise<void>;
}

interface StudioCorePostgresJsModule {
  createPostgresJSExecutor(sql: PostgresSql): Executor;
  /**
   * Present in newer `@prisma-sharding/studio` releases. When absent the
   * connection string is handed to postgres.js unchanged, which is exactly the
   * pre-existing behaviour for URLs without client-side SSL file parameters.
   */
  createPostgresJSConnectionConfig?(connectionString: string): {
    connectionString: string;
    options: Record<string, unknown>;
  };
}

export interface CreateStudioHostPostgresConnectionFactoryOptions {
  /** Upper bound on connections held per selected shard. */
  maxConnectionsPerShard?: number;
  /** Seconds postgres.js keeps an unused connection before closing it. */
  idleConnectionTimeoutSeconds?: number;
  /** Seconds to wait for a connection before failing the request. */
  connectTimeoutSeconds?: number;
  /** Seconds to wait for in-flight queries during shutdown. */
  shutdownTimeoutSeconds?: number;
  /** Injection points for tests. */
  loadPostgres?: () => PostgresJsModule;
  loadStudioCore?: () => StudioCorePostgresJsModule;
}

const DEFAULT_MAX_CONNECTIONS_PER_SHARD = 4;
const DEFAULT_IDLE_CONNECTION_TIMEOUT_SECONDS = 30;
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10;
const DEFAULT_SHUTDOWN_TIMEOUT_SECONDS = 5;

export const createStudioHostPostgresConnectionFactory = (
  options: CreateStudioHostPostgresConnectionFactoryOptions = {}
): StudioHostConnectionFactory => {
  const {
    maxConnectionsPerShard = DEFAULT_MAX_CONNECTIONS_PER_SHARD,
    idleConnectionTimeoutSeconds = DEFAULT_IDLE_CONNECTION_TIMEOUT_SECONDS,
    connectTimeoutSeconds = DEFAULT_CONNECT_TIMEOUT_SECONDS,
    shutdownTimeoutSeconds = DEFAULT_SHUTDOWN_TIMEOUT_SECONDS,
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    loadPostgres = () => require('postgres') as PostgresJsModule,
    loadStudioCore = () =>
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('@prisma-sharding/studio/data/postgresjs') as StudioCorePostgresJsModule,
  } = options;

  return async (target) => {
    const postgresModule = loadPostgres();
    const postgres = postgresModule.default ?? postgresModule;
    const studioCore = loadStudioCore();

    // Prisma's driver arguments are consumed first. postgres.js forwards every
    // query parameter it does not recognise to the server as a startup
    // parameter, so a stock Prisma URL ending in `?schema=public` would fail
    // the connection outright before Studio could introspect anything.
    const prismaArguments = normalizeStudioHostConnectionString(target.url);

    // Then studio-core's SSL handling, which reads the libpq client-side
    // certificate parameters that postgres.js would otherwise also forward.
    const { connectionString, options: sslOptions } =
      studioCore.createPostgresJSConnectionConfig?.(prismaArguments.connectionString) ?? {
        connectionString: prismaArguments.connectionString,
        options: {},
      };

    const sql = postgres(connectionString, {
      ...sslOptions,
      ...prismaArguments.options,
      // A per-shard cap the operator did not ask for should not override
      // `?connection_limit=`, but the host still bounds it.
      max: Math.min(prismaArguments.options.max ?? maxConnectionsPerShard, maxConnectionsPerShard),
      idle_timeout: idleConnectionTimeoutSeconds,
      connect_timeout: connectTimeoutSeconds,
      // Studio owns error reporting; postgres.js printing notices to stdout
      // would bypass the CLI's output sanitization.
      onnotice: () => undefined,
    });

    return {
      executor: studioCore.createPostgresJSExecutor(sql),
      dispose: async () => {
        await sql.end({ timeout: shutdownTimeoutSeconds });
      },
    };
  };
};
