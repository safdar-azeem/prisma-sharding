#!/usr/bin/env node
import 'dotenv/config';
import { isVerboseEnv } from '../utils/env';
import { printCliHeader, printCliRow, printVerboseHint } from './utils/output';
import { syncShardSchemas } from './utils/prisma';
import { getShardConfigs, NO_SHARDS_CONFIGURED_MESSAGE } from './utils/shards';

const migrateAllShards = async (): Promise<void> => {
  const verbose = isVerboseEnv(['SHARD_MIGRATE_VERBOSE', 'SHARD_CLI_VERBOSE']);
  const shards = getShardConfigs();
  const extraArgs = process.argv.slice(2);

  printCliHeader('🔄', 'Prisma Sharding Migrate');

  if (shards.length === 0) {
    printCliRow('❌', 'config', NO_SHARDS_CONFIGURED_MESSAGE);
    process.exit(1);
  }

  const results = await syncShardSchemas(shards, extraArgs, verbose);

  const successful = results.filter((result) => result.success).length;
  const failed = results.length - successful;

  if (failed > 0) {
    if (!verbose) {
      printVerboseHint();
    }
    process.exit(1);
  }
};

migrateAllShards().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
