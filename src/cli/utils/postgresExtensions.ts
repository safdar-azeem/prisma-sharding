import { Client } from 'pg';
import { PostgresExtensionConfig } from './config';

const DEFAULT_TIMEOUT_MS = 15000;
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]*$/;

export interface ExtensionProvisionResult {
  success: boolean;
  error?: string;
}

export type EnsurePostgresExtensionsFn = (
  url: string,
  extensions: PostgresExtensionConfig[]
) => Promise<ExtensionProvisionResult>;

const quoteIdentifier = (identifier: string): string =>
  `"${identifier.replace(/"/g, '""')}"`;

const validateExtensions = (
  extensions: PostgresExtensionConfig[]
): Array<Required<PostgresExtensionConfig>> => {
  const normalized = extensions.map((extension) => ({
    name: extension.name?.trim() || '',
    schema: extension.schema?.trim() || 'public',
  }));

  for (const extension of normalized) {
    if (!IDENTIFIER_PATTERN.test(extension.name) || !IDENTIFIER_PATTERN.test(extension.schema)) {
      throw new Error(
        `Invalid PostgreSQL extension declaration: ${extension.schema}.${extension.name}`
      );
    }
  }

  const unique = new Map<string, Required<PostgresExtensionConfig>>();
  for (const extension of normalized) {
    const key = `${extension.schema}.${extension.name}`;
    if (!unique.has(key)) {
      unique.set(key, extension);
    }
  }
  return [...unique.values()];
};

/**
 * Ensures source-controlled PostgreSQL prerequisites exist before Prisma's
 * schema push or committed migrations create objects that depend on them.
 *
 * Extension DDL is serialized per physical database so concurrent application
 * deployments cannot race one another. A different existing owner schema is a
 * hard error: silently moving extension objects could break other consumers.
 */
export const ensurePostgresExtensions: EnsurePostgresExtensionsFn = async (
  url,
  extensions
) => {
  let required: Array<Required<PostgresExtensionConfig>>;
  try {
    required = validateExtensions(extensions);
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }

  if (required.length === 0) {
    return { success: true };
  }

  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: DEFAULT_TIMEOUT_MS,
    statement_timeout: DEFAULT_TIMEOUT_MS,
    application_name: 'prisma-sharding-extensions',
  });

  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('prisma-sharding:extensions')::bigint)`
    );

    for (const extension of required) {
      const installed = await client.query(
        `SELECT namespace.nspname AS schema_name
           FROM pg_extension AS extension
           JOIN pg_namespace AS namespace ON namespace.oid = extension.extnamespace
          WHERE extension.extname = $1`,
        [extension.name]
      );
      const installedSchema = installed.rows[0]?.schema_name as string | undefined;

      if (installedSchema && installedSchema !== extension.schema) {
        throw new Error(
          `Extension ${extension.name} is installed in schema ${installedSchema}; ` +
            `configuration requires ${extension.schema}`
        );
      }

      if (!installedSchema) {
        await client.query(
          `CREATE EXTENSION IF NOT EXISTS ${quoteIdentifier(extension.name)} ` +
            `WITH SCHEMA ${quoteIdentifier(extension.schema)}`
        );
      }
    }

    await client.query('COMMIT');
    return { success: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await client.end().catch(() => undefined);
  }
};
