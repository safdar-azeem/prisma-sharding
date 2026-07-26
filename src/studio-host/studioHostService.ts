import {
  executeStudioHostBffRequest,
  StudioHostBffRequest,
  StudioHostBffResponse,
} from './studioHostBff';
import {
  createStudioHostConnectionPool,
  StudioHostConnectionFactory,
  StudioHostConnectionPool,
} from './studioHostConnectionPool';
import type { Executor } from './studioHostExecutorTypes';
import { computeStudioHostFingerprint } from './studioHostIdentity';
import {
  assertStudioShardManifestIsSafe,
  buildStudioShardManifest,
  StudioShardManifest,
  StudioShardManifestUi,
  StudioShardStatus,
} from './studioHostManifest';
import {
  findStudioHostTarget,
  NO_STUDIO_TARGETS_MESSAGE,
  resolveStudioHostTargets,
  StudioHostTarget,
  StudioHostTargetsResult,
} from './studioHostTargets';

/**
 * Header carrying the selected shard.
 *
 * Studio's own BFF client cannot set arbitrary per-request headers, so the
 * browser normally sends the shard in `customPayload`. The header exists for
 * embedders that prefer to inject the shard at their proxy layer.
 */
export const STUDIO_HOST_SHARD_HEADER = 'x-prisma-shard-id';

export interface StudioHostRequestContext {
  /** Lower-cased request headers, when the transport has them. */
  headers?: Readonly<Record<string, string | string[] | undefined>>;
  /** Opaque value the embedder attaches, e.g. an authenticated session. */
  auth?: unknown;
}

export interface StudioHostAuthorizationInput extends StudioHostRequestContext {
  /** Shard the request is asking for, already known to exist in configuration. */
  shardId: string;
  procedure: string;
  customPayload?: Record<string, unknown>;
}

export type StudioHostAuthorizationResult =
  | true
  | false
  | { allowed: true }
  | { allowed: false; status?: number; message?: string };

export interface StudioHostLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface StudioHostServiceOptions {
  /** Environment to discover shards from. Defaults to the invoking process. */
  env?: NodeJS.ProcessEnv;
  /** Project that owns the configuration. Defaults to `process.cwd()`. */
  projectRoot?: string;
  /** Resolved Prisma schema path, used only for host identity. */
  schemaPath?: string;
  /**
   * Called before any database work for every shard-bound request.
   *
   * CLI usage binds to a loopback interface and defaults to allowing local
   * requests. Consuming applications that mount the service on a network-
   * reachable endpoint MUST supply this.
   */
  authorize?: (
    input: StudioHostAuthorizationInput
  ) => StudioHostAuthorizationResult | Promise<StudioHostAuthorizationResult>;
  createConnection: StudioHostConnectionFactory;
  maxOpenConnections?: number;
  idleTimeoutMs?: number;
  logger?: StudioHostLogger;
  /** Presentation preferences forwarded to Studio in the manifest. */
  ui?: Partial<StudioShardManifestUi>;
}

export interface StudioHostService {
  readonly fingerprint: string;
  readonly projectRoot: string;
  readonly targets: readonly StudioHostTarget[];
  readonly targetsResult: StudioHostTargetsResult;
  /** Sanitized, credential-free description of the selectable databases. */
  getManifest(): StudioShardManifest;
  /** Lightweight liveness probe for one shard; opens a connection on demand. */
  checkShard(shardId: unknown): Promise<{ status: StudioShardStatus; message?: string }>;
  handleBffRequest(
    request: StudioHostBffRequest,
    context?: StudioHostRequestContext
  ): Promise<StudioHostBffResponse>;
  dispose(): Promise<void>;
  /** Exposed for lifecycle tests and shutdown assertions. */
  readonly openShardIds: string[];
}

const readHeader = (
  headers: StudioHostRequestContext['headers'],
  name: string
): string | undefined => {
  const value = headers?.[name];

  if (Array.isArray(value)) {
    return value[0];
  }

  return typeof value === 'string' ? value : undefined;
};

/**
 * Extracts the requested shard from a request without trusting it.
 *
 * Returns the raw candidate only; validation against server-owned
 * configuration happens in {@link createStudioHostService}. A request carrying
 * conflicting hints in the payload and the header is rejected rather than
 * silently resolved in favour of one of them.
 */
export const readRequestedShardId = (
  request: StudioHostBffRequest,
  context: StudioHostRequestContext = {}
): { shardId?: string; conflict?: boolean } => {
  const payloadShardId = request.customPayload?.shardId;
  const headerShardId = readHeader(context.headers, STUDIO_HOST_SHARD_HEADER);
  const fromPayload = typeof payloadShardId === 'string' ? payloadShardId.trim() : undefined;
  const fromHeader = headerShardId?.trim();

  if (fromPayload && fromHeader && fromPayload !== fromHeader) {
    return { conflict: true };
  }

  return { shardId: fromPayload || fromHeader || undefined };
};

/**
 * Guards against a client trying to smuggle a connection target into a request.
 *
 * The host resolves every URL from its own configuration, so any URL-shaped
 * field in `customPayload` is either a mistake or an attack; either way the
 * request is refused instead of partially honoured.
 */
const hasForbiddenConnectionFields = (
  customPayload: Record<string, unknown> | undefined
): boolean => {
  if (!customPayload) {
    return false;
  }

  const forbiddenKeys = ['url', 'databaseUrl', 'connectionString', 'dsn', 'shardUrl'];

  return Object.entries(customPayload).some(([key, value]) => {
    if (forbiddenKeys.includes(key)) {
      return true;
    }

    return typeof value === 'string' && /^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim());
  });
};

export const createStudioHostService = (
  options: StudioHostServiceOptions
): StudioHostService => {
  const {
    env = process.env,
    projectRoot = process.cwd(),
    schemaPath = '',
    authorize,
    createConnection,
    maxOpenConnections,
    idleTimeoutMs,
    logger,
    ui,
  } = options;

  const targetsResult = resolveStudioHostTargets(env);
  const { targets } = targetsResult;

  if (targets.length === 0) {
    throw new Error(NO_STUDIO_TARGETS_MESSAGE);
  }

  const fingerprint = computeStudioHostFingerprint({
    projectRoot,
    schemaPath,
    targets,
  });

  const pool: StudioHostConnectionPool = createStudioHostConnectionPool({
    createConnection,
    maxOpenConnections,
    idleTimeoutMs,
    onError: (message, error) => {
      logger?.warn(`${message}: ${error instanceof Error ? error.message : String(error)}`);
    },
  });

  const statusById: Record<string, { status: StudioShardStatus; message?: string }> = {};

  const buildManifest = (): StudioShardManifest => {
    const manifest = buildStudioShardManifest(targetsResult, { statusById, ui });
    // The manifest is the only shard-derived payload the browser receives.
    assertStudioShardManifestIsSafe(manifest, targets);
    return manifest;
  };

  const resolveAuthorization = async (
    input: StudioHostAuthorizationInput
  ): Promise<{ allowed: boolean; status: number; message: string }> => {
    if (!authorize) {
      return { allowed: true, status: 200, message: '' };
    }

    let outcome: StudioHostAuthorizationResult;

    try {
      outcome = await authorize(input);
    } catch (error) {
      logger?.error(
        `Studio host authorization threw: ${error instanceof Error ? error.message : String(error)}`
      );
      // A throwing authorizer is a deny, never an accidental allow.
      return { allowed: false, status: 500, message: 'Authorization failed' };
    }

    if (outcome === true || (typeof outcome === 'object' && outcome?.allowed === true)) {
      return { allowed: true, status: 200, message: '' };
    }

    const denial = typeof outcome === 'object' && outcome !== null ? outcome : undefined;

    return {
      allowed: false,
      status: denial && 'status' in denial && denial.status ? denial.status : 403,
      message: (denial && 'message' in denial && denial.message) || 'Forbidden',
    };
  };

  return {
    fingerprint,
    projectRoot,
    targets,
    targetsResult,

    get openShardIds() {
      return pool.openShardIds;
    },

    getManifest: buildManifest,

    async checkShard(shardId) {
      const target = findStudioHostTarget(targets, shardId);

      if (!target) {
        return { status: 'unavailable', message: 'Unknown shard' };
      }

      try {
        const executor = await pool.acquire(target);

        try {
          const [error] = await executor.execute({ sql: 'select 1', parameters: [] });

          if (error) {
            throw error;
          }
        } finally {
          pool.release(target.id);
        }

        statusById[target.id] = { status: 'available' };
        return statusById[target.id];
      } catch (error) {
        // Connection errors routinely embed the connection string; only a
        // generic reason ever reaches the browser.
        logger?.warn(
          `Shard ${target.id} is unreachable: ${
            error instanceof Error ? error.name : 'unknown error'
          }`
        );
        statusById[target.id] = {
          status: 'unavailable',
          message: 'Could not connect to this database.',
        };
        return statusById[target.id];
      }
    },

    async handleBffRequest(request, context = {}) {
      if (!request || typeof request.procedure !== 'string') {
        return { status: 400, text: 'Invalid request payload' };
      }

      if (hasForbiddenConnectionFields(request.customPayload)) {
        return {
          status: 400,
          text: 'Connection details cannot be supplied by the client.',
        };
      }

      const { shardId: requestedShardId, conflict } = readRequestedShardId(request, context);

      if (conflict) {
        return { status: 400, text: 'Conflicting shard identifiers in request' };
      }

      if (!requestedShardId) {
        return { status: 400, text: 'A shard identifier is required' };
      }

      // Validation against server-owned configuration happens before anything
      // else touches a database, and before the authorizer is consulted with a
      // shard ID it could not otherwise trust.
      const target = findStudioHostTarget(targets, requestedShardId);

      if (!target) {
        return { status: 404, text: 'Unknown or stale shard identifier' };
      }

      const authorization = await resolveAuthorization({
        ...context,
        shardId: target.id,
        procedure: request.procedure,
        customPayload: request.customPayload,
      });

      if (!authorization.allowed) {
        return { status: authorization.status, text: authorization.message };
      }

      const schema = typeof request.schema === 'string' ? request.schema : undefined;

      let executor: Executor;

      try {
        executor = await pool.acquire(target);
      } catch (error) {
        logger?.error(
          `Could not open a connection for ${target.id}: ${
            error instanceof Error ? error.name : 'unknown error'
          }`
        );
        return { status: 503, text: 'Could not connect to the selected database.' };
      }

      try {
        return await executeStudioHostBffRequest({
          executor,
          request,
          schema,
        });
      } finally {
        pool.release(target.id);
      }
    },

    async dispose() {
      await pool.dispose();
    },
  };
};
