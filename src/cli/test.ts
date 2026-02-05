#!/usr/bin/env node
import 'dotenv/config';

interface TestResult {
  name: string;
  passed: boolean;
  message: string;
  duration: number;
}

interface TestUser {
  id: string;
  email: string;
  shardId: string;
}

const results: TestResult[] = [];
const testUsers: TestUser[] = [];
const TEST_USER_COUNT = 24;

const log = {
  info: (msg: string) => console.log(`ℹ️  ${msg}`),
  success: (msg: string) => console.log(`✅ ${msg}`),
  error: (msg: string) => console.log(`❌ ${msg}`),
  warn: (msg: string) => console.log(`⚠️  ${msg}`),
  section: (msg: string) => console.log(`\n${'='.repeat(60)}\n📋 ${msg}\n${'='.repeat(60)}`),
  detail: (msg: string) => console.log(`   ${msg}`),
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

const parsePostgresUrl = (
  url: string
): { host: string; port: number; database: string; user: string; password: string } | null => {
  try {
    // postgresql://user:pass@host:port/database?schema=public
    const match = url.match(/postgresql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/([^?]+)/);
    if (match) {
      return {
        user: match[1],
        password: match[2],
        host: match[3],
        port: parseInt(match[4], 10),
        database: match[5],
      };
    }
    return null;
  } catch {
    return null;
  }
};

const testTcpConnection = (host: string, port: number): Promise<boolean> => {
  return new Promise((resolve) => {
    import('net')
      .then(({ default: net }) => {
        const socket = new net.Socket();
        socket.setTimeout(5000);
        socket.on('connect', () => {
          socket.destroy();
          resolve(true);
        });
        socket.on('timeout', () => {
          socket.destroy();
          resolve(false);
        });
        socket.on('error', () => {
          socket.destroy();
          resolve(false);
        });
        socket.connect(port, host);
      })
      .catch(() => resolve(false));
  });
};

// Dynamic import of pg to handle cases where it's not installed
const getPgClient = async () => {
  try {
    const pg = await import('pg');
    return pg.default?.Client || pg.Client;
  } catch {
    return null;
  }
};

const executeSql = async (
  url: string,
  sql: string
): Promise<{ success: boolean; rows?: unknown[]; error?: string }> => {
  const Client = await getPgClient();

  if (!Client) {
    // Fallback to psql if pg is not available
    return executeSqlWithPsql(url, sql);
  }

  const client = new Client({ connectionString: url });

  try {
    await client.connect();
    const result = await client.query(sql);
    await client.end();
    return { success: true, rows: result.rows };
  } catch (error) {
    try {
      await client.end();
    } catch {}
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
};

const executeSqlWithPsql = (
  url: string,
  sql: string
): Promise<{ success: boolean; rows?: unknown[]; error?: string }> => {
  return new Promise((resolve) => {
    import('child_process').then(({ spawn }) => {
      const psql = spawn('psql', [url, '-c', sql], {
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      psql.stdout?.on('data', (data) => {
        stdout += data.toString();
      });
      psql.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      const timeout = setTimeout(() => {
        psql.kill();
        resolve({ success: false, error: 'Command timeout' });
      }, 15000);

      psql.on('close', (code) => {
        clearTimeout(timeout);
        resolve({ success: code === 0, error: code !== 0 ? stderr : undefined });
      });

      psql.on('error', (err) => {
        clearTimeout(timeout);
        resolve({ success: false, error: err.message });
      });
    });
  });
};

const hashString = (str: string): number => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
};

const getShardIndex = (key: string, shardCount: number): number => {
  return hashString(key) % shardCount;
};

const runTests = async (): Promise<void> => {
  const shards = getShardConfigs();
  const timestamp = Date.now();
  const testTableName = `_prisma_sharding_test_${timestamp}`;

  console.log('\n' + '═'.repeat(60));
  console.log('🧪 PRISMA SHARDING - Comprehensive Test Suite');
  console.log('═'.repeat(60));
  console.log(`\n📊 Configuration:`);
  console.log(`   • Shard Count: ${shards.length}`);
  console.log(`   • Routing Strategy: ${process.env.SHARD_ROUTING_STRATEGY || 'modulo'}`);
  console.log(`   • Test Users: ${TEST_USER_COUNT}`);
  console.log(`   • Test Table: ${testTableName}`);

  if (shards.length === 0) {
    console.error(
      '\n❌ No shards configured. Set SHARD_COUNT and SHARD_N_URL environment variables.'
    );
    process.exit(1);
  }

  // Check if pg is available
  const pgAvailable = await getPgClient();
  if (pgAvailable) {
    console.log(`   • Database Client: pg (native)`);
  } else {
    console.log(`   • Database Client: psql (fallback)`);
  }

  // ══════════════════════════════════════════════════════════════
  // TEST 1: Configuration Validation
  // ══════════════════════════════════════════════════════════════
  log.section('Test 1: Configuration Validation');

  await runTest('Verify environment variables', async () => {
    const shardCount = parseInt(process.env.SHARD_COUNT || '0', 10);
    if (shardCount === 0 && !process.env.DATABASE_URL) {
      throw new Error('SHARD_COUNT or DATABASE_URL must be set');
    }
    log.detail(`SHARD_COUNT = ${shardCount}`);
    log.detail(`SHARD_ROUTING_STRATEGY = ${process.env.SHARD_ROUTING_STRATEGY || 'modulo'}`);
  });

  await runTest('Verify shard URL formats', async () => {
    for (const shard of shards) {
      const urlInfo = parsePostgresUrl(shard.url);
      if (!urlInfo) {
        throw new Error(`Invalid URL format for ${shard.id}`);
      }
      log.detail(`${shard.id} → ${urlInfo.host}:${urlInfo.port}/${urlInfo.database}`);
    }
  });

  // ══════════════════════════════════════════════════════════════
  // TEST 2: Network Connectivity
  // ══════════════════════════════════════════════════════════════
  log.section('Test 2: Network Connectivity');

  for (const shard of shards) {
    await runTest(`TCP connection to ${shard.id}`, async () => {
      const urlInfo = parsePostgresUrl(shard.url);
      if (!urlInfo) throw new Error('Invalid URL');

      const connected = await testTcpConnection(urlInfo.host, urlInfo.port);
      if (!connected) {
        throw new Error(`Cannot reach ${urlInfo.host}:${urlInfo.port}`);
      }
      log.detail(`${urlInfo.host}:${urlInfo.port} is reachable`);
    });
  }

  // ══════════════════════════════════════════════════════════════
  // TEST 3: Database Connection & SQL Execution
  // ══════════════════════════════════════════════════════════════
  log.section('Test 3: Database Connection');

  for (const shard of shards) {
    await runTest(`SQL execution on ${shard.id}`, async () => {
      const result = await executeSql(shard.url, 'SELECT 1 as test;');
      if (!result.success) {
        throw new Error(result.error || 'SQL execution failed');
      }
      log.detail(`${shard.id} accepts SQL commands`);
    });
  }

  // ══════════════════════════════════════════════════════════════
  // TEST 4: Create Temporary Test Table on All Shards
  // ══════════════════════════════════════════════════════════════
  log.section('Test 4: Create Test Table');

  const createTableSql = `
    CREATE TABLE IF NOT EXISTS "${testTableName}" (
      id VARCHAR(50) PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      username VARCHAR(100) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `;

  for (const shard of shards) {
    await runTest(`Create test table on ${shard.id}`, async () => {
      const result = await executeSql(shard.url, createTableSql);
      if (!result.success) {
        throw new Error(result.error || 'Failed to create table');
      }
      log.detail(`Table "${testTableName}" created on ${shard.id}`);
    });
  }

  // ══════════════════════════════════════════════════════════════
  // TEST 5: Create Test Users with Shard Distribution
  // ══════════════════════════════════════════════════════════════
  log.section('Test 5: User Distribution Test');

  console.log(`\n   Creating ${TEST_USER_COUNT} test users across ${shards.length} shards...\n`);

  const distribution: Map<string, number> = new Map();
  shards.forEach((s) => distribution.set(s.id, 0));

  for (let i = 0; i < TEST_USER_COUNT; i++) {
    const userId = `test_user_${timestamp}_${i}`;
    const email = `test_${timestamp}_${i}@example.com`;
    const username = `testuser_${i}`;

    // Determine which shard this user goes to
    const shardIndex = getShardIndex(userId, shards.length);
    const targetShard = shards[shardIndex];

    const insertSql = `
      INSERT INTO "${testTableName}" (id, email, username)
      VALUES ('${userId}', '${email}', '${username}');
    `;

    const result = await executeSql(targetShard.url, insertSql);
    if (result.success) {
      testUsers.push({ id: userId, email, shardId: targetShard.id });
      distribution.set(targetShard.id, (distribution.get(targetShard.id) || 0) + 1);
      log.detail(`User ${i + 1}/${TEST_USER_COUNT}: "${username}" → ${targetShard.id}`);
    } else {
      log.warn(`Failed to create user ${i + 1}: ${result.error}`);
    }
  }

  log.success(`Created ${testUsers.length}/${TEST_USER_COUNT} test users`);

  // ══════════════════════════════════════════════════════════════
  // TEST 6: Verify Distribution
  // ══════════════════════════════════════════════════════════════
  log.section('Test 6: Distribution Analysis');

  await runTest('Analyze shard distribution', async () => {
    console.log('\n   📊 User Distribution Across Shards:\n');
    console.log('   ┌─────────────┬───────────┬────────────┬────────────────────┐');
    console.log('   │ Shard       │ Users     │ Percentage │ Visual             │');
    console.log('   ├─────────────┼───────────┼────────────┼────────────────────┤');

    let minCount = Infinity;
    let maxCount = 0;

    distribution.forEach((count, shardId) => {
      const percentage =
        testUsers.length > 0 ? ((count / testUsers.length) * 100).toFixed(1) : '0.0';
      const barLength = testUsers.length > 0 ? Math.round((count / testUsers.length) * 15) : 0;
      const bar = '█'.repeat(barLength) + '░'.repeat(15 - barLength);
      console.log(
        `   │ ${shardId.padEnd(11)} │ ${count.toString().padStart(9)} │ ${percentage.padStart(6)}%    │ ${bar}   │`
      );

      minCount = Math.min(minCount, count);
      maxCount = Math.max(maxCount, count);
    });

    console.log('   └─────────────┴───────────┴────────────┴────────────────────┘\n');

    if (testUsers.length > 0) {
      const minPercentage = (minCount / testUsers.length) * 100;
      const maxPercentage = (maxCount / testUsers.length) * 100;

      if (minPercentage < 10) {
        log.warn(`Some shards have very few users (${minPercentage.toFixed(1)}%)`);
      }
      if (maxPercentage > 60) {
        log.warn(`Some shards are overloaded (${maxPercentage.toFixed(1)}%)`);
      }

      log.detail(`Distribution range: ${minPercentage.toFixed(1)}% - ${maxPercentage.toFixed(1)}%`);
      log.detail(`Average per shard: ${(testUsers.length / shards.length).toFixed(1)} users`);
    }
  });

  // ══════════════════════════════════════════════════════════════
  // TEST 7: Read Users from Correct Shards
  // ══════════════════════════════════════════════════════════════
  log.section('Test 7: Read Verification');

  await runTest('Verify users exist on correct shards', async () => {
    let verified = 0;
    const sampleSize = Math.min(5, testUsers.length);

    for (let i = 0; i < sampleSize; i++) {
      const user = testUsers[i];
      const shard = shards.find((s) => s.id === user.shardId);
      if (!shard) continue;

      const selectSql = `SELECT id, email FROM "${testTableName}" WHERE id = '${user.id}';`;
      const result = await executeSql(shard.url, selectSql);

      if (result.success && result.rows && result.rows.length > 0) {
        verified++;
        log.detail(`✓ User "${user.id}" found on ${user.shardId}`);
      } else {
        log.warn(`✗ User "${user.id}" NOT found on ${user.shardId}`);
      }
    }

    if (verified < sampleSize) {
      throw new Error(`Only ${verified}/${sampleSize} users verified`);
    }
    log.detail(`Verified ${verified}/${sampleSize} users on correct shards`);
  });

  // ══════════════════════════════════════════════════════════════
  // TEST 8: Cross-Shard Query Test
  // ══════════════════════════════════════════════════════════════
  log.section('Test 8: Cross-Shard Count');

  await runTest('Count users across all shards', async () => {
    let totalCount = 0;

    for (const shard of shards) {
      const countSql = `SELECT COUNT(*) as count FROM "${testTableName}";`;
      const result = await executeSql(shard.url, countSql);

      if (result.success && result.rows && result.rows.length > 0) {
        const count = parseInt((result.rows[0] as { count: string }).count, 10);
        totalCount += count;
        log.detail(`${shard.id}: ${count} users`);
      }
    }

    log.detail(`Total users across all shards: ${totalCount}`);

    if (totalCount !== testUsers.length) {
      log.warn(`Expected ${testUsers.length} users, found ${totalCount}`);
    }
  });

  // ══════════════════════════════════════════════════════════════
  // TEST 9: Cleanup - Drop Test Tables
  // ══════════════════════════════════════════════════════════════
  log.section('Test 9: Cleanup');

  let cleanedUp = 0;
  for (const shard of shards) {
    const dropSql = `DROP TABLE IF EXISTS "${testTableName}";`;
    const result = await executeSql(shard.url, dropSql);
    if (result.success) {
      cleanedUp++;
      log.detail(`Test table removed from ${shard.id}`);
    } else {
      log.warn(`Could not drop table on ${shard.id}: ${result.error}`);
    }
  }
  log.success(`Cleanup complete (${cleanedUp}/${shards.length} shards)`);

  // ══════════════════════════════════════════════════════════════
  // FINAL SUMMARY
  // ══════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(60));
  console.log('📋 TEST RESULTS SUMMARY');
  console.log('═'.repeat(60));

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

  console.log(`\n   Total Tests: ${results.length}`);
  console.log(`   ✅ Passed: ${passed}`);
  console.log(`   ❌ Failed: ${failed}`);
  console.log(`   ⏱️  Duration: ${(totalDuration / 1000).toFixed(2)}s`);
  console.log(`   📊 Users Created: ${testUsers.length}`);

  if (failed > 0) {
    console.log('\n   Failed Tests:');
    results
      .filter((r) => !r.passed)
      .forEach((r) => {
        console.log(`     • ${r.name}: ${r.message}`);
      });

    console.log('\n💡 Troubleshooting Tips:');
    console.log('   • Ensure PostgreSQL is running');
    console.log('   • Verify shard databases exist');
    console.log('   • Check credentials in SHARD_N_URL');
    console.log('   • Run: yarn migrate:shards\n');
    process.exit(1);
  }

  console.log('\n' + '═'.repeat(60));
  console.log('✅ ALL TESTS PASSED SUCCESSFULLY!');
  console.log('═'.repeat(60) + '\n');
};

runTests().catch((error) => {
  console.error('\n💥 Test suite crashed:', error);
  process.exit(1);
});
