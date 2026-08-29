/**
 * Type-compatibility fixture for prisma-sharding public API contracts.
 *
 * This file is compiled by `tsc -p tsconfig.typecheck-compat.json`, which is
 * invoked as part of the `yarn typecheck` script. It validates that the
 * package's published declaration surface (`dist/index.d.ts`) exports all
 * required types with structurally correct signatures.
 *
 * If this file fails to compile, the public API contract has been broken.
 *
 * This file is NOT executed at runtime — it is compile-only. The build must
 * complete (`yarn build`) before running `yarn typecheck` so that `dist/`
 * declarations exist.
 */

import type {
  ShardHealth,
  ShardInspection,
  ShardFindResult,
  ShardRunResult,
  FindFirstResult,
  CrossShardResult,
  ShardResult,
  ShardConfig,
  ShardingConfig,
  ShardHealthStatus,
} from '../dist';

import { PrismaSharding } from '../dist';

// ---------------------------------------------------------------------------
// Helper: compile-time assignability assertion
// ---------------------------------------------------------------------------
type AssertAssignable<_T extends U, U> = true;

// ---------------------------------------------------------------------------
// 1. ShardHealth — backward-compatible v1.3.0 contract
// ---------------------------------------------------------------------------
type _ShardHealthCheck = AssertAssignable<
  ShardHealth,
  {
    shardId: string;
    isHealthy: boolean;
    latencyMs: number;
    lastChecked: Date;
    errorCount: number;
    consecutiveFailures: number;
  }
>;

// Verify individual field types by assignment
declare const health: ShardHealth;
const _healthShardId: string = health.shardId;
const _healthIsHealthy: boolean = health.isHealthy;
const _healthLatencyMs: number = health.latencyMs;
const _healthLastChecked: Date = health.lastChecked;
const _healthErrorCount: number = health.errorCount;
const _healthConsecutiveFailures: number = health.consecutiveFailures;

// ---------------------------------------------------------------------------
// 2. ShardInspection — canonical inspectShards() contract
// ---------------------------------------------------------------------------
type _ShardInspectionCheck = AssertAssignable<
  ShardInspection,
  {
    shardId: string;
    status: ShardHealthStatus;
    latencyMs: number | null;
  }
>;

declare const inspection: ShardInspection;
const _inspShardId: string = inspection.shardId;
const _inspStatus: 'healthy' | 'unhealthy' | 'unknown' = inspection.status;
const _inspLatencyMs: number | null = inspection.latencyMs;

// ---------------------------------------------------------------------------
// 3. ShardFindResult — canonical findAcrossShards() contract
// ---------------------------------------------------------------------------
type _ShardFindResultCheck = AssertAssignable<
  ShardFindResult<{ id: string }, { $queryRaw: () => void }>,
  {
    data: { id: string } | null;
    shardId: string | null;
    client: { $queryRaw: () => void } | null;
  }
>;

declare const findResult: ShardFindResult<{ id: string }, { $queryRaw: () => void }>;
const _findData: { id: string } | null = findResult.data;
const _findShardId: string | null = findResult.shardId;
const _findClient: { $queryRaw: () => void } | null = findResult.client;

// ---------------------------------------------------------------------------
// 4. ShardRunResult — canonical runAcrossShards() contract
// ---------------------------------------------------------------------------
type _ShardRunResultCheck = AssertAssignable<
  ShardRunResult<number>,
  {
    shardId: string;
    data: number | null;
    error: Error | null;
  }
>;

declare const runResult: ShardRunResult<number>;
const _runShardId: string = runResult.shardId;
const _runData: number | null = runResult.data;
const _runError: Error | null = runResult.error;

// ---------------------------------------------------------------------------
// 5. FindFirstResult — legacy findFirst() contract
// ---------------------------------------------------------------------------
type _FindFirstResultCheck = AssertAssignable<
  FindFirstResult<{ id: string }, { $queryRaw: () => void }>,
  {
    result: { id: string } | null;
    shardId: string | null;
    client: { $queryRaw: () => void } | null;
  }
>;

declare const findFirstResult: FindFirstResult<{ id: string }, { $queryRaw: () => void }>;
const _ffResult: { id: string } | null = findFirstResult.result;
const _ffShardId: string | null = findFirstResult.shardId;
const _ffClient: { $queryRaw: () => void } | null = findFirstResult.client;

// ---------------------------------------------------------------------------
// 6. CrossShardResult — legacy runOnAllWithDetails() contract
// ---------------------------------------------------------------------------
type _CrossShardResultCheck = AssertAssignable<
  CrossShardResult<string>,
  {
    shardId: string;
    result: string | null;
    error?: Error;
  }
>;

declare const crossResult: CrossShardResult<string>;
const _csShardId: string = crossResult.shardId;
const _csResult: string | null = crossResult.result;
const _csError: Error | undefined = crossResult.error;

// ---------------------------------------------------------------------------
// 7. ShardResult — legacy getShardWithInfo() / getRandomShardWithInfo() contract
// ---------------------------------------------------------------------------
type _ShardResultCheck = AssertAssignable<
  ShardResult<{ $queryRaw: () => void }>,
  {
    shardId: string;
    client: { $queryRaw: () => void };
  }
>;

// ---------------------------------------------------------------------------
// 8. PrismaSharding — verify canonical method signatures compile
// ---------------------------------------------------------------------------
type MockClient = {
  $connect: () => Promise<void>;
  $disconnect: () => Promise<void>;
  $queryRaw: (query: unknown) => Promise<unknown>;
};

declare const sharding: PrismaSharding<MockClient>;

// Lifecycle
async function _testLifecycle() {
  const _connectResult: void = await sharding.connect();
  const _disconnectResult: void = await sharding.disconnect();
  const _isConnected: boolean = sharding.isConnected();
}

// Canonical single-shard
async function _testCanonicalSingleShard() {
  const _allocated: MockClient = await sharding.allocateShard('key');
  const _resolved: MockClient = await sharding.resolveShard('key');
  const _selected: MockClient = sharding.selectShard('shard_1');
  const _random: MockClient = sharding.randomShard();
}

// Canonical multi-shard
async function _testCanonicalMultiShard() {
  const found: ShardFindResult<{ id: string }, MockClient> =
    await sharding.findAcrossShards(async (client) => {
      void client;
      return { id: '1' } as { id: string } | null;
    });
  const _foundData: { id: string } | null = found.data;

  const results: ShardRunResult<number>[] =
    await sharding.runAcrossShards(async (_client, _shardId) => 42);
  const _firstResult: ShardRunResult<number> = results[0];
}

// Canonical inspection
function _testCanonicalInspection() {
  const inspections: ShardInspection[] = sharding.inspectShards();
  const _firstInspection: ShardInspection = inspections[0];
}

// Legacy single-shard
function _testLegacySingleShard() {
  const _legacy: MockClient = sharding.getShard('key');
  const _legacyById: MockClient = sharding.getShardById('shard_1');
  const _legacyWithInfo: ShardResult<MockClient> = sharding.getShardWithInfo('key');
  const _legacyRandom: MockClient = sharding.getRandomShard();
  const _legacyRandomInfo: ShardResult<MockClient> = sharding.getRandomShardWithInfo();
}

// Legacy multi-shard
async function _testLegacyMultiShard() {
  const ff: FindFirstResult<{ id: string }, MockClient> =
    await sharding.findFirst(async () => ({ id: '1' } as { id: string } | null));
  const _ffResult2: { id: string } | null = ff.result;

  const _runAll: number[] = await sharding.runOnAll(async () => 42);
  const _runAllDetailed: CrossShardResult<number>[] =
    await sharding.runOnAllWithDetails(async () => 42);
}

// Legacy health — must return ShardHealth (not ShardInspection)
function _testLegacyHealth() {
  const allHealth: ShardHealth[] = sharding.getHealth();
  const _firstHealth: ShardHealth = allHealth[0];
  const _byShardHealth: ShardHealth | undefined = sharding.getHealthByShard('shard_1');

  // Verify ShardHealth is assignable to the v1.3.0 contract shape
  if (_byShardHealth) {
    const _h: {
      shardId: string;
      isHealthy: boolean;
      latencyMs: number;
      lastChecked: Date;
      errorCount: number;
      consecutiveFailures: number;
    } = _byShardHealth;
  }
}

// Suppress unused warnings — this file is compile-only
void [
  _healthShardId, _healthIsHealthy, _healthLatencyMs, _healthLastChecked,
  _healthErrorCount, _healthConsecutiveFailures,
  _inspShardId, _inspStatus, _inspLatencyMs,
  _findData, _findShardId, _findClient,
  _runShardId, _runData, _runError,
  _ffResult, _ffShardId, _ffClient,
  _csShardId, _csResult, _csError,
  _testLifecycle, _testCanonicalSingleShard, _testCanonicalMultiShard,
  _testCanonicalInspection, _testLegacySingleShard, _testLegacyMultiShard,
  _testLegacyHealth,
];
