import { createStudioBFFClient } from '@prisma/studio-core/data/bff';
import { createPostgresAdapter } from '@prisma/studio-core/data/postgres-core';
import { STUDIO_SHELL_BFF_URL } from './studioShellApi';

/**
 * One shard's live connection to the host, from the browser's point of view.
 *
 * A session owns the adapter Studio is rendered with and every request that
 * adapter makes. Switching shards ends the previous session, which aborts its
 * in-flight requests and makes any response that still arrives unusable - a
 * result computed against the previous database can never reach the UI showing
 * the new one, even when both databases have identical schemas.
 */
export interface StudioShellShardSession {
  readonly shardId: string;
  readonly adapter: ReturnType<typeof createPostgresAdapter>;
  /** Aborts in-flight work and permanently invalidates the session. */
  dispose(): void;
  readonly isDisposed: boolean;
}

class StudioShellStaleSessionError extends Error {
  constructor(shardId: string) {
    super(`The connection to ${shardId} was closed by a shard switch.`);
    this.name = 'AbortError';
  }
}

export const createStudioShellShardSession = (
  shardId: string
): StudioShellShardSession => {
  const inFlight = new Set<AbortController>();
  let isDisposed = false;

  /**
   * Every request carries the shard ID and is bound to the session lifetime.
   *
   * `customPayload` is Studio's documented channel for host context, so no
   * transport logic is duplicated: the standard BFF client does the sending.
   */
  const sessionFetch: typeof fetch = async (input, init) => {
    if (isDisposed) {
      throw new StudioShellStaleSessionError(shardId);
    }

    const controller = new AbortController();
    inFlight.add(controller);

    // Honour Studio's own cancellation (query cancel, unmounting views) on top
    // of the session-wide abort.
    const callerSignal = init?.signal;

    if (callerSignal) {
      if (callerSignal.aborted) {
        inFlight.delete(controller);
        controller.abort();
      } else {
        callerSignal.addEventListener('abort', () => controller.abort(), {
          once: true,
        });
      }
    }

    try {
      const response = await fetch(input, { ...init, signal: controller.signal });

      if (isDisposed) {
        // The switch completed while this response was in flight. Refuse it
        // rather than letting a caller apply previous-shard data.
        throw new StudioShellStaleSessionError(shardId);
      }

      return response;
    } finally {
      inFlight.delete(controller);
    }
  };

  const bffClient = createStudioBFFClient({
    customPayload: { shardId },
    fetch: sessionFetch,
    url: STUDIO_SHELL_BFF_URL,
    // The host does not observe SQL executed outside Studio, so the Queries
    // view stays hidden rather than showing an empty snapshot.
    queryInsights: false,
  });

  const adapter = createPostgresAdapter({ executor: bffClient });

  return {
    shardId,
    adapter,

    get isDisposed() {
      return isDisposed;
    },

    dispose() {
      if (isDisposed) {
        return;
      }

      isDisposed = true;

      for (const controller of inFlight) {
        controller.abort();
      }

      inFlight.clear();
    },
  };
};
