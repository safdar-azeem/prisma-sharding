#!/usr/bin/env node
/**
 * Escape hatch for a disposable local database. Not part of the normal workflow:
 * `yarn db:update` is migration-first and already falls back to a safe push when
 * a project genuinely has no migrations.
 */
import 'dotenv/config';
import { isVerboseEnv, parseBooleanEnv } from '../utils/env';
import { printCliHeader, printCliRow, printVerboseHint } from './utils/output';
import { getDatabaseTargets, NO_DATABASES_CONFIGURED_MESSAGE } from './utils/shards';
import { unsafePushSchemas } from './utils/unsafe-push';

const CONFIRM_ENV = 'SHARD_ALLOW_UNSAFE_PUSH';

const pushAll = async (): Promise<void> => {
  const verbose = isVerboseEnv(['SHARD_PUSH_VERBOSE', 'SHARD_CLI_VERBOSE']);
  const { targets, missingShardIds } = getDatabaseTargets();
  const extraArgs = process.argv.slice(2);

  printCliHeader('⚠️', 'Prisma Sharding Push (unsafe development utility)');

  if (!parseBooleanEnv(CONFIRM_ENV, false)) {
    printCliRow('❌', 'blocked', 'This command bypasses committed migrations and can lose data.');
    printCliRow(
      'ℹ️',
      'use',
      'For normal development, Docker, CI, staging and production: yarn db:update'
    );
    printCliRow(
      'ℹ️',
      'override',
      `Only for a disposable local database, rerun with ${CONFIRM_ENV}=true`
    );
    process.exit(1);
  }

  if (process.env.NODE_ENV === 'production') {
    printCliRow('❌', 'blocked', 'Refusing to run with NODE_ENV=production.');
    process.exit(1);
  }

  if (missingShardIds.length > 0) {
    printCliRow('❌', 'config', `Missing shard URLs: ${missingShardIds.join(', ')}`);
    process.exit(1);
  }

  if (targets.length === 0) {
    printCliRow('❌', 'config', NO_DATABASES_CONFIGURED_MESSAGE);
    process.exit(1);
  }

  printCliRow('⚠️', 'warning', 'Committed migration SQL and backfills will NOT run.');
  printCliRow(
    '⚠️',
    'warning',
    'Databases pushed this way must be baselined before `db:update` works.'
  );
  console.log('');

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
