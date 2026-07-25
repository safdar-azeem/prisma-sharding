import { INTERNAL_DEFAULTS } from '../../constants/internal';
import { isVerboseEnv, parseBooleanEnv, parsePositiveIntegerEnv } from '../../utils/env';
import { getStudioRegistryDirectory } from './studio-registry';

export interface StudioOptions {
  basePort: number;
  reuseExisting: boolean;
  startupTimeoutMs: number;
  stabilityMs: number;
  shutdownTimeoutMs: number;
  strictPortCheck: boolean;
  verbose: boolean;
  registryDirectory: string;
  portScanLimit: number;
}

export const getStudioOptions = (): StudioOptions => ({
  registryDirectory: getStudioRegistryDirectory(),
  portScanLimit: parsePositiveIntegerEnv(
    'SHARD_STUDIO_PORT_SCAN_LIMIT',
    INTERNAL_DEFAULTS.STUDIO_PORT_SCAN_LIMIT
  ),
  basePort: parsePositiveIntegerEnv(
    'SHARD_STUDIO_BASE_PORT',
    INTERNAL_DEFAULTS.STUDIO_BASE_PORT
  ),
  reuseExisting: parseBooleanEnv(
    'SHARD_STUDIO_REUSE_EXISTING',
    INTERNAL_DEFAULTS.STUDIO_REUSE_EXISTING
  ),
  startupTimeoutMs: parsePositiveIntegerEnv(
    'SHARD_STUDIO_START_TIMEOUT_MS',
    INTERNAL_DEFAULTS.STUDIO_START_TIMEOUT_MS
  ),
  stabilityMs: parsePositiveIntegerEnv(
    'SHARD_STUDIO_STABILITY_MS',
    INTERNAL_DEFAULTS.STUDIO_STABILITY_MS
  ),
  shutdownTimeoutMs: parsePositiveIntegerEnv(
    'SHARD_STUDIO_SHUTDOWN_TIMEOUT_MS',
    INTERNAL_DEFAULTS.STUDIO_SHUTDOWN_TIMEOUT_MS
  ),
  strictPortCheck: parseBooleanEnv(
    'SHARD_STUDIO_STRICT_PORT_CHECK',
    INTERNAL_DEFAULTS.STUDIO_STRICT_PORT_CHECK
  ),
  verbose: isVerboseEnv(['SHARD_STUDIO_VERBOSE', 'SHARD_STUDIO_DEBUG']),
});
