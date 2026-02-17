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

const runCommand = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): Promise<{ success: boolean; output: string; error?: string }> => {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      env,
      cwd: path.resolve(cwd),
      shell: true,
    });

    let output = '';
    let errorOutput = '';

    proc.stdout.on('data', (data) => {
      process.stdout.write(data); // Stream output directly to console
      output += data.toString();
    });

    proc.stderr.on('data', (data) => {
      process.stderr.write(data); // Stream error directly to console
      errorOutput += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, output });
      } else {
        resolve({ success: false, output, error: errorOutput || `Exit code: ${code}` });
      }
    });

    proc.on('error', (err) => {
      resolve({ success: false, output, error: err.message });
    });
  });
};

const updateAll = async (): Promise<void> => {
  console.log('\n' + '='.repeat(60));
  console.log('🔄 PRISMA SHARDING UPDATE');
  console.log('='.repeat(60) + '\n');

  // --- STEP 1: GENERATE TYPES ---
  console.log('🛠️  Step 1: Generating Prisma Client Types...');
  const genResult = await runCommand('npx', ['prisma', 'generate']);
  
  if (!genResult.success) {
    console.error('\n❌ Failed to generate client. Aborting migration.');
    process.exit(1);
  }
  console.log('✅ Client types generated successfully.\n');

  // --- STEP 2: MIGRATE SHARDS ---
  const shards = getShardConfigs();
  const extraArgs = process.argv.slice(2);

  console.log('📦 Step 2: Migrating Shards...');
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
    console.log(`\n👉 Processing ${shard.id}...`);
    // Mask password in logs
    // console.log(`   URL: ${shard.url.replace(/:[^:@]+@/, ':***@')}`);

    const env = { ...process.env, DATABASE_URL: shard.url };
    const args = ['prisma', 'db', 'push', '--accept-data-loss', ...extraArgs];

    // We use 'npx' here to ensure we use the local prisma binary
    const { success, output, error } = await runCommand('npx', args, env);

    if (!success) {
      console.error(`   ❌ Failed`);
      results.push({ shardId: shard.id, success: false, output, error });
    } else {
      console.log(`   ✅ Success`);
      results.push({ shardId: shard.id, success: true, output });
    }
  }

  // --- SUMMARY ---
  console.log('\n' + '='.repeat(60));
  console.log('📋 Update Summary');
  console.log('='.repeat(60));

  const successful = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  results.forEach((result) => {
    const status = result.success ? '✅' : '❌';
    console.log(`   ${status} ${result.shardId}`);
  });

  console.log(`\n   Total: ${results.length} | Success: ${successful} | Failed: ${failed}`);

  if (failed > 0) {
    console.log('\n⚠️  Some migrations failed. Run with --force-reset if needed.');
    process.exit(1);
  }

  console.log('\n✨ All updates completed successfully!');
};

updateAll().catch((error) => {
  console.error('Update script failed:', error);
  process.exit(1);
});

