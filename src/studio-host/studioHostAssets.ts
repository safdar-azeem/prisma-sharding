import fs from 'fs';
import path from 'path';

/**
 * Serves the pre-built Studio host browser bundle.
 *
 * The bundle is produced at package build time (`yarn build:studio-host`) and
 * shipped inside `dist`, so starting Studio never runs a bundler and never
 * needs network access. Nothing shard-specific is baked into the assets: the
 * browser learns which databases exist by fetching the sanitized manifest at
 * runtime.
 */

export const STUDIO_HOST_ASSET_DIRECTORY = 'studio-host-assets';

export interface StudioHostAsset {
  bytes: Buffer;
  contentType: string;
}

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * Locates the built asset directory.
 *
 * Checked next to the compiled CLI first (the published layout), then relative
 * to the source tree so the host is runnable from a checkout.
 */
export const resolveStudioHostAssetDirectory = (
  fromDirectory: string = __dirname
): string | undefined => {
  const candidates = [
    path.resolve(fromDirectory, STUDIO_HOST_ASSET_DIRECTORY),
    path.resolve(fromDirectory, '..', STUDIO_HOST_ASSET_DIRECTORY),
    path.resolve(fromDirectory, '..', '..', STUDIO_HOST_ASSET_DIRECTORY),
    path.resolve(fromDirectory, '..', '..', 'dist', STUDIO_HOST_ASSET_DIRECTORY),
  ];

  return candidates.find(
    (candidate) =>
      fs.existsSync(candidate) && fs.existsSync(path.join(candidate, 'index.html'))
  );
};

export interface StudioHostAssetReader {
  /** Returns the asset for a URL path, or `undefined` when it is not ours. */
  read(urlPath: string): StudioHostAsset | undefined;
  readonly directory: string;
}

/**
 * Reads assets from disk with path traversal blocked.
 *
 * Only files that resolve inside the asset directory are ever returned, so a
 * request for `/../../.env` can never read project files.
 */
export const createStudioHostAssetReader = (directory: string): StudioHostAssetReader => {
  const rootDirectory = path.resolve(directory);
  const cache = new Map<string, StudioHostAsset | undefined>();

  return {
    directory: rootDirectory,

    read(urlPath) {
      const cached = cache.get(urlPath);

      if (cache.has(urlPath)) {
        return cached;
      }

      const relativePath = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
      const resolved = path.resolve(rootDirectory, relativePath);

      if (resolved !== rootDirectory && !resolved.startsWith(rootDirectory + path.sep)) {
        cache.set(urlPath, undefined);
        return undefined;
      }

      let asset: StudioHostAsset | undefined;

      try {
        if (fs.statSync(resolved).isFile()) {
          asset = {
            bytes: fs.readFileSync(resolved),
            contentType:
              CONTENT_TYPES[path.extname(resolved).toLowerCase()] ||
              'application/octet-stream',
          };
        }
      } catch {
        asset = undefined;
      }

      cache.set(urlPath, asset);
      return asset;
    },
  };
};

export const STUDIO_HOST_ASSETS_MISSING_MESSAGE =
  'The Studio host browser bundle is missing. Reinstall prisma-sharding, or run "yarn build" in the package to rebuild it.';
