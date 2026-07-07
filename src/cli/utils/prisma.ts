import { CommandResult, runPrismaCommand, sanitizeCommandOutput } from './command';
import { createCliLoader } from './output';
import { maskShardUrl, ShardConfig } from './shards';

export interface ShardSyncResult {
  shardId: string;
  success: boolean;
}

interface ShardCommandOptions {
  shards: ShardConfig[];
  args: string[];
  extraArgs: string[];
  verbose: boolean;
  action: string;
}

const executeShardCommand = async (
  shard: ShardConfig,
  commandArgs: string[],
  verbose: boolean,
  action: string
): Promise<CommandResult> => {
  const commandEnv = { ...process.env, DATABASE_URL: shard.url };

  if (verbose) {
    console.log(`\n${action} ${shard.id}...`);
    console.log(`Database: ${maskShardUrl(shard.url)}\n`);
    console.log(
      `Command: ${sanitizeCommandOutput(`prisma ${commandArgs.join(' ')}`, commandEnv)}`
    );
  }

  const result = await runPrismaCommand(commandArgs, {
    env: commandEnv,
    verbose,
  });

  if (verbose) {
    console.log(`Exit code: ${result.exitCode ?? 'unavailable'}`);
  }
  if (verbose && result.error && !result.stderr.trim() && !result.stdout.trim()) {
    console.error(result.error);
  }
  if (verbose && !result.success) {
    console.error(`Next: verify ${shard.id} connectivity and migration state, then retry.`);
  }

  return result;
};

const runShardCommands = async ({
  shards,
  args,
  extraArgs,
  verbose,
  action,
}: ShardCommandOptions): Promise<ShardSyncResult[]> => {
  const results: ShardSyncResult[] = [];

  for (const shard of shards) {
    const loader = createCliLoader(shard.id, action, !verbose);
    const commandArgs = [...args, ...extraArgs];
    const result = await executeShardCommand(shard, commandArgs, verbose, action);

    results.push({ shardId: shard.id, success: result.success });
    if (result.success) {
      loader.succeed('Synced');
    } else {
      loader.fail('Failed');
      if (!verbose && result.error) {
        console.error(result.error);
      }
    }
  }

  return results;
};

export const syncShardSchemas = (
  shards: ShardConfig[],
  extraArgs: string[],
  verbose: boolean
): Promise<ShardSyncResult[]> =>
  runShardCommands({
    shards,
    args: ['db', 'push'],
    extraArgs,
    verbose,
    action: 'Syncing',
  });

export const deployShardMigrations = async (
  shards: ShardConfig[],
  extraArgs: string[],
  verbose: boolean
): Promise<ShardSyncResult[]> => {
  const results: ShardSyncResult[] = [];

  for (const shard of shards) {
    const loader = createCliLoader(shard.id, 'Migrating', !verbose);
    const status = await executeShardCommand(
      shard,
      ['migrate', 'status'],
      verbose,
      'Checking migration status for'
    );

    if (!status.success) {
      results.push({ shardId: shard.id, success: false });
      loader.fail('Failed');
      if (!verbose && status.error) {
        console.error(status.error);
      }
      continue;
    }

    const deploy = await executeShardCommand(
      shard,
      ['migrate', 'deploy', ...extraArgs],
      verbose,
      'Migrating'
    );
    results.push({ shardId: shard.id, success: deploy.success });
    if (deploy.success) {
      loader.succeed('Synced');
    } else {
      loader.fail('Failed');
      if (!verbose && deploy.error) {
        console.error(deploy.error);
      }
    }
  }

  return results;
};
