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

/**
 * Locate the shard that owns a given User and return its Prisma client.
 *
 * Uses findAcrossShards() to discover which shard the User lives on.
 * In a real application, the User's shard ownership (e.g. shard ID) would
 * normally be persisted/cached during authentication/session setup and the
 * appropriate client resolved directly (e.g. selectShard) rather than scanning
 * all shards on each request.
 */
export const getUserClient = async (userId: string) => {
  const found = await sharding.findAcrossShards((db) =>
    db.user.findUnique({
      where: { id: userId },
      select: { id: true },
    })
  );

  if (!found.client) {
    throw new Error('User not found');
  }

  return found.client;
};
