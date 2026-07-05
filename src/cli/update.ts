#!/usr/bin/env node
import 'dotenv/config';
import { isVerboseEnv } from '../utils/env';
import { runPrismaCommand } from './utils/command';
import { createCliLoader, printCliHeader, printCliRow, printVerboseHint } from './utils/output';
import { syncShardSchemas } from './utils/prisma';
import { getShardConfigs, NO_SHARDS_CONFIGURED_MESSAGE } from './utils/shards';

const updateAll = async (): Promise<void> => {
  const verbose = isVerboseEnv(['SHARD_UPDATE_VERBOSE', 'SHARD_CLI_VERBOSE']);
  const shards = getShardConfigs();
  const extraArgs = process.argv.slice(2);

  printCliHeader('🔄', 'Prisma Sharding Update');

  if (shards.length === 0) {
    printCliRow('❌', 'config', NO_SHARDS_CONFIGURED_MESSAGE);
    process.exit(1);
  }

  if (verbose) {
    console.log('Generating Prisma Client...\n');
  }

  const generateLoader = createCliLoader('client', 'Generating', !verbose);
  const generateResult = await runPrismaCommand(['generate'], { verbose });
  if (
    verbose &&
    generateResult.error &&
    !generateResult.stderr.trim() &&
    !generateResult.stdout.trim()
  ) {
    console.error(generateResult.error);
  }

  if (!generateResult.success) {
    generateLoader.fail('Generation failed');
    if (!verbose) {
      printVerboseHint();
    }
    process.exit(1);
  }

  generateLoader.succeed('Generated');

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

updateAll().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
