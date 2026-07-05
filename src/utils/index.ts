import { parseBooleanEnv } from './env';

export function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

export function validateUrl(url: string): boolean {
  return url.startsWith('postgresql://') || url.startsWith('postgres://');
}

export function createDefaultLogger() {
  const verbose = parseBooleanEnv('PRISMA_SHARDING_VERBOSE', false);

  return {
    info: (msg: string) => {
      if (verbose) {
        console.log(`[PrismaSharding] ${msg}`);
      }
    },
    warn: (msg: string) => console.warn(`[PrismaSharding] ${msg}`),
    error: (msg: string) => console.error(`[PrismaSharding] ${msg}`),
  };
}
