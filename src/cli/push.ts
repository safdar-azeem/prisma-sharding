#!/usr/bin/env node
/**
 * Direct `prisma db push` against every configured database and shard. It
 * bypasses committed migrations, so `yarn db:update` remains the normal
 * workflow - but this command runs in any environment without a confirmation
 * env var, because the developer asked for it explicitly.
 */
import 'dotenv/config';
import { isVerboseEnv } from '../utils/env';
import { printCliHeader, printCliRow, printVerboseHint } from './utils/output';
import { getDatabaseTargets, NO_DATABASES_CONFIGURED_MESSAGE } from './utils/shards';
import { unsafePushSchemas } from './utils/unsafe-push';

const pushAll = async (): Promise<void> => {
  const verbose = isVerboseEnv(['SHARD_PUSH_VERBOSE', 'SHARD_CLI_VERBOSE']);
  const { targets, missingShardIds } = getDatabaseTargets();
  const extraArgs = process.argv.slice(2);

  printCliHeader('⚠️', 'Prisma Sharding Push');

  if (missingShardIds.length > 0) {
    printCliRow('❌', 'config', `Missing shard URLs: ${missingShardIds.join(', ')}`);
    process.exit(1);
  }

  if (targets.length === 0) {
    printCliRow('❌', 'config', NO_DATABASES_CONFIGURED_MESSAGE);
    process.exit(1);
  }

  if (verbose) {
    printCliRow('⚠️', 'warning', 'Committed migration SQL and backfills will NOT run.');
    printCliRow(
      '⚠️',
      'warning',
      'Databases pushed this way must be baselined before `db:update` works.'
    );
    console.log('');
  }

  const results = await unsafePushSchemas(targets, extraArgs, verbose);
  const failed = results.filter((result) => !result.success).length;

  if (failed > 0) {
    if (!verbose) {
      printVerboseHint();
    }
    process.exit(1);
  }
};

pushAll().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
