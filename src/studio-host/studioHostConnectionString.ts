/**
 * Translates a Prisma-style connection string into postgres.js client options.
 *
 * Prisma's PostgreSQL URLs carry driver arguments in the query string -
 * `?schema=public`, `?connection_limit=5`, `?pgbouncer=true` and friends.
 * Prisma's own engine consumes them; postgres.js does not recognise them and
 * forwards anything it does not know to the server as a startup parameter,
 * which PostgreSQL rejects outright:
 *
 *     unrecognized configuration parameter "schema"
 *
 * This is the same class of problem `sslrootcert` caused for embedders
 * (prisma/studio#1433). Every Studio operation, including introspection, fails
 * before it starts, because the connection itself is refused.
 *
 * So the arguments Prisma owns are consumed here rather than forwarded:
 * translated into the equivalent postgres.js option where one exists, dropped
 * where they describe behaviour Studio does not need, and left untouched when
 * they are genuine PostgreSQL settings the server should receive.
 */

export interface StudioHostConnectionSettings {
  /** Connection string with Prisma-only arguments removed. */
  connectionString: string;
  /** postgres.js client options derived from the consumed arguments. */
  options: {
    connection?: Record<string, string>;
    max?: number;
    path?: string;
  };
  /** Schema requested by `?schema=`, when present. */
  schema?: string;
  /** Argument names that were consumed. Diagnostics only; never printed with values. */
  consumed: string[];
}

/**
 * Prisma-specific arguments that describe engine behaviour with no postgres.js
 * equivalent. Forwarding them would break the connection; honouring them would
 * mean reimplementing Prisma's engine. They are dropped.
 */
const PRISMA_ONLY_ARGUMENTS = new Set([
  'pgbouncer',
  'pool_timeout',
  'socket_timeout',
  'statement_cache_size',
  'sslidentity',
  'sslaccept',
  'channel_binding',
  'schema_search_path',
]);

const parsePositiveInteger = (value: string): number | undefined => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

export const normalizeStudioHostConnectionString = (
  url: string
): StudioHostConnectionSettings => {
  const trimmed = url.trim();
  const questionMarkIndex = trimmed.indexOf('?');

  if (questionMarkIndex === -1) {
    return { connectionString: trimmed, options: {}, consumed: [] };
  }

  const base = trimmed.slice(0, questionMarkIndex);
  const parameters = new URLSearchParams(trimmed.slice(questionMarkIndex + 1));
  const consumed: string[] = [];
  const options: StudioHostConnectionSettings['options'] = {};
  let schema: string | undefined;

  const take = (name: string): string | undefined => {
    // Later occurrences win, matching libpq semantics.
    const value = parameters.getAll(name).at(-1)?.trim();

    if (value === undefined) {
      return undefined;
    }

    parameters.delete(name);
    consumed.push(name);

    return value || undefined;
  };

  const schemaValue = take('schema');

  if (schemaValue) {
    schema = schemaValue;
    // A GUC in the startup packet, so unqualified identifiers resolve in the
    // configured schema for every query on the connection. Studio's executor
    // still applies a transaction-local search_path when the UI asks for a
    // specific schema; this only sets the default.
    options.connection = { ...options.connection, search_path: schemaValue };
  }

  const connectionLimit = take('connection_limit');

  if (connectionLimit) {
    const parsed = parsePositiveInteger(connectionLimit);

    if (parsed !== undefined) {
      options.max = parsed;
    }
  }

  const applicationName = take('application_name');

  if (applicationName) {
    options.connection = { ...options.connection, application_name: applicationName };
  }

  // Prisma spells the unix socket directory `?host=/var/run/postgresql`, while
  // postgres.js expects the full socket path.
  const socketDirectory = take('host');

  if (socketDirectory && socketDirectory.startsWith('/')) {
    let port = '5432';

    try {
      port = new URL(base).port || '5432';
    } catch {
      // Keep the default port when the base URL cannot be parsed; the socket
      // path is still better than forwarding `host` as a startup parameter.
    }

    options.path = `${socketDirectory.replace(/\/+$/, '')}/.s.PGSQL.${port}`;
  }

  for (const name of PRISMA_ONLY_ARGUMENTS) {
    take(name);
  }

  // Anything still in the query string is either understood by postgres.js or
  // a genuine PostgreSQL setting the operator meant the server to receive, so
  // it is passed through untouched rather than guessed at.
  const remainingQuery = parameters.toString();

  return {
    connectionString: remainingQuery ? `${base}?${remainingQuery}` : base,
    options,
    schema,
    consumed,
  };
};
