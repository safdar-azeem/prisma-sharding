import { parseBooleanEnv } from '../../utils/env';
import {
  CommandResult,
  RunCommandOptions,
  runPrismaCommand,
  sanitizeCommandOutput,
} from './command';
import { loadProjectConfig, ShardingProjectConfig } from './config';
import { IntrospectFn, introspectDatabase } from './introspect';
import { classifyMigrationState, MigrationState, MigrationStateKind, isBlockingState } from './migration-state';
import {
  readLocalMigrationChecksums,
  readLocalMigrations,
  resolveMigrationsDirectory,
  resolveSchemaPath,
} from './migrations';
import { createCliLoader, printCliRow } from './output';
import { DatabaseTarget, maskShardUrl } from './shards';

/**
 * Flags that make Prisma drop or recreate data. The update pipeline never adds
 * them and refuses to forward them: a committed migration must be able to apply
 * itself, and a migration that cannot is a bug to fix, not data to delete.
 */
export const DESTRUCTIVE_FLAGS = ['--force-reset', '--accept-data-loss'];

/** The one public command name, used consistently in every message. */
const PUBLIC_COMMAND = 'yarn db:update';

export type UpdateStrategy = 'migrate' | 'push' | 'blocked';

export interface TargetUpdateResult {
  id: string;
  success: boolean;
  attempted: boolean;
  kind: MigrationStateKind | 'push' | 'config' | 'drift' | 'verify';
  message: string;
}

export interface UpdateWarning {
  id: string;
  kind: 'drift' | 'verify' | 'note';
  message: string;
}

export interface UpdateSummary {
  success: boolean;
  strategy: UpdateStrategy;
  results: TargetUpdateResult[];
  warnings: UpdateWarning[];
}

export type RunPrismaFn = (
  args: string[],
  options?: RunCommandOptions
) => Promise<CommandResult>;

export interface DatabaseUpdateOptions {
  targets: DatabaseTarget[];
  extraArgs?: string[];
  verbose?: boolean;
  retryHint?: string;
  generateClient?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Fail on schema drift / unverifiable schemas. Default: SHARD_STRICT_DRIFT env. */
  strictDrift?: boolean;
  /** Test seams: production callers never pass these. */
  introspect?: IntrospectFn;
  runPrisma?: RunPrismaFn;
  projectConfig?: ShardingProjectConfig;
}

type ExecuteFn = (
  target: DatabaseTarget,
  commandArgs: string[],
  action: string
) => Promise<CommandResult>;

interface PreflightEntry {
  target: DatabaseTarget;
  state: MigrationState;
  blocked: boolean;
  blockedMessage?: string;
  skipped: boolean;
  /** Migrations to record as applied before deploying (verified legacy baseline). */
  baselinePlan: string[];
}

const printDetail = (lines: string[]): void => {
  for (const line of lines) {
    console.log(line ? `    ${line}` : '');
  }
};

const notAttempted = (
  targets: DatabaseTarget[],
  kind: TargetUpdateResult['kind'],
  message: string
): TargetUpdateResult[] =>
  targets.map((target) => ({
    id: target.id,
    success: false,
    attempted: false,
    kind,
    message,
  }));

/** Pulls the failing migration name out of Prisma's deploy error output. */
export const extractFailedMigration = (output: string): string | undefined => {
  const named = output.match(/Migration name: (\S+)/);
  if (named) {
    return named[1];
  }
  const quoted = output.match(/migration\s+[`"']([\w]+)[`"']/i);
  return quoted ? quoted[1] : undefined;
};

type DiffArgumentMode = 'prisma7' | 'legacy';

export interface SchemaVerification {
  status: 'clean' | 'drift' | 'error';
  detail?: string;
}

const UNSUPPORTED_ARGUMENT_PATTERN =
  /unknown (argument|option)|wasn't expected|unexpected argument|Found argument/i;

const diffArgsFor = (mode: DiffArgumentMode, schemaPath: string): string[] =>
  mode === 'prisma7'
    ? // Prisma v7 removed --from-schema-datasource/--to-schema-datamodel. The
      // datasource URL comes from prisma.config.ts, which resolves DATABASE_URL
      // from the child environment - credentials never appear in argv.
      ['migrate', 'diff', '--from-config-datasource', '--to-schema', schemaPath, '--exit-code']
    : ['migrate', 'diff', '--from-schema-datasource', schemaPath, '--to-schema-datamodel', schemaPath, '--exit-code'];

/**
 * Compares the live database against the Prisma datamodel. Tries the Prisma v7
 * argument names first and falls back to the pre-v7 names, remembering which
 * form worked for the rest of the run. `--exit-code` semantics: 0 in sync,
 * 2 differences found, 1 error.
 */
const createSchemaVerifier = () => {
  let resolvedMode: DiffArgumentMode | undefined;

  return async (
    target: DatabaseTarget,
    schemaPath: string,
    execute: ExecuteFn
  ): Promise<SchemaVerification> => {
    const modes: DiffArgumentMode[] = resolvedMode ? [resolvedMode] : ['prisma7', 'legacy'];

    for (const mode of modes) {
      const result = await execute(target, diffArgsFor(mode, schemaPath), 'Verifying schema for');

      if (result.exitCode === 0) {
        resolvedMode = mode;
        return { status: 'clean' };
      }
      if (result.exitCode === 2) {
        resolvedMode = mode;
        return { status: 'drift' };
      }

      const output = `${result.stderr}\n${result.stdout}\n${result.error || ''}`;
      if (!resolvedMode && UNSUPPORTED_ARGUMENT_PATTERN.test(output)) {
        continue; // This Prisma version does not know these flags; try the other form.
      }

      return { status: 'error', detail: result.error || 'prisma migrate diff failed' };
    }

    return {
      status: 'error',
      detail:
        'No supported `prisma migrate diff` argument form was accepted (tried Prisma v7 and pre-v7 forms).',
    };
  };
};

interface PushFallbackOptions {
  targets: DatabaseTarget[];
  extraArgs: string[];
  verbose: boolean;
  env: NodeJS.ProcessEnv;
  directoryError: string;
  execute: ExecuteFn;
}

/**
 * Only reached when the project genuinely has no committed migrations. This is
 * the development bootstrap case; it is refused in production and refused when
 * the absence of migrations looks like a broken checkout.
 */
const pushFallback = async ({
  targets,
  extraArgs,
  verbose,
  env,
  directoryError,
  execute,
}: PushFallbackOptions): Promise<UpdateSummary> => {
  const isProduction = env.NODE_ENV === 'production';
  const optedOut = parseBooleanEnv('SHARD_DISABLE_PUSH_FALLBACK', false, env);

  if (isProduction || optedOut) {
    printCliRow('❌', 'migrations', directoryError);
    printCliRow(
      'ℹ️',
      'info',
      isProduction
        ? 'Refusing to synchronise schemas without migrations while NODE_ENV=production.'
        : 'Refusing the development push fallback because SHARD_DISABLE_PUSH_FALLBACK is set.'
    );
    printCliRow('ℹ️', 'info', `Commit a migration directory, then rerun: ${PUBLIC_COMMAND}`);
    return {
      success: false,
      strategy: 'blocked',
      results: notAttempted(targets, 'config', directoryError),
      warnings: [],
    };
  }

  if (verbose) {
    printCliRow('ℹ️', 'migrations', directoryError);
    printCliRow(
      'ℹ️',
      'push',
      'No migration history to apply - synchronising schemas directly (development only).'
    );
    console.log('');
  }

  const results: TargetUpdateResult[] = [];
  let failedAny = false;

  for (const target of targets) {
    if (failedAny) {
      results.push({
        id: target.id,
        success: false,
        attempted: false,
        kind: 'push',
        message: 'Not attempted - an earlier database failed',
      });
      continue;
    }

    const loader = createCliLoader(target.id, 'Pushing', !verbose);
    // extraArgs is already known to be free of destructive flags at this point.
    const pushed = await execute(target, ['db', 'push', ...extraArgs], 'Pushing schema to');

    if (pushed.success) {
      loader.succeed(verbose ? 'Schema synchronised' : 'Synced');
      results.push({
        id: target.id,
        success: true,
        attempted: true,
        kind: 'push',
        message: 'Schema synchronised',
      });
      continue;
    }

    loader.fail('Failed');
    failedAny = true;
    results.push({
      id: target.id,
      success: false,
      attempted: true,
      kind: 'push',
      message: pushed.error || 'db push failed',
    });

    if (!verbose && pushed.error) {
      console.error(pushed.error);
    }
    if (/data loss|force-reset|not empty/i.test(String(pushed.error || ''))) {
      printCliRow(
        'ℹ️',
        'safe',
        'Prisma asked for a destructive flag. It was not supplied and nothing was changed.'
      );
      printCliRow(
        'ℹ️',
        'next',
        'Write a migration that adds the column nullable, backfills it, then makes it required.'
      );
    }
  }

  if (failedAny) {
    const succeededIds = results.filter((result) => result.success).map((result) => result.id);
    const failedIds = results
      .filter((result) => !result.success && result.attempted)
      .map((result) => result.id);
    const skippedIds = results
      .filter((result) => !result.success && !result.attempted)
      .map((result) => result.id);

    console.log('');
    printCliRow('✅', 'succeeded', succeededIds.length > 0 ? succeededIds.join(', ') : 'none');
    printCliRow('❌', 'failed', failedIds.join(', '));
    if (skippedIds.length > 0) {
      printCliRow('⏭️', 'not applied', skippedIds.join(', '));
    }
  }

  return {
    success: results.every((result) => result.success),
    strategy: 'push',
    results,
    warnings: [],
  };
};

/**
 * The one database-update pipeline behind every CLI entry point:
 *
 *   validate flags → generate client once → discover committed migrations →
 *   silently preflight every database → adopt a configured legacy baseline →
 *   apply pending migrations in order → verify → one quiet `Synced` line per
 *   active database (detailed statuses only when verbose).
 *
 * Committed migrations are always authoritative. `db push` is only a
 * development-time fallback when no migration files exist at all, and no
 * destructive flag is ever injected or forwarded.
 *
 * Verification policy: real migration failures, checksum mismatches, and
 * incomplete migrations always fail the run. Schema drift (which can be a
 * semantically equivalent object Prisma formats differently) is a concise
 * grouped warning by default and only fails with SHARD_STRICT_DRIFT=true.
 */
export const runDatabaseUpdate = async (
  options: DatabaseUpdateOptions
): Promise<UpdateSummary> => {
  const {
    targets,
    extraArgs = [],
    verbose = false,
    retryHint = PUBLIC_COMMAND,
    generateClient = false,
    cwd = process.cwd(),
    env = process.env,
    introspect = introspectDatabase,
    runPrisma = runPrismaCommand,
  } = options;

  const strictDrift =
    options.strictDrift ?? parseBooleanEnv('SHARD_STRICT_DRIFT', false, env);

  const execute: ExecuteFn = async (target, commandArgs, action) => {
    const commandEnv = { ...env, DATABASE_URL: target.url };

    if (verbose) {
      console.log(`\n${action} ${target.id}...`);
      console.log(`Database: ${maskShardUrl(target.url)}\n`);
      console.log(
        `Command: ${sanitizeCommandOutput(`prisma ${commandArgs.join(' ')}`, commandEnv)}`
      );
    }

    const result = await runPrisma(commandArgs, { env: commandEnv, verbose, cwd });

    if (verbose) {
      console.log(`Exit code: ${result.exitCode ?? 'unavailable'}`);
      if (result.error && !result.stderr.trim() && !result.stdout.trim()) {
        console.error(result.error);
      }
    }

    return result;
  };

  // 1. Refuse destructive flags before touching anything.
  const destructive = extraArgs.filter((arg) => DESTRUCTIVE_FLAGS.includes(arg.split('=')[0]));

  if (destructive.length > 0) {
    printCliRow(
      '❌',
      'safety',
      `Refusing ${destructive.join(', ')}. This command never resets a database or drops data.`
    );
    printCliRow(
      'ℹ️',
      'info',
      'For a disposable local database only, use `prisma-sharding-push` explicitly.'
    );
    return {
      success: false,
      strategy: 'blocked',
      results: notAttempted(targets, 'config', 'Refused destructive flag'),
      warnings: [],
    };
  }

  // 2. Generate the Prisma Client once for the whole run.
  if (generateClient) {
    const loader = createCliLoader('client', 'Generating', !verbose);
    if (verbose) {
      console.log('Generating Prisma Client...\n');
    }

    const generated = await runPrisma(['generate'], { verbose, env, cwd });

    if (!generated.success) {
      loader.fail('Generation failed');
      if (generated.error) {
        console.error(generated.error);
      }
      return {
        success: false,
        strategy: 'blocked',
        results: notAttempted(targets, 'config', 'Prisma Client generation failed'),
        warnings: [],
      };
    }

    loader.succeed('Generated');
  }

  // 3. Decide the authoritative mechanism: committed migrations, or nothing.
  const directory = resolveMigrationsDirectory(cwd, env);
  const localMigrations = directory.path ? readLocalMigrations(directory.path) : [];
  const localChecksums = directory.path ? readLocalMigrationChecksums(directory.path) : {};
  const schemaPath = resolveSchemaPath(cwd, env);
  const verifySchema = createSchemaVerifier();
  const projectConfig = options.projectConfig ?? loadProjectConfig(cwd).config;
  const legacyBaseline = projectConfig.migrations?.legacyBaseline;

  if (verbose) {
    if (directory.path) {
      console.log(
        `\nMigrations directory: ${directory.path} (${localMigrations.length} migration${
          localMigrations.length === 1 ? '' : 's'
        }, source: ${directory.source})`
      );
    } else {
      console.log(`\n${directory.error || 'Migrations directory not found.'}`);
    }
    if (!schemaPath) {
      console.log('Prisma schema path not resolved; post-apply verification is disabled.');
    }
  }

  if (localMigrations.length === 0) {
    return pushFallback({
      targets,
      extraArgs,
      verbose,
      env,
      directoryError: directory.path
        ? `No committed migrations found in ${directory.path}.`
        : directory.error || 'Migrations directory not found.',
      execute,
    });
  }

  // A configured-but-invalid legacy baseline is a config error, not a guess.
  if (legacyBaseline?.verified && !localMigrations.includes(legacyBaseline.until)) {
    printCliRow(
      '❌',
      'config',
      `migrations.legacyBaseline.until '${legacyBaseline.until}' is not a committed migration.`
    );
    return {
      success: false,
      strategy: 'blocked',
      results: notAttempted(targets, 'config', 'Invalid legacyBaseline configuration'),
      warnings: [],
    };
  }

  // 4. Silent read-only preflight of every database before changing any of them.
  const preflight: PreflightEntry[] = [];
  const shardTargets = targets.filter((target) => !target.isPrimary);
  const warnings: UpdateWarning[] = [];

  for (const target of targets) {
    const introspection = await introspect(target.url);
    const state = classifyMigrationState({
      targetId: target.id,
      introspection,
      localMigrations,
      localChecksums,
    });

    for (const message of state.warnings) {
      warnings.push({ id: target.id, kind: 'note', message });
    }

    // A DATABASE_URL that was never created is a CLI datasource placeholder when
    // real shards are configured; it is not a database we are failing to migrate.
    const skippablePrimary =
      state.kind === 'absent' && target.isPrimary && shardTargets.length > 0;

    if (skippablePrimary) {
      preflight.push({
        target,
        state,
        blocked: false,
        skipped: true,
        baselinePlan: [],
      });
      continue;
    }

    // Legacy `db push` databases: adopt the source-controlled, verified baseline
    // inside this same run instead of demanding a separate command ritual.
    if (state.kind === 'baseline-required') {
      if (legacyBaseline?.verified) {
        const appliedNames = new Set(
          introspection.applied
            .filter((row) => row.finishedAt !== null && row.rolledBackAt === null)
            .map((row) => row.name)
        );
        const cutoffIndex = localMigrations.indexOf(legacyBaseline.until);
        const baselinePlan = localMigrations
          .slice(0, cutoffIndex + 1)
          .filter((name) => !appliedNames.has(name));
        const pending = localMigrations
          .slice(cutoffIndex + 1)
          .filter((name) => !appliedNames.has(name));

        preflight.push({
          target,
          state: { ...state, kind: 'pending', pending },
          blocked: false,
          skipped: false,
          baselinePlan,
        });
        continue;
      }

      preflight.push({
        target,
        state,
        blocked: true,
        blockedMessage: `Legacy database detected: ${
          introspection.userTableCount
        } tables exist without Prisma migration history.`,
        skipped: false,
        baselinePlan: [],
      });
      continue;
    }

    preflight.push({
      target,
      state,
      blocked: isBlockingState(state.kind),
      blockedMessage: state.summary,
      skipped: false,
      baselinePlan: [],
    });

    if (verbose) {
      console.log(`State (${target.id}): ${state.kind} — ${state.summary}`);
      // Prisma's own view of the same database, for diagnostics only: a non-zero
      // exit here just means "pending migrations exist" and must not fail the run.
      await execute(target, ['migrate', 'status'], 'Checking migration status for');
    }
  }

  const blockedEntries = preflight.filter((entry) => entry.blocked);

  if (blockedEntries.length > 0) {
    const legacyBlocked = blockedEntries.some(
      (entry) => entry.state.kind === 'baseline-required'
    );

    for (const entry of preflight) {
      if (entry.blocked) {
        printCliRow('❌', entry.target.id, entry.blockedMessage || entry.state.summary);
        if (verbose && entry.state.reconciliation.length > 0) {
          printDetail(entry.state.reconciliation);
        }
      } else if (!entry.skipped) {
        printCliRow('⏭️', entry.target.id, 'Not attempted');
      }
    }

    console.log('');
    if (legacyBlocked) {
      printCliRow(
        'ℹ️',
        'next',
        `Configure migrations.legacyBaseline (prisma-sharding.config.json) before running ${PUBLIC_COMMAND}.`
      );
      printCliRow('ℹ️', 'docs', 'See the "Legacy databases" section of the prisma-sharding README.');
    }
    console.log('No database was modified.');

    return {
      success: false,
      strategy: 'blocked',
      results: preflight.map((entry) => ({
        id: entry.target.id,
        success: false,
        attempted: false,
        kind: entry.state.kind,
        message: entry.blockedMessage || entry.state.summary,
      })),
      warnings,
    };
  }

  // 5. Apply per database: optional verified baseline adoption, pending
  //    migrations in order, then verification. One final line per database.
  const results: TargetUpdateResult[] = [];
  let firstError: string | undefined;
  let halted = false;

  for (const entry of preflight) {
    const target = entry.target;

    if (halted) {
      printCliRow('⏭️', target.id, 'Not attempted');
      results.push({
        id: target.id,
        success: false,
        attempted: false,
        kind: entry.state.kind,
        message: 'Not attempted - an earlier database failed',
      });
      continue;
    }

    if (entry.skipped) {
      if (verbose) {
        printCliRow('⏭️', target.id, 'Skipped (DATABASE_URL not created)');
      }
      results.push({
        id: target.id,
        success: true,
        attempted: false,
        kind: entry.state.kind,
        message: 'Skipped - database does not exist and shards are configured',
      });
      continue;
    }

    const pendingCount = entry.state.pending.length;
    const baselineCount = entry.baselinePlan.length;
    const label = pendingCount === 0 && baselineCount === 0 ? undefined : 'working';
    const loader = createCliLoader(
      target.id,
      label ? (baselineCount > 0 ? 'Adopting' : 'Migrating') : 'Checking',
      !verbose && Boolean(label)
    );

    // 5a. Verified legacy baseline adoption (records history, runs no SQL).
    let baselineFailed = false;
    for (const name of entry.baselinePlan) {
      const recorded = await execute(
        target,
        ['migrate', 'resolve', '--applied', name],
        'Recording baseline for'
      );
      if (!recorded.success) {
        loader.fail(`Baseline failed on ${name}`);
        firstError = firstError || recorded.error;
        results.push({
          id: target.id,
          success: false,
          attempted: true,
          kind: 'config',
          message: `Baseline failed on ${name}`,
        });
        baselineFailed = true;
        halted = true;
        break;
      }
    }
    if (baselineFailed) {
      continue;
    }

    // 5b. Deploy pending migrations.
    if (pendingCount > 0) {
      const deployed = await execute(
        target,
        ['migrate', 'deploy', ...extraArgs],
        'Applying migrations to'
      );

      if (!deployed.success) {
        const output = `${deployed.stderr}\n${deployed.stdout}\n${deployed.error || ''}`;
        const failedName = extractFailedMigration(output);
        loader.fail(failedName ? `${failedName} failed` : 'Migration failed');
        firstError = firstError || deployed.error;
        results.push({
          id: target.id,
          success: false,
          attempted: true,
          kind: entry.state.kind,
          message: failedName ? `${failedName} failed` : deployed.error || 'migrate deploy failed',
        });
        // Stop here: never fall through to `db push` after a failed migration.
        halted = true;
        continue;
      }
    }

    // 5c. Verification. Drift can be a semantically equivalent object Prisma
    // formats differently, so by default it is a warning, never a false failure.
    let verification: SchemaVerification | undefined;
    if (schemaPath) {
      verification = await verifySchema(target, schemaPath, execute);
    }

    const hardVerificationFailure =
      strictDrift && verification && verification.status !== 'clean';

    if (hardVerificationFailure) {
      loader.fail(
        verification?.status === 'drift'
          ? 'Schema drift (strict mode)'
          : 'Schema verification failed (strict mode)'
      );
      firstError = firstError || verification?.detail || 'Live schema differs from the Prisma datamodel';
      results.push({
        id: target.id,
        success: false,
        attempted: pendingCount > 0,
        kind: verification?.status === 'drift' ? 'drift' : 'verify',
        message:
          verification?.status === 'drift'
            ? 'Live schema differs from the Prisma datamodel'
            : verification?.detail || 'Schema verification failed',
      });
      continue;
    }

    if (verification && verification.status === 'drift') {
      warnings.push({
        id: target.id,
        kind: 'drift',
        message: 'Live schema differs from the Prisma datamodel',
      });
    } else if (verification && verification.status === 'error') {
      warnings.push({
        id: target.id,
        kind: 'verify',
        message: verification.detail || 'Schema verification could not run',
      });
    }

    // 5d. One unambiguous final line. Normal mode stays quiet with a single
    // success status; migration counts and "already up to date" live in verbose.
    const parts: string[] = [];
    if (baselineCount > 0) {
      parts.push(`Baselined ${baselineCount}`);
    }
    if (pendingCount > 0) {
      parts.push(`${pendingCount} migration${pendingCount === 1 ? '' : 's'} applied`);
    }
    const message = parts.length > 0 ? parts.join(', ') : 'Already up to date';

    loader.succeed(verbose ? message : 'Synced');
    results.push({
      id: target.id,
      success: true,
      attempted: pendingCount > 0 || baselineCount > 0,
      kind: entry.state.kind,
      message,
    });
  }

  // 6. Grouped, non-repeating warnings (verbose only — routine runs stay quiet).
  if (verbose) {
    const driftIds = warnings.filter((w) => w.kind === 'drift').map((w) => w.id);
    const verifyWarnings = warnings.filter((w) => w.kind === 'verify');
    const noteGroups = new Map<string, string[]>();
    for (const warning of warnings) {
      if (warning.kind === 'note') {
        const ids = noteGroups.get(warning.message) || [];
        ids.push(warning.id);
        noteGroups.set(warning.message, ids);
      }
    }

    if (driftIds.length > 0 || verifyWarnings.length > 0 || noteGroups.size > 0) {
      console.log('');
    }
    if (driftIds.length > 0) {
      printCliRow(
        '⚠️',
        'drift',
        `${driftIds.join(', ')}: live schema differs from the datamodel (often an equivalent index/opclass form). Not blocking; enforce with SHARD_STRICT_DRIFT=true.`
      );
    }
    if (verifyWarnings.length > 0) {
      printCliRow(
        '⚠️',
        'verify',
        `${verifyWarnings.map((w) => w.id).join(', ')}: schema verification could not run (${
          verifyWarnings[0].message
        }).`
      );
    }
    for (const [message, ids] of noteGroups) {
      printCliRow('⚠️', 'note', `${ids.join(', ')}: ${message}`);
    }
  }

  // 7. One final, unambiguous outcome.
  const failedCount = results.filter((result) => !result.success).length;
  // Placeholder primary databases are never part of the active fleet count.
  const activeDatabaseCount = results.filter(
    (result) => !result.message.startsWith('Skipped')
  ).length;

  if (failedCount === 0) {
    if (verbose) {
      console.log('');
      printCliRow(
        '✅',
        'Complete',
        `All ${activeDatabaseCount} databases are up to date`
      );
    }
    return { success: true, strategy: 'migrate', results, warnings };
  }

  console.log('');
  if (firstError && !verbose) {
    console.error(firstError.trim());
    console.log('');
  }
  console.log('No database was reset.');
  console.log(`Fix the issue and rerun: ${retryHint}`);

  return { success: false, strategy: 'migrate', results, warnings };
};
