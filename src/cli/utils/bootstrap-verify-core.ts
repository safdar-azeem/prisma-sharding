import { loadProjectConfig } from './config';
import { runPrismaCommand } from './command';
import { IntrospectFn, introspectDatabase } from './introspect';
import {
  readLocalMigrationHistory,
  readLocalMigrationHistoryDigest,
  readPrismaSchemaDigest,
  resolveMigrationsDirectory,
  resolveSchemaPath,
} from './migrations';
import { printCliHeader, printCliRow } from './output';
import {
  EnsurePostgresExtensionsFn,
  ensurePostgresExtensions,
} from './postgresExtensions';
import { getDatabaseTargets } from './shards';
import type { RunPrismaFn } from './pipeline';

const VALIDATION_URL_ENV = 'PRISMA_SHARDING_BOOTSTRAP_DATABASE_URL';
const UNSUPPORTED_ARGUMENT_PATTERN =
  /unknown (argument|option)|wasn't expected|unexpected argument|Found argument/i;

export interface BootstrapVerificationOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  introspect?: IntrospectFn;
  runPrisma?: RunPrismaFn;
  ensureExtensions?: EnsurePostgresExtensionsFn;
}

const endpointIdentity = (url: string): string | undefined => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
      return undefined;
    }
    const socket = parsed.searchParams.get('host');
    return socket?.startsWith('/')
      ? `socket:${socket}`
      : `${parsed.hostname.toLowerCase()}:${parsed.port || '5432'}`;
  } catch {
    return undefined;
  }
};

const verifyDatamodel = async (
  runPrisma: RunPrismaFn,
  cwd: string,
  env: NodeJS.ProcessEnv,
  schemaPath: string
): Promise<{ clean: boolean; detail?: string }> => {
  const attempts = [
    ['migrate', 'diff', '--from-config-datasource', '--to-schema', schemaPath, '--exit-code'],
    [
      'migrate',
      'diff',
      '--from-schema-datasource',
      schemaPath,
      '--to-schema-datamodel',
      schemaPath,
      '--exit-code',
    ],
  ];

  for (let index = 0; index < attempts.length; index++) {
    const result = await runPrisma(attempts[index], { cwd, env, verbose: false });
    if (result.exitCode === 0) {
      return { clean: true };
    }
    if (result.exitCode === 2) {
      return { clean: false, detail: 'Deployed migrations differ from the Prisma datamodel.' };
    }
    const detail = result.error || result.stderr.trim() || result.stdout.trim();
    if (index === 0 && UNSUPPORTED_ARGUMENT_PATTERN.test(detail || '')) {
      continue;
    }
    return { clean: false, detail: detail || 'Prisma schema comparison failed.' };
  }

  return { clean: false, detail: 'No supported Prisma migrate diff syntax was accepted.' };
};

/**
 * Authoritative bootstrap verification workflow. It never creates or destroys
 * infrastructure: callers must supply a freshly provisioned, disposable
 * PostgreSQL instance/cluster and explicitly attest that it may be modified.
 */
export const runBootstrapVerificationCli = async (
  options: BootstrapVerificationOptions = {}
): Promise<number> => {
  const {
    argv = process.argv.slice(2),
    env = process.env,
    cwd = process.cwd(),
    introspect = introspectDatabase,
    runPrisma = runPrismaCommand,
    ensureExtensions = ensurePostgresExtensions,
  } = options;

  printCliHeader('🧪', 'Prisma Sharding Bootstrap Verification');

  if (!argv.includes('--yes') || !argv.includes('--disposable')) {
    printCliRow('❌', 'safety', '--yes and --disposable are both required.');
    printCliRow(
      'ℹ️',
      'usage',
      `${VALIDATION_URL_ENV}=<empty disposable PostgreSQL URL> prisma-sharding-verify-bootstrap --yes --disposable`
    );
    return 1;
  }

  const validationUrl = env[VALIDATION_URL_ENV]?.trim();
  if (!validationUrl) {
    printCliRow('❌', 'config', `${VALIDATION_URL_ENV} is required.`);
    return 1;
  }

  const validationEndpoint = endpointIdentity(validationUrl);
  if (!validationEndpoint) {
    printCliRow('❌', 'config', `${VALIDATION_URL_ENV} must be a valid PostgreSQL URL.`);
    return 1;
  }
  const { targets } = getDatabaseTargets(env);
  const sameServerTarget = targets.find(
    (target) => endpointIdentity(target.url) === validationEndpoint
  );
  if (sameServerTarget) {
    printCliRow(
      '❌',
      'safety',
      `Disposable validation must not share a PostgreSQL server with ${sameServerTarget.id}.`
    );
    printCliRow('ℹ️', 'safe', 'No migration SQL was executed.');
    return 1;
  }

  const directory = resolveMigrationsDirectory(cwd, env);
  if (!directory.path) {
    printCliRow('❌', 'migrations', directory.error || 'Migrations directory not found.');
    return 1;
  }
  const history = readLocalMigrationHistory(directory.path);
  if (history.errors.length > 0 || history.migrations.length === 0) {
    printCliRow(
      '❌',
      'migrations',
      history.errors[0] || 'At least one committed migration is required.'
    );
    return 1;
  }

  const schemaPath = resolveSchemaPath(cwd, env);
  if (!schemaPath) {
    printCliRow('❌', 'schema', 'Prisma schema path could not be resolved.');
    printCliRow('ℹ️', 'safe', 'No migration SQL was executed.');
    return 1;
  }

  // Fingerprint every input before the disposable database is touched. This
  // also rejects an invalid/empty multi-file schema directory before extension
  // setup or migration SQL, and ensures the emitted contract describes the
  // exact inputs supplied to migrate deploy and migrate diff.
  let historyDigest: string;
  let schemaDigest: string;
  try {
    historyDigest = readLocalMigrationHistoryDigest(directory.path);
    schemaDigest = readPrismaSchemaDigest(schemaPath);
  } catch (error) {
    printCliRow(
      '❌',
      'schema',
      error instanceof Error ? error.message : 'Migration or schema inputs could not be read.'
    );
    printCliRow('ℹ️', 'safe', 'No migration SQL was executed.');
    return 1;
  }

  const state = await introspect(validationUrl);
  if (!state.reachable || state.databaseMissing || state.error) {
    printCliRow('❌', 'database', state.error || 'Disposable PostgreSQL is not reachable.');
    return 1;
  }
  if (!state.empty || state.hasMigrationsTable) {
    printCliRow('❌', 'database', 'Disposable PostgreSQL target must be completely empty.');
    printCliRow('ℹ️', 'safe', 'Nothing was reset or deleted.');
    return 1;
  }

  const projectConfig = loadProjectConfig(cwd);
  if (projectConfig.error) {
    printCliRow('❌', 'config', projectConfig.error);
    return 1;
  }
  const extensions = projectConfig.config.postgresql?.extensions || [];
  if (extensions.length > 0) {
    const provisioned = await ensureExtensions(validationUrl, extensions);
    if (!provisioned.success) {
      printCliRow('❌', 'extensions', provisioned.error || 'Extension setup failed.');
      return 1;
    }
  }

  const commandEnv = { ...env, DATABASE_URL: validationUrl };
  const deployed = await runPrisma(['migrate', 'deploy'], {
    cwd,
    env: commandEnv,
    verbose: false,
  });
  if (!deployed.success) {
    printCliRow('❌', 'migrations', deployed.error || 'Migration deployment failed.');
    printCliRow(
      '⚠️',
      'disposable',
      'The validation environment may be partially modified; destroy and recreate it before retrying.'
    );
    return 1;
  }

  const datamodel = await verifyDatamodel(runPrisma, cwd, commandEnv, schemaPath);
  if (!datamodel.clean) {
    printCliRow('❌', 'schema', datamodel.detail || 'Datamodel verification failed.');
    printCliRow(
      '⚠️',
      'disposable',
      'Destroy and recreate the validation environment before retrying.'
    );
    return 1;
  }

  const contract = {
    initialMigration: history.migrations[0],
    historyDigest,
    schemaDigest,
    verified: true,
  };

  printCliRow('✅', 'verified', 'Migration history builds the current datamodel from zero.');
  console.log('');
  console.log(JSON.stringify({ migrations: { bootstrap: contract } }, null, 2));
  console.log('');
  printCliRow(
    '⚠️',
    'disposable',
    'Destroy the validation PostgreSQL environment; this command never resets it automatically.'
  );
  return 0;
};
