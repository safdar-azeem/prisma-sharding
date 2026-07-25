import { isVerboseEnv } from '../../utils/env';
import { printCliHeader, printCliRow, printVerboseHint } from './output';
import { DatabaseUpdateOptions, runDatabaseUpdate } from './pipeline';
import { getDatabaseTargets, NO_DATABASES_CONFIGURED_MESSAGE } from './shards';

export interface UpdateCliOptions {
  title: string;
  icon?: string;
  retryHint?: string;
  generateClient: boolean;
  verboseEnvNames: string[];
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Test seams: production callers never pass these. */
  introspect?: DatabaseUpdateOptions['introspect'];
  runPrisma?: DatabaseUpdateOptions['runPrisma'];
}

/**
 * The single entry point behind every public database-update command. Adding a
 * new alias must mean calling this, never re-implementing the flow.
 */
export const runUpdateCli = async (options: UpdateCliOptions): Promise<number> => {
  const {
    title,
    icon = '🔄',
    retryHint,
    generateClient,
    verboseEnvNames,
    argv = process.argv.slice(2),
    env = process.env,
    cwd = process.cwd(),
    introspect,
    runPrisma,
  } = options;

  const verbose = isVerboseEnv(verboseEnvNames, env);
  const { targets, missingShardIds, duplicates } = getDatabaseTargets(env);

  printCliHeader(icon, title);

  if (missingShardIds.length > 0) {
    printCliRow('❌', 'config', `Missing shard URLs: ${missingShardIds.join(', ')}`);
    return 1;
  }

  if (targets.length === 0) {
    printCliRow('❌', 'config', NO_DATABASES_CONFIGURED_MESSAGE);
    return 1;
  }

  if (verbose && duplicates.length > 0) {
    for (const duplicate of duplicates) {
      console.log(
        `${duplicate.source} resolves to the same database as ${duplicate.sameAs}; updating once.`
      );
    }
  }

  const summary = await runDatabaseUpdate({
    targets,
    extraArgs: argv,
    verbose,
    retryHint,
    generateClient,
    env,
    cwd,
    ...(introspect ? { introspect } : {}),
    ...(runPrisma ? { runPrisma } : {}),
  });

  if (!summary.success) {
    if (!verbose) {
      printVerboseHint();
    }
    return 1;
  }

  return 0;
};

export const runUpdateCliAndExit = (options: UpdateCliOptions): void => {
  runUpdateCli(options)
    .then((exitCode) => {
      if (exitCode !== 0) {
        process.exit(exitCode);
      }
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
};
