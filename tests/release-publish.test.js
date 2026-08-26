/** @jest-environment node */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jest } from '@jest/globals';

import {
  isDuplicateVersionFailure,
  isVersionPublished,
  publishPackage,
  readEnvOverrides,
  runMainIfCalled,
  registryVersionUrl
} from '../scripts/publish-package.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELPER_PATH = path.join(REPO_ROOT, 'scripts', 'publish-package.mjs');

function npmError(body, code) {
  const error = new Error(`npm error ${code ?? 'ERR'} ${body}`);
  error.stderr = `npm error ${code} ${body}`;
  error.stdout = '';
  if (code) {
    error.code = code;
  }
  return error;
}

// A minimal package.json is enough for readPackageMeta and for `npm publish` to pack against a mock
// registry. Each scenario gets its own directory so package state never leaks between tests.
function makeCwd({ name = 'mock-pkg', version = '1.0.0' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapdrift-publish-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version }, null, 2) + '\n'
  );
  return { dir, name, version };
}

function fakeFetch(status) {
  return async () => ({ status });
}

describe('registryVersionUrl', () => {
  it('encodes the scope slash for scoped packages', () => {
    expect(registryVersionUrl('https://registry.npmjs.org', '@snapdrift/manifest', '1.2.0')).toBe(
      'https://registry.npmjs.org/@snapdrift%2Fmanifest/1.2.0'
    );
  });

  it('leaves unscoped packages untouched and encodes the version', () => {
    expect(registryVersionUrl('https://registry.npmjs.org/', 'snapdrift', '0.8.2')).toBe(
      'https://registry.npmjs.org/snapdrift/0.8.2'
    );
  });
});

describe('isVersionPublished', () => {
  it('is true only for an existing (200) version', () => {
    expect(isVersionPublished({ status: 200 })).toBe(true);
  });

  it('is false for a not-yet-published (404) version', () => {
    expect(isVersionPublished({ status: 404 })).toBe(false);
  });
});

describe('isDuplicateVersionFailure', () => {
  it('classifies the "version already exists" duplicate response as idempotent', () => {
    expect(
      isDuplicateVersionFailure({
        message: '403 403 Conflict - PUT ... "version 1.0.0 already exists"'
      })
    ).toBe(true);
  });

  it('classifies an authentication failure as a real error', () => {
    expect(
      isDuplicateVersionFailure({ message: '403 403 Forbidden - you must log in to publish' })
    ).toBe(false);
  });

  it('classifies a missing message as a real error', () => {
    expect(isDuplicateVersionFailure({ message: '' })).toBe(false);
  });
});

describe('publishPackage (pure logic)', () => {
  it('skips publishing when the preflight lookup finds the version already published', async () => {
    const { dir } = makeCwd();
    const publishImpl = jest.fn();
    const result = await publishPackage({
      cwd: dir,
      registry: 'https://registry.npmjs.org',
      fetchImpl: fakeFetch(200),
      publishImpl
    });

    expect(result).toEqual({ skipped: true, published: false });
    expect(publishImpl).not.toHaveBeenCalled();
  });

  it('publishes when the version is new and publish succeeds', async () => {
    const { dir } = makeCwd();
    const result = await publishPackage({
      cwd: dir,
      registry: 'https://registry.npmjs.org',
      fetchImpl: fakeFetch(404),
      publishImpl: jest.fn()
    });

    expect(result).toEqual({ skipped: false, published: true });
  });

  it('treats a duplicate-version publish failure as idempotent (no job failure)', async () => {
    const { dir } = makeCwd();
    const result = await publishPackage({
      cwd: dir,
      registry: 'https://registry.npmjs.org',
      fetchImpl: fakeFetch(404),
      publishImpl: () => {
        throw npmError('version 1.0.0 already exists', 'E403');
      }
    });

    expect(result).toEqual({ skipped: true, published: false });
  });

  it('fails the job on an authentication error', async () => {
    const { dir } = makeCwd();
    await expect(
      publishPackage({
        cwd: dir,
        registry: 'https://registry.npmjs.org',
        fetchImpl: fakeFetch(404),
        publishImpl: () => {
          throw npmError('you must log in to publish packages', 'E403');
        }
      })
    ).rejects.toThrow(/you must log in/);
  });

  it('fails the job on a network/package failure', async () => {
    const { dir } = makeCwd();
    await expect(
      publishPackage({
        cwd: dir,
        registry: 'https://registry.npmjs.org',
        fetchImpl: fakeFetch(404),
        publishImpl: () => {
          throw npmError('network ECONNRESET while fetching package tarball', 'EFETCH');
        }
      })
    ).rejects.toThrow();
  });

  it('falls through a preflight network failure and still publishes', async () => {
    const { dir } = makeCwd();
    const result = await publishPackage({
      cwd: dir,
      registry: 'https://registry.npmjs.org',
      fetchImpl: async () => {
        throw new Error('registry unreachable');
      },
      publishImpl: jest.fn()
    });

    expect(result).toEqual({ skipped: false, published: true });
  });
});

// Install a fake `npm` executable (ahead of the real one on PATH) that simulates `npm publish`.
// Its exit code and stderr are driven by MOCK_PUT_STATUS / MOCK_PUT_BODY so the helper's narrow
// classification runs against realistic npm-style error output without contacting a registry.
function writeFakeNpm(dir) {
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const npm = path.join(binDir, 'npm');
  fs.writeFileSync(
    npm,
    [
      '#!/usr/bin/env node',
      '// Fake `npm publish` for the shell test. It requires the `publish` subcommand (so a missing',
      '// subcommand such as "npm --provenance" is caught rather than ignored) and drives the exit',
      '// code / stderr by MOCK_PUT_STATUS / MOCK_PUT_BODY to exercise the helper narrow classification offline.',
      'const args = process.argv.slice(2);',
      'if (args[0] !== "publish") {',
      '  const missing = args.length > 0 ? args[0] : "(none)";',
      '  process.stderr.write(`npm error Missing subcommand: expected "publish", got ${JSON.stringify(missing)}\\n`);',
      '  process.exit(1);',
      '}',
      'const status = Number(process.env.MOCK_PUT_STATUS ?? 201);',
      'const body = process.env.MOCK_PUT_BODY ?? \'\';',
      'if (status >= 200 && status < 300) { process.exit(0); }',
      'process.stderr.write(`npm error code E403\\nnpm error ${status} ${body}\\n`);',
      'process.exit(1);'
    ].join('\n') + '\n'
  );
  fs.chmodSync(npm, 0o755);
  return binDir;
}

async function runHelper(dir, { putStatus, putBody }) {
  // `http://127.0.0.1:9` is the discarded "discard" port, which nothing listens on locally, so the
  // preflight fetch fails with ECONNREFUSED instantly. (Binding and closing an ephemeral port
  // inside a Jest worker stalls on `server.close()`, so a fixed dead port is used instead.) The
  // refused connection fails preflight and the helper falls through to the faked `npm publish`.
  const registry = 'http://127.0.0.1:9';
  const binDir = writeFakeNpm(dir);
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    SNAPDRIFT_REGISTRY: registry,
    SNAPDRIFT_SKIP_PROVENANCE: '1',
    MOCK_PUT_STATUS: String(putStatus),
    MOCK_PUT_BODY: putBody ?? ''
  };
  // Async `spawn` (rather than the synchronous `spawnSync`) returns control to the event loop,
  // which avoids a deadlock that synchronous spawns hit inside Jest's worker.
  return new Promise((resolve) => {
    const child = spawn('node', [HELPER_PATH], { cwd: dir, env, stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timeout);
      resolve({ status: null, signal: null, stdout, stderr: `${stderr}${stderr ? '\n' : ''}${error.message}` });
    });
    child.on('close', (status) => {
      clearTimeout(timeout);
      resolve({ status, signal: null, stdout, stderr });
    });
  });
}

describe('readEnvOverrides', () => {
  it('uses the public registry and trusted-publishing args by default', () => {
    expect(readEnvOverrides({})).toEqual({
      registry: 'https://registry.npmjs.org',
      publishArgs: ['publish', '--provenance', '--access', 'public']
    });
  });

  it('points at a custom registry and drops provenance when skip is set', () => {
    expect(
      readEnvOverrides({ SNAPDRIFT_REGISTRY: 'http://localhost:5000', SNAPDRIFT_SKIP_PROVENANCE: '1' })
    ).toEqual({
      registry: 'http://localhost:5000',
      publishArgs: ['publish', '--registry', 'http://localhost:5000']
    });
  });

  it('keeps trusted-publishing args for a custom registry when not skipping', () => {
    expect(readEnvOverrides({ SNAPDRIFT_REGISTRY: 'http://localhost:5000' })).toEqual({
      registry: 'http://localhost:5000',
      publishArgs: ['publish', '--provenance', '--access', 'public']
    });
  });
});

describe('runMainIfCalled (CLI entry)', () => {
  it('fails the job (exitCode 1) when publish fails for a real reason', async () => {
    const savedExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const { dir } = makeCwd();
      await runMainIfCalled(process.env, {
        cwd: dir,
        publishImpl: () => {
          throw npmError('403 403 Forbidden - you must log in to publish', 'E403');
        }
      });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('leaves the exit code unset when publish succeeds', async () => {
    const savedExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const { dir } = makeCwd();
      await runMainIfCalled(process.env, { cwd: dir, publishImpl: () => {} });
      expect(process.exitCode).toBeUndefined();
    } finally {
      process.exitCode = savedExitCode;
    }
  });
});

describe('publish-package shell integration', () => {
  let dir;
  beforeEach(() => {
    ({ dir } = makeCwd({ name: 'mock-pkg', version: '1.0.0' }));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('skips (exit 0) when publish reports "version already exists" (idempotent)', async () => {
    const result = await runHelper(dir, { putStatus: 403, putBody: 'version 1.0.0 already exists' });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/already exists/);
  });

  it('publishes (exit 0) when publish succeeds', async () => {
    const result = await runHelper(dir, { putStatus: 201 });
    expect(result.status).toBe(0);
  });

  it('fails the job (non-zero) on an authentication error', async () => {
    const result = await runHelper(dir, { putStatus: 403, putBody: 'you must log in to publish packages' });
    expect(result.status).not.toBe(0);
  });

  it('fails the job (non-zero) on a network/package failure', async () => {
    const result = await runHelper(dir, { putStatus: 500, putBody: 'internal server error' });
    expect(result.status).not.toBe(0);
  });
});
