import { runPrismaCommand } from './command';
import { createCliLoader } from './output';
import { maskShardUrl, ShardConfig } from './shards';

export interface ShardSyncResult {
  shardId: string;
  success: boolean;
}

export const syncShardSchemas = async (
  shards: ShardConfig[],
  extraArgs: string[],
  verbose: boolean
): Promise<ShardSyncResult[]> => {
  const results: ShardSyncResult[] = [];

  for (const shard of shards) {
    const loader = createCliLoader(shard.id, 'Syncing', !verbose);

    if (verbose) {
      console.log(`\nSyncing ${shard.id}...`);
      console.log(`Database: ${maskShardUrl(shard.url)}\n`);
    }

    const result = await runPrismaCommand(
      ['db', 'push', '--accept-data-loss', ...extraArgs],
      {
        env: { ...process.env, DATABASE_URL: shard.url },
        verbose,
      }
    );

    if (verbose && result.error && !result.stderr.trim() && !result.stdout.trim()) {
      console.error(result.error);
    }

    results.push({ shardId: shard.id, success: result.success });
    if (result.success) {
      loader.succeed('Synced');
    } else {
      loader.fail('Failed');
    }
  }

  return results;
};
