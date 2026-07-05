import { hashString } from '../utils';
import { RoutingError } from './errors';
import { DEFAULTS } from '../constants';
import type { RoutingStrategy, ShardingLogger } from '../types';

interface RouterConfig {
  strategy: RoutingStrategy;
  shardIds: string[];
  shardWeights?: Map<string, number>;
  logger: ShardingLogger;
}

export class ShardRouter {
  private readonly strategy: RoutingStrategy;
  private readonly shardIds: string[];
  private readonly consistentHashRing: Map<number, string> = new Map();
  private readonly sortedRingHashes: number[];
  private readonly randomShardWeights: number[];
  private readonly totalRandomWeight: number;
  private readonly virtualNodes = DEFAULTS.CONSISTENT_HASH_VIRTUAL_NODES;
  private readonly logger: ShardingLogger;

  constructor(config: RouterConfig) {
    this.strategy = config.strategy;
    this.shardIds = config.shardIds;
    this.logger = config.logger;

    if (this.strategy === 'consistent-hash') {
      this.initializeConsistentHashRing();
    }

    this.sortedRingHashes = Array.from(this.consistentHashRing.keys()).sort((a, b) => a - b);
    this.randomShardWeights = this.shardIds.map(
      (shardId) => config.shardWeights?.get(shardId) ?? 1
    );
    this.totalRandomWeight = this.randomShardWeights.reduce((sum, weight) => sum + weight, 0);
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
    return this.shardIds.indexOf(this.getConsistentHashShardId(key));
  }

  private getConsistentHashShardId(key: string): string {
    const hash = hashString(key);
    let low = 0;
    let high = this.sortedRingHashes.length - 1;
    let matchIndex = 0;

    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (this.sortedRingHashes[middle] >= hash) {
        matchIndex = middle;
        high = middle - 1;
      } else {
        low = middle + 1;
      }
    }

    if (low >= this.sortedRingHashes.length) {
      matchIndex = 0;
    }

    return this.consistentHashRing.get(this.sortedRingHashes[matchIndex])!;
  }

  getShardId(key: string): string {
    if (this.shardIds.length === 0) {
      throw new RoutingError('No shards available');
    }

    if (this.strategy === 'consistent-hash') {
      return this.getConsistentHashShardId(key);
    }

    const index = this.getShardIndex(key);
    return this.shardIds[index] || `shard_${index + 1}`;
  }

  getRandomShardIndex(): number {
    if (this.shardIds.length === 0) {
      throw new RoutingError('No shards available');
    }

    let selection = Math.random() * this.totalRandomWeight;
    for (let index = 0; index < this.randomShardWeights.length; index++) {
      selection -= this.randomShardWeights[index];
      if (selection < 0) {
        return index;
      }
    }

    return this.shardIds.length - 1;
  }

  getRandomShardId(): string {
    const index = this.getRandomShardIndex();
    return this.shardIds[index];
  }
}
