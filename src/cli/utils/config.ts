import fs from 'fs';
import path from 'path';

/**
 * Optional, source-controlled project configuration for prisma-sharding.
 *
 * The legacy baseline is deliberately declarative: adopting a `db push`-built
 * database means permanently recording migrations as applied without running
 * their SQL, and that decision belongs in code review, not in a terminal flag.
 */
export interface LegacyBaselineConfig {
  /** Newest migration whose schema AND data effects are already present. */
  until: string;
  /** Explicit human attestation that the cutoff was verified. */
  verified?: boolean;
}

export interface PostgresExtensionConfig {
  /** PostgreSQL extension name as listed by pg_available_extensions. */
  name: string;
  /** Schema that must own the extension objects. Defaults to public. */
  schema?: string;
}

export interface ShardingProjectConfig {
  postgresql?: {
    /** Idempotently provisioned before the db-push fallback runs. */
    extensions?: PostgresExtensionConfig[];
  };
  migrations?: {
    legacyBaseline?: LegacyBaselineConfig;
  };
}

export interface LoadedProjectConfig {
  config: ShardingProjectConfig;
  source?: string;
  error?: string;
}

const CONFIG_FILENAMES = [
  'prisma-sharding.config.json',
  'prisma-sharding.config.cjs',
  'prisma-sharding.config.js',
];

export const loadProjectConfig = (cwd: string = process.cwd()): LoadedProjectConfig => {
  for (const filename of CONFIG_FILENAMES) {
    const filePath = path.join(cwd, filename);
    if (!fs.existsSync(filePath)) {
      continue;
    }

    try {
      if (filename.endsWith('.json')) {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return { config: parsed as ShardingProjectConfig, source: filename };
      }

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const loaded = require(filePath);
      const config = (loaded && loaded.default ? loaded.default : loaded) as ShardingProjectConfig;
      return { config: config || {}, source: filename };
    } catch (error) {
      return {
        config: {},
        source: filename,
        error: `Could not read ${filename}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  return { config: {} };
};
