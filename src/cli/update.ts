#!/usr/bin/env node
/**
 * `yarn db:update` — the one command developers need. Runs the shared
 * migration-first pipeline: generate the client once, then apply committed
 * migrations to every configured database and shard. `db push` only happens
 * when the project has no migration files at all, and destructive flags are
 * always refused.
 */
import 'dotenv/config';
import { runUpdateCliAndExit } from './utils/update-cli';

runUpdateCliAndExit({
  title: 'Prisma Sharding Update',
  retryHint: 'yarn db:update',
  generateClient: true,
  verboseEnvNames: ['SHARD_UPDATE_VERBOSE', 'SHARD_CLI_VERBOSE'],
});
