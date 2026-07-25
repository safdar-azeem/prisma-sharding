import { isVerboseEnv } from '../../utils/env';
import { runPrismaCommand, sanitizeCommandOutput } from './command';
import { IntrospectFn, introspectDatabase } from './introspect';
import { classifyMigrationState, isBlockingState } from './migration-state';
import {
  readLocalMigrationChecksums,
  readLocalMigrations,
  resolveMigrationsDirectory,
} from './migrations';
import { printCliHeader, printCliRow } from './output';
import { RunPrismaFn } from './pipeline';
import {
  DatabaseTarget,
  getDatabaseTargets,
  maskShardUrl,
  NO_DATABASES_CONFIGURED_MESSAGE,
} from './shards';

export interface BaselineArgs {
  until?: string;
  only?: string[];
  confirm: boolean;
  verified: boolean;
}

export interface BaselineCliOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Test seams: production callers never pass these. */
  introspect?: IntrospectFn;
  runPrisma?: RunPrismaFn;
}

interface TargetPlan {
  target: DatabaseTarget;
  action: 'record' | 'skip';
  reason?: string;
  toRecord: string[];
  alreadyRecorded: number;
}

export const parseBaselineArgs = (argv: string[]): BaselineArgs => {
  const args: BaselineArgs = { confirm: false, verified: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--until') {
      args.until = argv[++i];
    } else if (arg.startsWith('--until=')) {
      args.until = arg.slice('--until='.length);
    } else if (arg === '--yes' || arg === '-y') {
      args.confirm = true;
    } else if (arg === '--verified') {
      args.verified = true;
    } else if (arg === '--only') {
      args.only = (argv[++i] || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    } else if (arg.startsWith('--only=')) {
      args.only = arg
        .slice('--only='.length)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    }
  }

  return args;
};

const usage = (): void => {
  console.log(
    [
      'Record already-applied migrations on databases that were built with `db push`.',
      '',
      'Usage:',
      '  prisma-sharding-baseline --until <migration> [--only shard_1,shard_2] [--yes --verified]',
      '',
      'Options:',
      '  --until <migration>  Mark every migration up to AND INCLUDING this one as applied.',
      '                       Everything after it stays pending so `db:update` runs its SQL.',
      '  --only <ids>         Restrict to specific database ids. Defaults to all configured.',
      '  --yes, -y            Execute. Without it, the plan is printed and nothing changes.',
      '  --verified           Required with --yes. Confirms you verified that every',
      '                       migration up to the cutoff is fully represented in every',
      '                       target database: schema changes AND data effects (backfills,',
      '                       corrections, custom SQL). Baselined SQL never runs.',
      '',
      'Before anything is recorded anywhere, every selected database is preflighted',
      'read-only; any unreachable or inconsistent database aborts the whole run.',
      'This command only writes rows to _prisma_migrations. It never runs migration SQL,',
      'never alters your schema, and never deletes data.',
    ].join('\n')
  );
};

/**
 * The baseline workflow, separated from the process entry point so every phase
 * is testable. Phases: validate input → (dry-run: print plan and stop) →
 * verification gate → read-only preflight of ALL targets → record history.
 * No `_prisma_migrations` row is written anywhere until every target passed
 * preflight.
 */
export const runBaselineCli = async (options: BaselineCliOptions = {}): Promise<number> => {
  const {
    argv = process.argv.slice(2),
    env = process.env,
    cwd = process.cwd(),
    introspect = introspectDatabase,
    runPrisma = runPrismaCommand,
  } = options;

  const verbose = isVerboseEnv(['SHARD_BASELINE_VERBOSE', 'SHARD_CLI_VERBOSE'], env);
  const args = parseBaselineArgs(argv);

  printCliHeader('📌', 'Prisma Sharding Baseline');

  if (!args.until) {
    printCliRow('❌', 'usage', '--until <migration> is required.');
    console.log('');
    usage();
    return 1;
  }

  const directory = resolveMigrationsDirectory(cwd, env);
  if (!directory.path) {
    printCliRow('❌', 'migrations', directory.error || 'Migrations directory not found.');
    return 1;
  }

  const localMigrations = readLocalMigrations(directory.path);
  const cutoffIndex = localMigrations.indexOf(args.until);

  if (cutoffIndex === -1) {
    printCliRow('❌', 'migrations', `'${args.until}' is not in ${directory.path}.`);
    printCliRow('ℹ️', 'found', `${localMigrations.length} migration(s) on disk.`);
    if (localMigrations.length > 0) {
      console.log('');
      for (const name of localMigrations) {
        console.log(`    ${name}`);
      }
    }
    return 1;
  }

  const toApply = localMigrations.slice(0, cutoffIndex + 1);
  const staysPending = localMigrations.slice(cutoffIndex + 1);
  const { targets, missingShardIds } = getDatabaseTargets(env);

  if (missingShardIds.length > 0) {
    printCliRow('❌', 'config', `Missing shard URLs: ${missingShardIds.join(', ')}`);
    return 1;
  }

  if (targets.length === 0) {
    printCliRow('❌', 'config', NO_DATABASES_CONFIGURED_MESSAGE);
    return 1;
  }

  const selected = args.only
    ? targets.filter((target) => args.only?.includes(target.id))
    : targets;

  if (selected.length === 0) {
    printCliRow(
      '❌',
      'config',
      `No configured database matched --only ${(args.only || []).join(',')}.`
    );
    return 1;
  }

  printCliRow(
    'ℹ️',
    'plan',
    `Mark ${toApply.length} migration(s) as applied, up to ${args.until}.`
  );
  for (const name of toApply) {
    console.log(`    applied   ${name}`);
  }
  for (const name of staysPending) {
    console.log(`    PENDING   ${name}  (its SQL will run on the next db:update)`);
  }
  console.log('');

  if (staysPending.length === 0) {
    printCliRow(
      '⚠️',
      'warning',
      'This marks EVERY committed migration as applied. No migration SQL will ever run.'
    );
    printCliRow(
      '⚠️',
      'warning',
      'That is only correct if the schema is already fully up to date.'
    );
    console.log('');
  }

  if (!args.confirm) {
    printCliRow('ℹ️', 'dry run', 'Nothing was changed. Re-run with --yes to execute.');
    return 0;
  }

  // Verification gate: recording a migration as applied permanently skips its
  // SQL. Schema effects can be probed, but data effects (backfills, custom SQL)
  // cannot be inferred - a human must confirm them.
  if (!args.verified) {
    printCliRow('❌', 'blocked', 'Refusing to execute without --verified.');
    printCliRow(
      'ℹ️',
      'why',
      'Baselined migrations never run their SQL. Before executing, confirm that every'
    );
    printCliRow(
      'ℹ️',
      '',
      `migration up to ${args.until} is fully represented in EVERY target database:`
    );
    printCliRow('ℹ️', '', 'schema changes AND data effects (backfills, corrections, custom SQL).');
    printCliRow(
      'ℹ️',
      'how',
      'Probe schema objects via information_schema and review each migration for data steps.'
    );
    printCliRow('ℹ️', 'then', 'Re-run with: --yes --verified');
    return 1;
  }

  // Phase 1: read-only preflight of every selected target. Nothing is written
  // anywhere until all of them pass.
  const localChecksums = readLocalMigrationChecksums(directory.path);
  const shardSelected = selected.filter((entry) => !entry.isPrimary);
  const plans: TargetPlan[] = [];
  const blockedRows: Array<{ id: string; summary: string; reconciliation: string[] }> = [];

  for (const target of selected) {
    const introspection = await introspect(target.url);

    // Mirror the update pipeline: an uncreated DATABASE_URL is a CLI datasource
    // placeholder when real shards are configured, not a failure.
    if (
      introspection.databaseMissing &&
      target.isPrimary &&
      shardSelected.length > 0
    ) {
      plans.push({
        target,
        action: 'skip',
        reason: 'Database does not exist; treating DATABASE_URL as a CLI datasource only',
        toRecord: [],
        alreadyRecorded: 0,
      });
      continue;
    }

    const state = classifyMigrationState({
      targetId: target.id,
      introspection,
      localMigrations,
      localChecksums,
    });

    if (state.kind === 'new' || (introspection.reachable && introspection.empty)) {
      plans.push({
        target,
        action: 'skip',
        reason: 'Empty database - db:update will build it from the full history instead',
        toRecord: [],
        alreadyRecorded: 0,
      });
      continue;
    }

    // baseline-required is exactly the state this command exists to fix; treat
    // every other blocking state as a hard stop before any write.
    if (state.kind !== 'baseline-required' && isBlockingState(state.kind)) {
      blockedRows.push({
        id: target.id,
        summary: state.summary,
        reconciliation: state.reconciliation,
      });
      continue;
    }

    const alreadyApplied = new Set(
      introspection.applied
        .filter((row) => row.finishedAt !== null && row.rolledBackAt === null)
        .map((row) => row.name)
    );
    const toRecord = toApply.filter((name) => !alreadyApplied.has(name));

    plans.push({
      target,
      action: 'record',
      toRecord,
      alreadyRecorded: toApply.length - toRecord.length,
    });
  }

  if (blockedRows.length > 0) {
    console.log('');
    printCliRow('❌', 'preflight', 'Stopping before any migration history is recorded.');
    printCliRow('ℹ️', 'safe', 'No database was modified.');
    for (const blocked of blockedRows) {
      console.log('');
      printCliRow('❌', blocked.id, blocked.summary);
      for (const line of blocked.reconciliation) {
        console.log(line ? `    ${line}` : '');
      }
    }
    return 1;
  }

  // Phase 2: record history. Failure stops the run; rerunning is safe because
  // already-recorded migrations are skipped.
  let failures = 0;

  for (const plan of plans) {
    const target = plan.target;

    if (plan.action === 'skip') {
      printCliRow('⏭️', target.id, plan.reason || 'Skipped');
      continue;
    }

    if (plan.toRecord.length === 0) {
      printCliRow('✅', target.id, `Nothing to record - all ${toApply.length} already present`);
      continue;
    }

    let recorded = 0;
    let targetFailed = false;

    for (const name of plan.toRecord) {
      const commandEnv = { ...env, DATABASE_URL: target.url };

      if (verbose) {
        console.log(
          `\n${sanitizeCommandOutput(
            `prisma migrate resolve --applied ${name}`,
            commandEnv
          )} on ${maskShardUrl(target.url)}`
        );
      }

      const result = await runPrisma(['migrate', 'resolve', '--applied', name], {
        env: commandEnv,
        verbose,
        cwd,
      });

      if (!result.success) {
        printCliRow('❌', target.id, `Failed on ${name}`);
        if (result.error) {
          console.error(result.error);
        }
        failures++;
        targetFailed = true;
        break;
      }

      recorded++;
    }

    if (targetFailed) {
      break;
    }

    printCliRow(
      '✅',
      target.id,
      `Baselined - ${recorded} newly recorded, ${plan.alreadyRecorded} already present`
    );
  }

  console.log('');

  if (failures > 0) {
    printCliRow('❌', 'result', `${failures} database(s) failed. Re-running this command is safe.`);
    return 1;
  }

  printCliRow('✅', 'result', 'Baseline complete. No schema was changed and no data was deleted.');
  printCliRow('↻', 'next', 'Run `yarn db:update` to apply the remaining migrations.');
  return 0;
};
