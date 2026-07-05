const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const LIBRARY_PATH = path.resolve(__dirname, '../dist/index.js');
const SCRIPT = `
  const { PrismaSharding } = require(${JSON.stringify(LIBRARY_PATH)});
  const sharding = new PrismaSharding({
    shards: [{ id: 'shard_1', url: 'postgresql://test:test@localhost/test' }],
    createClient: () => ({
      $queryRaw: async () => 1,
      $disconnect: async () => undefined,
    }),
  });
  sharding.connect().then(() => sharding.disconnect());
`;

const runLibrary = (verbose) => {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.PRISMA_SHARDING_VERBOSE;
    if (verbose) {
      env.PRISMA_SHARDING_VERBOSE = 'true';
    }

    const child = spawn(process.execPath, ['-e', SCRIPT], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
};

test('default Prisma Sharding logger keeps informational lifecycle logs quiet', async () => {
  const result = await runLibrary(false);

  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('Prisma Sharding lifecycle logs remain available in verbose mode', async () => {
  const result = await runLibrary(true);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /\[PrismaSharding\] Initializing 1 shard/);
  assert.match(result.stdout, /\[PrismaSharding\] Shutdown complete/);
  assert.equal(result.stderr, '');
});
