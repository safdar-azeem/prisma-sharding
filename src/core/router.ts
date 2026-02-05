import type { RoutingStrategy, ShardingLogger } from '../types';
import { hashString } from '../utils';
import { RoutingError } from './errors';
import { DEFAULTS } from '../constants';

interface RouterConfig {
  strategy: RoutingStrategy;
  shardIds: string[];
  logger: ShardingLogger;
}

export class ShardRouter {
  private strategy: RoutingStrategy;
  private shardIds: string[];
  private consistentHashRing: Map<number, string> = new Map();
  private virtualNodes = DEFAULTS.CONSISTENT_HASH_VIRTUAL_NODES;
  private logger: ShardingLogger;

  constructor(config: RouterConfig) {
    this.strategy = config.strategy;
    this.shardIds = config.shardIds;
    this.logger = config.logger;

    if (this.strategy === 'consistent-hash') {
      this.initializeConsistentHashRing();
    }
  }

  private initializeConsistentHashRing(): void {
    for (const shardId of this.shardIds) {
      for (let i = 0; i < this.virtualNodes; i++) {
        const hash = hashString(`${shardId}:${i}`);
        this.consistentHashRing.set(hash, shardId);
      }
    }
  }

  getShardIndex(key: string): number {
    const shardCount = this.shardIds.length;

    if (shardCount === 0) {
      throw new RoutingError('No shards available');
    }

    if (this.strategy === 'consistent-hash') {
      return this.getIndexConsistentHash(key);
    }

    return this.getIndexModulo(key, shardCount);
  }

  private getIndexModulo(key: string, shardCount: number): number {
    const hash = hashString(key);
    return hash % shardCount;
  }

  private getIndexConsistentHash(key: string): number {
    const hash = hashString(key);
    const sortedHashes = Array.from(this.consistentHashRing.keys()).sort((a, b) => a - b);

    for (const ringHash of sortedHashes) {
      if (hash <= ringHash) {
        const shardId = this.consistentHashRing.get(ringHash)!;
        const match = shardId.match(/shard_(\d+)/);
        return match ? parseInt(match[1], 10) - 1 : 0;
      }
    }

    const firstShardId = this.consistentHashRing.get(sortedHashes[0])!;
    const match = firstShardId.match(/shard_(\d+)/);
    return match ? parseInt(match[1], 10) - 1 : 0;
  }

  getShardId(key: string): string {
    const index = this.getShardIndex(key);
    return this.shardIds[index] || `shard_${index + 1}`;
  }

  getRandomShardIndex(): number {
    return Math.floor(Math.random() * this.shardIds.length);
  }

  getRandomShardId(): string {
    const index = this.getRandomShardIndex();
    return this.shardIds[index];
  }
}
