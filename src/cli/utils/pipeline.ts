import { parseBooleanEnv } from '../../utils/env';
import {
  CommandResult,
  RunCommandOptions,
  runPrismaCommand,
  sanitizeCommandOutput,
} from './command';
import {
  BootstrapHistoryConfig,
  loadProjectConfig,
  PostgresExtensionConfig,
  ShardingProjectConfig,
} from './config';
import { IntrospectFn, introspectDatabase } from './introspect';
import { classifyMigrationState, MigrationState, MigrationStateKind, isBlockingState } from './migration-state';
import {
  readLocalMigrationChecksums,
  readLocalMigrationHistory,
  readLocalMigrationHistoryDigest,
  readPrismaSchemaDigest,
  resolveMigrationsDirectory,
  resolveSchemaPath,
} from './migrations';
import { createCliLoader, printCliRow } from './output';
import {
  EnsurePostgresExtensionsFn,
  ensurePostgresExtensions,
} from './postgresExtensions';
import { DatabaseTarget, maskShardUrl } from './shards';

/**
 * Flags that make Prisma drop or recreate data. The pipeline never *adds* them
 * on its own, but it always honours them when a developer passes them
 * explicitly: they switch the run to a direct `prisma db push`, which is the
 * only Prisma command that accepts them. No environment gating, no prompt.
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
  /** Require a verified bootstrap contract for empty databases. Default: opt-in env. */
  strictBootstrap?: boolean;
  /** Test seams: production callers never pass these. */
  introspect?: IntrospectFn;
  runPrisma?: RunPrismaFn;
  ensureExtensions?: EnsurePostgresExtensionsFn;
  projectConfig?: ShardingProjectConfig;
}

export interface BootstrapContractValidation {
  valid: boolean;
  summary: string;
  detail?: string;
}

export interface BootstrapContractOptions {
  config?: BootstrapHistoryConfig;
  localMigrations: string[];
  historyDigest: string;
  schemaDigest?: string;
  schemaPath?: string;
}

/**
 * Runtime bootstrap validation is deliberately side-effect free. The contract
 * attests that this exact, checksum-pinned history was previously exercised in
 * a genuinely disposable PostgreSQL environment. db:update never executes
 * arbitrary migration SQL twice or inside a production "temporary" schema.
 */
export const validateBootstrapHistoryContract = ({
  config,
  localMigrations,
  historyDigest,
  schemaDigest,
  schemaPath,
}: BootstrapContractOptions): BootstrapContractValidation => {
  if (!schemaPath) {
    return {
      valid: false,
      summary: 'Prisma schema path could not be resolved',
      detail:
        'Set PRISMA_SCHEMA_PATH or configure a literal schema path in prisma.config.ts before initializing empty databases.',
    };
  }
  if (!config?.verified) {
    return {
      valid: false,
      summary: 'Migration history has no verified bootstrap contract',
      detail:
        `Validate the complete history in a disposable PostgreSQL environment, then commit migrations.bootstrap with verified=true, historyDigest='${historyDigest}', and schemaDigest='${schemaDigest || 'unavailable'}'.`,
    };
  }
  if (
    typeof config.initialMigration !== 'string' ||
    typeof config.historyDigest !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(config.historyDigest) ||
    typeof config.schemaDigest !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(config.schemaDigest)
  ) {
    return {
      valid: false,
      summary: 'Bootstrap contract is malformed',
      detail:
        'migrations.bootstrap requires initialMigration plus 64-character SHA-256 historyDigest and schemaDigest values.',
    };
  }
  if (config.initialMigration !== localMigrations[0]) {
    return {
      valid: false,
      summary: 'Configured initial migration is not the earliest committed migration',
      detail: `Expected '${localMigrations[0]}', configured '${config.initialMigration}'.`,
    };
  }
  if (config.historyDigest.toLowerCase() !== historyDigest.toLowerCase()) {
    return {
      valid: false,
      summary: 'Migration history changed after bootstrap validation',
      detail:
        `Current history digest: ${historyDigest}. Revalidate this exact history in an isolated PostgreSQL environment and update migrations.bootstrap.historyDigest.`,
    };
  }
  if (!schemaDigest || config.schemaDigest.toLowerCase() !== schemaDigest.toLowerCase()) {
    return {
      valid: false,
      summary: 'Prisma datamodel changed after bootstrap validation',
      detail:
        `Current schema digest: ${schemaDigest || 'unavailable'}. Revalidate migrations against this exact datamodel and update migrations.bootstrap.schemaDigest.`,
    };
  }
  return {
    valid: true,
    summary: 'Verified bootstrap history matches the committed migrations',
  };
};

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
  /** Verbose skip reason when primary is a CLI placeholder. */
  skipReason?: string;
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
  /** Why the direct push path was chosen (shown in verbose only). */
  reason: string;
  execute: ExecuteFn;
  extensions: PostgresExtensionConfig[];
  ensureExtensions: EnsurePostgresExtensionsFn;
}

/**
 * Direct `prisma db push` against every target, forwarding whatever flags the
 * caller passed. Reached when the project has no committed migrations, or when
 * the caller explicitly asked for a destructive flag. Works in every
 * environment - the CLI does not second-guess an explicit instruction.
 */
const pushFallback = async ({
  targets,
  extraArgs,
  verbose,
  reason,
  execute,
  extensions,
  ensureExtensions,
}: PushFallbackOptions): Promise<UpdateSummary> => {
  if (verbose) {
    printCliRow('ℹ️', 'push', reason);
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
    // Caller flags (including --force-reset / --accept-data-loss) are forwarded
    // verbatim; `db push` is the Prisma command that understands them.
    const forceReset = extraArgs.some((arg) => arg.split('=')[0] === '--force-reset');
    let pushed: CommandResult;

    if (forceReset) {
      // Prisma calculates the push plan before resetting. If an extension was
      // present during planning, reset can drop it without scheduling its
      // recreation, so a dependent index/type may fail partway through. Retry
      // once after restoring prerequisites, without resetting a second time.
      pushed = await execute(target, ['db', 'push', ...extraArgs], 'Resetting schema on');
      const provisioned = await ensureExtensions(target.url, extensions);

      if (!provisioned.success) {
        loader.fail('Extension setup failed');
        failedAny = true;
        results.push({
          id: target.id,
          success: false,
          attempted: true,
          kind: 'config',
          message: provisioned.error || 'PostgreSQL extension setup failed',
        });
        if (!verbose && provisioned.error) {
          console.error(provisioned.error);
        }
        continue;
      }

      if (!pushed.success && extensions.length > 0) {
        const retryArgs = extraArgs.filter((arg) => arg.split('=')[0] !== '--force-reset');
        if (!retryArgs.some((arg) => arg.split('=')[0] === '--accept-data-loss')) {
          // The caller already authorized complete data destruction with
          // --force-reset. Its failed first pass can leave a partial schema
          // whose completion Prisma classifies as additional data loss.
          retryArgs.push('--accept-data-loss');
        }
        pushed = await execute(
          target,
          ['db', 'push', ...retryArgs],
          'Retrying schema push after extension setup on'
        );
      }
    } else {
      const provisioned = await ensureExtensions(target.url, extensions);
      if (!provisioned.success) {
        loader.fail('Extension setup failed');
        failedAny = true;
        results.push({
          id: target.id,
          success: false,
          attempted: true,
          kind: 'config',
          message: provisioned.error || 'PostgreSQL extension setup failed',
        });
        if (!verbose && provisioned.error) {
          console.error(provisioned.error);
        }
        continue;
      }

      pushed = await execute(target, ['db', 'push', ...extraArgs], 'Pushing schema to');
    }

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
        'next',
        extensions.length > 0
          ? 'Prisma needs a destructive flag here. Review the change, then rerun with --accept-data-loss.'
          : 'Prisma needs a destructive flag here. Rerun with --accept-data-loss or --force-reset.'
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
 * grouped warning for existing databases by default and fails with
 * SHARD_STRICT_DRIFT=true. A detected mismatch on a newly initialized database
 * always fails; unavailable verification remains a warning in compatible mode.
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
    ensureExtensions = ensurePostgresExtensions,
  } = options;

  const strictDrift =
    options.strictDrift ?? parseBooleanEnv('SHARD_STRICT_DRIFT', false, env);
  const strictBootstrap =
    options.strictBootstrap ?? parseBooleanEnv('SHARD_STRICT_BOOTSTRAP', false, env);
  const loadedProjectConfig = options.projectConfig
    ? { config: options.projectConfig, error: undefined }
    : loadProjectConfig(cwd);
  const projectConfig = loadedProjectConfig.config;
  const requiredExtensions = projectConfig.postgresql?.extensions || [];

  if (loadedProjectConfig.error) {
    printCliRow('❌', 'config', loadedProjectConfig.error);
    return {
      success: false,
      strategy: 'blocked',
      results: notAttempted(targets, 'config', loadedProjectConfig.error),
      warnings: [],
    };
  }

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

  // 1. An explicit destructive flag is an explicit instruction. Note it here and
  //    honour it after the client is generated - it is never refused.
  const destructive = extraArgs.filter((arg) => DESTRUCTIVE_FLAGS.includes(arg.split('=')[0]));

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

  // 2b. Destructive flags request a direct schema push. Extension-aware reset
  //     recovery is handled inside pushFallback without resetting twice.
  if (destructive.length > 0) {
    return pushFallback({
      targets,
      extraArgs,
      verbose,
      env,
      reason: `${destructive.join(', ')} requested - pushing the schema directly.`,
      execute,
      extensions: requiredExtensions,
      ensureExtensions,
    });
  }

  // 3. Decide the authoritative mechanism: committed migrations, or nothing.
  const directory = resolveMigrationsDirectory(cwd, env);
  const localHistory = directory.path
    ? readLocalMigrationHistory(directory.path)
    : { migrations: [], errors: [] };
  const localMigrations = localHistory.migrations;
  const schemaPath = resolveSchemaPath(cwd, env);
  let schemaDigest: string | undefined;
  if (schemaPath) {
    try {
      schemaDigest = readPrismaSchemaDigest(schemaPath);
    } catch {
      schemaDigest = undefined;
    }
  }
  const verifySchema = createSchemaVerifier();
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

  if (localHistory.errors.length > 0) {
    printCliRow('❌', 'migrations', 'Committed migration history is structurally invalid.');
    if (verbose) {
      printDetail(localHistory.errors);
    }
    console.log('');
    console.log('No database was modified.');
    return {
      success: false,
      strategy: 'blocked',
      results: notAttempted(targets, 'config', localHistory.errors.join(' ')),
      warnings: [],
    };
  }

  if (localMigrations.length === 0) {
    return pushFallback({
      targets,
      extraArgs,
      verbose,
      env,
      reason: directory.path
        ? `No committed migrations found in ${directory.path} - synchronising schemas directly.`
        : `${directory.error || 'Migrations directory not found.'} Synchronising schemas directly.`,
      execute,
      extensions: requiredExtensions,
      ensureExtensions,
    });
  }

  const localChecksums = readLocalMigrationChecksums(directory.path as string);
  const historyDigest = readLocalMigrationHistoryDigest(directory.path as string);

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

    // DATABASE_URL is often only a Prisma CLI / primary-client datasource. When
    // real shards are configured, skip an uncreated or empty primary so a stub
    // migration history cannot be applied to a blank schema (e.g. schema=public
    // beside schema=shardN) and block the shard fleet.
    const skippablePrimary =
      target.isPrimary &&
      shardTargets.length > 0 &&
      (state.kind === 'absent' || state.kind === 'new');

    if (skippablePrimary) {
      preflight.push({
        target,
        state,
        blocked: false,
        skipped: true,
        skipReason:
          state.kind === 'absent'
            ? 'Skipped (DATABASE_URL not created)'
            : 'Skipped (DATABASE_URL empty; shards configured)',
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
        const hasSuccessfulHistory = appliedNames.size > 0;
        const gapBeyondCutoff = hasSuccessfulHistory
          ? state.baselineCandidates.filter(
              (name) => localMigrations.indexOf(name) > cutoffIndex
            )
          : [];

        if (gapBeyondCutoff.length > 0) {
          preflight.push({
            target,
            state: {
              ...state,
              kind: 'history-mismatch',
              summary: `Migration history has gaps after the verified legacy baseline (${gapBeyondCutoff
                .slice(0, 3)
                .join(', ')})`,
              reconciliation: [
                'The configured legacy baseline cannot adopt migrations after its verified cutoff.',
                'Nothing has been changed. Reconcile this non-prefix history explicitly.',
              ],
            },
            blocked: true,
            blockedMessage: 'Migration history has non-baseline gaps',
            skipped: false,
            baselinePlan: [],
          });
          continue;
        }

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
          introspection.userObjectCount ?? introspection.userTableCount
        } schema objects exist without Prisma migration history.`,
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

  // Up-to-date databases can be compared with the current datamodel before any
  // fleet writes. Pending databases are verified after deployment because their
  // expected pre-deploy difference is not drift.
  const preflightVerifications = new Map<string, SchemaVerification>();
  if (schemaPath) {
    for (const entry of preflight) {
      if (entry.skipped || entry.blocked || entry.state.kind !== 'up-to-date') {
        continue;
      }
      const verification = await verifySchema(entry.target, schemaPath, execute);
      preflightVerifications.set(entry.target.id, verification);

      if (strictDrift && verification.status !== 'clean') {
        entry.blocked = true;
        entry.state = {
          ...entry.state,
          kind:
            verification.status === 'drift'
              ? 'schema-drift'
              : 'verification-error',
          summary:
            verification.status === 'drift'
              ? 'Live schema differs from the Prisma datamodel'
              : verification.detail || 'Schema verification could not run',
          reconciliation: [
            verification.status === 'drift'
              ? 'Strict drift checking is enabled. Reconcile the live schema with a committed migration.'
              : 'Strict drift checking is enabled. Restore schema verification before applying fleet changes.',
            'No migration was attempted against any database.',
          ],
        };
        entry.blockedMessage = entry.state.summary;
      } else if (verification.status === 'drift') {
        warnings.push({
          id: entry.target.id,
          kind: 'drift',
          message: 'Live schema differs from the Prisma datamodel',
        });
      } else if (verification.status === 'error') {
        warnings.push({
          id: entry.target.id,
          kind: 'verify',
          message: verification.detail || 'Schema verification could not run',
        });
      }
    }
  }

  let blockedEntries = preflight.filter((entry) => entry.blocked);

  // Bootstrap contracts are opt-in. Existing consumers keep the ordinary
  // migrate-deploy flow; a project that commits a contract, or explicitly
  // enables strict mode, gets the stronger source-controlled preflight.
  // Runtime contract validation is read-only.
  const emptyEntries = preflight.filter(
    (entry) => !entry.skipped && !entry.blocked && entry.state.kind === 'new'
  );
  const bootstrapConfig = projectConfig.migrations?.bootstrap;
  const enforceBootstrapContract = strictBootstrap || Boolean(bootstrapConfig);
  if (
    blockedEntries.length === 0 &&
    emptyEntries.length > 0 &&
    enforceBootstrapContract
  ) {
    const bootstrap = validateBootstrapHistoryContract({
      config: bootstrapConfig,
      localMigrations,
      historyDigest,
      schemaDigest,
      schemaPath,
    });
    if (!bootstrap.valid) {
      const blockedSummary =
        `Migration history cannot bootstrap an empty database: ${bootstrap.summary}`;
      for (const entry of emptyEntries) {
        entry.state = {
          ...entry.state,
          kind: 'bootstrap-invalid',
          summary: blockedSummary,
          reconciliation: [
            'Migration SQL was not executed during preflight and no validation artifact was created.',
            'Restore/add the missing bootstrap or forward migrations, validate the exact history in disposable PostgreSQL, and commit its contract.',
            ...(bootstrap.detail ? ['', bootstrap.detail] : []),
          ],
        };
        entry.blocked = true;
        entry.blockedMessage = blockedSummary;
      }
      printCliRow(
        '❌',
        'migrations',
        `${blockedSummary}.`
      );
      if (bootstrap.detail) {
        printDetail([bootstrap.detail]);
      }
      blockedEntries = preflight.filter((entry) => entry.blocked);
    }
  }

  // Strict drift mode explicitly requires verification. Compatible/default
  // mode does not invent a new schema-path requirement for projects whose
  // dynamic Prisma config the CLI itself can resolve but static inspection
  // cannot. Configured/strict bootstrap contracts were handled above.
  if (
    blockedEntries.length === 0 &&
    strictDrift &&
    !schemaPath
  ) {
    const summary =
      'Prisma schema could not be resolved for strict drift verification';
    for (const entry of preflight.filter(
      (candidate) => !candidate.skipped && !candidate.blocked
    )) {
      entry.state = {
        ...entry.state,
        kind: 'verification-error',
        summary,
        reconciliation: [
          'Set PRISMA_SCHEMA_PATH or configure a readable literal schema path in prisma.config.ts.',
          'No migration SQL was executed.',
        ],
      };
      entry.blocked = true;
      entry.blockedMessage = summary;
    }
    blockedEntries = preflight.filter((entry) => entry.blocked);
  }

  if (
    blockedEntries.length === 0 &&
    emptyEntries.length > 0 &&
    !schemaPath
  ) {
    for (const entry of emptyEntries) {
      const message =
        'Fresh-schema verification was unavailable because the Prisma schema path could not be resolved';
      warnings.push({
        id: entry.target.id,
        kind: 'verify',
        message,
      });
      if (!verbose) {
        printCliRow('⚠️', entry.target.id, `${message}; continuing in compatible mode`);
      }
    }
  }

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
        printCliRow(
          '⏭️',
          target.id,
          entry.skipReason || 'Skipped (DATABASE_URL placeholder)'
        );
      }
      results.push({
        id: target.id,
        success: true,
        attempted: false,
        kind: entry.state.kind,
        message:
          entry.state.kind === 'new'
            ? 'Skipped - empty DATABASE_URL while shards are configured'
            : 'Skipped - database does not exist and shards are configured',
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

    // PostgreSQL extension prerequisites apply to committed migrations as well
    // as db push. Provision them before recording a baseline or executing SQL.
    if (pendingCount > 0 && requiredExtensions.length > 0) {
      const provisioned = await ensureExtensions(target.url, requiredExtensions);
      if (!provisioned.success) {
        loader.fail('Extension setup failed');
        firstError = firstError || provisioned.error;
        results.push({
          id: target.id,
          success: false,
          attempted: true,
          kind: 'config',
          message: provisioned.error || 'PostgreSQL extension setup failed',
        });
        halted = true;
        continue;
      }
    }

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

    // 5c. Verification. Existing-database drift is relaxed by default because
    // Prisma can format equivalent objects differently. A detected mismatch on
    // a freshly initialized database always fails before reporting Synced.
    let verification: SchemaVerification | undefined;
    if (schemaPath) {
      verification =
        preflightVerifications.get(target.id) ||
        (await verifySchema(target, schemaPath, execute));
    }

    const newlyInitialized = entry.state.kind === 'new';
    const hardVerificationFailure =
      verification &&
      verification.status !== 'clean' &&
      (strictDrift ||
        (newlyInitialized &&
          (verification.status === 'drift' || enforceBootstrapContract)));

    if (hardVerificationFailure) {
      loader.fail(
        verification?.status === 'drift'
          ? newlyInitialized
            ? 'Fresh schema differs from datamodel'
            : 'Schema drift (strict mode)'
          : newlyInitialized
          ? 'Fresh schema verification failed'
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
      // A blocking verification result is a fleet failure. Stop before
      // changing any later shard; rerunning remains recoverable through
      // Prisma's idempotent migration history.
      halted = true;
      continue;
    }

    const alreadyWarned = preflightVerifications.has(target.id);
    if (verification && verification.status === 'drift' && !alreadyWarned) {
      warnings.push({
        id: target.id,
        kind: 'drift',
        message: 'Live schema differs from the Prisma datamodel',
      });
    } else if (verification && verification.status === 'error' && !alreadyWarned) {
      warnings.push({
        id: target.id,
        kind: 'verify',
        message: verification.detail || 'Schema verification could not run',
      });
      if (newlyInitialized && !verbose) {
        printCliRow(
          '⚠️',
          target.id,
          `${verification.detail || 'Fresh-schema verification could not run'}; continuing in compatible mode`
        );
      }
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
