import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const CONFIG_FILENAMES = ['prisma.config.ts', 'prisma.config.mts', 'prisma.config.js'];

export interface MigrationsDirectoryResult {
  path?: string;
  source: string;
  error?: string;
}

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
  const candidates = [
    env.PRISMA_SCHEMA_PATH?.trim(),
    path.join('prisma', 'schema'),
    path.join('prisma', 'schema.prisma'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
  }

  return undefined;
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
  const entries = (() => {
    try {
      return fs.readdirSync(migrationsDirectory, { withFileTypes: true });
    } catch {
      return [] as fs.Dirent[];
    }
  })();

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(migrationsDirectory, name, 'migration.sql')))
    .sort((a, b) => a.localeCompare(b));
};
