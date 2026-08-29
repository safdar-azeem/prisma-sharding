const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const library = require(path.resolve(__dirname, '../dist/index.js'));

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate, timeoutMs = 1000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await delay(5);
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
};

const runNodeScript = (script, timeoutMs = 1500) =>
  new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, ['-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stderr, timedOut, duration: Date.now() - startedAt });
    });
  });

const shardConfigs = (ids) =>
  ids.map((id) => ({ id, url: `postgresql://test:test@localhost/${id}` }));

const createHealthyClient = (shardId) => ({
  shardId,
  $connect: async () => undefined,
  $queryRaw: async () => 1,
  $disconnect: async () => undefined,
});

const createSharding = (ids, overrides = {}) =>
  new library.PrismaSharding({
    shards: shardConfigs(ids),
    createClient: (_url, shardId) => createHealthyClient(shardId),
    logger: silentLogger,
    ...overrides,
  });

test('modulo routing keeps the existing hash placement, including an empty key', async () => {
  const ids = ['shard_1', 'shard_2', 'shard_3'];
  const sharding = createSharding(ids);
  await sharding.connect();

  try {
    for (const key of ['', 'alpha', 'user-123', 'tenant:west']) {
      const expected = ids[library.hashString(key) % ids.length];
      assert.equal(sharding.getShardWithInfo(key).shardId, expected);
      assert.equal(sharding.getShardWithInfo(key).shardId, expected);
    }
  } finally {
    await sharding.disconnect();
  }
});

test('consistent hashing supports custom and non-sequential shard IDs deterministically', async () => {
  for (const ids of [
    ['shard_1', 'shard_2', 'shard_3'],
    ['tenant-east', 'tenant-west', 'primary-eu'],
    ['shard_2', 'shard_9', 'archive'],
  ]) {
    const sharding = createSharding(ids, { strategy: 'consistent-hash' });
    await sharding.connect();

    try {
      const keys = Array.from({ length: 500 }, (_, index) =>
        index === 0
          ? ''
          : `${index.toString(36)}:${((index * 2654435761) >>> 0).toString(16)}:${'x'.repeat(index % 31)}`
      );
      const firstMappings = keys.map((key) => sharding.getShardWithInfo(key).shardId);
      const repeatedMappings = keys.map((key) => sharding.getShardWithInfo(key).shardId);

      assert.deepEqual(repeatedMappings, firstMappings);
      assert.ok(firstMappings.every((shardId) => ids.includes(shardId)));
      if (!ids.every((id) => /^shard_[1-3]$/.test(id))) {
        assert.ok(new Set(firstMappings).size > 1);
      }
    } finally {
      await sharding.disconnect();
    }
  }
});

test('weight affects random assignment only and does not alter deterministic routing', async () => {
  const sharding = createSharding(['light', 'heavy'], {
    shards: [
      { id: 'light', url: 'postgresql://test:test@localhost/light', weight: 1 },
      { id: 'heavy', url: 'postgresql://test:test@localhost/heavy', weight: 3 },
    ],
  });
  await sharding.connect();
  const originalRandom = Math.random;

  try {
    const deterministicBefore = sharding.getShardWithInfo('stable-key').shardId;
    Math.random = () => 0.1;
    assert.equal(sharding.getRandomShardWithInfo().shardId, 'light');
    Math.random = () => 0.3;
    assert.equal(sharding.getRandomShardWithInfo().shardId, 'heavy');
    assert.equal(sharding.getShardWithInfo('stable-key').shardId, deterministicBefore);
  } finally {
    Math.random = originalRandom;
    await sharding.disconnect();
  }
});

test('configuration validation rejects ambiguous or unsafe values', () => {
  const validShard = {
    id: 'shard_1',
    url: 'postgresql://test:test@localhost/one',
  };
  const factory = () => createHealthyClient('shard_1');
  const construct = (overrides) =>
    new library.PrismaSharding({
      shards: [validShard],
      createClient: factory,
      logger: silentLogger,
      ...overrides,
    });

  assert.throws(
    () => construct({ shards: [validShard, validShard] }),
    /Duplicate shard ID/
  );
  assert.throws(
    () => construct({ shards: [{ ...validShard, id: '  ' }] }),
    /must not be empty/
  );
  assert.throws(
    () => construct({ shards: [{ ...validShard, weight: 0 }] }),
    /Weight.*must be positive/
  );
  assert.throws(() => construct({ healthCheckIntervalMs: 0 }), /must be positive/);
  assert.throws(() => construct({ circuitBreakerThreshold: -1 }), /must be positive/);
  assert.throws(() => construct({ createClient: null }), /createClient function is required/);
  assert.throws(() => construct({ strategy: 'random' }), /Invalid routing strategy/);
});

test('partial initialization failure disconnects clients that were already created', async () => {
  let disconnectCalls = 0;
  const sharding = new library.PrismaSharding({
    shards: shardConfigs(['shard_1', 'shard_2']),
    createClient: (_url, shardId) => {
      if (shardId === 'shard_2') {
        throw new Error('factory failed');
      }
      return {
        $disconnect: async () => {
          disconnectCalls++;
        },
      };
    },
    logger: silentLogger,
  });

  await assert.rejects(sharding.connect(), /Failed to initialize shard shard_2/);
  assert.equal(disconnectCalls, 1);
  assert.equal(sharding.isConnected(), false);
});

test('cross-shard execution is bounded and preserves configured result order', async () => {
  const ids = Array.from({ length: 7 }, (_, index) => `shard_${index + 1}`);
  const sharding = createSharding(ids);
  await sharding.connect();
  let active = 0;
  let maximumActive = 0;

  try {
    const results = await sharding.runOnAll(async (_client, shardId) => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await delay(shardId === 'shard_1' ? 40 : 10);
      active--;
      return shardId;
    });

    assert.ok(maximumActive <= 4);
    assert.deepEqual(results, ids);
  } finally {
    await sharding.disconnect();
  }
});

test('findFirst resolves on the first non-null result without waiting for slow shards', async () => {
  const sharding = createSharding(['slow-first', 'fast-result', 'slow-last']);
  await sharding.connect();
  const startedAt = Date.now();

  try {
    const found = await sharding.findFirst(async (client) => {
      if (client.shardId === 'fast-result') {
        await delay(25);
        return { id: 'found' };
      }
      await delay(250);
      return null;
    });

    assert.deepEqual(found.result, { id: 'found' });
    assert.equal(found.shardId, 'fast-result');
    assert.equal(found.client.shardId, 'fast-result');
    assert.ok(Date.now() - startedAt < 150);
  } finally {
    await sharding.disconnect();
  }
});

test('cross-shard failures and timeouts are isolated without changing result shapes', async () => {
  const sharding = createSharding(['ok', 'error', 'timeout']);
  await sharding.connect();

  try {
    const details = await sharding.runOnAllWithDetails(async (_client, shardId) => {
      if (shardId === 'error') {
        throw new Error('isolated failure');
      }
      if (shardId === 'timeout') {
        return new Promise(() => undefined);
      }
      return shardId;
    });

    assert.equal(details.length, 3);
    assert.deepEqual(details[0], { shardId: 'ok', result: 'ok', error: undefined });
    assert.match(details[1].error.message, /isolated failure/);
    assert.match(details[2].error.message, /timed out/);

    const successful = await sharding.runOnAll(async (_client, shardId) =>
      shardId === 'ok' ? shardId : null
    );
    assert.deepEqual(successful, ['ok']);
  } finally {
    await sharding.disconnect();
  }
});

test('cross-shard operation failures do not emit one warning per request', async () => {
  let warningCount = 0;
  const sharding = createSharding(['shard_1', 'shard_2'], {
    logger: {
      info: () => undefined,
      warn: () => {
        warningCount++;
      },
      error: () => undefined,
    },
  });
  await sharding.connect();

  try {
    await sharding.runOnAll(async () => {
      throw new Error('expected request failure');
    });
    assert.equal(warningCount, 0);
  } finally {
    await sharding.disconnect();
  }
});

test('a synchronous cross-shard throw does not leave a timeout timer alive', async () => {
  const script = `
    const { PrismaSharding } = require(${JSON.stringify(
      path.resolve(__dirname, '../dist/index.js')
    )});
    const sharding = new PrismaSharding({
      shards: [{ id: 'shard_1', url: 'postgresql://test:test@localhost/test' }],
      createClient: () => ({
        $queryRaw: async () => 1,
        $disconnect: async () => undefined,
      }),
      logger: { info() {}, warn() {}, error() {} },
    });
    (async () => {
      await sharding.connect();
      await sharding.runOnAll(() => { throw new Error('sync failure'); });
      await sharding.disconnect();
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `;
  const result = await runNodeScript(script);

  assert.equal(result.timedOut, false, result.stderr);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.duration < 1000);
});

test('connect warms clients and records initial health verification', async () => {
  let connectCalls = 0;
  let queryCalls = 0;
  const sharding = createSharding(['shard_1'], {
    createClient: () => ({
      $connect: async () => {
        connectCalls++;
      },
      $queryRaw: async () => {
        queryCalls++;
        return 1;
      },
      $disconnect: async () => undefined,
    }),
  });

  await sharding.connect();
  try {
    await waitFor(() => queryCalls === 1);
    assert.equal(connectCalls, 1);
    assert.equal(queryCalls, 1);
    assert.equal(sharding.getHealth()[0].isHealthy, true);
    assert.equal(sharding.getHealth()[0].consecutiveFailures, 0);
  } finally {
    await sharding.disconnect();
  }
});

test('connect does not block client availability on initial health warmup', async () => {
  let releaseConnect;
  const connectGate = new Promise((resolve) => {
    releaseConnect = resolve;
  });
  const sharding = createSharding(['shard_1'], {
    createClient: (_url, shardId) => ({
      shardId,
      $connect: async () => connectGate,
      $queryRaw: async () => 1,
      $disconnect: async () => undefined,
    }),
  });

  const connectedWithoutWarmup = await Promise.race([
    sharding.connect().then(() => true),
    delay(100).then(() => false),
  ]);

  assert.equal(connectedWithoutWarmup, true);
  assert.equal(sharding.isConnected(), true);
  assert.deepEqual(
    await sharding.runOnAll(async (client) => client.shardId),
    ['shard_1']
  );

  releaseConnect();
  await sharding.disconnect();
});

test('health failures are counted, recovery resets failures, and checks do not overlap', async () => {
  let queryCalls = 0;
  let active = 0;
  let maximumActive = 0;
  const sharding = createSharding(['shard_1'], {
    healthCheckIntervalMs: 5,
    circuitBreakerThreshold: 2,
    createClient: () => ({
      $connect: async () => undefined,
      $queryRaw: async () => {
        queryCalls++;
        active++;
        maximumActive = Math.max(maximumActive, active);
        await delay(20);
        active--;
        if (queryCalls <= 2) {
          throw new Error('temporary outage');
        }
        return 1;
      },
      $disconnect: async () => undefined,
    }),
  });

  await sharding.connect();
  await waitFor(() => sharding.getHealth()[0].errorCount === 1);
  assert.equal(sharding.getHealth()[0].isHealthy, false);
  assert.equal(sharding.getHealth()[0].errorCount, 1);

  await delay(75);
  const recoveredHealth = sharding.getHealth()[0];
  assert.equal(recoveredHealth.isHealthy, true);
  assert.equal(recoveredHealth.consecutiveFailures, 0);
  assert.ok(recoveredHealth.errorCount >= 2);
  assert.equal(maximumActive, 1);

  await sharding.disconnect();
  const callsAfterShutdown = queryCalls;
  await delay(30);
  assert.equal(queryCalls, callsAfterShutdown);
});

test('health checks time out and leave an unverified shard unhealthy', async () => {
  const sharding = createSharding(['shard_1'], {
    createClient: () => ({
      $connect: async () => undefined,
      $queryRaw: async () => new Promise(() => undefined),
      $disconnect: async () => undefined,
    }),
  });

  await sharding.connect();
  try {
    await waitFor(() => sharding.getHealth()[0].errorCount === 1, 5500);
    const health = sharding.getHealth()[0];
    assert.equal(health.isHealthy, false);
    assert.equal(health.errorCount, 1);
    assert.equal(health.latencyMs, -1);
  } finally {
    await sharding.disconnect();
  }
});

test('allocateShard and resolveShard return clients deterministically as promises', async () => {
  const ids = ['shard_1', 'shard_2', 'shard_3'];
  const sharding = createSharding(ids);
  await sharding.connect();

  try {
    for (const key of ['user_100', 'user_200', 'account_abc', 'tenant_xyz']) {
      const allocated = await sharding.allocateShard(key);
      const resolved = await sharding.resolveShard(key);
      const expectedShardId = ids[library.hashString(key) % ids.length];

      assert.equal(allocated.shardId, expectedShardId);
      assert.equal(resolved.shardId, expectedShardId);
      assert.equal(allocated, resolved);
    }
  } finally {
    await sharding.disconnect();
  }
});

test('selectShard returns the exact client synchronously and throws for unknown shard ID', async () => {
  const sharding = createSharding(['shard_1', 'shard_2']);
  await sharding.connect();

  try {
    const client1 = sharding.selectShard('shard_1');
    assert.equal(client1.shardId, 'shard_1');

    const client2 = sharding.selectShard('shard_2');
    assert.equal(client2.shardId, 'shard_2');

    assert.throws(
      () => sharding.selectShard('does-not-exist'),
      /Shard does-not-exist not found/
    );
  } finally {
    await sharding.disconnect();
  }
});

test('randomShard returns a client directly', async () => {
  const sharding = createSharding(['shard_1', 'shard_2']);
  await sharding.connect();

  try {
    const client = sharding.randomShard();
    assert.ok(client.shardId === 'shard_1' || client.shardId === 'shard_2');
    assert.equal(typeof client.$queryRaw, 'function');
  } finally {
    await sharding.disconnect();
  }
});

test('findAcrossShards returns data, shardId, and client or null values when not found', async () => {
  const sharding = createSharding(['shard_1', 'shard_2', 'shard_3']);
  await sharding.connect();

  try {
    const found = await sharding.findAcrossShards(async (client) => {
      if (client.shardId === 'shard_2') {
        return { id: 'item_123', name: 'Test' };
      }
      return null;
    });

    assert.deepEqual(found.data, { id: 'item_123', name: 'Test' });
    assert.equal(found.shardId, 'shard_2');
    assert.equal(found.client.shardId, 'shard_2');

    const notFound = await sharding.findAcrossShards(async () => null);
    assert.deepEqual(notFound, {
      data: null,
      shardId: null,
      client: null,
    });
  } finally {
    await sharding.disconnect();
  }
});

test('runAcrossShards returns structured results for every shard without dropping errors', async () => {
  const sharding = createSharding(['shard_1', 'shard_2', 'shard_3']);
  await sharding.connect();

  try {
    const results = await sharding.runAcrossShards(async (_client, shardId) => {
      if (shardId === 'shard_2') {
        throw new Error('shard 2 failed');
      }
      return `result-${shardId}`;
    });

    assert.equal(results.length, 3);

    assert.equal(results[0].shardId, 'shard_1');
    assert.equal(results[0].data, 'result-shard_1');
    assert.equal(results[0].error, null);

    assert.equal(results[1].shardId, 'shard_2');
    assert.equal(results[1].data, null);
    assert.match(results[1].error.message, /shard 2 failed/);

    assert.equal(results[2].shardId, 'shard_3');
    assert.equal(results[2].data, 'result-shard_3');
    assert.equal(results[2].error, null);
  } finally {
    await sharding.disconnect();
  }
});

test('inspectShards returns normalized public health shape with null latency for unhealthy shards', async () => {
  let failShard2 = false;
  const sharding = createSharding(['shard_1', 'shard_2'], {
    healthCheckIntervalMs: 5,
    circuitBreakerThreshold: 1,
    createClient: (_url, shardId) => ({
      shardId,
      $connect: async () => undefined,
      $queryRaw: async () => {
        if (shardId === 'shard_2' && failShard2) {
          throw new Error('shard_2 is down');
        }
        return 1;
      },
      $disconnect: async () => undefined,
    }),
  });

  await sharding.connect();
  try {
    const initialHealth = sharding.inspectShards();
    assert.equal(initialHealth.length, 2);
    assert.deepEqual(
      initialHealth.map((h) => ({ shardId: h.shardId, status: h.status })),
      [
        { shardId: 'shard_1', status: 'healthy' },
        { shardId: 'shard_2', status: 'healthy' },
      ]
    );
    assert.ok(initialHealth[0].latencyMs >= 0);

    failShard2 = true;
    await waitFor(() => sharding.getHealth()[1].isHealthy === false);

    const degradedHealth = sharding.inspectShards();
    assert.equal(degradedHealth[0].status, 'healthy');
    assert.ok(degradedHealth[0].latencyMs >= 0);

    assert.equal(degradedHealth[1].shardId, 'shard_2');
    assert.equal(degradedHealth[1].status, 'unhealthy');
    assert.equal(degradedHealth[1].latencyMs, null);
  } finally {
    await sharding.disconnect();
  }
});
