import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { PrismaSharding } from 'prisma-sharding';

export const sharding = new PrismaSharding<PrismaClient>({
  shards: [
    { id: 'shard_1', url: process.env.SHARD_1_URL! },
    { id: 'shard_2', url: process.env.SHARD_2_URL! }
  ],
  strategy: 'modulo',
  createClient: (url) => {
    const adapter = new PrismaPg({ connectionString: url });
    return new PrismaClient({ adapter });
  }
});
