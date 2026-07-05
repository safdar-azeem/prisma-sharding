import http from 'http';
import net from 'net';

export type PortUsageStatus = 'available' | 'occupied' | 'unavailable';

export interface PortCheckResult {
  host: string;
  available: boolean;
  skipped?: boolean;
  code?: string;
  message?: string;
}

export interface PortUsage {
  port: number;
  status: PortUsageStatus;
  checks: PortCheckResult[];
}

export interface PrismaStudioProbe {
  reachable: boolean;
  isPrismaStudio: boolean;
  host?: string;
  detail: string;
}

const LISTEN_CHECK_HOSTS = ['127.0.0.1', '::1', '0.0.0.0', '::'];
const HTTP_PROBE_HOSTS = ['127.0.0.1', '::1', 'localhost'];
const HTTP_PROBE_BODY_LIMIT = 16 * 1024;

const unsupportedAddressCodes = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT']);

const checkListenHost = (port: number, host: string): Promise<PortCheckResult> => {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;

    const finish = (result: PortCheckResult) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    server.once('error', (error: NodeJS.ErrnoException) => {
      const code = error.code;
      if (code && unsupportedAddressCodes.has(code)) {
        finish({ host, available: true, skipped: true, code, message: error.message });
        return;
      }

      finish({ host, available: false, code, message: error.message });
    });

    server.listen({ port, host }, () => {
      server.close(() => {
        finish({ host, available: true });
      });
    });
  });
};

export const getPortUsage = async (port: number): Promise<PortUsage> => {
  const checks: PortCheckResult[] = [];

  for (const host of LISTEN_CHECK_HOSTS) {
    checks.push(await checkListenHost(port, host));
  }

  const occupied = checks.some((check) => check.code === 'EADDRINUSE');
  const unavailable = checks.some(
    (check) => !check.available && check.code && check.code !== 'EADDRINUSE'
  );

  return {
    port,
    status: occupied ? 'occupied' : unavailable ? 'unavailable' : 'available',
    checks,
  };
};

const responseLooksLikePrismaStudio = (
  body: string,
  headers: http.IncomingHttpHeaders
): boolean => {
  const headerText = Object.entries(headers)
    .map(([key, value]) => `${key}:${Array.isArray(value) ? value.join(',') : value || ''}`)
    .join('\n');
  const text = `${headerText}\n${body}`.toLowerCase();
  const hasModernStudioShell =
    text.includes('window.__studio_config__') &&
    text.includes('/studio.js') &&
    text.includes('/studio.css');
  const hasLegacyStudioShell =
    text.includes('createstudiobffclient') &&
    text.includes('/data/bff/index.js') &&
    text.includes('/ui/index.js') &&
    text.includes('/adapter.js');

  return (
    text.includes('prisma studio') ||
    text.includes('prisma-studio') ||
    text.includes('@prisma/studio') ||
    text.includes('prisma.io/studio') ||
    text.includes('@prisma/studio-core') ||
    hasModernStudioShell ||
    hasLegacyStudioShell
  );
};

const probeHttpHost = (
  port: number,
  host: string,
  timeoutMs: number
): Promise<PrismaStudioProbe> => {
  return new Promise((resolve) => {
    let settled = false;
    let body = '';

    const finish = (probe: PrismaStudioProbe) => {
      if (!settled) {
        settled = true;
        resolve(probe);
      }
    };

    const request = http.request(
      {
        hostname: host,
        port,
        path: '/',
        method: 'GET',
        timeout: timeoutMs,
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        },
      },
      (response) => {
        response.setEncoding('utf8');

        response.on('data', (chunk: string) => {
          if (body.length < HTTP_PROBE_BODY_LIMIT) {
            body += chunk.slice(0, HTTP_PROBE_BODY_LIMIT - body.length);
          }
        });

        response.on('end', () => {
          const isPrismaStudio = responseLooksLikePrismaStudio(body, response.headers);
          finish({
            reachable: true,
            isPrismaStudio,
            host,
            detail: `HTTP ${response.statusCode || 'response'}`,
          });
        });
      }
    );

    request.once('timeout', () => {
      request.destroy();
      finish({
        reachable: false,
        isPrismaStudio: false,
        host,
        detail: `HTTP probe timed out after ${timeoutMs}ms`,
      });
    });

    request.once('error', (error: Error) => {
      finish({
        reachable: false,
        isPrismaStudio: false,
        host,
        detail: error.message,
      });
    });

    request.end();
  });
};

export const probePrismaStudio = async (
  port: number,
  timeoutMs = 1200
): Promise<PrismaStudioProbe> => {
  const probes = await Promise.all(
    HTTP_PROBE_HOSTS.map((host) => probeHttpHost(port, host, timeoutMs))
  );
  const prismaStudio = probes.find((probe) => probe.isPrismaStudio);
  if (prismaStudio) {
    return prismaStudio;
  }

  const reachable = probes.find((probe) => probe.reachable);
  if (reachable) {
    return {
      ...reachable,
      isPrismaStudio: false,
      detail: `${reachable.detail}; response did not look like Prisma Studio`,
    };
  }

  return {
    reachable: false,
    isPrismaStudio: false,
    detail: probes.map((probe) => `${probe.host}: ${probe.detail}`).join('; '),
  };
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const waitForPrismaStudio = async (
  port: number,
  timeoutMs: number,
  intervalMs = 400,
  shouldContinue: () => boolean = () => true
): Promise<PrismaStudioProbe> => {
  const startedAt = Date.now();
  let lastProbe: PrismaStudioProbe = {
    reachable: false,
    isPrismaStudio: false,
    detail: 'Studio probe has not run yet',
  };

  while (Date.now() - startedAt < timeoutMs && shouldContinue()) {
    lastProbe = await probePrismaStudio(port, Math.min(intervalMs, 1000));
    if (lastProbe.isPrismaStudio) {
      return lastProbe;
    }
    if (!shouldContinue()) {
      return lastProbe;
    }
    await delay(intervalMs);
  }

  return lastProbe;
};
