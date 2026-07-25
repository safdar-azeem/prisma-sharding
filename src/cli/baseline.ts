#!/usr/bin/env node
/**
 * Records already-applied migrations on databases that were originally built with
 * `db push`. It only writes rows to `_prisma_migrations`: it never runs migration
 * SQL, never alters a schema and never deletes data.
 *
 * Executing requires --yes AND --verified, and every selected database is
 * preflighted read-only before any history is recorded anywhere.
 */
import 'dotenv/config';
import { runBaselineCli } from './utils/baseline-core';

runBaselineCli()
  .then((exitCode) => {
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
