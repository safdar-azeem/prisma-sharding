import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { normalizeDatabaseUrl } from './shards';

/**
 * Per-user registry of Prisma Studio processes started by prisma-sharding.
 *
 * A port being occupied by something that answers like Prisma Studio proves
 * nothing about WHICH project or database it belongs to. Before reusing an
 * instance, the CLI requires a registry entry whose fingerprint matches the
 * current project root, Prisma schema, shard ID and database target. The
 * fingerprint is a SHA-256 hash of credential-free values - no secret is ever
 * written to disk or printed.
 */
export interface StudioRegistryEntry {
  version: 1;
  port: number;
  pid: number;
  fingerprint: string;
  shardId: string;
  projectRoot: string;
  createdAt: string;
}

export interface StudioIdentity {
  projectRoot: string;
  schemaPath: string;
  shardId: string;
  url: string;
}

export const getStudioRegistryDirectory = (
  env: NodeJS.ProcessEnv = process.env
): string =>
  env.SHARD_STUDIO_REGISTRY_DIR?.trim() ||
  path.join(os.tmpdir(), 'prisma-sharding-studio');

export const computeStudioFingerprint = (identity: StudioIdentity): string => {
  // normalizeDatabaseUrl removes credentials before hashing; the raw URL never
  // participates, so the fingerprint is safe to persist and compare.
  const material = [
    path.resolve(identity.projectRoot),
    identity.schemaPath || '',
    identity.shardId,
    normalizeDatabaseUrl(identity.url),
  ].join('\n');

  return crypto.createHash('sha256').update(material, 'utf8').digest('hex');
};

const entryPath = (directory: string, port: number): string =>
  path.join(directory, `port-${port}.json`);

export const readStudioRegistryEntry = (
  directory: string,
  port: number
): StudioRegistryEntry | undefined => {
  try {
    const parsed = JSON.parse(fs.readFileSync(entryPath(directory, port), 'utf8'));
    if (parsed && parsed.version === 1 && typeof parsed.fingerprint === 'string') {
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
    // break Studio startup. Without an entry the instance is simply never reused.
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
