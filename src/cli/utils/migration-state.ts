import { IntrospectionResult } from './introspect';

export type MigrationStateKind =
  | 'new'
  | 'pending'
  | 'up-to-date'
  | 'baseline-required'
  | 'failed-migration'
  | 'unknown-migrations'
  | 'history-mismatch'
  | 'absent'
  | 'unreachable';

export interface MigrationState {
  kind: MigrationStateKind;
  summary: string;
  pending: string[];
  reconciliation: string[];
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
  'failed-migration',
  'unknown-migrations',
  'history-mismatch',
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
      warnings: [],
    };
  }

  const appliedRows = introspection.applied;
  const successful = appliedRows.filter(
    (row) => row.finishedAt !== null && row.rolledBackAt === null
  );
  const appliedNames = successful.map((row) => row.name);
  const failed = appliedRows.filter(
    (row) => row.finishedAt === null && row.rolledBackAt === null
  );
  const rolledBack = appliedRows.filter((row) => row.rolledBackAt !== null);
  const pending = localMigrations.filter((name) => !appliedNames.includes(name));
  const unknown = appliedNames.filter((name) => !localMigrations.includes(name));
  const warnings: string[] = [];

  if (introspection.empty && !introspection.hasMigrationsTable) {
    return {
      kind: 'new',
      summary: `Empty database - ${localMigrations.length} migration${
        localMigrations.length === 1 ? '' : 's'
      } to apply`,
      pending: localMigrations,
      reconciliation: [],
      warnings,
    };
  }

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
      warnings,
    };
  }

  if (!introspection.empty && !introspection.hasMigrationsTable) {
    return {
      kind: 'baseline-required',
      summary: `${introspection.userTableCount} existing tables with no _prisma_migrations history`,
      pending,
      reconciliation: baselineInstructions(targetId, localMigrations, []),
      warnings,
    };
  }

  if (unknown.length > 0) {
    return {
      kind: 'unknown-migrations',
      summary: `Database has ${unknown.length} migration${
        unknown.length === 1 ? '' : 's'
      } not present locally (${unknown.slice(0, 3).join(', ')}${
        unknown.length > 3 ? ', ...' : ''
      })`,
      pending,
      reconciliation: [
        'The database is ahead of, or diverged from, the committed migrations directory.',
        'Nothing has been changed and nothing was marked as applied.',
        'Pull the missing migration files, or reconcile the history deliberately before rerunning.',
      ],
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
  const matchedCount = comparable.length - mismatched.length;

  if (mismatched.length > 0) {
    if (matchedCount === 0 && comparable.length >= 3) {
      // Every comparable checksum differs: almost certainly a systemic cause
      // (checksum format or line-ending conversion), not individual edits.
      warnings.push(
        `All ${comparable.length} recorded migration checksums differ from the local files. ` +
          'This is usually a line-ending or checksum-format difference, not an edit; ' +
          'checksum validation was skipped for this database.'
      );
    } else {
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
        warnings,
      };
    }
  }

  if (!introspection.empty && appliedNames.length === 0 && localMigrations.length > 0) {
    return {
      kind: 'baseline-required',
      summary: `${introspection.userTableCount} existing tables but no applied migrations recorded`,
      pending,
      reconciliation: baselineInstructions(targetId, localMigrations, appliedNames),
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
    warnings,
  };
};
