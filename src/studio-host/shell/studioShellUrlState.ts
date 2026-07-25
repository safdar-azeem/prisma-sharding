import {
  buildStudioShardUrl,
  readShardIdFromSearch,
  STUDIO_SHARD_URL_PARAM,
} from '../studioHostShardUrl';

/**
 * Browser binding for the shard URL rules.
 *
 * The rules themselves live in `studioHostShardUrl`, which has no DOM
 * dependency and is unit-tested. This module only reads `window.location` and
 * writes through `history.replaceState`.
 */

export { STUDIO_SHARD_URL_PARAM };

export { resolveInitialShardId } from '../studioHostShardUrl';

export const readShardIdFromUrl = (): string | null =>
  readShardIdFromSearch(window.location.search);

/**
 * Points the URL at another shard without disturbing anything else.
 *
 * `replaceState` rather than `pushState`: switching shards is not a navigation
 * within Studio, and stacking a history entry per switch would make the back
 * button walk through databases instead of through the user's actual path.
 */
export const writeShardIdToUrl = (shardId: string): string => {
  const url = buildStudioShardUrl(
    {
      pathname: window.location.pathname,
      search: window.location.search,
      // Studio's navigation state is preserved verbatim, so the user stays on
      // the same view, schema, table, filters and sorting across the switch.
      hash: window.location.hash,
    },
    shardId
  );

  window.history.replaceState(null, '', url);

  return url;
};
