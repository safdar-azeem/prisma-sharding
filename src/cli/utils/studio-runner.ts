import { createStudioHostPostgresConnectionFactory } from '../../studio-host/studioHostPostgresConnection';
import {
  createStudioHostServer,
  StudioHostServer,
} from '../../studio-host/studioHostServer';
import {
  createStudioHostService,
  StudioHostService,
} from '../../studio-host/studioHostService';
import {
  NO_STUDIO_TARGETS_MESSAGE,
  resolveStudioHostTargets,
} from '../../studio-host/studioHostTargets';
import { resolveSchemaPath } from './migrations';
import { getPortUsage, probePrismaStudio } from './ports';
import { getStudioOptions, StudioOptions } from './studio-options';
import {
  computeStudioFingerprint,
  isPidAlive,
  readStudioRegistryEntry,
  removeStudioRegistryEntry,
  writeStudioRegistryEntry,
} from './studio-registry';

/**
 * Starts ONE Studio host for the invoking project.
 *
 * The previous implementation spawned a `prisma studio` child process per
 * shard, on sequential ports, producing one browser URL per database. This runs
 * a single in-process HTTP server that serves every configured shard behind one
 * URL, with the database chosen inside Studio.
 *
 * Everything is still resolved from the project that invoked the CLI: its
 * working directory, its `.env` (already loaded by `studio.ts`), its schema and
 * its shard URLs. Nothing resolves relative to the installed library.
 *
 * Because the host runs in this process rather than in spawned children, there
 * are no child processes to track, orphan or force-kill; shutdown is closing
 * one server and disposing one bounded connection pool.
 */

const projectRoot = process.cwd();
const projectSchemaPath = resolveSchemaPath(projectRoot) || '';

interface StartedHost {
  port: number;
  url: string;
  reused: boolean;
  server?: StudioHostServer;
  service?: StudioHostService;
}

let startedHost: StartedHost | undefined;
let activeOptions: StudioOptions | undefined;
let isShuttingDown = false;
let keepAliveTimer: NodeJS.Timeout | undefined;

const studioUrl = (port: number): string => `http://localhost:${port}`;

const logVerbose = (
  options: StudioOptions,
  message: string,
  writer: (line: string) => void = console.log
): void => {
  if (options.verbose) {
    writer(message);
  }
};

/**
 * Reuse is only safe when the occupant is provably OUR host for THIS project:
 * a registry entry whose fingerprint matches the project root, schema and full
 * shard set, whose recorded process is still alive, and whose port reports the
 * same fingerprint from its own identity endpoint. Anything else on the port -
 * another project's host, an unrelated service - is left completely untouched
 * and the scan moves on.
 */
const tryReuseMatchingHost = async (
  port: number,
  fingerprint: string,
  options: StudioOptions
): Promise<StartedHost | undefined> => {
  const entry = readStudioRegistryEntry(options.registryDirectory, port);

  if (!entry) {
    logVerbose(
      options,
      `   Port ${port} is occupied by an unidentified process; leaving it untouched.`
    );
    return undefined;
  }

  if (!isPidAlive(entry.pid)) {
    // Stale record from a crashed run: the occupant is something else entirely.
    removeStudioRegistryEntry(options.registryDirectory, port);
    logVerbose(options, `   Removed stale Studio registry entry for port ${port}.`);
    return undefined;
  }

  if (entry.fingerprint !== fingerprint) {
    logVerbose(
      options,
      `   Port ${port} runs a Studio host for a different project or shard set (${entry.projectRoot}); not reusing.`
    );
    return undefined;
  }

  if (!options.reuseExisting) {
    logVerbose(
      options,
      `   Matching Studio host on port ${port} ignored because SHARD_STUDIO_REUSE_EXISTING is false.`
    );
    return undefined;
  }

  const probe = await probePrismaStudio(port);

  if (!probe.isPrismaStudio || probe.fingerprint !== fingerprint) {
    logVerbose(
      options,
      `   Registry matched port ${port} but the host did not confirm the same identity (${probe.detail}); not reusing.`
    );
    return undefined;
  }

  return { port, url: studioUrl(port), reused: true };
};

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

const startOwnHost = async (
  port: number,
  service: StudioHostService,
  options: StudioOptions
): Promise<{ host?: StartedHost; addressInUse?: boolean; error?: Error }> => {
  const server = createStudioHostServer({
    service,
    host: options.bindHost,
    logger: { warn: (message) => logVerbose(options, `   ${message}`, console.warn) },
  });

  let listeningPort: number;

  try {
    listeningPort = await Promise.race([
      server.listen(port),
      wait(options.startupTimeoutMs).then<number>(() => {
        throw new Error(`Timed out binding port ${port}`);
      }),
    ]);
  } catch (error) {
    await server.close().catch(() => undefined);

    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      // Lost a startup race for this port. The caller scans on, and whatever
      // claimed the port is left untouched.
      return { addressInUse: true };
    }

    return { error: error as Error };
  }

  // A host that binds and immediately dies must not be reported as started.
  await wait(options.stabilityMs);

  if (!server.server.listening) {
    await server.close().catch(() => undefined);
    return { error: new Error('The Studio host stopped immediately after starting.') };
  }

  return {
    host: {
      port: listeningPort,
      url: studioUrl(listeningPort),
      reused: false,
      server,
      service,
    },
  };
};

const printFailure = (options: StudioOptions, lastError?: Error): void => {
  console.log('🗄️ Prisma Sharding Studio\n');
  console.log(
    `❌ Studio  ${
      lastError
        ? 'Failed to start'
        : `No free port in ${options.basePort}-${options.basePort + options.portScanLimit - 1}`
    }`
  );

  if (options.verbose) {
    console.log(
      `\n   ${
        lastError?.message ||
        'Every occupied port belonged to another project or process and was left untouched.'
      }`
    );
    return;
  }

  console.log('\nRun with SHARD_STUDIO_VERBOSE=true for details.');
};

/** One URL, plus one line about how many databases it serves. */
const printResult = (shardCount: number, options: StudioOptions): void => {
  if (!startedHost) {
    return;
  }

  const icon = startedHost.reused ? '♻️' : '✅';
  const databases = `${shardCount} ${shardCount === 1 ? 'database' : 'databases'}`;

  console.log('🗄️ Prisma Sharding Studio\n');
  console.log(`${icon} Studio  ${startedHost.url}`);
  console.log(`   ${databases} available. Switch between them inside Studio.`);

  if (!options.verbose) {
    return;
  }

  console.log('\nVerbose details:');
  console.log(`   Base port: ${options.basePort}`);
  console.log(`   Bound interface: ${options.bindHost}`);
  console.log(`   Reuse existing host: ${options.reuseExisting ? 'yes' : 'no'}`);
  console.log(`   Startup timeout: ${options.startupTimeoutMs}ms`);
  console.log(`   Startup stability window: ${options.stabilityMs}ms`);
  console.log(`   Max open shard connections: ${options.maxOpenConnections}`);
  console.log(`   Idle connection timeout: ${options.idleConnectionTimeoutMs}ms`);
  console.log(`   Owned by this run: ${startedHost.reused ? 'no (reused)' : 'yes'}`);
};

const startStudioHost = async (options: StudioOptions): Promise<boolean> => {
  const targetsResult = resolveStudioHostTargets();

  if (targetsResult.targets.length === 0) {
    console.log('🗄️ Prisma Sharding Studio\n');
    console.error(`❌ ${NO_STUDIO_TARGETS_MESSAGE}`);
    process.exit(1);
  }

  if (targetsResult.missingShardIds.length > 0) {
    logVerbose(
      options,
      `Missing shard URLs: ${targetsResult.missingShardIds.join(', ')}`,
      console.warn
    );
  }

  for (const duplicate of targetsResult.duplicates) {
    logVerbose(
      options,
      `${duplicate.id} points at the same database as ${duplicate.sameAs}; listed once.`,
      console.warn
    );
  }

  const fingerprint = computeStudioFingerprint({
    projectRoot,
    schemaPath: projectSchemaPath,
    targets: targetsResult.targets,
  });

  let service: StudioHostService | undefined;
  let lastError: Error | undefined;

  for (
    let candidate = options.basePort;
    candidate < options.basePort + options.portScanLimit;
    candidate++
  ) {
    logVerbose(options, `\n🔎 Checking Studio host port ${candidate}...`);
    const portUsage = await getPortUsage(candidate);

    if (portUsage.status === 'unavailable') {
      logVerbose(
        options,
        `   Port ${candidate} could not be checked safely; trying the next one.`
      );
      continue;
    }

    if (portUsage.status === 'occupied') {
      const reused = await tryReuseMatchingHost(candidate, fingerprint, options);

      if (reused) {
        startedHost = reused;
        printResult(targetsResult.targets.length, options);
        return true;
      }

      continue;
    }

    // Built once and carried across port attempts, so losing a port race never
    // opens and abandons database connections.
    if (!service) {
      service = createStudioHostService({
        projectRoot,
        schemaPath: projectSchemaPath,
        maxOpenConnections: options.maxOpenConnections,
        idleTimeoutMs: options.idleConnectionTimeoutMs,
        createConnection: createStudioHostPostgresConnectionFactory(),
        logger: {
          info: (message) => logVerbose(options, `   ${message}`),
          warn: (message) => logVerbose(options, `   ${message}`, console.warn),
          error: (message) => logVerbose(options, `   ${message}`, console.error),
        },
      });
    }

    const attempt = await startOwnHost(candidate, service, options);

    if (attempt.addressInUse) {
      continue;
    }

    if (attempt.error) {
      lastError = attempt.error;
      break;
    }

    startedHost = attempt.host;

    if (!startedHost) {
      continue;
    }

    writeStudioRegistryEntry(options.registryDirectory, {
      version: 2,
      port: startedHost.port,
      pid: process.pid,
      fingerprint,
      shardCount: targetsResult.targets.length,
      projectRoot,
      createdAt: new Date().toISOString(),
    });

    if (startedHost.port !== options.basePort) {
      logVerbose(
        options,
        `   Preferred port ${options.basePort} was busy; the Studio host is on ${startedHost.port}.`
      );
    }

    printResult(targetsResult.targets.length, options);
    return true;
  }

  // Nothing started: release whatever the attempt opened before reporting.
  await service?.dispose().catch(() => undefined);
  printFailure(options, lastError);

  return false;
};

/**
 * Stops only what THIS run created.
 *
 * A reused host keeps running and keeps its registry entry, so stopping one
 * project's command never affects another project's Studio, and a second
 * terminal for the same project never stops the first one's host.
 */
const shutdownOwnedHost = async (options: StudioOptions): Promise<void> => {
  if (!startedHost || startedHost.reused) {
    return;
  }

  const { server, service, port } = startedHost;

  removeStudioRegistryEntry(options.registryDirectory, port);

  // Bounded: a database that stopped responding must not prevent the CLI from
  // exiting, while the happy path still closes every pool cleanly.
  await Promise.race([
    Promise.allSettled([
      server?.close() ?? Promise.resolve(),
      service?.dispose() ?? Promise.resolve(),
    ]).then(() => undefined),
    wait(options.shutdownTimeoutMs),
  ]);
};

const gracefulShutdown = async (): Promise<void> => {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;

  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = undefined;
  }

  const options = activeOptions || getStudioOptions();
  await shutdownOwnedHost(options);
  process.exit(0);
};

process.on('SIGINT', () => {
  void gracefulShutdown();
});

process.on('SIGTERM', () => {
  void gracefulShutdown();
});

const run = async (): Promise<void> => {
  const options = getStudioOptions();
  activeOptions = options;

  const started = await startStudioHost(options);

  if (!started) {
    process.exit(options.strictPortCheck ? 1 : 0);
  }

  if (startedHost?.reused) {
    // A reused host lives in another process, so nothing here holds the event
    // loop open. The command stays attached anyway, so Ctrl+C behaves the same
    // whether the host was reused or started by this run.
    keepAliveTimer = setInterval(() => undefined, 2_147_483_647);
  }
};

run().catch((error) => {
  console.error('Failed to start Studio:', error instanceof Error ? error.message : error);
  process.exit(1);
});
