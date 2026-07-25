import { spawn, ChildProcess } from 'child_process';
import { getNpxCommand, sanitizeCommandOutput } from './command';
import { resolveSchemaPath } from './migrations';
import { getPortUsage, probePrismaStudio, waitForPrismaStudio } from './ports';
import { terminateChildProcess, waitForChildProcessClose } from './process';
import {
  getShardConfigResult,
  maskShardUrl,
  NO_SHARDS_CONFIGURED_MESSAGE,
  ShardConfig,
} from './shards';
import { getStudioOptions, StudioOptions } from './studio-options';
import {
  computeStudioFingerprint,
  isPidAlive,
  readStudioRegistryEntry,
  removeStudioRegistryEntry,
  writeStudioRegistryEntry,
} from './studio-registry';

type StudioStatus = 'started' | 'reused' | 'failed';
type FailureSeverity = 'warning' | 'error';

interface StudioInstance {
  shardId: string;
  port: number;
  url: string;
  status: StudioStatus;
  process?: ChildProcess;
  processGroup?: boolean;
  message?: string;
  details?: string;
  severity?: FailureSeverity;
  /** Startup lost a race for the port; the caller should try the next one. */
  addressInUse?: boolean;
}

/**
 * Everything Studio needs is resolved from the project that invoked the CLI:
 * its working directory, its .env (already loaded), its schema, its shard
 * URLs. Nothing is resolved relative to the installed library.
 */
const projectRoot = process.cwd();
const projectSchemaPath = resolveSchemaPath(projectRoot) || '';

const instances: StudioInstance[] = [];
let activeOptions: StudioOptions | undefined;
let isShuttingDown = false;
let keepAliveTimer: NodeJS.Timeout | undefined;

const studioUrl = (port: number): string => `http://localhost:${port}`;

const isAddressInUseOutput = (output: string): boolean => output.includes('EADDRINUSE');

const outputLooksReady = (output: string, port: number): boolean => {
  const normalized = output.toLowerCase();
  return (
    normalized.includes('prisma studio is running') ||
    normalized.includes('prisma studio is up') ||
    normalized.includes(`localhost:${port}`) ||
    normalized.includes(`127.0.0.1:${port}`)
  );
};

const logVerbose = (
  options: StudioOptions,
  message: string,
  writer: (line: string) => void = console.log
): void => {
  if (options.verbose) {
    writer(message);
  }
};

const writeVerboseOutput = (
  options: StudioOptions,
  shardId: string,
  shardUrl: string,
  output: string,
  writer: (line: string) => void
): void => {
  if (!options.verbose) {
    return;
  }

  sanitizeCommandOutput(output, { DATABASE_URL: shardUrl })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => writer(`   [${shardId}] ${line}`));
};

const failedInstance = (
  shard: ShardConfig,
  port: number,
  message: string,
  details?: string,
  severity: FailureSeverity = 'error'
): StudioInstance => {
  return {
    shardId: shard.id,
    port,
    url: studioUrl(port),
    status: 'failed',
    message,
    details,
    severity,
  };
};

const reusedInstance = (shard: ShardConfig, port: number, details?: string): StudioInstance => {
  return {
    shardId: shard.id,
    port,
    url: studioUrl(port),
    status: 'reused',
    details,
  };
};

const getShardPort = (shard: ShardConfig, options: StudioOptions): number => {
  return options.basePort + shard.index;
};

/** Ports claimed during this run, so two shards never race for the same fallback. */
const claimedPorts = new Set<number>();

/**
 * Reuse is only safe when the occupant is provably OUR Studio: a registry
 * entry whose fingerprint matches this project root, schema, shard ID and
 * database target, whose recorded process is still alive, and whose port
 * actually answers like Prisma Studio. Anything else on the port - another
 * project's Studio, an unknown service - is left completely untouched and the
 * scan moves to the next port.
 */
const tryReuseMatchingStudio = async (
  shard: ShardConfig,
  port: number,
  fingerprint: string,
  options: StudioOptions
): Promise<StudioInstance | undefined> => {
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
      `   Port ${port} runs Studio for a different project/database (${entry.projectRoot}, ${entry.shardId}); not reusing.`
    );
    return undefined;
  }

  if (!options.reuseExisting) {
    logVerbose(
      options,
      `   Matching Studio on port ${port} ignored because SHARD_STUDIO_REUSE_EXISTING is false.`
    );
    return undefined;
  }

  const probe = await probePrismaStudio(port);
  if (!probe.isPrismaStudio) {
    logVerbose(
      options,
      `   Registry matched port ${port} but it does not answer like Prisma Studio (${probe.detail}); not reusing.`
    );
    return undefined;
  }

  return reusedInstance(
    shard,
    port,
    'Existing Prisma Studio for this exact project, shard and database'
  );
};

const startSpawnedStudio = (
  shard: ShardConfig,
  port: number,
  options: StudioOptions
): Promise<StudioInstance> => {
  return new Promise((resolve) => {
    const shardId = shard.id;
    const processGroup = process.platform !== 'win32';
    let stdout = '';
    let stderr = '';
    let settled = false;
    let readySeen = false;
    let addressInUse = false;
    let stabilityTimer: NodeJS.Timeout | undefined;
    let resolvedInstance: StudioInstance | undefined;

    logVerbose(options, `\n🚀 Starting Prisma Studio for ${shardId} on port ${port}...`);
    logVerbose(options, `   URL: ${maskShardUrl(shard.url)}`);

    const studioProcess = spawn(
      getNpxCommand(),
      ['prisma', 'studio', '--port', port.toString(), '--browser', 'none'],
      {
        // The invoking project is authoritative: schema, prisma.config.*, env
        // files and the generated client all resolve from ITS root, never from
        // the installed library's directory.
        cwd: projectRoot,
        env: {
          ...process.env,
          DATABASE_URL: shard.url,
        },
        detached: processGroup,
        shell: false,
        stdio: 'pipe',
      }
    );

    const settle = (instance: StudioInstance) => {
      if (settled) {
        return;
      }

      settled = true;
      resolvedInstance = instance;
      if (stabilityTimer) {
        clearTimeout(stabilityTimer);
      }
      resolve(instance);
    };

    const fail = (message: string, details?: string) => {
      terminateChildProcess(studioProcess, { processGroup });
      settle(failedInstance(shard, port, message, details));
    };

    const settleStartedAfterStability = () => {
      if (settled || readySeen) {
        return;
      }

      readySeen = true;
      stabilityTimer = setTimeout(() => {
        settle({
          shardId,
          port,
          url: studioUrl(port),
          status: 'started',
          process: studioProcess,
          processGroup,
        });
      }, options.stabilityMs);
    };

    studioProcess.stdout?.on('data', (data) => {
      const output = data.toString();
      stdout += output;

      if (outputLooksReady(output, port)) {
        settleStartedAfterStability();
      }

      writeVerboseOutput(options, shardId, shard.url, output, console.log);
    });

    studioProcess.stderr?.on('data', (data) => {
      const output = data.toString();
      stderr += output;

      if (isAddressInUseOutput(output)) {
        addressInUse = true;
        return;
      }

      writeVerboseOutput(options, shardId, shard.url, output, console.error);
    });

    studioProcess.on('error', (err) => {
      fail('Failed to start', err.message);
    });

    studioProcess.on('close', (code, signal) => {
      const reason = signal ? `signal ${signal}` : `exit code ${code}`;

      if (settled) {
        if (resolvedInstance?.status === 'started' && !isShuttingDown) {
          console.warn(`⚠️ ${shardId} Studio exited after startup (${reason})`);
        }
        return;
      }

      if (readySeen) {
        const output = (stderr || stdout).trim();
        settle(
          failedInstance(
            shard,
            port,
            'Failed to start',
            `Prisma Studio exited during startup stability check (${reason})${
              output ? `: ${output}` : ''
            }`
          )
        );
        return;
      }

      if (addressInUse || isAddressInUseOutput(stderr)) {
        // Lost a startup race for this port. The caller scans to the next
        // free port; whatever claimed this one is left untouched.
        settle({
          ...failedInstance(
            shard,
            port,
            'Port claimed by another process during startup',
            undefined,
            'warning'
          ),
          addressInUse: true,
        });
        return;
      }

      const output = (stderr || stdout).trim();
      settle(
        failedInstance(
          shard,
          port,
          'Failed to start',
          `Prisma Studio exited before it was ready (${reason})${output ? `: ${output}` : ''}`
        )
      );
    });

    waitForPrismaStudio(port, options.startupTimeoutMs, 400, () => !settled && !readySeen)
      .then((probe) => {
        if (settled || readySeen) {
          return;
        }

        if (probe.isPrismaStudio) {
          settleStartedAfterStability();
          return;
        }

        fail('Failed to start', `Timed out waiting for ${studioUrl(port)} (${probe.detail})`);
      })
      .catch((error: Error) => {
        if (!settled) {
          fail('Failed to start', error.message);
        }
      });
  });
};

const startStudio = async (
  shard: ShardConfig,
  options: StudioOptions
): Promise<StudioInstance> => {
  const preferredPort = getShardPort(shard, options);
  const fingerprint = computeStudioFingerprint({
    projectRoot,
    schemaPath: projectSchemaPath,
    shardId: shard.id,
    url: shard.url,
  });

  for (
    let candidate = preferredPort;
    candidate < preferredPort + options.portScanLimit;
    candidate++
  ) {
    if (claimedPorts.has(candidate)) {
      continue;
    }

    logVerbose(options, `\n🔎 Checking ${shard.id} Studio port ${candidate}...`);
    const portUsage = await getPortUsage(candidate);

    if (portUsage.status === 'unavailable') {
      logVerbose(options, `   Port ${candidate} could not be checked safely; trying the next one.`);
      continue;
    }

    if (portUsage.status === 'occupied') {
      const reused = await tryReuseMatchingStudio(shard, candidate, fingerprint, options);
      if (reused) {
        claimedPorts.add(candidate);
        return reused;
      }
      // Foreign Studio or unknown service: never reused, never killed.
      continue;
    }

    const instance = await startSpawnedStudio(shard, candidate, options);

    if (instance.status === 'failed' && instance.addressInUse) {
      continue; // Lost the race for this port; scan on.
    }

    if (instance.status === 'started') {
      claimedPorts.add(candidate);
      writeStudioRegistryEntry(options.registryDirectory, {
        version: 1,
        port: candidate,
        pid: instance.process?.pid ?? process.pid,
        fingerprint,
        shardId: shard.id,
        projectRoot,
        createdAt: new Date().toISOString(),
      });
      if (candidate !== preferredPort) {
        logVerbose(
          options,
          `   Preferred port ${preferredPort} was busy; ${shard.id} is on ${candidate}.`
        );
      }
    }

    return instance;
  }

  return failedInstance(
    shard,
    preferredPort,
    'No free port found',
    `No reusable or free port in ${preferredPort}-${
      preferredPort + options.portScanLimit - 1
    }. Every occupied port belonged to another project or process and was left untouched.`
  );
};

const getStatusIcon = (instance: StudioInstance): string => {
  if (instance.status === 'started') {
    return '✅';
  }
  if (instance.status === 'reused') {
    return '♻️';
  }
  return instance.severity === 'warning' ? '⚠️' : '❌';
};

const getStatusText = (instance: StudioInstance): string => {
  if (instance.status === 'started' || instance.status === 'reused') {
    return instance.url;
  }
  return instance.message || 'Failed to start';
};

const printCompactResults = (results: StudioInstance[], options: StudioOptions): void => {
  const failed = results.filter((instance) => instance.status === 'failed');
  const hasErrorFailure = failed.some((instance) => instance.severity !== 'warning');

  console.log('🗄️ Prisma Sharding Studio\n');

  results.forEach((instance) => {
    console.log(`${getStatusIcon(instance)} ${instance.shardId}  ${getStatusText(instance)}`);
  });

  if (options.verbose) {
    printVerboseSummary(results, options);
  }

  if (hasErrorFailure && !options.verbose) {
    console.log('\nRun with SHARD_STUDIO_VERBOSE=true for details.');
  }
};

const printVerboseSummary = (results: StudioInstance[], options: StudioOptions): void => {
  const started = results.filter((instance) => instance.status === 'started');
  const reused = results.filter((instance) => instance.status === 'reused');
  const failed = results.filter((instance) => instance.status === 'failed');

  console.log('\nVerbose details:');
  console.log(`   Base port: ${options.basePort}`);
  console.log(`   Reuse existing Studio ports: ${options.reuseExisting ? 'yes' : 'no'}`);
  console.log(`   Startup timeout: ${options.startupTimeoutMs}ms`);
  console.log(`   Startup stability window: ${options.stabilityMs}ms`);
  console.log(`   Strict port check: ${options.strictPortCheck ? 'yes' : 'no'}`);
  console.log(`   Total: ${results.length}`);
  console.log(`   Started: ${started.length}`);
  console.log(`   Reused: ${reused.length}`);
  console.log(`   Failed: ${failed.length}`);

  failed.forEach((instance) => {
    console.log(`   ${instance.shardId}: ${instance.details || instance.message || 'Failed'}`);
  });
};

const getOwnedInstances = (): Array<StudioInstance & { process: ChildProcess }> => {
  return instances.filter(
    (instance): instance is StudioInstance & { process: ChildProcess } =>
      instance.status === 'started' && Boolean(instance.process)
  );
};

const shutdownOwnedInstances = async (
  options: StudioOptions,
  announce = true
): Promise<void> => {
  const ownedInstances = getOwnedInstances();

  if (ownedInstances.length === 0) {
    return;
  }

  if (announce) {
    console.log('\nStopping owned Studio processes...');
  }

  ownedInstances.forEach((instance) => {
    logVerbose(options, `   Stopping ${instance.shardId}...`);
    terminateChildProcess(instance.process, { processGroup: instance.processGroup });
  });

  const closed = await Promise.all(
    ownedInstances.map((instance) =>
      waitForChildProcessClose(instance.process, options.shutdownTimeoutMs)
    )
  );

  closed.forEach((didClose, index) => {
    if (!didClose) {
      const instance = ownedInstances[index];
      logVerbose(options, `   Force stopping ${instance.shardId}...`, console.warn);
      terminateChildProcess(instance.process, {
        signal: 'SIGKILL',
        processGroup: instance.processGroup,
      });
    }
  });

  // Only entries for processes THIS run started are removed. Reused instances
  // and other projects' Studios keep their registrations untouched.
  ownedInstances.forEach((instance) => {
    removeStudioRegistryEntry(options.registryDirectory, instance.port);
  });

  if (announce) {
    console.log('Stopped.');
  }
};

const startAllStudios = async (): Promise<void> => {
  const options = getStudioOptions();
  const { shards, missingShardIds } = getShardConfigResult();
  activeOptions = options;

  if (shards.length === 0) {
    console.log('🗄️ Prisma Sharding Studio\n');
    console.error(`❌ ${NO_SHARDS_CONFIGURED_MESSAGE}`);
    process.exit(1);
  }

  if (missingShardIds.length > 0) {
    logVerbose(options, `Missing shard URLs: ${missingShardIds.join(', ')}`, console.warn);
  }

  for (const shard of shards) {
    try {
      const instance = await startStudio(shard, options);
      instances.push(instance);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      instances.push(failedInstance(shard, getShardPort(shard, options), 'Failed to start', message));
    }
  }

  printCompactResults(instances, options);

  const failed = instances.filter((instance) => instance.status === 'failed');
  if (failed.length > 0 && options.strictPortCheck) {
    isShuttingDown = true;
    await shutdownOwnedInstances(options, options.verbose);
    process.exit(1);
  }

  if (failed.length === 0 && getOwnedInstances().length === 0) {
    keepAliveTimer = setInterval(() => undefined, 2_147_483_647);
  }
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
  await shutdownOwnedInstances(options, options.verbose);
  process.exit(0);
};

process.on('SIGINT', () => {
  void gracefulShutdown();
});
process.on('SIGTERM', () => {
  void gracefulShutdown();
});

startAllStudios().catch((error) => {
  console.error('Failed to start studios:', error);
  process.exit(1);
});
