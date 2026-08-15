import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const CONFIG_FILENAMES = [
  'prisma.config.ts',
  'prisma.config.mts',
  'prisma.config.cts',
  'prisma.config.js',
  'prisma.config.mjs',
  'prisma.config.cjs',
];

export interface MigrationsDirectoryResult {
  path?: string;
  source: string;
  error?: string;
}

export interface LocalMigrationHistory {
  migrations: string[];
  errors: string[];
}

/**
 * A byte-wise ordering is stable across operating systems and locales. Migration
 * directory names are identifiers, not natural-language strings, so localeCompare
 * can make fleet decisions differ between otherwise identical machines.
 */
const compareMigrationNames = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const readMigrationsPathFromConfig = (cwd: string): string | undefined => {
  for (const filename of CONFIG_FILENAMES) {
    const configPath = path.join(cwd, filename);
    if (!fs.existsSync(configPath)) {
      continue;
    }
    try {
      const contents = fs.readFileSync(configPath, 'utf8');
      const match = contents.match(
        /migrations\s*:\s*\{[^}]*?\bpath\s*:\s*['"`]([^'"`]+)['"`]/s
      );
      if (match?.[1]) {
        return match[1];
      }
    } catch {
      // Unreadable config: fall through to the next candidate.
    }
  }
  return undefined;
};

interface ConfiguredSchemaPath {
  configured: boolean;
  path?: string;
}

const readSchemaPathFromConfig = (cwd: string): ConfiguredSchemaPath => {
  for (const filename of CONFIG_FILENAMES) {
    const configPath = path.join(cwd, filename);
    if (!fs.existsSync(configPath)) {
      continue;
    }
    try {
      const contents = fs.readFileSync(configPath, 'utf8');
      const match = contents.match(/\bschema\s*:\s*['"`]([^'"`]+)['"`]/s);
      if (match?.[1]) {
        return { configured: true, path: match[1] };
      }
      if (/\bschema\s*:/.test(contents)) {
        // Dynamic config cannot be evaluated safely by static source inspection.
        // Report unresolved instead of silently selecting a different schema.
        return { configured: true };
      }
    } catch {
      // Unreadable config: fall through to the next candidate.
    }
  }
  return { configured: false };
};

export const resolveMigrationsDirectory = (
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env
): MigrationsDirectoryResult => {
  const candidates: Array<{ value: string; source: string }> = [];

  if (env.PRISMA_MIGRATIONS_PATH?.trim()) {
    candidates.push({
      value: env.PRISMA_MIGRATIONS_PATH.trim(),
      source: 'PRISMA_MIGRATIONS_PATH',
    });
  }

  const fromConfig = readMigrationsPathFromConfig(cwd);
  if (fromConfig) {
    candidates.push({ value: fromConfig, source: 'prisma.config' });
  }

  candidates.push({ value: path.join('prisma', 'migrations'), source: 'default' });

  for (const candidate of candidates) {
    const resolved = path.isAbsolute(candidate.value)
      ? candidate.value
      : path.resolve(cwd, candidate.value);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      return { path: resolved, source: candidate.source };
    }
  }

  return {
    source: 'none',
    error:
      'Migrations directory not found. Looked for ' +
      candidates.map((candidate) => candidate.value).join(', ') +
      ' relative to ' +
      cwd +
      '.',
  };
};

export const resolveSchemaPath = (
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env
): string | undefined => {
  const envPath = env.PRISMA_SCHEMA_PATH?.trim();
  const configured = readSchemaPathFromConfig(cwd);
  if (!envPath && configured.configured && !configured.path) {
    return undefined;
  }
  const explicitPath = envPath || configured.path;
  const candidates = explicitPath
    ? [explicitPath]
    : [path.join('prisma', 'schema'), path.join('prisma', 'schema.prisma')];

  for (const candidate of candidates) {
    const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
  }

  return undefined;
};

/**
 * Stable digest of migration names and LF-normalised SQL. A verified bootstrap
 * contract pins the complete history, so adding or editing any migration forces
 * isolated re-validation before a new empty database may be initialized.
 */
export const readLocalMigrationHistoryDigest = (
  migrationsDirectory: string
): string => {
  const history = readLocalMigrationHistory(migrationsDirectory);
  const digest = crypto.createHash('sha256');

  for (const name of history.migrations) {
    const sql = fs
      .readFileSync(path.join(migrationsDirectory, name, 'migration.sql'), 'utf8')
      .replace(/\r\n/g, '\n');
    const sqlDigest = crypto.createHash('sha256').update(sql, 'utf8').digest('hex');
    digest.update(name, 'utf8');
    digest.update('\0', 'utf8');
    digest.update(sqlDigest, 'utf8');
    digest.update('\n', 'utf8');
  }

  return digest.digest('hex');
};

const listPrismaSchemaFiles = (schemaPath: string): string[] => {
  const stat = fs.statSync(schemaPath);
  if (stat.isFile()) {
    return [schemaPath];
  }

  const files: string[] = [];
  const visit = (directory: string): void => {
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareMigrationNames(left.name, right.name));
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile() && entry.name.endsWith('.prisma')) {
        files.push(entryPath);
      }
    }
  };
  visit(schemaPath);
  return files;
};

/** Stable fingerprint of a single-file or multi-file Prisma datamodel. */
export const readPrismaSchemaDigest = (schemaPath: string): string => {
  const files = listPrismaSchemaFiles(schemaPath);
  if (files.length === 0) {
    throw new Error(`No .prisma schema files were found under ${schemaPath}.`);
  }

  const root = fs.statSync(schemaPath).isDirectory()
    ? schemaPath
    : path.dirname(schemaPath);
  const digest = crypto.createHash('sha256');
  for (const filePath of files) {
    const relative = path.relative(root, filePath).split(path.sep).join('/');
    const contents = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
    const fileDigest = crypto
      .createHash('sha256')
      .update(contents, 'utf8')
      .digest('hex');
    digest.update(relative, 'utf8');
    digest.update('\0', 'utf8');
    digest.update(fileDigest, 'utf8');
    digest.update('\n', 'utf8');
  }
  return digest.digest('hex');
};

/**
 * Acceptable SHA-256 digests for each local migration.sql, matching the
 * checksum Prisma stores in `_prisma_migrations` (a hex SHA-256 of the script).
 * Both the raw bytes and an LF-normalised variant are computed so a Git
 * line-ending conversion is not misreported as an edited migration.
 */
export const readLocalMigrationChecksums = (
  migrationsDirectory: string
): Record<string, string[]> => {
  const checksums: Record<string, string[]> = {};

  for (const name of readLocalMigrations(migrationsDirectory)) {
    try {
      const raw = fs.readFileSync(path.join(migrationsDirectory, name, 'migration.sql'));
      const rawHex = crypto.createHash('sha256').update(raw).digest('hex');
      const normalized = raw.toString('utf8').replace(/\r\n/g, '\n');
      const normalizedHex = crypto
        .createHash('sha256')
        .update(normalized, 'utf8')
        .digest('hex');
      checksums[name] = rawHex === normalizedHex ? [rawHex] : [rawHex, normalizedHex];
    } catch {
      // Unreadable file: leave it out; readLocalMigrations already vouched for it.
    }
  }

  return checksums;
};

export const readLocalMigrations = (migrationsDirectory: string): string[] => {
  return readLocalMigrationHistory(migrationsDirectory).migrations;
};

/**
 * Reads and validates the on-disk history without attempting to interpret SQL.
 * SQL semantics are intentionally not guessed here. Normal updates let Prisma
 * deploy the history; optional strict bootstrap verification exercises it on a
 * separately provisioned disposable PostgreSQL environment.
 */
export const readLocalMigrationHistory = (
  migrationsDirectory: string
): LocalMigrationHistory => {
  const entries = (() => {
    try {
      return fs.readdirSync(migrationsDirectory, { withFileTypes: true });
    } catch {
      return [] as fs.Dirent[];
    }
  })();

  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareMigrationNames);
  const errors: string[] = [];
  const caseInsensitiveNames = new Map<string, string>();

  for (const name of directories) {
    const folded = name.toLocaleLowerCase('en-US');
    const existing = caseInsensitiveNames.get(folded);
    if (existing && existing !== name) {
      errors.push(
        `Migration directories '${existing}' and '${name}' differ only by letter case. ` +
          'That history is not portable across filesystems.'
      );
    } else {
      caseInsensitiveNames.set(folded, name);
    }

    const sqlPath = path.join(migrationsDirectory, name, 'migration.sql');
    if (!fs.existsSync(sqlPath)) {
      errors.push(`Migration directory '${name}' has no migration.sql file.`);
      continue;
    }
    try {
      const stat = fs.statSync(sqlPath);
      if (!stat.isFile()) {
        errors.push(`Migration '${name}' has a migration.sql path that is not a file.`);
      } else if (stat.size === 0) {
        errors.push(`Migration '${name}' has an empty migration.sql file.`);
      }
    } catch (error) {
      errors.push(
        `Migration '${name}' could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return {
    migrations: directories.filter((name) =>
      fs.existsSync(path.join(migrationsDirectory, name, 'migration.sql'))
    ),
    errors,
  };
};
