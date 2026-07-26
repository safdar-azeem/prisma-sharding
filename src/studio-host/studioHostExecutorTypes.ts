/**
 * Structural mirror of the `prisma-studio-next` executor contract.
 *
 * The host runs the real `createPostgresJSExecutor` at runtime. These types
 * exist so the routing, pooling and BFF modules can be typed and unit-tested
 * without pulling Studio's Kysely-backed query types (and their transitive
 * type dependencies) into this package's type graph.
 *
 * Anything here that drifts from Studio's contract is a bug: the shapes are
 * intentionally minimal and cover only what the host forwards.
 */

export type StudioHostEither<E, T> = [E] | [null, T];

export interface StudioHostQuery {
  sql: string;
  parameters: readonly unknown[];
}

export interface StudioHostExecuteOptions {
  abortSignal?: AbortSignal;
  schema?: string;
}

export interface StudioHostSqlLintDetails {
  schema?: string;
  schemaVersion?: string;
  sql: string;
}

export interface StudioHostSqlLintDiagnostic {
  code?: string;
  from: number;
  message: string;
  severity: 'error' | 'warning' | 'info' | 'hint';
  source?: string;
  to: number;
}

export interface StudioHostSqlLintResult {
  diagnostics: StudioHostSqlLintDiagnostic[];
  schemaVersion?: string;
}

export interface Executor {
  execute(
    query: StudioHostQuery,
    options?: StudioHostExecuteOptions
  ): Promise<StudioHostEither<Error, unknown>>;

  executeTransaction?(
    queries: readonly StudioHostQuery[],
    options?: StudioHostExecuteOptions
  ): Promise<StudioHostEither<Error, unknown[]>>;

  lintSql?(
    details: StudioHostSqlLintDetails,
    options?: StudioHostExecuteOptions
  ): Promise<StudioHostEither<Error, StudioHostSqlLintResult>>;
}

/** Wire shape of a serialized error, matching Studio's BFF contract. */
export interface StudioHostSerializedError {
  message: string;
  name: string;
  errors?: StudioHostSerializedError[];
}

/**
 * Byte-for-byte equivalent of `serializeError` in `prisma-studio-next/data/bff`.
 *
 * Reimplemented rather than imported because the BFF entry point is a browser
 * bundle; the contract it defines is what matters, and it is asserted by tests.
 */
export const serializeStudioHostError = (error: unknown): StudioHostSerializedError => {
  if (error instanceof AggregateError) {
    return {
      name: error.name,
      message: error.message,
      errors: error.errors.map(serializeStudioHostError),
    };
  }

  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }

  return { name: 'UnknownError', message: JSON.stringify(error) };
};
