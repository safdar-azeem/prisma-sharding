import { runPrismaCommand, sanitizeCommandOutput } from './command';
import { createCliLoader } from './output';
import { DatabaseTarget, maskShardUrl } from './shards';

export interface UnsafePushResult {
  shardId: string;
  success: boolean;
  attempted: boolean;
}

/**
 * Direct `prisma db push`, used only by the explicit opt-in CLI. The normal
 * update pipeline never calls this: it bypasses migration history entirely.
 */
export const unsafePushSchemas = async (
  targets: DatabaseTarget[],
  extraArgs: string[],
  verbose: boolean
): Promise<UnsafePushResult[]> => {
  const results: UnsafePushResult[] = [];

  for (const target of targets) {
    const loader = createCliLoader(target.id, 'Pushing', !verbose);
    const commandEnv = { ...process.env, DATABASE_URL: target.url };
    const commandArgs = ['db', 'push', ...extraArgs];

    if (verbose) {
      console.log(`\nPushing schema to ${target.id}...`);
      console.log(`Database: ${maskShardUrl(target.url)}\n`);
      console.log(
        `Command: ${sanitizeCommandOutput(`prisma ${commandArgs.join(' ')}`, commandEnv)}`
      );
    }

    const result = await runPrismaCommand(commandArgs, { env: commandEnv, verbose });

    if (verbose) {
      console.log(`Exit code: ${result.exitCode ?? 'unavailable'}`);
    }

    results.push({ shardId: target.id, success: result.success, attempted: true });

    if (result.success) {
      loader.succeed('Pushed');
    } else {
      loader.fail('Failed');
      if (!verbose && result.error) {
        console.error(result.error);
      }
    }
  }

  return results;
};
