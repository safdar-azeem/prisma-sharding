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

/**
 * Source-controlled attestation that this exact migration history was validated
 * from empty in a genuinely disposable PostgreSQL environment (for example an
 * isolated CI service/container, not another schema in a production database).
 */
export interface BootstrapHistoryConfig {
  /** Must be the earliest committed migration and must construct the schema from zero. */
  initialMigration: string;
  /** SHA-256 digest reported by prisma-sharding for the complete normalised history. */
  historyDigest: string;
  /** SHA-256 digest of the exact Prisma datamodel validated with this history. */
  schemaDigest: string;
  /** Explicit human/CI attestation that the pinned history passed isolated validation. */
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
    /** Idempotently provisioned before schema push or pending migration deployment. */
    extensions?: PostgresExtensionConfig[];
  };
  migrations?: {
    legacyBaseline?: LegacyBaselineConfig;
    bootstrap?: BootstrapHistoryConfig;
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
