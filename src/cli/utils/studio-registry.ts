import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  computeStudioHostFingerprint,
  StudioHostIdentity,
} from '../../studio-host/studioHostIdentity';

/**
 * Per-user registry of Prisma Sharding Studio hosts.
 *
 * A port being occupied by something that answers HTTP proves nothing about
 * WHICH project it serves. Before reusing a host the CLI requires a registry
 * entry whose fingerprint matches the current project root, Prisma schema and
 * complete configured shard set, whose recorded process is still alive, and
 * whose port reports the same fingerprint from its own identity endpoint.
 *
 * The fingerprint is a SHA-256 hash of credential-free values, so no secret is
 * ever written to disk or printed.
 */
export interface StudioRegistryEntry {
  version: 2;
  port: number;
  pid: number;
  fingerprint: string;
  /** Number of shards the host serves. Diagnostics only; never trusted. */
  shardCount: number;
  projectRoot: string;
  createdAt: string;
}

export type { StudioHostIdentity };

/**
 * Re-exported so the CLI and its tests have a single import site for host
 * identity, and so the fingerprint used for reuse is provably the same one the
 * host reports about itself.
 */
export const computeStudioFingerprint = computeStudioHostFingerprint;

export const getStudioRegistryDirectory = (
  env: NodeJS.ProcessEnv = process.env
): string =>
  env.SHARD_STUDIO_REGISTRY_DIR?.trim() ||
  path.join(os.tmpdir(), 'prisma-studio-next');

const entryPath = (directory: string, port: number): string =>
  path.join(directory, `port-${port}.json`);

export const readStudioRegistryEntry = (
  directory: string,
  port: number
): StudioRegistryEntry | undefined => {
  try {
    const parsed = JSON.parse(fs.readFileSync(entryPath(directory, port), 'utf8'));

    // Entries written by the per-shard implementation describe a different
    // kind of process entirely. They are ignored rather than migrated, so a
    // stale v1 record can never cause a mismatched reuse.
    if (parsed && parsed.version === 2 && typeof parsed.fingerprint === 'string') {
      return parsed as StudioRegistryEntry;
    }
  } catch {
    // Missing or unreadable entry: treated as "unknown process".
  }

  return undefined;
};

export const writeStudioRegistryEntry = (
  directory: string,
  entry: StudioRegistryEntry
): void => {
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(entryPath(directory, entry.port), JSON.stringify(entry, null, 2));
  } catch {
    // Registry writes are best-effort: failing to persist identity must never
    // break Studio startup. Without an entry the host is simply never reused.
  }
};

export const removeStudioRegistryEntry = (directory: string, port: number): void => {
  try {
    fs.unlinkSync(entryPath(directory, port));
  } catch {
    // Already gone.
  }
};

export const isPidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};
