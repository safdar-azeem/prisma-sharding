#!/usr/bin/env node
import 'dotenv/config';
import { spawn } from 'child_process';
import path from 'path';

interface TestResult {
  name: string;
  passed: boolean;
  message: string;
  duration: number;
}

const results: TestResult[] = [];

const log = {
  info: (msg: string) => console.log(`ℹ️  ${msg}`),
  success: (msg: string) => console.log(`✅ ${msg}`),
  error: (msg: string) => console.log(`❌ ${msg}`),
  warn: (msg: string) => console.log(`⚠️  ${msg}`),
  section: (msg: string) => console.log(`\n${'='.repeat(50)}\n📋 ${msg}\n${'='.repeat(50)}`),
};

const getShardConfigs = (): Array<{ id: string; url: string }> => {
  const shards: Array<{ id: string; url: string }> = [];
  const shardCount = parseInt(process.env.SHARD_COUNT || '0', 10);

  for (let i = 1; i <= shardCount; i++) {
    const url = process.env[`SHARD_${i}_URL`];
    if (url) {
      shards.push({ id: `shard_${i}`, url });
    }
  }

  if (shards.length === 0 && process.env.DATABASE_URL) {
    shards.push({ id: 'shard_1', url: process.env.DATABASE_URL });
  }

  return shards;
};

const runTest = async (name: string, testFn: () => Promise<void>): Promise<void> => {
  const start = Date.now();
  try {
    await testFn();
    const duration = Date.now() - start;
    results.push({ name, passed: true, message: 'Passed', duration });
    log.success(`${name} (${duration}ms)`);
  } catch (error) {
    const duration = Date.now() - start;
    const message = error instanceof Error ? error.message : String(error);
    results.push({ name, passed: false, message, duration });
    log.error(`${name}: ${message}`);
  }
};

const testConnection = (url: string): Promise<boolean> => {
  return new Promise((resolve) => {
    const prisma = spawn('npx', ['prisma', 'db', 'execute', '--url', url, '--stdin'], {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    prisma.stdin.write('SELECT 1');
    prisma.stdin.end();

    prisma.on('close', (code) => {
      resolve(code === 0);
    });

    prisma.on('error', () => {
      resolve(false);
    });
  });
};

const runTests = async (): Promise<void> => {
  const shards = getShardConfigs();

  console.log('\n🧪 prisma-sharding: Shard Connection Test Suite\n');
  console.log(`📊 Configuration:`);
  console.log(`   - Shard Count: ${shards.length}`);
  console.log(`   - Routing Strategy: ${process.env.SHARD_ROUTING_STRATEGY || 'modulo'}`);

  if (shards.length === 0) {
    console.error(
      '\n❌ No shards configured. Set SHARD_COUNT and SHARD_N_URL environment variables.'
    );
    process.exit(1);
  }

  log.section('Test 1: Shard Connection Tests');

  for (const shard of shards) {
    await runTest(`Connect to ${shard.id}`, async () => {
      const success = await testConnection(shard.url);
      if (!success) {
        throw new Error(`Failed to connect to ${shard.id}`);
      }
    });
  }

  log.section('Test 2: Configuration Verification');

  await runTest('Verify environment variables', async () => {
    const shardCount = parseInt(process.env.SHARD_COUNT || '0', 10);
    if (shardCount === 0 && !process.env.DATABASE_URL) {
      throw new Error('SHARD_COUNT or DATABASE_URL must be set');
    }
    log.info(`SHARD_COUNT: ${shardCount}`);
    log.info(`Routing Strategy: ${process.env.SHARD_ROUTING_STRATEGY || 'modulo'}`);
  });

  await runTest('Verify all shard URLs are present', async () => {
    const shardCount = parseInt(process.env.SHARD_COUNT || '0', 10);
    for (let i = 1; i <= shardCount; i++) {
      const url = process.env[`SHARD_${i}_URL`];
      if (!url) {
        throw new Error(`SHARD_${i}_URL is missing`);
      }
    }
  });

  log.section('Test Results Summary');

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

  console.log(`\n   Total Tests: ${results.length}`);
  console.log(`   Passed: ${passed}`);
  console.log(`   Failed: ${failed}`);
  console.log(`   Duration: ${totalDuration}ms`);

  if (failed > 0) {
    console.log('\n   Failed Tests:');
    results
      .filter((r) => !r.passed)
      .forEach((r) => {
        console.log(`     - ${r.name}: ${r.message}`);
      });
    process.exit(1);
  }

  console.log('\n✅ All shard tests passed!');
};

runTests().catch((error) => {
  console.error('\n💥 Test suite crashed:', error);
  process.exit(1);
});
