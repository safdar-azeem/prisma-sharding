import { maskDatabaseUrl } from '../../utils/sanitize';

export interface ShardConfig {
  id: string;
  index: number;
  url: string;
}

export interface ShardConfigResult {
  shards: ShardConfig[];
  missingShardIds: string[];
}

export const NO_SHARDS_CONFIGURED_MESSAGE =
  'No shards configured. Set SHARD_COUNT and SHARD_N_URL environment variables.';

export const getShardConfigResult = (
  env: NodeJS.ProcessEnv = process.env
): ShardConfigResult => {
  const shards: ShardConfig[] = [];
  const missingShardIds: string[] = [];
  const shardCount = parseInt(env.SHARD_COUNT || '0', 10);

  for (let i = 1; i <= shardCount; i++) {
    const url = env[`SHARD_${i}_URL`];
    if (url) {
      shards.push({ id: `shard_${i}`, index: i - 1, url });
    } else {
      missingShardIds.push(`shard_${i}`);
    }
  }

  if (shards.length === 0 && env.DATABASE_URL) {
    shards.push({ id: 'shard_1', index: 0, url: env.DATABASE_URL });
  }

  return { shards, missingShardIds };
};

export const getShardConfigs = (env: NodeJS.ProcessEnv = process.env): ShardConfig[] => {
  return getShardConfigResult(env).shards;
};

export const maskShardUrl = maskDatabaseUrl;
