import { normalizeDatabaseUrl, ShardConfig } from '../cli/utils/shards';

/**
 * A single database Studio may be pointed at.
 *
 * `url` is the only credential-bearing field in the whole Studio host and it
 * never leaves the server: the browser receives {@link StudioShardManifest}
 * entries built from these targets by `studioHostManifest`, and requests only
 * ever carry `id`.
 */
export interface StudioHostTarget {
  /** Stable identifier the browser sends back on every request. */
  id: string;
  /** Human-facing label. Derived from the id, never from the URL. */
  label: string;
  /** Position in the configured shard order; used for deterministic defaults. */
  index: number;
  /** Server-side connection string. Never serialized. */
  url: string;
  /**
   * Environment-variable NAMES this target came from, e.g. `SHARD_1_URL`.
   * Names only - values are never included, and names that themselves look
   * like secrets are filtered out before the manifest is built.
   */
  sources: string[];
  /**
   * Other configured shard IDs that resolve to the same physical database.
   *
   * De-duplication follows the same rule the update pipeline already uses, so
   * two env vars pointing at one database are one selectable target rather
   * than two shards that would silently show identical data.
   */
  aliasIds: string[];
}

export interface StudioHostDuplicateTarget {
  /** The configured shard ID that was folded away. */
  id: string;
  /** The target it duplicates. */
  sameAs: string;
}

export interface StudioHostTargetsResult {
  targets: StudioHostTarget[];
  /** Shard IDs declared by SHARD_COUNT whose SHARD_N_URL is missing or blank. */
  missingShardIds: string[];
  duplicates: StudioHostDuplicateTarget[];
  /**
   * True when no shards were configured at all and DATABASE_URL was used as
   * the single target, matching the pre-existing Studio fallback.
   */
  usedPrimaryFallback: boolean;
}

export const NO_STUDIO_TARGETS_MESSAGE =
  'No databases configured for Studio. Set SHARD_COUNT with SHARD_N_URL, or DATABASE_URL.';

const SHARD_ID_PATTERN = /^shard[_-](\d+)$/i;

/**
 * `shard_1` reads better as `Shard 1`; anything custom (`tenant-east`) is shown
 * exactly as configured so operators recognise their own naming.
 */
export const getStudioShardLabel = (shardId: string): string => {
  const match = SHARD_ID_PATTERN.exec(shardId);
  return match ? `Shard ${match[1]}` : shardId;
};

/**
 * Resolves the databases Studio may connect to, from the invoking project's
 * environment only.
 *
 * Discovery deliberately mirrors the shard parser the rest of the CLI uses:
 * SHARD_COUNT + SHARD_N_URL define the shards, and DATABASE_URL is used only
 * when no shards exist at all. The primary is not silently added as an extra
 * target when shards are configured, because per-shard Studio never treated it
 * as one.
 */
export const resolveStudioHostTargets = (
  env: NodeJS.ProcessEnv = process.env
): StudioHostTargetsResult => {
  const missingShardIds: string[] = [];
  const duplicates: StudioHostDuplicateTarget[] = [];
  const byNormalizedUrl = new Map<string, StudioHostTarget>();
  const parsedShardCount = parseInt(env.SHARD_COUNT || '0', 10);
  const shardCount = Number.isFinite(parsedShardCount) && parsedShardCount > 0 ? parsedShardCount : 0;
  const candidates: Array<{ id: string; source: string; url: string }> = [];

  for (let i = 1; i <= shardCount; i++) {
    const source = `SHARD_${i}_URL`;
    const url = env[source]?.trim();

    if (url) {
      candidates.push({ id: `shard_${i}`, source, url });
    } else {
      missingShardIds.push(`shard_${i}`);
    }
  }

  // Same fallback the per-shard Studio command used: DATABASE_URL only steps in
  // when the project configured no shards at all.
  const usedPrimaryFallback = candidates.length === 0 && Boolean(env.DATABASE_URL?.trim());

  if (usedPrimaryFallback) {
    candidates.push({
      id: 'shard_1',
      source: 'DATABASE_URL',
      url: env.DATABASE_URL!.trim(),
    });
  }

  for (const candidate of candidates) {
    const key = normalizeDatabaseUrl(candidate.url);
    const existing = byNormalizedUrl.get(key);

    if (existing) {
      existing.sources.push(candidate.source);
      existing.aliasIds.push(candidate.id);
      duplicates.push({ id: candidate.id, sameAs: existing.id });
      continue;
    }

    byNormalizedUrl.set(key, {
      id: candidate.id,
      label: getStudioShardLabel(candidate.id),
      index: byNormalizedUrl.size,
      url: candidate.url,
      sources: [candidate.source],
      aliasIds: [],
    });
  }

  return {
    targets: [...byNormalizedUrl.values()],
    missingShardIds,
    duplicates,
    usedPrimaryFallback,
  };
};

/**
 * Resolves a client-supplied shard identifier against the server-owned target
 * list.
 *
 * This is the single choke point every request passes through: an ID that is
 * not present here never reaches a database. Aliases resolve to the target
 * that absorbed them so a stale deep link to a de-duplicated shard still works.
 */
export const findStudioHostTarget = (
  targets: readonly StudioHostTarget[],
  shardId: unknown
): StudioHostTarget | undefined => {
  if (typeof shardId !== 'string') {
    return undefined;
  }

  const trimmed = shardId.trim();

  if (!trimmed) {
    return undefined;
  }

  return targets.find(
    (target) => target.id === trimmed || target.aliasIds.includes(trimmed)
  );
};

/**
 * The shard selected when the browser has no valid preference: first configured
 * target, so repeated starts are deterministic.
 */
export const getDefaultStudioHostTargetId = (
  targets: readonly StudioHostTarget[]
): string | null => targets[0]?.id ?? null;

/** Adapts a host target to the shape the rest of the CLI already speaks. */
export const toShardConfig = (target: StudioHostTarget): ShardConfig => ({
  id: target.id,
  index: target.index,
  url: target.url,
});
