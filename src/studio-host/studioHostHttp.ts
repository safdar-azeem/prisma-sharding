import type { IncomingMessage, ServerResponse } from 'http';
import type { StudioHostRequestContext, StudioHostService } from './studioHostService';

/**
 * Node HTTP transport for the Studio host service.
 *
 * The same handler backs the CLI's own server and any consuming application
 * that mounts the service behind its own protected route, so CLI and embedded
 * usage share one discovery, validation, routing and execution path.
 */

/** Route suffixes, relative to the mount path. */
export const STUDIO_HOST_ROUTES = {
  manifest: '/shards',
  shardStatus: '/shards/status',
  bff: '/bff',
  identity: '/identity',
} as const;

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);

  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    // The host serves an application, never a document another site should
    // frame or sniff.
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(payload);
};

const sendText = (response: ServerResponse, status: number, body: string): void => {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
};

const readJsonBody = (request: IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    request.on('data', (chunk: Buffer) => {
      size += chunk.length;

      if (size > MAX_REQUEST_BYTES) {
        reject(new Error('Request body is too large'));
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });

    request.on('error', reject);

    request.on('end', () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }

      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Invalid JSON payload'));
      }
    });
  });

export interface StudioHostRequestHandlerOptions {
  service: StudioHostService;
  /**
   * Derives the embedder's request context (auth principal, tenancy) from the
   * raw request before the service authorizes it.
   */
  createContext?: (request: IncomingMessage) => StudioHostRequestContext | Promise<StudioHostRequestContext>;
}

export type StudioHostRequestHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  routePath: string
) => Promise<boolean>;

/**
 * Handles the host's API routes.
 *
 * Returns `true` when the request was handled, so a consuming application can
 * fall through to its own routes for anything else.
 */
export const createStudioHostRequestHandler = (
  options: StudioHostRequestHandlerOptions
): StudioHostRequestHandler => {
  const { service, createContext } = options;

  return async (request, response, routePath) => {
    if (
      routePath !== STUDIO_HOST_ROUTES.manifest &&
      routePath !== STUDIO_HOST_ROUTES.shardStatus &&
      routePath !== STUDIO_HOST_ROUTES.bff &&
      routePath !== STUDIO_HOST_ROUTES.identity
    ) {
      return false;
    }

    if (request.method === 'OPTIONS') {
      response.writeHead(204, { Allow: 'GET,POST,OPTIONS' });
      response.end();
      return true;
    }

    const context: StudioHostRequestContext = createContext
      ? await createContext(request)
      : { headers: request.headers };

    if (routePath === STUDIO_HOST_ROUTES.identity) {
      if (request.method !== 'GET') {
        sendText(response, 405, 'Method Not Allowed');
        return true;
      }

      // Credential-free identity, used by the CLI to prove that an occupied
      // port belongs to this exact project before reusing it.
      sendJson(response, 200, {
        product: 'prisma-sharding-studio',
        fingerprint: service.fingerprint,
        shardCount: service.targets.length,
      });
      return true;
    }

    if (routePath === STUDIO_HOST_ROUTES.manifest) {
      if (request.method !== 'GET') {
        sendText(response, 405, 'Method Not Allowed');
        return true;
      }

      sendJson(response, 200, service.getManifest());
      return true;
    }

    if (request.method !== 'POST') {
      sendText(response, 405, 'Method Not Allowed');
      return true;
    }

    let body: unknown;

    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendText(response, 400, error instanceof Error ? error.message : 'Invalid request');
      return true;
    }

    if (typeof body !== 'object' || body === null) {
      sendText(response, 400, 'Invalid request payload');
      return true;
    }

    if (routePath === STUDIO_HOST_ROUTES.shardStatus) {
      const shardId = (body as { shardId?: unknown }).shardId;
      sendJson(response, 200, await service.checkShard(shardId));
      return true;
    }

    const result = await service.handleBffRequest(body as never, context);

    if (result.text !== undefined) {
      sendText(response, result.status, result.text);
      return true;
    }

    sendJson(response, result.status, result.body);
    return true;
  };
};
