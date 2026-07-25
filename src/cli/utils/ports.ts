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
  /**
   * Credential-free identity reported by a Prisma Sharding Studio host.
   *
   * Present only when the occupant is our own host and answered the identity
   * endpoint. A port answering with anything else leaves this undefined and is
   * never treated as reusable.
   */
  fingerprint?: string;
  shardCount?: number;
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

/**
 * Path the Studio host answers with its credential-free identity.
 *
 * Identity is asserted by the host itself rather than guessed from HTML, so
 * "is this port one of ours, for this exact project?" has a definitive answer
 * instead of a heuristic one.
 */
export const STUDIO_HOST_IDENTITY_PATH = '/api/studio/identity';

const STUDIO_HOST_PRODUCT = 'prisma-sharding-studio';

interface StudioHostIdentityResponse {
  product?: unknown;
  fingerprint?: unknown;
  shardCount?: unknown;
}

const readStudioHostIdentity = (
  body: string
): { fingerprint: string; shardCount?: number } | undefined => {
  try {
    const parsed = JSON.parse(body) as StudioHostIdentityResponse;

    if (parsed?.product !== STUDIO_HOST_PRODUCT || typeof parsed.fingerprint !== 'string') {
      return undefined;
    }

    return {
      fingerprint: parsed.fingerprint,
      shardCount: typeof parsed.shardCount === 'number' ? parsed.shardCount : undefined,
    };
  } catch {
    return undefined;
  }
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
        path: STUDIO_HOST_IDENTITY_PATH,
        method: 'GET',
        timeout: timeoutMs,
        headers: {
          Accept: 'application/json',
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
          const identity = readStudioHostIdentity(body);

          finish({
            reachable: true,
            isPrismaStudio: Boolean(identity),
            host,
            detail: `HTTP ${response.statusCode || 'response'}`,
            fingerprint: identity?.fingerprint,
            shardCount: identity?.shardCount,
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
      detail: `${reachable.detail}; not a Prisma Sharding Studio host`,
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
