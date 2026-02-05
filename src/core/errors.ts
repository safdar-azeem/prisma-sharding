export class ShardingError extends Error {
  public readonly code: string;

  constructor(message: string, code: string = 'SHARDING_ERROR') {
    super(message);
    this.name = 'ShardingError';
    this.code = code;
    Object.setPrototypeOf(this, ShardingError.prototype);
  }
}

export class ConfigError extends ShardingError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR');
    this.name = 'ConfigError';
    Object.setPrototypeOf(this, ConfigError.prototype);
  }
}

export class ConnectionError extends ShardingError {
  public readonly shardId: string;

  constructor(message: string, shardId: string) {
    super(message, 'CONNECTION_ERROR');
    this.name = 'ConnectionError';
    this.shardId = shardId;
    Object.setPrototypeOf(this, ConnectionError.prototype);
  }
}

export class RoutingError extends ShardingError {
  constructor(message: string) {
    super(message, 'ROUTING_ERROR');
    this.name = 'RoutingError';
    Object.setPrototypeOf(this, RoutingError.prototype);
  }
}
