const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const packageJson = require('../package.json');
const library = require(path.resolve(__dirname, '../dist/index.js'));

const PUBLIC_METHODS = [
  'connect',
  'disconnect',
  'isConnected',
  'getShard',
  'getShardById',
  'getShardWithInfo',
  'getRandomShard',
  'getRandomShardWithInfo',
  'findFirst',
  'runOnAll',
  'runOnAllWithDetails',
  'getHealth',
  'getHealthByShard',
  'getAllClients',
  'getHealthyClients',
  'getShardCount',
  'getShardIds',
];

const EXPECTED_BINARIES = {
  'prisma-sharding-update': './dist/cli/update.js',
  'prisma-sharding-migrate': './dist/cli/migrate.js',
  'prisma-sharding-baseline': './dist/cli/baseline.js',
  'prisma-sharding-push': './dist/cli/push.js',
  'prisma-sharding-studio': './dist/cli/studio.js',
  'prisma-sharding-test': './dist/cli/test.js',
};

const createClient = (shardId) => ({
  shardId,
  $queryRaw: async () => 1,
  $disconnect: async () => undefined,
});

test('package entry points, CLI names, and existing exports remain compatible', () => {
  assert.equal(packageJson.main, 'dist/index.js');
  assert.equal(packageJson.module, 'dist/index.mjs');
  assert.equal(packageJson.types, 'dist/index.d.ts');
  assert.deepEqual(packageJson.bin, EXPECTED_BINARIES);

  assert.deepEqual(Object.keys(library).sort(), [
    'ConfigError',
    'ConnectionError',
    'DEFAULTS',
    'ERROR_MESSAGES',
    'PrismaSharding',
    'RoutingError',
    'ShardingError',
    'createDefaultLogger',
    'hashString',
    'validateUrl',
  ]);
  assert.deepEqual(library.DEFAULTS, {
    POOL_MAX_CONNECTIONS: 10,
    POOL_IDLE_TIMEOUT_MS: 10000,
    POOL_CONNECTION_TIMEOUT_MS: 5000,
    HEALTH_CHECK_INTERVAL_MS: 30000,
    CIRCUIT_BREAKER_THRESHOLD: 3,
    CONSISTENT_HASH_VIRTUAL_NODES: 150,
  });
});

test('public method names and return shapes remain compatible', async () => {
  const clients = new Map();
  const sharding = new library.PrismaSharding({
    shards: [
      { id: 'shard_1', url: 'postgresql://test:test@localhost/one' },
      { id: 'shard_2', url: 'postgresql://test:test@localhost/two' },
    ],
    createClient: (_url, shardId) => {
      const client = createClient(shardId);
      clients.set(shardId, client);
      return client;
    },
  });

  for (const method of PUBLIC_METHODS) {
    assert.equal(typeof sharding[method], 'function', `${method} must remain public`);
  }

  assert.equal(sharding.isConnected(), false);
  assert.equal(await sharding.connect(), undefined);
  assert.equal(sharding.isConnected(), true);
  assert.equal(sharding.getShardCount(), 2);
  assert.deepEqual(sharding.getShardIds(), ['shard_1', 'shard_2']);
  assert.deepEqual(sharding.getAllClients(), [clients.get('shard_1'), clients.get('shard_2')]);
  assert.deepEqual(sharding.getHealthyClients(), [
    clients.get('shard_1'),
    clients.get('shard_2'),
  ]);
  assert.equal(sharding.getShardById('shard_1'), clients.get('shard_1'));
  assert.equal(typeof sharding.getShard('compatibility-key').shardId, 'string');

  const shardWithInfo = sharding.getShardWithInfo('compatibility-key');
  assert.deepEqual(Object.keys(shardWithInfo).sort(), ['client', 'shardId']);
  assert.equal(typeof shardWithInfo.shardId, 'string');

  const randomClient = sharding.getRandomShard();
  assert.ok(clients.has(randomClient.shardId));
  const randomWithInfo = sharding.getRandomShardWithInfo();
  assert.deepEqual(Object.keys(randomWithInfo).sort(), ['client', 'shardId']);
  assert.equal(randomWithInfo.client, clients.get(randomWithInfo.shardId));

  const found = await sharding.findFirst(async (client) =>
    client.shardId === 'shard_2' ? { id: 'found' } : null
  );
  assert.deepEqual(Object.keys(found).sort(), ['client', 'result', 'shardId']);
  assert.deepEqual(found.result, { id: 'found' });
  assert.equal(found.shardId, 'shard_2');
  assert.equal(found.client, clients.get('shard_2'));

  const notFound = await sharding.findFirst(async () => null);
  assert.deepEqual(notFound, { result: null, shardId: null, client: null });

  const all = await sharding.runOnAll(async (_client, shardId) =>
    shardId === 'shard_1' ? shardId : null
  );
  assert.deepEqual(all, ['shard_1']);

  const detailed = await sharding.runOnAllWithDetails(async (_client, shardId) => shardId);
  assert.deepEqual(
    detailed.map((result) => Object.keys(result).sort()),
    [
      ['error', 'result', 'shardId'],
      ['error', 'result', 'shardId'],
    ]
  );

  const health = sharding.getHealth();
  assert.equal(health.length, 2);
  assert.deepEqual(Object.keys(health[0]).sort(), [
    'consecutiveFailures',
    'errorCount',
    'isHealthy',
    'lastChecked',
    'latencyMs',
    'shardId',
  ]);
  assert.equal(sharding.getHealthByShard('missing'), undefined);

  assert.equal(await sharding.disconnect(), undefined);
  assert.equal(sharding.isConnected(), false);
});
