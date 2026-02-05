#!/usr/bin/env node
import 'dotenv/config';
import { spawn, ChildProcess } from 'child_process';

interface StudioInstance {
  shardId: string;
  port: number;
  process: ChildProcess;
}

const instances: StudioInstance[] = [];
const BASE_PORT = parseInt(process.env.SHARD_STUDIO_BASE_PORT || '51212', 10);

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

const startStudio = (
  shard: { id: string; url: string },
  index: number
): Promise<StudioInstance> => {
  return new Promise((resolve, reject) => {
    const port = BASE_PORT + index;
    const shardId = shard.id;

    console.log(`\n🚀 Starting Prisma Studio for ${shardId} on port ${port}...`);
    console.log(`   URL: ${shard.url.replace(/:[^:@]+@/, ':***@')}`);

    const studioProcess = spawn(
      'npx',
      ['prisma', 'studio', '--port', port.toString(), '--browser', 'none'],
      {
        env: {
          ...process.env,
          DATABASE_URL: shard.url,
        },
        shell: true,
        stdio: 'pipe',
      }
    );

    studioProcess.stdout?.on('data', (data) => {
      const output = data.toString();
      if (output.includes('Prisma Studio is running')) {
        console.log(`   ✅ ${shardId} ready at http://localhost:${port}`);
      }
    });

    studioProcess.stderr?.on('data', (data) => {
      const output = data.toString();
      if (!output.includes('warn') && !output.includes('Loaded')) {
        console.error(`   [${shardId}] ${output}`);
      }
    });

    studioProcess.on('error', (err) => {
      console.error(`   ❌ Failed to start ${shardId}:`, err.message);
      reject(err);
    });

    const instance: StudioInstance = {
      shardId,
      port,
      process: studioProcess,
    };

    instances.push(instance);
    setTimeout(() => resolve(instance), 2000);
  });
};

const startAllStudios = async (): Promise<void> => {
  const shards = getShardConfigs();

  console.log('='.repeat(60));
  console.log('🗄️  prisma-sharding: Multi-Shard Studio Viewer');
  console.log('='.repeat(60));
  console.log(`\n📊 Starting ${shards.length} Prisma Studio instance(s)...\n`);

  if (shards.length === 0) {
    console.error(
      '❌ No shards configured. Set SHARD_COUNT and SHARD_N_URL environment variables.'
    );
    process.exit(1);
  }

  for (let i = 0; i < shards.length; i++) {
    try {
      await startStudio(shards[i], i);
    } catch (error) {
      console.error(`Failed to start studio for ${shards[i].id}:`, error);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('📋 All Studios Running:');
  console.log('='.repeat(60));

  instances.forEach((instance) => {
    console.log(`   • ${instance.shardId}: http://localhost:${instance.port}`);
  });

  console.log('\n   Press Ctrl+C to stop all instances\n');
};

const gracefulShutdown = () => {
  console.log('\n\n🛑 Shutting down all Prisma Studio instances...\n');

  instances.forEach((instance) => {
    console.log(`   Stopping ${instance.shardId}...`);
    instance.process.kill('SIGTERM');
  });

  setTimeout(() => {
    console.log('\n✅ All instances stopped\n');
    process.exit(0);
  }, 1000);
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

startAllStudios().catch((error) => {
  console.error('Failed to start studios:', error);
  process.exit(1);
});
