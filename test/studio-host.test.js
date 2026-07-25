const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  assertStudioShardManifestIsSafe,
  buildStudioShardUrl,
  normalizeStudioHostConnectionString,
  readShardIdFromSearch,
  resolveInitialShardId,
  buildStudioShardManifest,
  createStudioHostConnectionPool,
  createStudioHostService,
  executeStudioHostBffRequest,
  findStudioHostTarget,
  readRequestedShardId,
  resolveStudioHostTargets,
} = require(path.resolve(__dirname, '../dist/studio-host/index.js'));

const SHARD_1_URL = 'postgresql://app:secret1@db-a.internal:5432/shard_one';
const SHARD_2_URL = 'postgresql://app:secret2@db-b.internal:5432/shard_two';

const env = (overrides) => ({ SHARD_COUNT: '2', SHARD_1_URL, SHARD_2_URL, ...overrides });

const query = (sql, parameters = []) => ({ sql, parameters });

/** Executor that records what it was asked to do and answers deterministically. */
const createRecordingExecutor = (label, behaviour = {}) => {
  const calls = [];

  return {
    calls,
    executor: {
      async execute(q, options) {
        calls.push({ kind: 'execute', sql: q.sql, schema: options?.schema });

        if (behaviour.executeError) {
          return [behaviour.executeError];
        }

        return [null, [{ from: label, sql: q.sql }]];
      },
      async executeTransaction(queries) {
        calls.push({ kind: 'transaction', count: queries.length });

        if (behaviour.transactionError) {
          return [behaviour.transactionError];
        }

        return [null, queries.map((q) => [{ from: label, sql: q.sql }])];
      },
      async lintSql(details) {
        calls.push({ kind: 'lint', sql: details.sql });
        return [null, { diagnostics: [], schemaVersion: details.schemaVersion }];
      },
    },
  };
};

// ---------------------------------------------------------------- discovery

test('discovers every configured shard from the invoking project environment', () => {
  const result = resolveStudioHostTargets(env());

  assert.deepEqual(
    result.targets.map((target) => target.id),
    ['shard_1', 'shard_2']
  );
  assert.deepEqual(result.targets.map((target) => target.label), ['Shard 1', 'Shard 2']);
  assert.equal(result.missingShardIds.length, 0);
  assert.equal(result.usedPrimaryFallback, false);
});

test('reports zero targets when nothing is configured', () => {
  assert.deepEqual(resolveStudioHostTargets({}).targets, []);
});

test('uses DATABASE_URL only when no shards are configured, matching prior Studio semantics', () => {
  const withShards = resolveStudioHostTargets(
    env({ DATABASE_URL: 'postgresql://app:pw@primary:5432/main' })
  );

  assert.deepEqual(
    withShards.targets.map((target) => target.id),
    ['shard_1', 'shard_2'],
    'the primary is not silently added as an extra database when shards exist'
  );
  assert.equal(withShards.usedPrimaryFallback, false);

  const withoutShards = resolveStudioHostTargets({
    DATABASE_URL: 'postgresql://app:pw@primary:5432/main',
  });

  assert.deepEqual(withoutShards.targets.map((target) => target.id), ['shard_1']);
  assert.equal(withoutShards.usedPrimaryFallback, true);
});

test('records missing shard URLs instead of inventing databases', () => {
  const result = resolveStudioHostTargets({ SHARD_COUNT: '3', SHARD_1_URL, SHARD_3_URL: SHARD_2_URL });

  assert.deepEqual(result.targets.map((target) => target.id), ['shard_1', 'shard_3']);
  assert.deepEqual(result.missingShardIds, ['shard_2']);
});

test('folds duplicate physical databases into one selectable target', () => {
  const result = resolveStudioHostTargets({
    SHARD_COUNT: '3',
    SHARD_1_URL,
    // Same database, different credentials and protocol alias.
    SHARD_2_URL: 'postgres://other:pw@db-a.internal:5432/shard_one',
    SHARD_3_URL: SHARD_2_URL,
  });

  assert.deepEqual(result.targets.map((target) => target.id), ['shard_1', 'shard_3']);
  assert.deepEqual(result.targets[0].aliasIds, ['shard_2']);
  assert.deepEqual(result.duplicates, [{ id: 'shard_2', sameAs: 'shard_1' }]);
});

test('keeps custom and non-sequential shard identifiers exactly as configured', () => {
  const result = resolveStudioHostTargets({
    SHARD_COUNT: '2',
    SHARD_1_URL,
    SHARD_2_URL,
  });

  assert.equal(findStudioHostTarget(result.targets, 'shard_2').id, 'shard_2');
  assert.equal(findStudioHostTarget(result.targets, '  shard_2  ').id, 'shard_2');
});

test('resolves an aliased shard id so a de-duplicated deep link still works', () => {
  const result = resolveStudioHostTargets({
    SHARD_COUNT: '2',
    SHARD_1_URL,
    SHARD_2_URL: SHARD_1_URL,
  });

  assert.equal(findStudioHostTarget(result.targets, 'shard_2').id, 'shard_1');
});

test('never resolves an unknown, malformed or non-string shard identifier', () => {
  const { targets } = resolveStudioHostTargets(env());

  for (const candidate of [undefined, null, '', '   ', 'shard_9', 'SHARD_1', 42, {}, ['shard_1']]) {
    assert.equal(findStudioHostTarget(targets, candidate), undefined, `rejected ${String(candidate)}`);
  }
});

// ----------------------------------------------------------------- manifest

test('the manifest sent to the browser contains no credentials of any kind', () => {
  const result = resolveStudioHostTargets(env());
  const manifest = buildStudioShardManifest(result);
  const serialized = JSON.stringify(manifest);

  assert.doesNotMatch(serialized, /secret1|secret2/);
  assert.doesNotMatch(serialized, /db-a\.internal|db-b\.internal/);
  assert.doesNotMatch(serialized, /postgres/i);
  assert.doesNotThrow(() => assertStudioShardManifestIsSafe(manifest, result.targets));

  assert.deepEqual(manifest.shards.map((shard) => shard.id), ['shard_1', 'shard_2']);
  assert.equal(manifest.defaultShardId, 'shard_1', 'the default is deterministic');
  assert.equal(manifest.version, 1);
});

test('the manifest safety check fails loudly if a URL or password ever leaks in', () => {
  const result = resolveStudioHostTargets(env());
  const manifest = buildStudioShardManifest(result);

  assert.throws(
    () =>
      assertStudioShardManifestIsSafe(
        { ...manifest, warnings: [`Could not reach ${SHARD_1_URL}`] },
        result.targets
      ),
    /connection string/i
  );

  assert.throws(
    () =>
      assertStudioShardManifestIsSafe(
        { ...manifest, warnings: ['password is secret1'] },
        result.targets
      ),
    /password/i
  );
});

test('the manifest drops environment variable names that could themselves be secrets', () => {
  const manifest = buildStudioShardManifest({
    targets: [
      {
        id: 'shard_1',
        label: 'Shard 1',
        index: 0,
        url: SHARD_1_URL,
        sources: ['SHARD_1_URL', 'DB_PASSWORD', 'API_TOKEN', 'not a name!'],
        aliasIds: [],
      },
    ],
    missingShardIds: [],
    duplicates: [],
    usedPrimaryFallback: false,
  });

  assert.deepEqual(manifest.shards[0].sources, ['SHARD_1_URL']);
});

test('the manifest truncates very long labels and strips control characters', () => {
  const manifest = buildStudioShardManifest({
    targets: [
      {
        id: 'x'.repeat(400),
        label: `tenant-${'east'.repeat(80)}`,
        index: 0,
        url: SHARD_1_URL,
        sources: [],
        aliasIds: [],
      },
    ],
    missingShardIds: [],
    duplicates: [],
    usedPrimaryFallback: false,
  });

  assert.ok(manifest.shards[0].label.length <= 120);
  assert.doesNotMatch(manifest.shards[0].label, /[\u0000-\u001F]/);
});

test('the manifest explains missing, duplicated and fallback configuration', () => {
  const manifest = buildStudioShardManifest(
    resolveStudioHostTargets({ SHARD_COUNT: '3', SHARD_1_URL, SHARD_2_URL: SHARD_1_URL })
  );

  assert.ok(manifest.warnings.some((warning) => warning.includes('shard_3')));
  assert.ok(manifest.warnings.some((warning) => warning.includes('same physical database')));
});

// -------------------------------------------------------------- shard in URL

test('switching shards changes only the shard parameter and keeps Studio navigation', () => {
  // The whole point of switching on a homogeneous shard set is to see the same
  // table in another database, so the view, schema, table, filters and sorting
  // in the hash must survive untouched.
  const hash = '#view=table&schema=public&table=Appointment&filter=%7B%7D&sort=id.asc';

  assert.equal(
    buildStudioShardUrl({ pathname: '/', search: '?shard=shard_1', hash }, 'shard_2'),
    `/?shard=shard_2${hash}`
  );
});

test('a first visit with no shard parameter keeps the deep-linked hash', () => {
  assert.equal(
    buildStudioShardUrl(
      { pathname: '/', search: '', hash: '#view=table&schema=public&table=Appointment' },
      'shard_1'
    ),
    '/?shard=shard_1#view=table&schema=public&table=Appointment'
  );
});

test('an empty hash produces no stray fragment', () => {
  assert.equal(buildStudioShardUrl({ pathname: '/', search: '', hash: '' }, 'shard_1'), '/?shard=shard_1');
});

test('unrelated query parameters are preserved alongside the shard', () => {
  const url = buildStudioShardUrl(
    { pathname: '/studio', search: '?tenant=acme&debug=1', hash: '#view=sql' },
    'shard_3'
  );
  const search = new URLSearchParams(url.split('?')[1].split('#')[0]);

  assert.equal(search.get('tenant'), 'acme');
  assert.equal(search.get('debug'), '1');
  assert.equal(search.get('shard'), 'shard_3');
  assert.ok(url.endsWith('#view=sql'));
});

test('switching twice does not accumulate duplicate shard parameters', () => {
  let url = buildStudioShardUrl({ pathname: '/', search: '', hash: '#view=table' }, 'shard_1');
  const parts = (value) => ({
    pathname: value.split('?')[0],
    search: `?${value.split('?')[1].split('#')[0]}`,
    hash: `#${value.split('#')[1]}`,
  });

  url = buildStudioShardUrl(parts(url), 'shard_2');
  url = buildStudioShardUrl(parts(url), 'shard_3');

  assert.equal(url, '/?shard=shard_3#view=table');
  assert.deepEqual([...new URLSearchParams(url.split('?')[1].split('#')[0]).getAll('shard')], [
    'shard_3',
  ]);
});

test('a hash carrying encoded filter state is not re-encoded on switch', () => {
  // Studio writes its own fragment; round-tripping it through URLSearchParams
  // would corrupt the encoding Studio expects to read back.
  const hash = '#filter=%7B%22kind%22%3A%22FilterGroup%22%7D&aggregations';

  assert.ok(
    buildStudioShardUrl({ pathname: '/', search: '?shard=shard_1', hash }, 'shard_2').endsWith(hash)
  );
});

test('the shard is read back from the query string, ignoring blanks', () => {
  assert.equal(readShardIdFromSearch('?shard=shard_2'), 'shard_2');
  assert.equal(readShardIdFromSearch('shard=shard_2'), 'shard_2');
  assert.equal(readShardIdFromSearch('?shard=%20%20'), null);
  assert.equal(readShardIdFromSearch('?other=1'), null);
  assert.equal(readShardIdFromSearch(''), null);
});

test('a deep link to a valid shard is honoured, a stale one falls back', () => {
  const availableShardIds = ['shard_1', 'shard_2'];

  assert.deepEqual(
    resolveInitialShardId({ availableShardIds, defaultShardId: 'shard_1', requestedShardId: 'shard_2' }),
    { shardId: 'shard_2', wasRequestedShardStale: false }
  );

  assert.deepEqual(
    resolveInitialShardId({ availableShardIds, defaultShardId: 'shard_1', requestedShardId: 'shard_9' }),
    { shardId: 'shard_1', wasRequestedShardStale: true },
    'a removed shard falls back to the default and is reported'
  );

  assert.deepEqual(
    resolveInitialShardId({ availableShardIds, defaultShardId: 'shard_1', requestedShardId: null }),
    { shardId: 'shard_1', wasRequestedShardStale: false }
  );
});

// ------------------------------------------------- Prisma connection strings

test('a stock Prisma URL does not forward ?schema= to the server', () => {
  // postgres.js sends every query parameter it does not recognise as a startup
  // parameter, so leaving `schema` in place makes PostgreSQL reject the whole
  // connection with `unrecognized configuration parameter "schema"`.
  const result = normalizeStudioHostConnectionString(
    'postgresql://postgres:pw@localhost:5432/erp_shard1?schema=public'
  );

  assert.equal(result.connectionString, 'postgresql://postgres:pw@localhost:5432/erp_shard1');
  assert.equal(result.schema, 'public');
  assert.deepEqual(result.options.connection, { search_path: 'public' });
  assert.ok(result.consumed.includes('schema'));
});

test('a non-public schema becomes the connection default search path', () => {
  const result = normalizeStudioHostConnectionString(
    'postgresql://u:p@localhost:5432/db?schema=tenant_east'
  );

  assert.deepEqual(result.options.connection, { search_path: 'tenant_east' });
});

test('a URL with no query string is passed through untouched', () => {
  const url = 'postgresql://u:p@localhost:5432/db';
  const result = normalizeStudioHostConnectionString(url);

  assert.equal(result.connectionString, url);
  assert.deepEqual(result.options, {});
  assert.deepEqual(result.consumed, []);
});

test('Prisma engine-only arguments are dropped rather than sent to the server', () => {
  const result = normalizeStudioHostConnectionString(
    'postgresql://u:p@localhost:5432/db' +
      '?schema=public&pgbouncer=true&pool_timeout=10&socket_timeout=5' +
      '&statement_cache_size=100&sslidentity=id.p12&sslaccept=accept_invalid_certs'
  );

  assert.equal(result.connectionString, 'postgresql://u:p@localhost:5432/db');

  for (const dropped of ['pgbouncer', 'pool_timeout', 'socket_timeout', 'statement_cache_size']) {
    assert.ok(result.consumed.includes(dropped), `${dropped} was consumed`);
  }
});

test('parameters postgres.js or PostgreSQL genuinely understand survive', () => {
  const result = normalizeStudioHostConnectionString(
    'postgresql://u:p@localhost:5432/db?schema=public&sslmode=require&connect_timeout=15'
  );

  const remaining = new URLSearchParams(result.connectionString.split('?')[1]);

  assert.equal(remaining.get('sslmode'), 'require');
  assert.equal(remaining.get('connect_timeout'), '15');
  assert.equal(remaining.has('schema'), false);
});

test('connection_limit becomes a postgres.js pool size', () => {
  assert.equal(
    normalizeStudioHostConnectionString('postgresql://u:p@h:5432/db?connection_limit=7').options
      .max,
    7
  );
  // A nonsensical value must not produce a broken pool configuration.
  assert.equal(
    normalizeStudioHostConnectionString('postgresql://u:p@h:5432/db?connection_limit=0').options
      .max,
    undefined
  );
});

test('a unix socket directory becomes a postgres.js socket path', () => {
  const result = normalizeStudioHostConnectionString(
    'postgresql://u:p@localhost:5432/db?host=/var/run/postgresql'
  );

  assert.equal(result.options.path, '/var/run/postgresql/.s.PGSQL.5432');
  assert.equal(result.connectionString, 'postgresql://u:p@localhost:5432/db');
});

test('application_name is preserved as a connection parameter, not a query argument', () => {
  const result = normalizeStudioHostConnectionString(
    'postgresql://u:p@h:5432/db?schema=public&application_name=erp'
  );

  assert.deepEqual(result.options.connection, {
    search_path: 'public',
    application_name: 'erp',
  });
});

test('normalization never alters the credentials in the connection string', () => {
  const result = normalizeStudioHostConnectionString(
    'postgresql://postgres:p%40ss%3Aword@localhost:5432/db?schema=public'
  );

  assert.ok(result.connectionString.startsWith('postgresql://postgres:p%40ss%3Aword@'));
});

// --------------------------------------------------------------------- pool

test('the connection pool opens lazily, reuses, and never exceeds its bound', async () => {
  const opened = [];
  const closed = [];
  const pool = createStudioHostConnectionPool({
    maxOpenConnections: 2,
    idleTimeoutMs: 0,
    createConnection: async (target) => {
      opened.push(target.id);
      return {
        executor: { async execute() { return [null, []]; } },
        dispose: async () => { closed.push(target.id); },
      };
    },
  });

  const target = (id) => ({ id, label: id, index: 0, url: `postgresql://u:p@h/${id}`, sources: [], aliasIds: [] });

  assert.deepEqual(pool.openShardIds, [], 'nothing is opened before a query');

  await pool.acquire(target('a'));
  pool.release('a');
  await pool.acquire(target('a'));
  pool.release('a');

  assert.deepEqual(opened, ['a'], 'a second request reuses the open connection');

  await pool.acquire(target('b'));
  pool.release('b');
  await pool.acquire(target('c'));
  pool.release('c');

  assert.ok(pool.openShardIds.length <= 2, 'the bound is enforced');
  assert.deepEqual(closed, ['a'], 'the least recently used connection is closed first');

  await pool.dispose();
  assert.deepEqual(pool.openShardIds, [], 'dispose leaves nothing open');
  assert.equal(closed.length, 3, 'every connection is closed exactly once');
});

test('concurrent requests for a cold shard open exactly one connection', async () => {
  let opens = 0;
  const pool = createStudioHostConnectionPool({
    createConnection: async () => {
      opens += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { executor: {}, dispose: async () => undefined };
    },
  });

  const target = { id: 'a', label: 'a', index: 0, url: 'postgresql://u:p@h/a', sources: [], aliasIds: [] };

  await Promise.all([pool.acquire(target), pool.acquire(target), pool.acquire(target)]);

  assert.equal(opens, 1);
  await pool.dispose();
});

test('a connection in use is never evicted by the bound', async () => {
  const closed = [];
  const pool = createStudioHostConnectionPool({
    maxOpenConnections: 1,
    createConnection: async (target) => ({
      executor: {},
      dispose: async () => { closed.push(target.id); },
    }),
  });

  const target = (id) => ({ id, label: id, index: 0, url: `postgresql://u:p@h/${id}`, sources: [], aliasIds: [] });

  await pool.acquire(target('a')); // acquired and NOT released: still in flight
  await pool.acquire(target('b'));

  assert.deepEqual(closed, [], 'an in-flight connection survives the bound');
  await pool.dispose();
});

// ---------------------------------------------------------------------- BFF

test('a query is executed once, against the executor it was given', async () => {
  const { calls, executor } = createRecordingExecutor('shard_1');

  const response = await executeStudioHostBffRequest({
    executor,
    request: { procedure: 'query', query: query('select 1'), schema: 'public' },
    schema: 'public',
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, [null, [{ from: 'shard_1', sql: 'select 1' }]]);
  assert.deepEqual(calls, [{ kind: 'execute', sql: 'select 1', schema: 'public' }]);
});

test('a failed query is returned as a serialized error, not an HTTP failure', async () => {
  const failure = new Error('relation "missing" does not exist');
  failure.name = 'PostgresError';
  const { executor } = createRecordingExecutor('shard_1', { executeError: failure });

  const response = await executeStudioHostBffRequest({
    executor,
    request: { procedure: 'query', query: query('select 1') },
  });

  assert.equal(response.status, 200, 'Studio surfaces database errors in its console view');
  assert.deepEqual(response.body[0], {
    name: 'PostgresError',
    message: 'relation "missing" does not exist',
  });
});

test('a sequence runs the second query only after the first succeeds', async () => {
  const { calls, executor } = createRecordingExecutor('shard_1');

  const ok = await executeStudioHostBffRequest({
    executor,
    request: { procedure: 'sequence', sequence: [query('first'), query('second')] },
  });

  assert.deepEqual(calls.map((call) => call.sql), ['first', 'second']);
  assert.equal(ok.body[0][0], null);
  assert.equal(ok.body[1][0], null);

  const failing = createRecordingExecutor('shard_1', { executeError: new Error('boom') });
  const failed = await executeStudioHostBffRequest({
    executor: failing.executor,
    request: { procedure: 'sequence', sequence: [query('first'), query('second')] },
  });

  assert.equal(failing.calls.length, 1, 'the second query never runs after a failure');
  assert.equal(failed.body.length, 1);
  assert.equal(failed.body[0][0].message, 'boom');
});

test('a transaction is forwarded as one atomic batch and refused when unsupported', async () => {
  const { calls, executor } = createRecordingExecutor('shard_1');

  const response = await executeStudioHostBffRequest({
    executor,
    request: { procedure: 'transaction', queries: [query('a'), query('b')] },
  });

  assert.deepEqual(calls, [{ kind: 'transaction', count: 2 }]);
  assert.equal(response.status, 200);

  const withoutTransactions = await executeStudioHostBffRequest({
    executor: { async execute() { return [null, []]; } },
    request: { procedure: 'transaction', queries: [query('a')] },
  });

  assert.equal(withoutTransactions.status, 501);
});

test('malformed payloads are rejected before anything reaches the database', async () => {
  const { calls, executor } = createRecordingExecutor('shard_1');

  const cases = [
    { procedure: 'query' },
    { procedure: 'query', query: { sql: 'select 1' } },
    { procedure: 'sequence', sequence: [query('a')] },
    { procedure: 'transaction', queries: [] },
    { procedure: 'transaction', queries: ['drop table users'] },
    { procedure: 'sql-lint' },
    { procedure: 'nonsense' },
  ];

  for (const request of cases) {
    const response = await executeStudioHostBffRequest({ executor, request });
    assert.equal(response.status, 400, `rejected ${JSON.stringify(request)}`);
  }

  assert.deepEqual(calls, [], 'no database work was attempted');
});

test('query insights are refused explicitly rather than answered with empty data', async () => {
  const { executor } = createRecordingExecutor('shard_1');

  const response = await executeStudioHostBffRequest({
    executor,
    request: { procedure: 'query-insights', limit: 10 },
  });

  assert.equal(response.status, 501);
});

// ------------------------------------------------------------------ service

const createTestService = (options = {}) => {
  const executors = new Map();
  const disposed = [];

  const service = createStudioHostService({
    env: env(),
    projectRoot: '/projects/demo',
    schemaPath: '/projects/demo/prisma/schema.prisma',
    createConnection: async (target) => {
      const recording = createRecordingExecutor(target.id);
      executors.set(target.id, recording);
      return {
        executor: recording.executor,
        dispose: async () => { disposed.push(target.id); },
      };
    },
    ...options,
  });

  return { service, executors, disposed };
};

test('the shard identifier is read from the payload or the header, and conflicts are refused', () => {
  assert.equal(
    readRequestedShardId({ procedure: 'query', customPayload: { shardId: 'shard_2' } }).shardId,
    'shard_2'
  );
  assert.equal(
    readRequestedShardId({ procedure: 'query' }, { headers: { 'x-prisma-shard-id': 'shard_2' } })
      .shardId,
    'shard_2'
  );
  assert.equal(
    readRequestedShardId(
      { procedure: 'query', customPayload: { shardId: 'shard_1' } },
      { headers: { 'x-prisma-shard-id': 'shard_2' } }
    ).conflict,
    true
  );
});

test('a request without a shard, or naming an unknown shard, never reaches a database', async () => {
  const { service, executors } = createTestService();

  const missing = await service.handleBffRequest({ procedure: 'query', query: query('select 1') });
  assert.equal(missing.status, 400);

  const unknown = await service.handleBffRequest({
    procedure: 'query',
    query: query('select 1'),
    customPayload: { shardId: 'shard_99' },
  });
  assert.equal(unknown.status, 404);

  assert.equal(executors.size, 0, 'no connection was opened');
  assert.deepEqual(service.openShardIds, []);

  await service.dispose();
});

test('a client cannot smuggle its own connection target into a request', async () => {
  const { service, executors } = createTestService();

  const injected = [
    { shardId: 'shard_1', url: 'postgresql://attacker@evil:5432/db' },
    { shardId: 'shard_1', connectionString: 'postgresql://attacker@evil:5432/db' },
    { shardId: 'shard_1', tenant: 'postgresql://attacker@evil:5432/db' },
  ];

  for (const customPayload of injected) {
    const response = await service.handleBffRequest({
      procedure: 'query',
      query: query('select 1'),
      customPayload,
    });

    assert.equal(response.status, 400, JSON.stringify(customPayload));
  }

  assert.equal(executors.size, 0);
  await service.dispose();
});

test('each request is routed to exactly one validated shard', async () => {
  const { service, executors } = createTestService();

  await service.handleBffRequest({
    procedure: 'query',
    query: query('select 1'),
    customPayload: { shardId: 'shard_1' },
  });
  await service.handleBffRequest({
    procedure: 'query',
    query: query('select 2'),
    customPayload: { shardId: 'shard_2' },
  });

  assert.deepEqual(
    executors.get('shard_1').calls.map((call) => call.sql),
    ['select 1'],
    'shard_1 only ran its own query'
  );
  assert.deepEqual(
    executors.get('shard_2').calls.map((call) => call.sql),
    ['select 2'],
    'shard_2 only ran its own query'
  );

  await service.dispose();
});

test('authorization runs before database execution and a throwing authorizer denies', async () => {
  const seen = [];
  const { service, executors } = createTestService({
    authorize: (input) => {
      seen.push(input);
      return input.shardId === 'shard_1';
    },
  });

  const allowed = await service.handleBffRequest({
    procedure: 'query',
    query: query('select 1'),
    customPayload: { shardId: 'shard_1' },
  });
  const denied = await service.handleBffRequest({
    procedure: 'query',
    query: query('select 1'),
    customPayload: { shardId: 'shard_2' },
  });

  assert.equal(allowed.status, 200);
  assert.equal(denied.status, 403);
  assert.equal(executors.has('shard_2'), false, 'a denied shard is never connected to');
  assert.deepEqual(seen.map((input) => input.procedure), ['query', 'query']);

  await service.dispose();

  const throwing = createTestService({
    authorize: () => {
      throw new Error('auth backend down');
    },
  });

  const failure = await throwing.service.handleBffRequest({
    procedure: 'query',
    query: query('select 1'),
    customPayload: { shardId: 'shard_1' },
  });

  assert.equal(failure.status, 500, 'a failing authorizer denies rather than allows');
  assert.equal(throwing.executors.size, 0);

  await throwing.service.dispose();
});

test('two services for different projects never share an identity', () => {
  const a = createStudioHostService({
    env: env(),
    projectRoot: '/projects/a',
    schemaPath: '/projects/a/prisma/schema.prisma',
    createConnection: async () => ({ executor: {}, dispose: async () => undefined }),
  });
  const b = createStudioHostService({
    env: env(),
    projectRoot: '/projects/b',
    schemaPath: '/projects/b/prisma/schema.prisma',
    createConnection: async () => ({ executor: {}, dispose: async () => undefined }),
  });
  const differentShards = createStudioHostService({
    env: env({ SHARD_COUNT: '1' }),
    projectRoot: '/projects/a',
    schemaPath: '/projects/a/prisma/schema.prisma',
    createConnection: async () => ({ executor: {}, dispose: async () => undefined }),
  });

  assert.notEqual(a.fingerprint, b.fingerprint, 'same shard names, different projects');
  assert.notEqual(a.fingerprint, differentShards.fingerprint, 'a changed shard set is a new host');
  assert.doesNotMatch(a.fingerprint, /secret1|secret2/);
});

test('a service refuses to start when the project configures no databases', () => {
  assert.throws(
    () =>
      createStudioHostService({
        env: {},
        createConnection: async () => ({ executor: {}, dispose: async () => undefined }),
      }),
    /No databases configured/
  );
});

test('shard availability is probed on demand and reported without leaking details', async () => {
  const { service } = createTestService({
    createConnection: async (target) => {
      if (target.id === 'shard_2') {
        throw new Error(`connect ECONNREFUSED for ${SHARD_2_URL}`);
      }

      return {
        executor: { async execute() { return [null, [{ '?column?': 1 }]]; } },
        dispose: async () => undefined,
      };
    },
  });

  assert.deepEqual(await service.checkShard('shard_1'), { status: 'available' });

  const unhealthy = await service.checkShard('shard_2');
  assert.equal(unhealthy.status, 'unavailable');
  assert.doesNotMatch(unhealthy.message, /secret2|db-b\.internal/);

  const unknown = await service.checkShard('shard_99');
  assert.equal(unknown.status, 'unavailable');

  // One shard failing must leave the healthy one usable.
  const stillWorks = await service.handleBffRequest({
    procedure: 'query',
    query: query('select 1'),
    customPayload: { shardId: 'shard_1' },
  });
  assert.equal(stillWorks.status, 200);

  await service.dispose();
});

test('disposing the service closes every connection it opened', async () => {
  const { service, disposed } = createTestService();

  await service.handleBffRequest({
    procedure: 'query',
    query: query('select 1'),
    customPayload: { shardId: 'shard_1' },
  });
  await service.handleBffRequest({
    procedure: 'query',
    query: query('select 1'),
    customPayload: { shardId: 'shard_2' },
  });

  assert.equal(service.openShardIds.length, 2);

  await service.dispose();

  assert.deepEqual(service.openShardIds, []);
  assert.deepEqual(disposed.sort(), ['shard_1', 'shard_2']);
});

test('repeated switching between shards does not leak connections', async () => {
  const { service, disposed } = createTestService({ maxOpenConnections: 1 });

  for (let i = 0; i < 20; i++) {
    await service.handleBffRequest({
      procedure: 'query',
      query: query(`select ${i}`),
      customPayload: { shardId: i % 2 === 0 ? 'shard_1' : 'shard_2' },
    });
  }

  assert.ok(service.openShardIds.length <= 1, 'the bound holds under rapid switching');
  assert.ok(disposed.length >= 1, 'superseded connections were actually closed');

  await service.dispose();
  assert.deepEqual(service.openShardIds, []);
});
