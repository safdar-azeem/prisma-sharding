const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const CLI_PATH = path.resolve(__dirname, '../dist/cli/studio.js');
const PRISMA_STUDIO_HTML =
  '<html><script>window.__STUDIO_CONFIG__={}</script>' +
  '<script src="/studio.js"></script><link href="/studio.css"></html>';

const createTestEnv = (overrides = {}) => {
  const env = { ...process.env };

  for (const key of Object.keys(env)) {
    if (key.startsWith('SHARD_') || key === 'DATABASE_URL') {
      delete env[key];
    }
  }

  return {
    ...env,
    SHARD_COUNT: '1',
    SHARD_1_URL: 'postgresql://test:test@localhost/test',
    ...overrides,
  };
};

const listen = (server, port = 0) => {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve(server.address().port);
    });
  });
};

const close = (server) => {
  return new Promise((resolve) => server.close(resolve));
};

const runCli = (env, options = {}) => {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH], {
      env: createTestEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let stopScheduled = false;
    let signalSent = false;

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (options.stopAfter && stdout.includes(options.stopAfter) && !stopScheduled) {
        stopScheduled = true;
        setTimeout(() => {
          if (child.exitCode === null) {
            signalSent = child.kill('SIGINT');
          }
        }, 100);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr, signalSent });
    });
  });
};

const waitFor = async (predicate, timeoutMs = 3000) => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Condition not met within ${timeoutMs}ms`);
};

const isProcessRunning = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('retries an occupied port while another Studio instance starts', async () => {
  const startedAt = Date.now();
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(
      Date.now() - startedAt >= 500 ? PRISMA_STUDIO_HTML : '<html>starting</html>'
    );
  });
  const port = await listen(server);

  try {
    const result = await runCli(
      {
        SHARD_STUDIO_BASE_PORT: String(port),
        SHARD_STUDIO_START_TIMEOUT_MS: '2000',
      },
      { stopAfter: `♻️ shard_1  http://localhost:${port}` }
    );

    assert.equal(result.code, 0);
    assert.equal(result.signalSent, true);
    assert.match(result.stdout, new RegExp(`♻️ shard_1  http://localhost:${port}`));
    assert.doesNotMatch(result.stdout, /No Studio processes started|Press Ctrl\+C/);
    assert.doesNotMatch(result.stdout, /Checking shard_1 Studio port/);
    assert.equal(result.stderr, '');
  } finally {
    await close(server);
  }
});

test('warns for an unknown occupied port and enforces strict mode', async () => {
  const server = http.createServer((_request, response) => {
    response.end('unrelated service');
  });
  const port = await listen(server);

  try {
    const result = await runCli({
      SHARD_STUDIO_BASE_PORT: String(port),
      SHARD_STUDIO_START_TIMEOUT_MS: '500',
      SHARD_STUDIO_STRICT_PORT_CHECK: 'true',
    });

    assert.equal(result.code, 1);
    assert.match(result.stdout, /⚠️ shard_1  Port already used by another process/);
    assert.doesNotMatch(result.stdout, /EADDRINUSE/);
    assert.equal(result.stderr, '');
  } finally {
    await close(server);
  }
});

test(
  'reports a startup timeout without claiming the shard started',
  { skip: process.platform === 'win32' },
  async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-sharding-timeout-'));
    const fakeNpxPath = path.join(tempDirectory, 'npx');
    const portServer = http.createServer();
    const port = await listen(portServer);
    await close(portServer);

    fs.writeFileSync(
      fakeNpxPath,
      '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n',
      { mode: 0o755 }
    );

    try {
      const result = await runCli({
        PATH: `${tempDirectory}${path.delimiter}${process.env.PATH || ''}`,
        SHARD_STUDIO_BASE_PORT: String(port),
        SHARD_STUDIO_START_TIMEOUT_MS: '500',
        SHARD_STUDIO_STABILITY_MS: '50',
      });

      assert.equal(result.code, 0);
      assert.match(result.stdout, /❌ shard_1  Failed to start/);
      assert.match(result.stdout, /SHARD_STUDIO_VERBOSE=true/);
      assert.doesNotMatch(result.stdout, /✅ shard_1/);
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  }
);

test(
  'stops the full owned process group on SIGINT',
  { skip: process.platform === 'win32' },
  async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-sharding-shutdown-'));
    const fakeNpxPath = path.join(tempDirectory, 'npx');
    const childPath = path.join(tempDirectory, 'studio-child.js');
    const pidPath = path.join(tempDirectory, 'studio.pid');

    fs.writeFileSync(
      childPath,
      [
        "const fs = require('node:fs');",
        "const http = require('node:http');",
        'const port = Number(process.argv[2]);',
        'const pidPath = process.argv[3];',
        `const body = ${JSON.stringify(PRISMA_STUDIO_HTML)};`,
        'fs.writeFileSync(pidPath, String(process.pid));',
        "http.createServer((_request, response) => response.end(body)).listen(port, '127.0.0.1', () => {",
        '  console.log(`Prisma Studio is running at http://localhost:${port}`);',
        '});',
      ].join('\n')
    );
    fs.writeFileSync(
      fakeNpxPath,
      [
        '#!/usr/bin/env node',
        "const { spawn } = require('node:child_process');",
        `const childPath = ${JSON.stringify(childPath)};`,
        `const pidPath = ${JSON.stringify(pidPath)};`,
        "const portIndex = process.argv.indexOf('--port');",
        'const port = process.argv[portIndex + 1];',
        "const child = spawn(process.execPath, [childPath, port, pidPath], { stdio: 'inherit' });",
        'child.on(\'exit\', (code) => process.exit(code || 0));',
        'setInterval(() => {}, 1000);',
      ].join('\n'),
      { mode: 0o755 }
    );

    const portServer = http.createServer();
    const port = await listen(portServer);
    await close(portServer);

    const child = spawn(process.execPath, [CLI_PATH], {
      env: createTestEnv({
        PATH: `${tempDirectory}${path.delimiter}${process.env.PATH || ''}`,
        SHARD_STUDIO_BASE_PORT: String(port),
        SHARD_STUDIO_START_TIMEOUT_MS: '2000',
        SHARD_STUDIO_STABILITY_MS: '100',
        SHARD_STUDIO_SHUTDOWN_TIMEOUT_MS: '1000',
      }),
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

    try {
      await waitFor(() => stdout.includes(`✅ shard_1  http://localhost:${port}`));
      await waitFor(() => fs.existsSync(pidPath));
      const studioPid = Number(fs.readFileSync(pidPath, 'utf8'));
      const cliExit = new Promise((resolve) => {
        child.on('close', (code, signal) => resolve({ code, signal }));
      });

      child.kill('SIGINT');
      const exit = await cliExit;

      await waitFor(() => !isProcessRunning(studioPid));
      assert.equal(exit.code, 0);
      assert.doesNotMatch(stdout, /Stopping owned Studio processes|Stopped\./);
      assert.equal(stderr, '');
    } finally {
      if (isProcessRunning(child.pid)) {
        child.kill('SIGKILL');
      }
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  }
);
