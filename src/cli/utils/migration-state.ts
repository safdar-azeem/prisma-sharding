import { IntrospectionResult } from './introspect';

export type MigrationStateKind =
  | 'new'
  | 'pending'
  | 'up-to-date'
  | 'baseline-required'
  | 'bootstrap-invalid'
  | 'failed-migration'
  | 'unknown-migrations'
  | 'history-mismatch'
  | 'schema-drift'
  | 'verification-error'
  | 'absent'
  | 'unreachable';

export interface MigrationState {
  kind: MigrationStateKind;
  summary: string;
  pending: string[];
  reconciliation: string[];
  /** Missing historical records that a verified legacy baseline may adopt. */
  baselineCandidates: string[];
  /** Non-fatal observations, printed but never blocking. */
  warnings: string[];
}

export interface ClassifyOptions {
  targetId: string;
  introspection: IntrospectionResult;
  localMigrations: string[];
  /** Acceptable SHA-256 digests per local migration (raw and LF-normalised). */
  localChecksums?: Record<string, string[]>;
}

/**
 * States that must stop the run before anything is applied anywhere.
 * None of them are auto-repaired: repairing them silently is how data gets lost.
 */
export const BLOCKING_STATES: MigrationStateKind[] = [
  'baseline-required',
  'bootstrap-invalid',
  'failed-migration',
  'unknown-migrations',
  'history-mismatch',
  'schema-drift',
  'verification-error',
  'absent',
  'unreachable',
];

export const isBlockingState = (kind: MigrationStateKind): boolean =>
  BLOCKING_STATES.includes(kind);

const baselineInstructions = (
  targetId: string,
  localMigrations: string[],
  appliedNames: string[]
): string[] => {
  const missing = localMigrations.filter((name) => !appliedNames.includes(name));

  const lines = [
    'This database has tables but no complete Prisma migration history.',
    'That normally means it was created with `db push`. Nothing has been changed.',
    '',
    'It needs a one-time baseline: recording which committed migrations are already',
    'fully represented here, so `migrate deploy` only runs the genuinely missing ones.',
    '',
    'IMPORTANT: a baselined migration NEVER has its SQL executed. Its schema changes',
    'AND its data effects (backfills, corrections, custom SQL) must already be present.',
    'Do not guess a cutoff; verify it. A safe way to verify per migration:',
    '',
    '  - schema effects: check the objects it creates/alters exist (information_schema),',
    '  - data effects: check the rows/values its backfill would have produced.',
    '',
    'Start by reviewing this database and the migration list:',
    '',
    `  DATABASE_URL="<${targetId} url>" npx prisma migrate status`,
    '',
    'Then plan the baseline (prints a reviewable plan, changes nothing):',
    '',
    '  npx prisma-sharding-baseline --until <newest migration you verified>',
    '',
    'Executing requires both --yes and --verified, and every configured database is',
    'preflighted read-only before anything is recorded anywhere.',
  ];

  if (missing.length > 0) {
    lines.push(
      '',
      `Migrations with no applied record on ${targetId} (${missing.length}):`,
      '',
      ...missing.map((name) => `  ${name}`)
    );
  }

  if (localMigrations.length <= 1) {
    lines.push(
      '',
      `Note: only ${localMigrations.length} migration file${
        localMigrations.length === 1 ? ' was' : 's were'
      } found on disk, which is unusually few for a`,
      'database this size. Check that the full migrations directory is present in',
      'this checkout before baselining - baselining against a truncated history',
      'cannot be undone cleanly.'
    );
  }

  lines.push(
    '',
    'Then rerun the update. No database is reset and no data is deleted at any point.'
  );

  return lines;
};

export const classifyMigrationState = ({
  targetId,
  introspection,
  localMigrations,
  localChecksums = {},
}: ClassifyOptions): MigrationState => {
  if (introspection.databaseMissing) {
    return {
      kind: 'absent',
      summary: 'Database does not exist on the server',
      pending: [],
      reconciliation: [
        'The server is reachable but this database has not been created.',
        'Either create it, or point the variable at an existing database.',
      ],
      baselineCandidates: [],
      warnings: [],
    };
  }

  if (!introspection.reachable) {
    return {
      kind: 'unreachable',
      summary: `Not reachable${introspection.error ? `: ${introspection.error}` : ''}`,
      pending: [],
      reconciliation: [
        'Verify the connection string, network access and database availability.',
        'No migration was attempted against any database.',
      ],
      baselineCandidates: [],
      warnings: [],
    };
  }

  if (introspection.error) {
    return {
      kind: 'unreachable',
      summary: `Could not read migration history: ${introspection.error}`,
      pending: [],
      reconciliation: [
        'The database answered but its migration history could not be read.',
        'Check the connecting role has permission to read information_schema and _prisma_migrations.',
      ],
      baselineCandidates: [],
      warnings: [],
    };
  }

  const appliedRows = introspection.applied;
  const userObjectCount = introspection.userObjectCount ?? introspection.userTableCount;
  const successful = appliedRows.filter(
    (row) => row.finishedAt !== null && row.rolledBackAt === null
  );
  const appliedNames = successful.map((row) => row.name);
  const failed = appliedRows.filter(
    (row) => row.finishedAt === null && row.rolledBackAt === null
  );
  const rolledBack = appliedRows.filter((row) => row.rolledBackAt !== null);
  const pending = localMigrations.filter((name) => !appliedNames.includes(name));
  const warnings: string[] = [];

  if (failed.length > 0) {
    return {
      kind: 'failed-migration',
      summary: `Migration '${failed[0].name}' is recorded as started but never finished`,
      pending,
      reconciliation: [
        'A previous migration did not complete. Nothing has been changed.',
        'Inspect the database, then record the real outcome:',
        '',
        '  # If the migration must run again (Prisma will re-apply it on the next update):',
        `  DATABASE_URL="<${targetId} url>" npx prisma migrate resolve --rolled-back ${failed[0].name}`,
        '',
        '  # ONLY if you manually completed every step of its SQL by hand:',
        `  DATABASE_URL="<${targetId} url>" npx prisma migrate resolve --applied ${failed[0].name}`,
        '',
        'If it partially ran, first finish or revert the partial change by hand.',
        'Then rerun the update.',
      ],
      baselineCandidates: [],
      warnings,
    };
  }

  // Any history row absent from disk is divergent history, including a
  // deliberately rolled-back attempt. Keeping it visible prevents a deleted
  // migration directory from being mistaken for a clean pending state.
  const unknownRows = appliedRows.filter((row) => !localMigrations.includes(row.name));
  if (unknownRows.length > 0) {
    const names = [...new Set(unknownRows.map((row) => row.name))];
    return {
      kind: 'unknown-migrations',
      summary: `Database has ${names.length} migration${
        names.length === 1 ? '' : 's'
      } not present locally (${names.slice(0, 3).join(', ')}${
        names.length > 3 ? ', ...' : ''
      })`,
      pending,
      reconciliation: [
        'The database is ahead of, or diverged from, the committed migrations directory.',
        'Nothing has been changed and nothing was marked as applied.',
        'Pull the missing migration files, or reconcile the history deliberately before rerunning.',
      ],
      baselineCandidates: [],
      warnings,
    };
  }

  const contradictoryRows = appliedRows.filter(
    (row) => row.finishedAt !== null && row.rolledBackAt !== null
  );
  const successfulCounts = new Map<string, number>();
  for (const row of successful) {
    successfulCounts.set(row.name, (successfulCounts.get(row.name) || 0) + 1);
  }
  const duplicateSuccesses = [...successfulCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name]) => name);

  if (contradictoryRows.length > 0 || duplicateSuccesses.length > 0) {
    return {
      kind: 'history-mismatch',
      summary:
        contradictoryRows.length > 0
          ? 'Migration history contains rows marked both finished and rolled back'
          : `Migration history contains duplicate successful records (${duplicateSuccesses
              .slice(0, 3)
              .join(', ')})`,
      pending,
      reconciliation: [
        'The _prisma_migrations audit trail is internally inconsistent.',
        'Nothing has been changed. Inspect and reconcile the history explicitly before rerunning.',
      ],
      baselineCandidates: [],
      warnings,
    };
  }

  if (introspection.empty) {
    if (successful.length > 0) {
      return {
        kind: 'history-mismatch',
        summary: 'Migration history records successful migrations but the target schema has no user tables',
        pending,
        reconciliation: [
          'The schema and _prisma_migrations audit trail disagree.',
          'Nothing has been changed. Do not delete history or mark migrations automatically.',
        ],
        baselineCandidates: [],
        warnings,
      };
    }

    return {
      kind: 'new',
      summary: `Empty database - ${localMigrations.length} migration${
        localMigrations.length === 1 ? '' : 's'
      } to apply`,
      pending: localMigrations,
      reconciliation: [],
      baselineCandidates: [],
      warnings,
    };
  }

  if (!introspection.empty && !introspection.hasMigrationsTable) {
    return {
      kind: 'baseline-required',
      summary: `${userObjectCount} existing schema objects with no _prisma_migrations history`,
      pending,
      reconciliation: baselineInstructions(targetId, localMigrations, []),
      baselineCandidates: localMigrations,
      warnings,
    };
  }

  // Checksum validation: an applied migration whose local migration.sql no longer
  // matches what actually ran is a rewritten history, not something to deploy over.
  const comparable = successful.filter(
    (row) => Boolean(row.checksum) && Boolean(localChecksums[row.name])
  );
  const mismatched = comparable.filter(
    (row) => !localChecksums[row.name].includes(row.checksum as string)
  );
  if (mismatched.length > 0) {
    const names = mismatched.map((row) => row.name);
    return {
      kind: 'history-mismatch',
      summary: `${names.length} applied migration${
        names.length === 1 ? '' : 's'
      } differ${names.length === 1 ? 's' : ''} from the local SQL (${names
        .slice(0, 3)
        .join(', ')}${names.length > 3 ? ', ...' : ''})`,
      pending,
      reconciliation: [
        'A migration file was edited after this database recorded it as applied.',
        'The SQL that actually ran here is not the SQL in the working tree.',
        'Nothing has been changed.',
        '',
        'Restore the original migration file from source control, or reconcile the',
        'difference deliberately (a new migration for the delta is usually correct).',
        'Do not edit applied migrations: their checksums are the audit trail.',
      ],
      baselineCandidates: [],
      warnings,
    };
  }

  const highestAppliedIndex = appliedNames.reduce(
    (highest, name) => Math.max(highest, localMigrations.indexOf(name)),
    -1
  );
  const historicalGaps = localMigrations
    .slice(0, highestAppliedIndex + 1)
    .filter((name) => !appliedNames.includes(name));
  const rolledBackNames = new Set(rolledBack.map((row) => row.name));

  if (historicalGaps.some((name) => rolledBackNames.has(name))) {
    return {
      kind: 'history-mismatch',
      summary: 'A rolled-back migration appears before a later successful migration',
      pending,
      reconciliation: [
        'Migration history is not a completed prefix of the committed history.',
        'Do not mark it applied automatically. Inspect the explicit failed-migration recovery that occurred.',
      ],
      baselineCandidates: [],
      warnings,
    };
  }

  if (historicalGaps.length > 0) {
    return {
      kind: 'baseline-required',
      summary: `${historicalGaps.length} earlier committed migration${
        historicalGaps.length === 1 ? ' is' : 's are'
      } missing before already recorded history`,
      pending,
      reconciliation: baselineInstructions(targetId, localMigrations, appliedNames),
      baselineCandidates: historicalGaps,
      warnings,
    };
  }

  if (
    appliedNames.length === 0 &&
    rolledBack.length === 0 &&
    localMigrations.length > 0
  ) {
    return {
      kind: 'baseline-required',
      summary: `${userObjectCount} existing schema objects but no applied migrations recorded`,
      pending,
      reconciliation: baselineInstructions(targetId, localMigrations, appliedNames),
      baselineCandidates: localMigrations,
      warnings,
    };
  }

  // Rolled-back migrations are deliberately deployable again: Prisma documents
  // `migrate resolve --rolled-back` as the step that allows `migrate deploy` to
  // re-apply them. They stay in `pending` and are never blocked here.
  const retriedRollbacks = rolledBack
    .map((row) => row.name)
    .filter((name) => pending.includes(name));

  if (retriedRollbacks.length > 0) {
    warnings.push(
      `Rolled-back migration${retriedRollbacks.length === 1 ? '' : 's'} ${retriedRollbacks
        .slice(0, 3)
        .join(', ')}${
        retriedRollbacks.length > 3 ? ', ...' : ''
      } will be re-applied by migrate deploy. Ensure any partial effects of the failed run were reverted.`
    );
  }

  if (pending.length === 0) {
    return {
      kind: 'up-to-date',
      summary: 'Already up to date',
      pending: [],
      reconciliation: [],
      baselineCandidates: [],
      warnings,
    };
  }

  return {
    kind: 'pending',
    summary: `${pending.length} pending migration${
      pending.length === 1 ? '' : 's'
    }: ${pending.slice(0, 3).join(', ')}${pending.length > 3 ? ', ...' : ''}`,
    pending,
    reconciliation: [],
    baselineCandidates: [],
    warnings,
  };
};
