import type {
  StudioShardManifest,
  StudioShardStatus,
} from '../studioHostManifest';

/**
 * Browser-side client for the Studio host API.
 *
 * The shell never learns a connection string: it asks the host which shards
 * exist and addresses every request by shard ID. The host resolves credentials.
 */

export const STUDIO_SHELL_API_PREFIX = '/api/studio';

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${STUDIO_SHELL_API_PREFIX}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(detail || `Request failed with status ${response.status}`);
  }

  return (await response.json()) as T;
};

export const fetchStudioShardManifest = (
  signal?: AbortSignal
): Promise<StudioShardManifest> => request('/shards', { signal });

export const checkStudioShardStatus = (
  shardId: string,
  signal?: AbortSignal
): Promise<{ status: StudioShardStatus; message?: string }> =>
  request('/shards/status', {
    method: 'POST',
    body: JSON.stringify({ shardId }),
    signal,
  });

export const STUDIO_SHELL_BFF_URL = `${STUDIO_SHELL_API_PREFIX}/bff`;
