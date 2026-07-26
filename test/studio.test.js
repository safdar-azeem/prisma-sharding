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

const SHARD_1_URL = 'postgresql://user:secret1@localhost:5432/project_shard_1';
const SHARD_2_URL = 'postgresql://user:secret2@localhost:5432/project_shard_2';

const createTestEnv = (overrides = {}) => {
  const env = { ...process.env };

  for (const key of Object.keys(env)) {
    if (key.startsWith('SHARD_') || key === 'DATABASE_URL') {
      delete env[key];
    }
  }

  const merged = {
    ...env,
    SHARD_COUNT: '2',
    SHARD_1_URL,
    SHARD_2_URL,
    SHARD_STUDIO_STABILITY_MS: '50',
    ...overrides,
  };

  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) {
      delete merged[key];
    }
  }

  return merged;
};

const listen = (server, port = 0) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });

const close = (server) => new Promise((resolve) => server.close(resolve));

const httpRequest = (port, options = {}) =>
  new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: options.path || '/',
        method: options.method || 'GET',
        headers: options.body
          ? { 'Content-Type': 'application/json', ...options.headers }
          : options.headers,
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (body += chunk));
        response.on('end', () => resolve({ status: response.statusCode, body }));
      }
    );

    request.once('error', reject);

    if (options.body) {
      request.write(JSON.stringify(options.body));
    }

    request.end();
  });

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

const waitFor = async (predicate, timeoutMs = 10000) => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
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

const makeRegistryDirectory = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), 'ps-studio-registry-'));

const readRegistry = (directory, port) =>
  JSON.parse(fs.readFileSync(path.join(directory, `port-${port}.json`), 'utf8'));

test('the host fingerprint identifies the project and its whole shard set, without credentials', () => {
  const base = {
    projectRoot: '/projects/a',
    schemaPath: '/projects/a/prisma/schema.prisma',
    targets: [
      { id: 'shard_1', url: 'postgresql://user:secret@localhost:5432/db_a' },
      { id: 'shard_2', url: 'postgresql://user:secret@localhost:5432/db_b' },
    ],
  };

  assert.equal(
    computeStudioFingerprint(base),
    computeStudioFingerprint({
      ...base,
      targets: base.targets.map((target) => ({
        ...target,
        url: target.url.replace('secret', 'DIFFERENT_PASSWORD'),
      })),
    }),
    'credentials never participate in the fingerprint'
  );

  assert.notEqual(
    computeStudioFingerprint(base),
    computeStudioFingerprint({ ...base, projectRoot: '/projects/b' }),
    'a different project is a different host'
  );

  assert.notEqual(
    computeStudioFingerprint(base),
    computeStudioFingerprint({ ...base, targets: [base.targets[0]] }),
    'dropping a shard is a different host'
  );

  assert.notEqual(
    computeStudioFingerprint(base),
    computeStudioFingerprint({ ...base, targets: [...base.targets].reverse() }),
    'reordering shards is a different host'
  );

  assert.doesNotMatch(computeStudioFingerprint(base), /secret/);
});

test(
  'one command produces exactly one Studio URL for all configured shards',
  { skip: process.platform === 'win32' },
  async () => {
    const registryDirectory = makeRegistryDirectory();
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-project-single-'));
    const port = await freePort();

    const cli = startCli(
      {
        SHARD_STUDIO_REGISTRY_DIR: registryDirectory,
        SHARD_STUDIO_BASE_PORT: String(port),
      },
      project
    );

    try {
      await waitFor(() => cli.state.stdout.includes(`📦 Studio  http://localhost:${port}`));

      const urls = cli.state.stdout.match(/http:\/\/localhost:\d+/g) || [];
      assert.equal(urls.length, 1, 'exactly one URL is printed');
      assert.doesNotMatch(cli.state.stdout, /databases available|Prisma Sharding Studio/);
      assert.doesNotMatch(cli.state.stdout, /secret1|secret2/);

      const identity = await httpRequest(port, { path: '/api/studio/identity' });
      assert.equal(identity.status, 200);
      assert.equal(JSON.parse(identity.body).product, 'prisma-studio-next');
      assert.equal(JSON.parse(identity.body).shardCount, 2);
    } finally {
      await cli.stop();
      fs.rmSync(registryDirectory, { recursive: true, force: true });
      fs.rmSync(project, { recursive: true, force: true });
    }
  }
);

test(
  'the shard manifest served to the browser carries no credentials',
  { skip: process.platform === 'win32' },
  async () => {
    const registryDirectory = makeRegistryDirectory();
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-project-manifest-'));
    const port = await freePort();

    const cli = startCli(
      {
        SHARD_STUDIO_REGISTRY_DIR: registryDirectory,
        SHARD_STUDIO_BASE_PORT: String(port),
      },
      project
    );

    try {
      await waitFor(() => cli.state.stdout.includes('📦 Studio'));

      const response = await httpRequest(port, { path: '/api/studio/shards' });
      assert.equal(response.status, 200);
      assert.doesNotMatch(response.body, /secret1|secret2/);
      assert.doesNotMatch(response.body, /postgresql:\/\//);

      const manifest = JSON.parse(response.body);
      assert.deepEqual(
        manifest.shards.map((shard) => shard.id),
        ['shard_1', 'shard_2']
      );
      assert.equal(manifest.defaultShardId, 'shard_1');
    } finally {
      await cli.stop();
      fs.rmSync(registryDirectory, { recursive: true, force: true });
      fs.rmSync(project, { recursive: true, force: true });
    }
  }
);

test(
  'the BFF rejects unknown shards, missing shards and client-supplied connection URLs',
  { skip: process.platform === 'win32' },
  async () => {
    const registryDirectory = makeRegistryDirectory();
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-project-bff-'));
    const port = await freePort();

    const cli = startCli(
      {
        SHARD_STUDIO_REGISTRY_DIR: registryDirectory,
        SHARD_STUDIO_BASE_PORT: String(port),
      },
      project
    );

    try {
      await waitFor(() => cli.state.stdout.includes('📦 Studio'));

      const query = { sql: 'select 1', parameters: [] };
      const post = (body, headers) =>
        httpRequest(port, { path: '/api/studio/bff', method: 'POST', body, headers });

      assert.equal(
        (await post({ procedure: 'query', query })).status,
        400,
        'a request without a shard is refused'
      );

      assert.equal(
        (await post({ procedure: 'query', query, customPayload: { shardId: 'shard_9' } })).status,
        404,
        'an unknown shard is refused before any database work'
      );

      assert.equal(
        (
          await post({
            procedure: 'query',
            query,
            customPayload: { shardId: 'shard_1', url: 'postgresql://evil@attacker/db' },
          })
        ).status,
        400,
        'a connection URL in the payload is refused outright'
      );

      assert.equal(
        (
          await post(
            { procedure: 'query', query, customPayload: { shardId: 'shard_1' } },
            { 'x-prisma-shard-id': 'shard_2' }
          )
        ).status,
        400,
        'conflicting shard hints are refused rather than silently resolved'
      );
    } finally {
      await cli.stop();
      fs.rmSync(registryDirectory, { recursive: true, force: true });
      fs.rmSync(project, { recursive: true, force: true });
    }
  }
);

test(
  'starts on the next free port and leaves an unrelated occupant untouched',
  { skip: process.platform === 'win32' },
  async () => {
    const registryDirectory = makeRegistryDirectory();
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-project-port-'));
    const unrelated = http.createServer((_request, response) => response.end('unrelated service'));
    const port = await listen(unrelated);

    const cli = startCli(
      {
        SHARD_STUDIO_REGISTRY_DIR: registryDirectory,
        SHARD_STUDIO_BASE_PORT: String(port),
      },
      project
    );

    try {
      await waitFor(() => cli.state.stdout.includes(`📦 Studio  http://localhost:${port + 1}`));
      assert.doesNotMatch(cli.state.stdout, /♻️/);

      const occupant = await httpRequest(port);
      assert.equal(occupant.body, 'unrelated service', 'the occupant is untouched');
    } finally {
      await cli.stop();
      await close(unrelated);
      fs.rmSync(registryDirectory, { recursive: true, force: true });
      fs.rmSync(project, { recursive: true, force: true });
    }
  }
);

test(
  'two projects with identical shard names stay fully isolated',
  { skip: process.platform === 'win32' },
  async () => {
    const registryDirectory = makeRegistryDirectory();
    const projectA = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-project-a-'));
    const projectB = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-project-b-'));
    const port = await freePort();

    const shared = {
      SHARD_STUDIO_REGISTRY_DIR: registryDirectory,
      SHARD_STUDIO_BASE_PORT: String(port),
    };

    const cliA = startCli(shared, projectA);

    try {
      await waitFor(() => cliA.state.stdout.includes(`📦 Studio  http://localhost:${port}`));
      const entryA = readRegistry(registryDirectory, port);

      // Same shard names, same preferred port, different project directory.
      const cliB = startCli(shared, projectB);

      try {
        await waitFor(() =>
          cliB.state.stdout.includes(`📦 Studio  http://localhost:${port + 1}`)
        );
        assert.doesNotMatch(
          cliB.state.stdout,
          /♻️/,
          "project B must never reuse project A's host"
        );

        const entryB = readRegistry(registryDirectory, port + 1);
        assert.notEqual(entryA.fingerprint, entryB.fingerprint);
        assert.equal(isProcessRunning(entryA.pid), true, "project A's host still runs");

        for (const output of [cliA.state.stdout, cliB.state.stdout]) {
          assert.doesNotMatch(output, /secret1|secret2/);
        }
      } finally {
        await cliB.stop();
      }

      // Stopping project B's command must not stop project A's host.
      const identity = await httpRequest(port, { path: '/api/studio/identity' });
      assert.equal(identity.status, 200, "A's host still answers after B stopped");
      assert.equal(isProcessRunning(entryA.pid), true, "B's shutdown left A untouched");
    } finally {
      await cliA.stop();
      fs.rmSync(registryDirectory, { recursive: true, force: true });
      fs.rmSync(projectA, { recursive: true, force: true });
      fs.rmSync(projectB, { recursive: true, force: true });
    }
  }
);

test(
  'a matching host from the same project is reused, not duplicated',
  { skip: process.platform === 'win32' },
  async () => {
    const registryDirectory = makeRegistryDirectory();
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-project-reuse-'));
    const port = await freePort();

    const shared = {
      SHARD_STUDIO_REGISTRY_DIR: registryDirectory,
      SHARD_STUDIO_BASE_PORT: String(port),
    };

    const first = startCli(shared, project);

    try {
      await waitFor(() => first.state.stdout.includes(`📦 Studio  http://localhost:${port}`));
      const entry = readRegistry(registryDirectory, port);

      const second = startCli(shared, project);

      try {
        await waitFor(() => second.state.stdout.includes(`📦 Studio  http://localhost:${port}`));
        assert.doesNotMatch(second.state.stdout, /♻️|databases available/);
        assert.equal(
          fs.existsSync(path.join(registryDirectory, `port-${port + 1}.json`)),
          false,
          'no duplicate host was started'
        );
      } finally {
        await second.stop();
      }

      assert.equal(
        isProcessRunning(entry.pid),
        true,
        'stopping the reusing command leaves the original host running'
      );
      assert.equal(
        fs.existsSync(path.join(registryDirectory, `port-${port}.json`)),
        true,
        "the reusing command did not remove the owner's registry entry"
      );
    } finally {
      await first.stop();
      fs.rmSync(registryDirectory, { recursive: true, force: true });
      fs.rmSync(project, { recursive: true, force: true });
    }
  }
);

test(
  'a host whose shard set changed is not reused',
  { skip: process.platform === 'win32' },
  async () => {
    const registryDirectory = makeRegistryDirectory();
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-project-changed-'));
    const port = await freePort();

    const first = startCli(
      { SHARD_STUDIO_REGISTRY_DIR: registryDirectory, SHARD_STUDIO_BASE_PORT: String(port) },
      project
    );

    try {
      await waitFor(() => first.state.stdout.includes(`📦 Studio  http://localhost:${port}`));

      // The same project, now configured with a third shard.
      const second = startCli(
        {
          SHARD_STUDIO_REGISTRY_DIR: registryDirectory,
          SHARD_STUDIO_BASE_PORT: String(port),
          SHARD_COUNT: '3',
          SHARD_3_URL: 'postgresql://user:secret3@localhost:5432/project_shard_3',
        },
        project
      );

      try {
        await waitFor(() =>
          second.state.stdout.includes(`📦 Studio  http://localhost:${port + 1}`)
        );
        assert.doesNotMatch(second.state.stdout, /♻️|databases available/);
        assert.match(second.state.stdout, new RegExp(`📦 Studio  http://localhost:${port + 1}`));
      } finally {
        await second.stop();
      }
    } finally {
      await first.stop();
      fs.rmSync(registryDirectory, { recursive: true, force: true });
      fs.rmSync(project, { recursive: true, force: true });
    }
  }
);

test(
  "shutdown releases the port and removes only this run's registry entry",
  { skip: process.platform === 'win32' },
  async () => {
    const registryDirectory = makeRegistryDirectory();
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-project-shutdown-'));
    const port = await freePort();

    const cli = startCli(
      {
        SHARD_STUDIO_REGISTRY_DIR: registryDirectory,
        SHARD_STUDIO_BASE_PORT: String(port),
        SHARD_STUDIO_SHUTDOWN_TIMEOUT_MS: '2000',
      },
      project
    );

    try {
      await waitFor(() => cli.state.stdout.includes('📦 Studio'));
      assert.equal(fs.existsSync(path.join(registryDirectory, `port-${port}.json`)), true);

      const exit = await cli.stop();

      assert.equal(exit.code, 0);
      assert.equal(
        fs.existsSync(path.join(registryDirectory, `port-${port}.json`)),
        false,
        'the registry entry is removed on shutdown'
      );
      assert.equal(cli.state.stderr, '', 'shutdown is silent on the happy path');

      // The port is genuinely free again: no server, socket or timer survived.
      const reclaimed = http.createServer();
      await listen(reclaimed, port);
      await close(reclaimed);
    } finally {
      if (cli.child.exitCode === null && isProcessRunning(cli.child.pid)) {
        cli.child.kill('SIGKILL');
      }
      fs.rmSync(registryDirectory, { recursive: true, force: true });
      fs.rmSync(project, { recursive: true, force: true });
    }
  }
);

test(
  'no configured databases is a sanitized error, not a half-started Studio',
  { skip: process.platform === 'win32' },
  async () => {
    const registryDirectory = makeRegistryDirectory();
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-project-empty-'));

    const cli = startCli(
      {
        SHARD_STUDIO_REGISTRY_DIR: registryDirectory,
        SHARD_COUNT: '0',
        SHARD_1_URL: undefined,
        SHARD_2_URL: undefined,
      },
      project
    );

    try {
      const result = await cli.closed;

      assert.equal(result.code, 1);
      assert.match(cli.state.stderr, /No databases configured/);
      assert.doesNotMatch(cli.state.stdout, /http:\/\/localhost/);
    } finally {
      await cli.stop();
      fs.rmSync(registryDirectory, { recursive: true, force: true });
      fs.rmSync(project, { recursive: true, force: true });
    }
  }
);

test(
  'a single configured shard still produces one Studio URL',
  { skip: process.platform === 'win32' },
  async () => {
    const registryDirectory = makeRegistryDirectory();
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-project-one-'));
    const port = await freePort();

    const cli = startCli(
      {
        SHARD_STUDIO_REGISTRY_DIR: registryDirectory,
        SHARD_STUDIO_BASE_PORT: String(port),
        SHARD_COUNT: '1',
        SHARD_2_URL: undefined,
        // The database count only appears in verbose output; the default is
        // deliberately just the URL.
        SHARD_STUDIO_VERBOSE: 'true',
      },
      project
    );

    try {
      await waitFor(() => cli.state.stdout.includes('📦 Studio'));
      assert.match(
        cli.state.stdout,
        /1 database available/,
        'a single shard is described in the singular'
      );
      assert.doesNotMatch(cli.state.stdout, /1 databases/);
    } finally {
      await cli.stop();
      fs.rmSync(registryDirectory, { recursive: true, force: true });
      fs.rmSync(project, { recursive: true, force: true });
    }
  }
);
