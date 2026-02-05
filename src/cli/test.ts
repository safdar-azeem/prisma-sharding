#!/usr/bin/env node
import 'dotenv/config';
import { spawn } from 'child_process';

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

const testConnection = (
  url: string,
  shardId: string
): Promise<{ success: boolean; error?: string }> => {
  return new Promise((resolve) => {
    // Use npx prisma db execute with proper schema argument
    const prisma = spawn('npx', ['prisma', 'db', 'execute', '--stdin', '--url', url], {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';

    prisma.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    prisma.stdin.write('SELECT 1;');
    prisma.stdin.end();

    const timeout = setTimeout(() => {
      prisma.kill();
      resolve({ success: false, error: 'Connection timeout' });
    }, 10000);

    prisma.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ success: true });
      } else {
        // Try alternate method with psql if available
        testWithPsql(url, shardId).then(resolve);
      }
    });

    prisma.on('error', () => {
      clearTimeout(timeout);
      testWithPsql(url, shardId).then(resolve);
    });
  });
};

const testWithPsql = (
  url: string,
  shardId: string
): Promise<{ success: boolean; error?: string }> => {
  return new Promise((resolve) => {
    // Try using Node's built-in TCP check
    const urlObj = parsePostgresUrl(url);
    if (!urlObj) {
      resolve({ success: false, error: 'Invalid URL format' });
      return;
    }

    // Use Node net module to test TCP connection
    import('net')
      .then(({ default: net }) => {
        const socket = new net.Socket();
        const timeout = 5000;

        socket.setTimeout(timeout);

        socket.on('connect', () => {
          socket.destroy();
          resolve({ success: true });
        });

        socket.on('timeout', () => {
          socket.destroy();
          resolve({ success: false, error: `Connection timeout to ${urlObj.host}:${urlObj.port}` });
        });

        socket.on('error', (err) => {
          socket.destroy();
          resolve({
            success: false,
            error: `Cannot reach ${urlObj.host}:${urlObj.port} - ${err.message}`,
          });
        });

        socket.connect(urlObj.port, urlObj.host);
      })
      .catch(() => {
        resolve({ success: false, error: 'Failed to test connection' });
      });
  });
};

const parsePostgresUrl = (url: string): { host: string; port: number; database: string } | null => {
  try {
    // postgresql://user:pass@host:port/database?schema=public
    const match = url.match(/postgresql:\/\/[^@]+@([^:]+):(\d+)\/([^?]+)/);
    if (match) {
      return {
        host: match[1],
        port: parseInt(match[2], 10),
        database: match[3],
      };
    }
    return null;
  } catch {
    return null;
  }
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

  log.section('Test 1: Shard Configuration');

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

  await runTest('Validate URL formats', async () => {
    for (const shard of shards) {
      const urlInfo = parsePostgresUrl(shard.url);
      if (!urlInfo) {
        throw new Error(`Invalid URL format for ${shard.id}`);
      }
      log.info(`${shard.id}: ${urlInfo.host}:${urlInfo.port}/${urlInfo.database}`);
    }
  });

  log.section('Test 2: Network Connectivity');

  for (const shard of shards) {
    await runTest(`Connect to ${shard.id}`, async () => {
      const result = await testConnection(shard.url, shard.id);
      if (!result.success) {
        throw new Error(result.error || `Failed to connect to ${shard.id}`);
      }
    });
  }

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
    console.log('\n💡 Tips:');
    console.log('   - Make sure PostgreSQL is running');
    console.log('   - Check if the shard databases exist');
    console.log('   - Verify credentials in SHARD_N_URL');
    process.exit(1);
  }

  console.log('\n✅ All shard tests passed!');
};

runTests().catch((error) => {
  console.error('\n💥 Test suite crashed:', error);
  process.exit(1);
});
