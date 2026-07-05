#!/usr/bin/env node
import 'dotenv/config';
import { spawn, ChildProcess } from 'child_process';
import { isVerboseEnv, parseBooleanEnv, parsePositiveIntegerEnv } from '../utils/env';
import { getNpxCommand } from './utils/command';
import { getPortUsage, waitForPrismaStudio } from './utils/ports';
import { terminateChildProcess, waitForChildProcessClose } from './utils/process';
import {
  getShardConfigResult,
  maskShardUrl,
  NO_SHARDS_CONFIGURED_MESSAGE,
  ShardConfig,
} from './utils/shards';

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
}

interface StudioOptions {
  basePort: number;
  reuseExisting: boolean;
  startupTimeoutMs: number;
  stabilityMs: number;
  shutdownTimeoutMs: number;
  strictPortCheck: boolean;
  verbose: boolean;
}

const instances: StudioInstance[] = [];
let activeOptions: StudioOptions | undefined;
let isShuttingDown = false;
let keepAliveTimer: NodeJS.Timeout | undefined;

const getStudioOptions = (): StudioOptions => {
  return {
    basePort: parsePositiveIntegerEnv('SHARD_STUDIO_BASE_PORT', 51212),
    reuseExisting: parseBooleanEnv('SHARD_STUDIO_REUSE_EXISTING', true),
    startupTimeoutMs: parsePositiveIntegerEnv('SHARD_STUDIO_START_TIMEOUT_MS', 15000),
    stabilityMs: parsePositiveIntegerEnv('SHARD_STUDIO_STABILITY_MS', 500),
    shutdownTimeoutMs: parsePositiveIntegerEnv('SHARD_STUDIO_SHUTDOWN_TIMEOUT_MS', 5000),
    strictPortCheck: parseBooleanEnv('SHARD_STUDIO_STRICT_PORT_CHECK', false),
    verbose: isVerboseEnv(['SHARD_STUDIO_VERBOSE', 'SHARD_STUDIO_DEBUG']),
  };
};

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
  output: string,
  writer: (line: string) => void
): void => {
  if (!options.verbose) {
    return;
  }

  output
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

const handleOccupiedPort = async (
  shard: ShardConfig,
  port: number,
  options: StudioOptions,
  source: 'preflight' | 'spawn'
): Promise<StudioInstance> => {
  logVerbose(
    options,
    `   Waiting for occupied ${shard.id} port ${port} to identify Prisma Studio...`
  );

  const probe = await waitForPrismaStudio(port, options.startupTimeoutMs);

  if (probe.isPrismaStudio && options.reuseExisting) {
    return reusedInstance(shard, port, 'Existing Prisma Studio instance is already active');
  }

  if (probe.isPrismaStudio && !options.reuseExisting) {
    return failedInstance(
      shard,
      port,
      'Studio already running but reuse is disabled',
      'Prisma Studio is already running on this port, but SHARD_STUDIO_REUSE_EXISTING is false'
    );
  }

  const details = probe.reachable
    ? `Port ${port} is active but did not look like Prisma Studio (${probe.detail})`
    : `Port ${port} is active but could not be identified as Prisma Studio (${probe.detail})`;
  const sourceDetails =
    source === 'spawn' ? `${details}; Prisma Studio reported EADDRINUSE during startup` : details;

  return failedInstance(
    shard,
    port,
    'Port already used by another process',
    sourceDetails,
    'warning'
  );
};

const startSpawnedStudio = (
  shard: ShardConfig,
  port: number,
  options: StudioOptions
): Promise<StudioInstance> => {
  return new Promise((resolve, reject) => {
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

      writeVerboseOutput(options, shardId, output, console.log);
    });

    studioProcess.stderr?.on('data', (data) => {
      const output = data.toString();
      stderr += output;

      if (isAddressInUseOutput(output)) {
        addressInUse = true;
        return;
      }

      writeVerboseOutput(options, shardId, output, console.error);
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
        handleOccupiedPort(shard, port, options, 'spawn')
          .then(settle)
          .catch((error: Error) => reject(error));
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
  const port = getShardPort(shard, options);

  logVerbose(options, `\n🔎 Checking ${shard.id} Studio port ${port}...`);

  const portUsage = await getPortUsage(port);
  if (portUsage.status === 'occupied') {
    return handleOccupiedPort(shard, port, options, 'preflight');
  }

  if (portUsage.status === 'unavailable') {
    const details = portUsage.checks
      .filter((check) => !check.available && check.code !== 'EADDRINUSE')
      .map((check) => `${check.host}: ${check.code || check.message}`)
      .join('; ');
    return failedInstance(
      shard,
      port,
      'Port check failed',
      `Could not safely check port ${port}${details ? ` (${details})` : ''}`,
      'warning'
    );
  }

  return startSpawnedStudio(shard, port, options);
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
