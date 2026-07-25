/**
 * How the selected shard is represented in the Studio URL.
 *
 * Pure string handling with no DOM dependency, so the rules are the same for
 * the browser shell, for an embedder building its own shell, and for tests.
 *
 * The division of the URL is deliberate:
 *
 * - The **query string** holds the shard. Studio's nuqs adapter rewrites the
 *   whole fragment on every navigation, so a shard stored in the hash would be
 *   erased by the first table click. The query string is untouched by it.
 * - The **hash** holds Studio's own navigation state - view, schema, table,
 *   filters, sorting, pagination, selection. That belongs to Studio, and this
 *   module never invents, reorders or drops any of it.
 */

export const STUDIO_SHARD_URL_PARAM = 'shard';

export interface StudioShardUrlParts {
  pathname: string;
  /** Leading `?` optional. */
  search: string;
  /** Leading `#` optional. */
  hash: string;
}

export const readShardIdFromSearch = (search: string): string | null => {
  const value = new URLSearchParams(
    search.startsWith('?') ? search.slice(1) : search
  ).get(STUDIO_SHARD_URL_PARAM);
  const trimmed = value?.trim();

  return trimmed ? trimmed : null;
};

/**
 * Rewrites only the shard parameter.
 *
 * Switching shards keeps the user exactly where they were: same view, same
 * schema, same table, same filters and sorting. On a homogeneous shard set -
 * the normal case, since every shard runs the same Prisma schema - that is the
 * whole point of switching, and losing the position on every switch would make
 * comparing the same table across shards needlessly tedious.
 *
 * When the new shard genuinely lacks the selected schema or table, Studio
 * already resolves that itself: `useNavigation` falls back to the first
 * available schema and table rather than rendering a broken view, so a
 * preserved hash degrades gracefully instead of erroring.
 *
 * Any other query parameters the host or embedder put on the URL are preserved
 * too, and their order is left alone.
 */
export const buildStudioShardUrl = (
  parts: StudioShardUrlParts,
  shardId: string
): string => {
  const { pathname, search, hash } = parts;
  const parameters = new URLSearchParams(
    search.startsWith('?') ? search.slice(1) : search
  );

  parameters.set(STUDIO_SHARD_URL_PARAM, shardId);

  const nextSearch = parameters.toString();
  const normalizedHash = hash && !hash.startsWith('#') ? `#${hash}` : hash;

  return `${pathname}${nextSearch ? `?${nextSearch}` : ''}${normalizedHash}`;
};

/**
 * Chooses the shard to start on.
 *
 * A URL preference wins when it still names a configured shard, so refreshing
 * a deep link is stable and two tabs can sit on two different shards. A stale
 * link - one naming a shard that configuration has since removed - falls back
 * to the deterministic default instead of failing, and the caller surfaces a
 * notice explaining the substitution.
 */
export const resolveInitialShardId = (args: {
  availableShardIds: readonly string[];
  defaultShardId: string | null;
  requestedShardId: string | null;
}): { shardId: string | null; wasRequestedShardStale: boolean } => {
  const { availableShardIds, defaultShardId, requestedShardId } = args;

  if (requestedShardId && availableShardIds.includes(requestedShardId)) {
    return { shardId: requestedShardId, wasRequestedShardStale: false };
  }

  return {
    shardId: defaultShardId ?? availableShardIds[0] ?? null,
    wasRequestedShardStale: Boolean(requestedShardId),
  };
};
