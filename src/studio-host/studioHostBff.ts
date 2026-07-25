import {
  Executor,
  serializeStudioHostError,
  StudioHostQuery,
  StudioHostSerializedError,
} from './studioHostExecutorTypes';

/**
 * The Studio BFF procedures this host implements.
 *
 * `query-insights` is deliberately absent: the host does not observe SQL
 * executed outside Studio, so the browser never enables the provider and the
 * Queries view stays hidden. Requests for it are rejected explicitly rather
 * than silently returning an empty snapshot.
 */
export type StudioHostBffProcedure = 'query' | 'sequence' | 'transaction' | 'sql-lint';

export interface StudioHostBffRequest {
  procedure: string;
  query?: unknown;
  sequence?: unknown;
  queries?: unknown;
  schema?: unknown;
  schemaVersion?: unknown;
  sql?: unknown;
  customPayload?: Record<string, unknown>;
}

export interface StudioHostBffResponse {
  status: number;
  /** Already-serialized JSON body, or `undefined` for a plain-text status. */
  body?: unknown;
  text?: string;
}

const MAX_TRANSACTION_QUERIES = 1000;

const isQuery = (value: unknown): value is StudioHostQuery =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as StudioHostQuery).sql === 'string' &&
  Array.isArray((value as StudioHostQuery).parameters);

const badRequest = (message: string): StudioHostBffResponse => ({
  status: 400,
  text: message,
});

const ok = (body: unknown): StudioHostBffResponse => ({ status: 200, body });

const failed = (error: unknown): [StudioHostSerializedError] => [
  serializeStudioHostError(error),
];

export interface ExecuteStudioHostBffOptions {
  /**
   * Executor bound to the already-validated shard. Callers must resolve this
   * from server-owned configuration; this module never sees a connection URL.
   */
  executor: Executor;
  request: StudioHostBffRequest;
  abortSignal?: AbortSignal;
  /** Default namespace for unqualified identifiers, when the client asked for one. */
  schema?: string;
}

/**
 * Executes one Studio BFF procedure against exactly one shard.
 *
 * Ordered-operation and transaction semantics are preserved verbatim from the
 * Studio contract: `sequence` runs the second query only after the first
 * succeeds and reports partial results, `transaction` is all-or-nothing, and
 * every failure is returned as Studio's serialized-error tuple rather than an
 * HTTP error so the client can surface it in the console view.
 */
export const executeStudioHostBffRequest = async (
  options: ExecuteStudioHostBffOptions
): Promise<StudioHostBffResponse> => {
  const { executor, request, abortSignal, schema } = options;
  const executeOptions = { abortSignal, schema };

  switch (request.procedure) {
    case 'query': {
      if (!isQuery(request.query)) {
        return badRequest('Invalid query payload');
      }

      try {
        const [error, result] = await executor.execute(request.query, executeOptions);
        return ok([error ? serializeStudioHostError(error) : null, result]);
      } catch (error) {
        return ok(failed(error));
      }
    }

    case 'sequence': {
      const sequence = request.sequence;

      if (!Array.isArray(sequence) || sequence.length !== 2) {
        return badRequest('Invalid sequence payload');
      }

      const [firstQuery, secondQuery] = sequence;

      if (!isQuery(firstQuery) || !isQuery(secondQuery)) {
        return badRequest('Invalid sequence payload');
      }

      try {
        const [firstError, firstResult] = await executor.execute(firstQuery, {
          abortSignal,
        });

        if (firstError) {
          return ok([[serializeStudioHostError(firstError)]]);
        }

        const [secondError, secondResult] = await executor.execute(secondQuery, {
          abortSignal,
        });

        if (secondError) {
          return ok([
            [null, firstResult],
            [serializeStudioHostError(secondError)],
          ]);
        }

        return ok([
          [null, firstResult],
          [null, secondResult],
        ]);
      } catch (error) {
        return ok([[serializeStudioHostError(error)]]);
      }
    }

    case 'transaction': {
      const queries = request.queries;

      if (!Array.isArray(queries) || queries.length === 0) {
        return badRequest('Invalid transaction payload');
      }

      if (queries.length > MAX_TRANSACTION_QUERIES) {
        return badRequest('Transaction payload is too large');
      }

      if (!queries.every(isQuery)) {
        return badRequest('Invalid transaction payload');
      }

      if (typeof executor.executeTransaction !== 'function') {
        return { status: 501, text: 'Transaction execution is not supported' };
      }

      try {
        const [error, results] = await executor.executeTransaction(queries, executeOptions);
        return ok([error ? serializeStudioHostError(error) : null, results]);
      } catch (error) {
        return ok(failed(error));
      }
    }

    case 'sql-lint': {
      if (typeof request.sql !== 'string') {
        return badRequest('Invalid sql-lint payload');
      }

      if (typeof executor.lintSql !== 'function') {
        // Studio's adapter falls back to local-only diagnostics when the
        // transport reports no lint support, so an empty result is correct.
        return ok([null, { diagnostics: [], schemaVersion: undefined }]);
      }

      try {
        const [error, result] = await executor.lintSql(
          {
            schema,
            schemaVersion:
              typeof request.schemaVersion === 'string' ? request.schemaVersion : undefined,
            sql: request.sql,
          },
          { abortSignal }
        );

        return ok([error ? serializeStudioHostError(error) : null, result]);
      } catch (error) {
        return ok(failed(error));
      }
    }

    case 'query-insights':
      return {
        status: 501,
        text: 'Query insights are not provided by the Prisma Sharding Studio host',
      };

    default:
      return badRequest('Invalid procedure');
  }
};
