import { Client } from 'pg';

const DEFAULT_TIMEOUT_MS = 5000;
const DATABASE_MISSING_CODE = '3D000';

export interface AppliedMigrationRow {
  name: string;
  finishedAt: Date | string | null;
  rolledBackAt: Date | string | null;
  checksum: string | null;
}

export interface IntrospectionResult {
  reachable: boolean;
  empty: boolean;
  hasMigrationsTable: boolean;
  databaseMissing: boolean;
  userTableCount: number;
  applied: AppliedMigrationRow[];
  /** The PostgreSQL schema that was inspected (from the URL's ?schema=, default public). */
  schemaName?: string;
  error?: string;
}

export type IntrospectFn = (
  url: string,
  timeoutMs?: number
) => Promise<IntrospectionResult>;

const UNREACHABLE: Omit<IntrospectionResult, 'error'> = {
  reachable: false,
  empty: false,
  hasMigrationsTable: false,
  databaseMissing: false,
  userTableCount: 0,
  applied: [],
};

/**
 * The PostgreSQL schema Prisma targets for this connection string. Prisma
 * encodes it as a `?schema=` query parameter; plain `pg` ignores that
 * parameter, so introspection must apply it explicitly.
 */
export const getSchemaFromUrl = (url: string): string => {
  try {
    return new URL(url).searchParams.get('schema')?.trim() || 'public';
  } catch {
    return 'public';
  }
};

const quoteIdentifier = (identifier: string): string =>
  `"${identifier.replace(/"/g, '""')}"`;

/**
 * Reads migration state directly instead of parsing `prisma migrate status` text.
 * This is read-only: it never creates, alters or drops anything. It honours the
 * URL's `?schema=` parameter the same way Prisma does.
 */
export const introspectDatabase: IntrospectFn = async (
  url,
  timeoutMs = DEFAULT_TIMEOUT_MS
) => {
  const schemaName = getSchemaFromUrl(url);
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: timeoutMs,
    statement_timeout: timeoutMs,
    application_name: 'prisma-sharding-cli',
  });

  try {
    await client.connect();
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    return {
      ...UNREACHABLE,
      schemaName,
      databaseMissing: code === DATABASE_MISSING_CODE,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const tables = await client.query(
      `SELECT COUNT(*)::text AS count
         FROM information_schema.tables
        WHERE table_schema = $1
          AND table_type = 'BASE TABLE'
          AND table_name <> '_prisma_migrations'`,
      [schemaName]
    );

    const migrationsTable = await client.query(
      `SELECT EXISTS (
         SELECT 1
           FROM information_schema.tables
          WHERE table_schema = $1
            AND table_name = '_prisma_migrations'
       ) AS exists`,
      [schemaName]
    );

    const userTableCount = Number(tables.rows[0]?.count || '0');
    const hasMigrationsTable = Boolean(migrationsTable.rows[0]?.exists);

    let applied: AppliedMigrationRow[] = [];
    if (hasMigrationsTable) {
      const history = await client.query(
        `SELECT migration_name, checksum, finished_at, rolled_back_at
           FROM ${quoteIdentifier(schemaName)}."_prisma_migrations"
          ORDER BY migration_name ASC`
      );
      applied = history.rows.map((row) => ({
        name: row.migration_name as string,
        checksum: (row.checksum as string | null) ?? null,
        finishedAt: row.finished_at,
        rolledBackAt: row.rolled_back_at,
      }));
    }

    return {
      reachable: true,
      empty: userTableCount === 0,
      hasMigrationsTable,
      databaseMissing: false,
      userTableCount,
      applied,
      schemaName,
    };
  } catch (error) {
    return {
      ...UNREACHABLE,
      reachable: true,
      schemaName,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await client.end().catch(() => undefined);
  }
};
