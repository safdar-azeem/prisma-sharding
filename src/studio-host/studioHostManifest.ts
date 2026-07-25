import { StudioHostTarget, StudioHostTargetsResult } from './studioHostTargets';

export type StudioShardStatus = 'unknown' | 'checking' | 'available' | 'unavailable';

/**
 * Everything the browser is allowed to know about one database.
 *
 * Deliberately excludes connection strings, credentials, SSL material, hosts,
 * ports, database names and environment-variable values. `sources` carries
 * variable NAMES only, and only those that cannot themselves be secrets.
 */
export interface StudioShardManifestEntry {
  id: string;
  label: string;
  status: StudioShardStatus;
  /** Sanitized, human-readable reason when `status` is `unavailable`. */
  statusMessage?: string;
  /** Configured shard IDs folded into this target by URL de-duplication. */
  aliasIds: string[];
  /** Environment variable names this target was configured from. */
  sources: string[];
}

export interface StudioShardManifest {
  version: 1;
  /** Shard selected when the browser expresses no valid preference. */
  defaultShardId: string | null;
  shards: StudioShardManifestEntry[];
  /** Sanitized configuration notices, safe to render in the UI. */
  warnings: string[];
}

/** Names that must never be echoed back, even as bare names. */
const SECRET_LOOKING_SOURCE = /(password|passwd|secret|token|key|credential)/i;

const isSafeSourceName = (source: string): boolean =>
  /^[A-Z0-9_]{1,64}$/i.test(source) && !SECRET_LOOKING_SOURCE.test(source);

/**
 * Labels come from operator-controlled shard IDs, so they are length-capped and
 * stripped of control characters before crossing into the browser.
 */
const sanitizeLabel = (label: string): string => {
  const withoutControlCharacters = label
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return withoutControlCharacters.length > 120
    ? `${withoutControlCharacters.slice(0, 119)}\u2026`
    : withoutControlCharacters || 'Unnamed database';
};

export interface BuildStudioShardManifestOptions {
  /** Per-shard status, when the host has probed connectivity. */
  statusById?: Readonly<Record<string, { status: StudioShardStatus; message?: string }>>;
}

export const buildStudioShardManifest = (
  result: StudioHostTargetsResult,
  options: BuildStudioShardManifestOptions = {}
): StudioShardManifest => {
  const { statusById = {} } = options;

  const shards = result.targets.map((target) => {
    const status = statusById[target.id];

    const entry: StudioShardManifestEntry = {
      id: target.id,
      label: sanitizeLabel(target.label),
      status: status?.status ?? 'unknown',
      aliasIds: [...target.aliasIds],
      sources: target.sources.filter(isSafeSourceName),
    };

    if (status?.message) {
      entry.statusMessage = status.message;
    }

    return entry;
  });

  const warnings: string[] = [];

  if (result.missingShardIds.length > 0) {
    warnings.push(
      `Missing connection URLs for ${result.missingShardIds.join(', ')}. ` +
        'Those shards are not selectable.'
    );
  }

  for (const duplicate of result.duplicates) {
    warnings.push(
      `${duplicate.id} points at the same physical database as ${duplicate.sameAs} and is shown once.`
    );
  }

  if (result.usedPrimaryFallback) {
    warnings.push(
      'No shards are configured; Studio is connected to DATABASE_URL as a single database.'
    );
  }

  return {
    version: 1,
    defaultShardId: shards[0]?.id ?? null,
    shards,
    warnings,
  };
};

/**
 * Defence in depth for the security boundary that matters most.
 *
 * The manifest is the only shard-derived payload sent to the browser, so it is
 * re-scanned for connection strings and credential-shaped values immediately
 * before serialization. A leak fails loudly here instead of silently shipping
 * a password into a page.
 */
export const assertStudioShardManifestIsSafe = (
  manifest: StudioShardManifest,
  targets: readonly StudioHostTarget[]
): void => {
  const serialized = JSON.stringify(manifest);

  if (/(postgres(ql)?|mysql|mongodb):\/\//i.test(serialized)) {
    throw new Error('Studio shard manifest contained a connection string.');
  }

  if (/:\/\/[^/\s"]*:[^/\s"]*@/.test(serialized)) {
    throw new Error('Studio shard manifest contained embedded credentials.');
  }

  for (const target of targets) {
    if (!target.url) {
      continue;
    }

    if (serialized.includes(target.url)) {
      throw new Error('Studio shard manifest contained a configured database URL.');
    }

    // The parse is guarded, but the assertion must not be: wrapping the throw
    // in the same try would let this check silently swallow its own failure.
    let password = '';

    try {
      password = decodeURIComponent(new URL(target.url).password);
    } catch {
      // A URL that does not parse has no structured password to compare; the
      // literal-URL and credential-pattern checks above still apply.
      continue;
    }

    if (password && serialized.includes(password)) {
      throw new Error('Studio shard manifest contained a database password.');
    }
  }
};
