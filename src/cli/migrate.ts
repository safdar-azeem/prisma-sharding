#!/usr/bin/env node
/**
 * Backward-compatible alias for `prisma-sharding-update`. It runs the same shared
 * pipeline and only skips the client generation step, which callers of this
 * command historically did themselves.
 */
import 'dotenv/config';
import { runUpdateCliAndExit } from './utils/update-cli';

runUpdateCliAndExit({
  title: 'Prisma Sharding Migrate',
  retryHint: 'yarn db:update',
  generateClient: false,
  verboseEnvNames: ['SHARD_MIGRATE_VERBOSE', 'SHARD_CLI_VERBOSE'],
});
