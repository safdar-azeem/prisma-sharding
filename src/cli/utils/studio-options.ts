import { INTERNAL_DEFAULTS } from '../../constants/internal';
import { DEFAULT_STUDIO_HOST_INTERFACE } from '../../studio-host/studioHostServer';
import { isVerboseEnv, parseBooleanEnv, parsePositiveIntegerEnv } from '../../utils/env';
import { getStudioRegistryDirectory } from './studio-registry';

/**
 * Studio host settings, resolved from the invoking project's environment.
 *
 * Every option that existed for the per-shard implementation is still honoured
 * and now applies to the single host, so existing `.env` files keep working
 * without edits. Nothing was silently repurposed: each meaning below is the one
 * documented in the README.
 */
export interface StudioOptions {
  /** Preferred first port. Scanning starts here, exactly as before. */
  basePort: number;
  /** Reuse an already-running host with a matching identity. */
  reuseExisting: boolean;
  /** How long to wait for the host to accept connections. */
  startupTimeoutMs: number;
  /** How long the host must stay listening before it is reported as started. */
  stabilityMs: number;
  /** How long to wait for the host and its connections to close. */
  shutdownTimeoutMs: number;
  /** Exit non-zero when the host could not start. */
  strictPortCheck: boolean;
  verbose: boolean;
  registryDirectory: string;
  portScanLimit: number;
  /** Interface to bind. Loopback by default; overriding exposes the host. */
  bindHost: string;
  /** Upper bound on shards holding an open database connection at once. */
  maxOpenConnections: number;
  /** How long an unused shard connection is kept before it is closed. */
  idleConnectionTimeoutMs: number;
}

export const getStudioOptions = (
  env: NodeJS.ProcessEnv = process.env
): StudioOptions => ({
  registryDirectory: getStudioRegistryDirectory(env),
  portScanLimit: parsePositiveIntegerEnv(
    'SHARD_STUDIO_PORT_SCAN_LIMIT',
    INTERNAL_DEFAULTS.STUDIO_PORT_SCAN_LIMIT,
    env
  ),
  basePort: parsePositiveIntegerEnv(
    'SHARD_STUDIO_BASE_PORT',
    INTERNAL_DEFAULTS.STUDIO_BASE_PORT,
    env
  ),
  reuseExisting: parseBooleanEnv(
    'SHARD_STUDIO_REUSE_EXISTING',
    INTERNAL_DEFAULTS.STUDIO_REUSE_EXISTING,
    env
  ),
  startupTimeoutMs: parsePositiveIntegerEnv(
    'SHARD_STUDIO_START_TIMEOUT_MS',
    INTERNAL_DEFAULTS.STUDIO_START_TIMEOUT_MS,
    env
  ),
  stabilityMs: parsePositiveIntegerEnv(
    'SHARD_STUDIO_STABILITY_MS',
    INTERNAL_DEFAULTS.STUDIO_STABILITY_MS,
    env
  ),
  shutdownTimeoutMs: parsePositiveIntegerEnv(
    'SHARD_STUDIO_SHUTDOWN_TIMEOUT_MS',
    INTERNAL_DEFAULTS.STUDIO_SHUTDOWN_TIMEOUT_MS,
    env
  ),
  strictPortCheck: parseBooleanEnv(
    'SHARD_STUDIO_STRICT_PORT_CHECK',
    INTERNAL_DEFAULTS.STUDIO_STRICT_PORT_CHECK,
    env
  ),
  verbose: isVerboseEnv(['SHARD_STUDIO_VERBOSE', 'SHARD_STUDIO_DEBUG'], env),
  bindHost: env.SHARD_STUDIO_HOST?.trim() || DEFAULT_STUDIO_HOST_INTERFACE,
  maxOpenConnections: parsePositiveIntegerEnv(
    'SHARD_STUDIO_MAX_OPEN_CONNECTIONS',
    INTERNAL_DEFAULTS.STUDIO_MAX_OPEN_CONNECTIONS,
    env
  ),
  idleConnectionTimeoutMs: parsePositiveIntegerEnv(
    'SHARD_STUDIO_IDLE_CONNECTION_TIMEOUT_MS',
    INTERNAL_DEFAULTS.STUDIO_IDLE_CONNECTION_TIMEOUT_MS,
    env
  ),
});
