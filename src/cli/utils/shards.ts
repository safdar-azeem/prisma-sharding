import { maskDatabaseUrl } from '../../utils/sanitize';

export interface ShardConfig {
  id: string;
  index: number;
  url: string;
}

export interface ShardConfigResult {
  shards: ShardConfig[];
  missingShardIds: string[];
}

/**
 * A database the update pipeline must keep in sync: the primary (when it uses
 * the same Prisma schema) or one of the configured shards.
 */
export interface DatabaseTarget {
  id: string;
  url: string;
  sources: string[];
  isPrimary: boolean;
}

export interface DuplicateTarget {
  source: string;
  sameAs: string;
}

export interface DatabaseTargetsResult {
  targets: DatabaseTarget[];
  missingShardIds: string[];
  duplicates: DuplicateTarget[];
}

export const NO_SHARDS_CONFIGURED_MESSAGE =
  'No shards configured. Set SHARD_COUNT and SHARD_N_URL environment variables.';

export const NO_DATABASES_CONFIGURED_MESSAGE =
  'No databases configured. Set DATABASE_URL, or SHARD_COUNT with SHARD_N_URL environment variables.';

/**
 * Canonical form used only to decide whether two connection strings point at the
 * same physical database, so the primary is never migrated twice when it is also
 * listed as a shard.
 */
export const normalizeDatabaseUrl = (url: string): string => {
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    const protocol = parsed.protocol === 'postgres:' ? 'postgresql:' : parsed.protocol;
    const host = parsed.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
    const port = parsed.port || '5432';
    const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, '')).replace(
      /\/+$/,
      ''
    );
    const schema = parsed.searchParams.get('schema') || 'public';
    const socket = parsed.searchParams.get('host') || '';
    return `${protocol}//${host}:${port}/${database}?schema=${schema}&host=${socket}`;
  } catch {
    return trimmed;
  }
};

/**
 * Every database the CLI must keep up to date: the primary (when it uses the same
 * Prisma schema) plus every configured shard, de-duplicated by physical database.
 */
export const getDatabaseTargets = (
  env: NodeJS.ProcessEnv = process.env
): DatabaseTargetsResult => {
  const missingShardIds: string[] = [];
  const duplicates: DuplicateTarget[] = [];
  const byNormalizedUrl = new Map<string, DatabaseTarget>();
  const shardCount = parseInt(env.SHARD_COUNT || '0', 10);
  const candidates: Array<{ id: string; source: string; url: string }> = [];

  if (env.DATABASE_URL?.trim()) {
    candidates.push({ id: 'primary', source: 'DATABASE_URL', url: env.DATABASE_URL.trim() });
  }

  for (let i = 1; i <= shardCount; i++) {
    const source = `SHARD_${i}_URL`;
    const url = env[source]?.trim();
    if (url) {
      candidates.push({ id: `shard_${i}`, source, url });
    } else {
      missingShardIds.push(`shard_${i}`);
    }
  }

  for (const candidate of candidates) {
    const key = normalizeDatabaseUrl(candidate.url);
    const existing = byNormalizedUrl.get(key);

    if (existing) {
      existing.sources.push(candidate.source);
      duplicates.push({ source: candidate.source, sameAs: existing.id });
      continue;
    }

    byNormalizedUrl.set(key, {
      id: candidate.id,
      url: candidate.url,
      sources: [candidate.source],
      isPrimary: candidate.source === 'DATABASE_URL',
    });
  }

  return { targets: [...byNormalizedUrl.values()], missingShardIds, duplicates };
};

export const getShardConfigResult = (
  env: NodeJS.ProcessEnv = process.env
): ShardConfigResult => {
  const shards: ShardConfig[] = [];
  const missingShardIds: string[] = [];
  const shardCount = parseInt(env.SHARD_COUNT || '0', 10);

  for (let i = 1; i <= shardCount; i++) {
    const url = env[`SHARD_${i}_URL`];
    if (url) {
      shards.push({ id: `shard_${i}`, index: i - 1, url });
    } else {
      missingShardIds.push(`shard_${i}`);
    }
  }

  if (shards.length === 0 && env.DATABASE_URL) {
    shards.push({ id: 'shard_1', index: 0, url: env.DATABASE_URL });
  }

  return { shards, missingShardIds };
};

export const getShardConfigs = (env: NodeJS.ProcessEnv = process.env): ShardConfig[] => {
  return getShardConfigResult(env).shards;
};

export const maskShardUrl = maskDatabaseUrl;
