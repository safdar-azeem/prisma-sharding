const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const CLI_PATH = path.resolve(__dirname, '../dist/cli/studio.js');
const { computeStudioFingerprint } = require(
  path.resolve(__dirname, '../dist/cli/utils/studio-registry.js')
);
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
    SHARD_STUDIO_STABILITY_MS: '100',
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

const httpGet = (port) =>
  new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/' }, (response) => {
        let body = '';
        response.on('data', (chunk) => (body += chunk));
        response.on('end', () => resolve(body));
      })
      .once('error', reject);
  });

/**
 * A fake `npx` whose `prisma studio` serves the Studio HTML shell and records
 * its pid + DATABASE_URL per port, so tests can prove exactly which database
 * every Studio instance was started for.
 */
const createFakeStudioNpx = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-sharding-studio-npx-'));
  const recordDirectory = path.join(directory, 'records');
  fs.mkdirSync(recordDirectory);
  const fakeNpxPath = path.join(directory, 'npx');

  fs.writeFileSync(
    fakeNpxPath,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "const http = require('node:http');",
      "const path = require('node:path');",
      "const portIndex = process.argv.indexOf('--port');",
      'const port = Number(process.argv[portIndex + 1]);',
      `const body = ${JSON.stringify(PRISMA_STUDIO_HTML)};`,
      'const recordDir = process.env.FAKE_STUDIO_RECORD_DIR;',
      "http.createServer((_q, r) => r.end(body)).listen(port, '127.0.0.1', () => {",
      '  if (recordDir) {',
      '    fs.writeFileSync(',
      '      path.join(recordDir, `studio-${port}.json`),',
      '      JSON.stringify({ pid: process.pid, url: process.env.DATABASE_URL, cwd: process.cwd() })',
      '    );',
      '  }',
      '  console.log(`Prisma Studio is running at http://localhost:${port}`);',
      '});',
      'setInterval(() => {}, 1000);',
    ].join('\n'),
    { mode: 0o755 }
  );

  return { directory, recordDirectory, fakeNpxPath };
};

const readRecord = (recordDirectory, port) =>
  JSON.parse(fs.readFileSync(path.join(recordDirectory, `studio-${port}.json`), 'utf8'));

const startCli = (env, cwd) => {
  const child = spawn(process.execPath, [CLI_PATH], {
    cwd,
    env: createTestEnv(env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => (state.stdout += chunk));
  child.stderr.on('data', (chunk) => (state.stderr += chunk));

  const closed = new Promise((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
  });

  return {
    child,
    state,
    closed,
    stop: async () => {
      if (child.exitCode === null) {
        child.kill('SIGINT');
      }
      return closed;
    },
  };
};

const waitFor = async (predicate, timeoutMs = 8000) => {
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

const freePort = async () => {
  const server = http.createServer();
  const port = await listen(server);
  await close(server);
  return port;
};

test('the Studio fingerprint identifies the database target without exposing credentials', () => {
  const base = {
    projectRoot: '/projects/a',
    schemaPath: '/projects/a/prisma/schema.prisma',
    shardId: 'shard_1',
    url: 'postgresql://user:secret@localhost:5432/db_a',
  };

  assert.equal(
    computeStudioFingerprint(base),
    computeStudioFingerprint({
      ...base,
      url: 'postgresql://user:DIFFERENT_PASSWORD@localhost:5432/db_a',
    }),
    'credentials never participate in the fingerprint'
  );
  assert.notEqual(
    computeStudioFingerprint(base),
    computeStudioFingerprint({ ...base, url: 'postgresql://user:secret@localhost:5432/db_b' })
  );
  assert.notEqual(
    computeStudioFingerprint(base),
    computeStudioFingerprint({ ...base, projectRoot: '/projects/b' })
  );
  assert.doesNotMatch(computeStudioFingerprint(base), /secret/);
});

test(
  'starts on the next free port and leaves an unrelated occupant untouched',
  { skip: process.platform === 'win32' },
  async () => {
    const { directory, recordDirectory, fakeNpxPath } = createFakeStudioNpx();
    const registryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-studio-registry-'));
    const unrelated = http.createServer((_q, r) => r.end('unrelated service'));
    const port = await listen(unrelated);

    const cli = startCli({
      PATH: `${directory}${path.delimiter}${process.env.PATH || ''}`,
      FAKE_STUDIO_RECORD_DIR: recordDirectory,
      SHARD_STUDIO_REGISTRY_DIR: registryDirectory,
      SHARD_STUDIO_BASE_PORT: String(port),
      SHARD_STUDIO_START_TIMEOUT_MS: '4000',
    });

    try {
      await waitFor(() =>
        cli.state.stdout.includes(`✅ shard_1  http://localhost:${port + 1}`)
      );
      assert.doesNotMatch(cli.state.stdout, /♻️/);

      const record = readRecord(recordDirectory, port + 1);
      assert.equal(record.url, 'postgresql://test:test@localhost/test');
      assert.equal(await httpGet(port), 'unrelated service', 'occupant is untouched');
    } finally {
      await cli.stop();
      await close(unrelated);
      fs.rmSync(directory, { recursive: true, force: true });
      fs.rmSync(registryDirectory, { recursive: true, force: true });
    }
  }
);

test(
  'two projects with the same shard names stay fully isolated',
  { skip: process.platform === 'win32' },
  async () => {
    const { directory, recordDirectory, fakeNpxPath } = createFakeStudioNpx();
    const registryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-studio-registry-'));
    const projectA = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-project-a-'));
    const projectB = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-project-b-'));
    const urlA = 'postgresql://user:secretA@localhost:5432/project_a_shard1';
    const urlB = 'postgresql://user:secretB@localhost:5432/project_b_shard1';
    const port = await freePort();

    const shared = {
      PATH: `${directory}${path.delimiter}${process.env.PATH || ''}`,
      FAKE_STUDIO_RECORD_DIR: recordDirectory,
      SHARD_STUDIO_REGISTRY_DIR: registryDirectory,
      SHARD_STUDIO_BASE_PORT: String(port),
      SHARD_STUDIO_START_TIMEOUT_MS: '4000',
    };

    const cliA = startCli({ ...shared, SHARD_1_URL: urlA }, projectA);

    try {
      await waitFor(() => cliA.state.stdout.includes(`✅ shard_1  http://localhost:${port}`));
      const recordA = readRecord(recordDirectory, port);
      assert.equal(recordA.url, urlA, "Project A's Studio got Project A's database");

      // Project B: same shard name, same preferred port, different database.
      const cliB = startCli({ ...shared, SHARD_1_URL: urlB }, projectB);

      try {
        await waitFor(() =>
          cliB.state.stdout.includes(`✅ shard_1  http://localhost:${port + 1}`)
        );
        assert.doesNotMatch(
          cliB.state.stdout,
          /♻️/,
          "Project B must never reuse Project A's Studio"
        );

        const recordB = readRecord(recordDirectory, port + 1);
        assert.equal(recordB.url, urlB, "Project B's Studio got Project B's database");
        assert.equal(isProcessRunning(recordA.pid), true, "Project A's Studio still runs");

        // Credentials never leak into any output.
        for (const output of [cliA.state.stdout, cliB.state.stdout]) {
          assert.doesNotMatch(output, /secretA|secretB/);
        }
      } finally {
        await cliB.stop();
      }

      // Stopping Project B's command must not stop Project A's Studio.
      await waitFor(() => !isProcessRunning(readRecord(recordDirectory, port + 1).pid));
      assert.equal(isProcessRunning(recordA.pid), true, "B's shutdown left A untouched");
    } finally {
      await cliA.stop();
      fs.rmSync(directory, { recursive: true, force: true });
      fs.rmSync(registryDirectory, { recursive: true, force: true });
      fs.rmSync(projectA, { recursive: true, force: true });
      fs.rmSync(projectB, { recursive: true, force: true });
    }
  }
);

test(
  'a fingerprint-matching Studio from the same project is reused, not duplicated',
  { skip: process.platform === 'win32' },
  async () => {
    const { directory, recordDirectory, fakeNpxPath } = createFakeStudioNpx();
    const registryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-studio-registry-'));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-project-reuse-'));
    const url = 'postgresql://user:pw@localhost:5432/reuse_db';
    const port = await freePort();

    const shared = {
      PATH: `${directory}${path.delimiter}${process.env.PATH || ''}`,
      FAKE_STUDIO_RECORD_DIR: recordDirectory,
      SHARD_STUDIO_REGISTRY_DIR: registryDirectory,
      SHARD_STUDIO_BASE_PORT: String(port),
      SHARD_STUDIO_START_TIMEOUT_MS: '4000',
      SHARD_1_URL: url,
    };

    const first = startCli(shared, project);

    try {
      await waitFor(() => first.state.stdout.includes(`✅ shard_1  http://localhost:${port}`));
      const record = readRecord(recordDirectory, port);

      const second = startCli(shared, project);
      try {
        await waitFor(() =>
          second.state.stdout.includes(`♻️ shard_1  http://localhost:${port}`)
        );
        assert.equal(
          fs.existsSync(path.join(recordDirectory, `studio-${port + 1}.json`)),
          false,
          'no duplicate Studio was spawned'
        );
      } finally {
        await second.stop();
      }

      assert.equal(
        isProcessRunning(record.pid),
        true,
        'stopping the reusing command leaves the original Studio running'
      );
    } finally {
      await first.stop();
      fs.rmSync(directory, { recursive: true, force: true });
      fs.rmSync(registryDirectory, { recursive: true, force: true });
      fs.rmSync(project, { recursive: true, force: true });
    }
  }
);

test(
  'reports a startup timeout without claiming the shard started',
  { skip: process.platform === 'win32' },
  async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-sharding-timeout-'));
    const registryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-studio-registry-'));
    const fakeNpxPath = path.join(tempDirectory, 'npx');
    const port = await freePort();

    fs.writeFileSync(
      fakeNpxPath,
      '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n',
      { mode: 0o755 }
    );

    const cli = startCli({
      PATH: `${tempDirectory}${path.delimiter}${process.env.PATH || ''}`,
      SHARD_STUDIO_REGISTRY_DIR: registryDirectory,
      SHARD_STUDIO_BASE_PORT: String(port),
      SHARD_STUDIO_START_TIMEOUT_MS: '500',
      SHARD_STUDIO_STABILITY_MS: '50',
    });

    try {
      const result = await cli.closed;
      assert.equal(result.code, 0);
      assert.match(cli.state.stdout, /❌ shard_1  Failed to start/);
      assert.match(cli.state.stdout, /SHARD_STUDIO_VERBOSE=true/);
      assert.doesNotMatch(cli.state.stdout, /✅ shard_1/);
    } finally {
      await cli.stop();
      fs.rmSync(tempDirectory, { recursive: true, force: true });
      fs.rmSync(registryDirectory, { recursive: true, force: true });
    }
  }
);

test(
  'stops the full owned process group on SIGINT',
  { skip: process.platform === 'win32' },
  async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-sharding-shutdown-'));
    const registryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-studio-registry-'));
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
        "child.on('exit', (code) => process.exit(code || 0));",
        'setInterval(() => {}, 1000);',
      ].join('\n'),
      { mode: 0o755 }
    );

    const port = await freePort();
    const cli = startCli({
      PATH: `${tempDirectory}${path.delimiter}${process.env.PATH || ''}`,
      SHARD_STUDIO_REGISTRY_DIR: registryDirectory,
      SHARD_STUDIO_BASE_PORT: String(port),
      SHARD_STUDIO_START_TIMEOUT_MS: '2000',
      SHARD_STUDIO_STABILITY_MS: '100',
      SHARD_STUDIO_SHUTDOWN_TIMEOUT_MS: '1000',
    });

    try {
      await waitFor(() => cli.state.stdout.includes(`✅ shard_1  http://localhost:${port}`));
      await waitFor(() => fs.existsSync(pidPath));
      const studioPid = Number(fs.readFileSync(pidPath, 'utf8'));

      const exit = await cli.stop();

      await waitFor(() => !isProcessRunning(studioPid));
      assert.equal(exit.code, 0);
      assert.doesNotMatch(cli.state.stdout, /Stopping owned Studio processes|Stopped\./);
      assert.equal(cli.state.stderr, '');
    } finally {
      if (cli.child.exitCode === null && isProcessRunning(cli.child.pid)) {
        cli.child.kill('SIGKILL');
      }
      fs.rmSync(tempDirectory, { recursive: true, force: true });
      fs.rmSync(registryDirectory, { recursive: true, force: true });
    }
  }
);
