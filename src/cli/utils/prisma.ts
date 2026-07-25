/**
 * Backward-compatible surface for consumers that imported the old helpers.
 * Everything here delegates to the shared pipeline - there is no second
 * implementation of the update flow.
 */
import { runDatabaseUpdate, TargetUpdateResult } from './pipeline';
import { DatabaseTarget, ShardConfig } from './shards';

export interface ShardSyncResult {
  shardId: string;
  success: boolean;
  attempted?: boolean;
}

const toTarget = (shard: ShardConfig | DatabaseTarget): DatabaseTarget => ({
  id: shard.id,
  url: shard.url,
  sources: 'sources' in shard ? shard.sources : [`${String(shard.id).toUpperCase()}_URL`],
  isPrimary: 'isPrimary' in shard ? shard.isPrimary : false,
});

const toShardResults = (results: TargetUpdateResult[]): ShardSyncResult[] =>
  results.map((result) => ({
    shardId: result.id,
    success: result.success,
    attempted: result.attempted,
  }));

export const deployShardMigrations = async (
  shards: Array<ShardConfig | DatabaseTarget>,
  extraArgs: string[],
  verbose: boolean
): Promise<ShardSyncResult[]> => {
  const summary = await runDatabaseUpdate({
    targets: shards.map(toTarget),
    extraArgs,
    verbose,
    generateClient: false,
  });

  return toShardResults(summary.results);
};

/**
 * @deprecated Kept only so old imports keep working. Committed migrations are
 * always authoritative, so this now runs the same migration-first pipeline.
 */
export const syncShardSchemas = deployShardMigrations;

export { runDatabaseUpdate };
