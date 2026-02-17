#!/usr/bin/env node
import 'dotenv/config';
import { spawn } from 'child_process';
import path from 'path';

interface MigrationResult {
  shardId: string;
  success: boolean;
  output: string;
  error?: string;
}

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

const runPrismaCommand = (
  shardUrl: string,
  command: string[]
): Promise<{ success: boolean; output: string; error?: string }> => {
  return new Promise((resolve) => {
    // Inject the specific shard URL as the DATABASE_URL environment variable
    const env = { 
      ...process.env, 
      DATABASE_URL: shardUrl 
    };

    const prisma = spawn('npx', ['prisma', ...command], {
      env,
      cwd: path.resolve(process.cwd()),
      shell: true,
    });

    let output = '';
    let errorOutput = '';

    prisma.stdout.on('data', (data) => {
      output += data.toString();
    });

    prisma.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    prisma.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, output });
      } else {
        // Prisma typically writes non-fatal warnings to stderr as well, 
        // but exit code != 0 definitely means failure.
        resolve({ success: false, output, error: errorOutput || `Exit code: ${code}` });
      }
    });

    prisma.on('error', (err) => {
      resolve({ success: false, output, error: err.message });
    });
  });
};

const migrateAllShards = async (): Promise<void> => {
  const shards = getShardConfigs();
  // Capture any arguments passed to the script (e.g., --force-reset)
  const extraArgs = process.argv.slice(2);

  console.log('🔄 prisma-sharding: Starting migrations...\n');
  console.log(`📊 Total shards to migrate: ${shards.length}`);
  if (extraArgs.length > 0) {
    console.log(`🔧 Using flags: ${extraArgs.join(' ')}`);
  }
  console.log('');

  if (shards.length === 0) {
    console.error(
      '❌ No shards configured. Set SHARD_COUNT and SHARD_N_URL environment variables.'
    );
    process.exit(1);
  }

  const results: MigrationResult[] = [];

  for (const shard of shards) {
    console.log(`\n📦 Migrating ${shard.id}...`);
    console.log(`   URL: ${shard.url.replace(/:[^:@]+@/, ':***@')}`);

    // Pass default flag --accept-data-loss, plus any extra user args
    const args = ['db', 'push', '--accept-data-loss', ...extraArgs];

    const { success, output, error } = await runPrismaCommand(shard.url, args);

    if (!success) {
      console.error(`   ❌ Failed:`);
      // Clean up error output for better readability
      console.error(error?.replace(/Check logs above/g, '').trim());
      results.push({ shardId: shard.id, success: false, output, error });
    } else {
      console.log(`   ✅ Success`);
      results.push({ shardId: shard.id, success: true, output });
    }
  }

  console.log('\n' + '='.repeat(50));
  console.log('📋 Migration Summary\n');

  const successful = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  results.forEach((result) => {
    const status = result.success ? '✅' : '❌';
    console.log(
      `   ${status} ${result.shardId}`
    );
  });

  console.log(`\n   Total: ${results.length} | Success: ${successful} | Failed: ${failed}`);

  if (failed > 0) {
    console.log('\n⚠️  Some migrations failed. Run with --force-reset to clear incompatible data.');
    process.exit(1);
  }

  console.log('\n✅ All shard migrations completed successfully!');
};

migrateAllShards().catch((error) => {
  console.error('Migration script failed:', error);
  process.exit(1);
});

