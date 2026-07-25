import http, { IncomingMessage, Server, ServerResponse } from 'http';
import {
  createStudioHostAssetReader,
  resolveStudioHostAssetDirectory,
  STUDIO_HOST_ASSETS_MISSING_MESSAGE,
  StudioHostAssetReader,
} from './studioHostAssets';
import { createStudioHostRequestHandler, StudioHostRequestHandler } from './studioHostHttp';
import type { StudioHostService } from './studioHostService';

/**
 * The single HTTP server the CLI starts.
 *
 * One server, one URL, every configured shard. It serves the pre-built browser
 * bundle plus the host API under `/api/studio`, and binds to a loopback
 * interface by default so a developer's databases are never exposed to the
 * network by starting Studio.
 */

export const STUDIO_HOST_API_PREFIX = '/api/studio';

export interface StudioHostServerOptions {
  service: StudioHostService;
  /** Defaults to the bundle shipped alongside the compiled CLI. */
  assetDirectory?: string;
  /** Loopback by default. Overriding this exposes the host to the network. */
  host?: string;
  logger?: { warn: (message: string) => void };
}

export interface StudioHostServer {
  readonly server: Server;
  listen(port: number): Promise<number>;
  close(): Promise<void>;
}

const HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  // The shell reads the manifest at runtime; caching it would pin a browser to
  // a stale shard list after configuration changes.
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

const ASSET_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

export const DEFAULT_STUDIO_HOST_INTERFACE = '127.0.0.1';

export const createStudioHostServer = (
  options: StudioHostServerOptions
): StudioHostServer => {
  const {
    service,
    assetDirectory = resolveStudioHostAssetDirectory(),
    host = DEFAULT_STUDIO_HOST_INTERFACE,
    logger,
  } = options;

  const assets: StudioHostAssetReader | undefined = assetDirectory
    ? createStudioHostAssetReader(assetDirectory)
    : undefined;

  if (!assets) {
    logger?.warn(STUDIO_HOST_ASSETS_MISSING_MESSAGE);
  }

  const handleApiRequest: StudioHostRequestHandler = createStudioHostRequestHandler({
    service,
  });

  const server = http.createServer((request: IncomingMessage, response: ServerResponse) => {
    void handleRequest(request, response).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      response.end('Studio host request failed');
    });
  });

  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> => {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (pathname.startsWith(STUDIO_HOST_API_PREFIX)) {
      const handled = await handleApiRequest(
        request,
        response,
        pathname.slice(STUDIO_HOST_API_PREFIX.length) || '/'
      );

      if (handled) {
        return;
      }

      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not Found');
      return;
    }

    if (!assets) {
      response.writeHead(503, HTML_HEADERS);
      response.end(
        `<!doctype html><meta charset="utf-8"><title>Prisma Sharding Studio</title>` +
          `<p>${STUDIO_HOST_ASSETS_MISSING_MESSAGE}</p>`
      );
      return;
    }

    const asset = assets.read(pathname);

    if (asset) {
      response.writeHead(200, {
        ...(asset.contentType.startsWith('text/html') ? HTML_HEADERS : ASSET_HEADERS),
        'Content-Type': asset.contentType,
        'Content-Length': asset.bytes.length,
      });
      response.end(asset.bytes);
      return;
    }

    // The shell keeps navigation state in the URL hash, so any unknown path is
    // still the single-page application.
    const indexDocument = assets.read('/');

    if (indexDocument) {
      response.writeHead(200, {
        ...HTML_HEADERS,
        'Content-Length': indexDocument.bytes.length,
      });
      response.end(indexDocument.bytes);
      return;
    }

    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not Found');
  };

  return {
    server,

    listen(port) {
      return new Promise((resolve, reject) => {
        const onError = (error: Error) => {
          server.off('listening', onListening);
          reject(error);
        };

        const onListening = () => {
          server.off('error', onError);
          const address = server.address();
          resolve(typeof address === 'object' && address ? address.port : port);
        };

        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
    },

    close() {
      return new Promise((resolve) => {
        // closeAllConnections is required for a prompt shutdown: keep-alive
        // sockets from an open browser tab would otherwise hold the server open.
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
};
