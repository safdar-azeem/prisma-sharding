export interface PostgresUrlInfo {
  host: string;
  port: number;
  database: string;
  socketPath?: string;
}

export const parsePostgresUrl = (url: string): PostgresUrlInfo | null => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
      return null;
    }

    const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
    const port = parsed.port ? Number(parsed.port) : 5432;
    const queryHost = parsed.searchParams.get('host');
    const host = parsed.hostname.replace(/^\[(.*)\]$/, '$1');

    if (!database || !host || !Number.isInteger(port) || port <= 0 || port > 65535) {
      return null;
    }

    return {
      host,
      port,
      database,
      socketPath: queryHost?.startsWith('/') ? queryHost : undefined,
    };
  } catch {
    return null;
  }
};

export const postgresEndpoint = (info: PostgresUrlInfo): string =>
  info.socketPath || `${info.host}:${info.port}`;
