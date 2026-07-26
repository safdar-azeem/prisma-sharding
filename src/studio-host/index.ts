/**
 * Public surface of the Prisma Sharding Studio host.
 *
 * Consuming applications import from here to mount the exact same shard-aware
 * Studio service the `prisma-studio-next` command runs, behind their own
 * authenticated route. There is one implementation: the CLI is just another
 * embedder.
 */

export {
  createStudioHostAssetReader,
  resolveStudioHostAssetDirectory,
  STUDIO_HOST_ASSET_DIRECTORY,
  STUDIO_HOST_ASSETS_MISSING_MESSAGE,
  type StudioHostAsset,
  type StudioHostAssetReader,
} from './studioHostAssets';

export {
  executeStudioHostBffRequest,
  type StudioHostBffProcedure,
  type StudioHostBffRequest,
  type StudioHostBffResponse,
} from './studioHostBff';

export {
  createStudioHostConnectionPool,
  type StudioHostConnectionFactory,
  type StudioHostConnectionPool,
  type StudioHostConnectionPoolOptions,
} from './studioHostConnectionPool';

export {
  computeStudioHostFingerprint,
  STUDIO_HOST_PROTOCOL_VERSION,
  type StudioHostIdentity,
} from './studioHostIdentity';

export {
  createStudioHostRequestHandler,
  STUDIO_HOST_ROUTES,
  type StudioHostRequestHandler,
  type StudioHostRequestHandlerOptions,
} from './studioHostHttp';

export {
  assertStudioShardManifestIsSafe,
  buildStudioShardManifest,
  type StudioShardManifest,
  type StudioShardManifestEntry,
  type StudioShardManifestUi,
  type StudioShardStatus,
} from './studioHostManifest';

export {
  normalizeStudioHostConnectionString,
  type StudioHostConnectionSettings,
} from './studioHostConnectionString';

export {
  createStudioHostPostgresConnectionFactory,
  type CreateStudioHostPostgresConnectionFactoryOptions,
} from './studioHostPostgresConnection';

export {
  buildStudioShardUrl,
  readShardIdFromSearch,
  resolveInitialShardId,
  STUDIO_SHARD_URL_PARAM,
  type StudioShardUrlParts,
} from './studioHostShardUrl';

export {
  createStudioHostServer,
  DEFAULT_STUDIO_HOST_INTERFACE,
  STUDIO_HOST_API_PREFIX,
  type StudioHostServer,
  type StudioHostServerOptions,
} from './studioHostServer';

export {
  createStudioHostService,
  readRequestedShardId,
  STUDIO_HOST_SHARD_HEADER,
  type StudioHostAuthorizationInput,
  type StudioHostAuthorizationResult,
  type StudioHostLogger,
  type StudioHostRequestContext,
  type StudioHostService,
  type StudioHostServiceOptions,
} from './studioHostService';

export {
  findStudioHostTarget,
  getDefaultStudioHostTargetId,
  getStudioShardLabel,
  NO_STUDIO_TARGETS_MESSAGE,
  resolveStudioHostTargets,
  type StudioHostTarget,
  type StudioHostTargetsResult,
} from './studioHostTargets';
