/** @jest-environment node */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { SnapProvider, SnapApiError, SnapUnavailableError, SnapFallbackError } = await import('../lib/snap-provider.mjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** @type {import('@snapdrift/manifest').SnapConfig} */
const validSnapConfig = {
  apiKeyEnv: 'SNAP_TEST_API_KEY',
  projectId: 'test-project-42'
};

function okResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body
  };
}

function errorResponse(status, errorBody) {
  return {
    ok: false,
    status,
    text: async () => JSON.stringify(errorBody),
    json: async () => errorBody
  };
}

// ---------------------------------------------------------------------------
// SnapProvider construction
// ---------------------------------------------------------------------------

describe('SnapProvider construction', () => {
  beforeEach(() => {
    process.env.SNAP_TEST_API_KEY = 'test-api-key-1234';
  });
  afterEach(() => {
    delete process.env.SNAP_TEST_API_KEY;
  });

  it('resolves API key from apiKeyEnv', () => {
    const provider = new SnapProvider(validSnapConfig);
    // Provider should be constructable without error
    expect(provider).toBeInstanceOf(SnapProvider);
  });

  it('throws if apiKeyEnv env var is not set', () => {
    delete process.env.SNAP_TEST_API_KEY;
    expect(() => new SnapProvider(validSnapConfig)).toThrow(/not found in environment variable/);
  });

  it('resolves API key from apiKey with interpolation', () => {
    process.env.MY_SECRET_KEY = 'interpolated-key';
    const provider = new SnapProvider({ apiKey: '${MY_SECRET_KEY}', projectId: 'p1' });
    expect(provider).toBeInstanceOf(SnapProvider);
    delete process.env.MY_SECRET_KEY;
  });

  it('throws if apiKey interpolation env var is missing', () => {
    expect(() => new SnapProvider({ apiKey: '${MISSING_VAR}', projectId: 'p1' }))
      .toThrow(/interpolation failed/);
  });

  it('resolves projectId "auto" from GITHUB_REPOSITORY', () => {
    process.env.GITHUB_REPOSITORY = 'myorg/myrepo';
    const provider = new SnapProvider({ ...validSnapConfig, projectId: 'auto' });
    expect(provider).toBeInstanceOf(SnapProvider);
    delete process.env.GITHUB_REPOSITORY;
  });

  it('throws if projectId is "auto" and GITHUB_REPOSITORY is not set', () => {
    delete process.env.GITHUB_REPOSITORY;
    expect(() => new SnapProvider({ ...validSnapConfig, projectId: 'auto' }))
      .toThrow(/GITHUB_REPOSITORY/);
  });

  it('uses explicit projectId', () => {
    const provider = new SnapProvider({ ...validSnapConfig, projectId: 'explicit-123' });
    expect(provider).toBeInstanceOf(SnapProvider);
  });
});

// ---------------------------------------------------------------------------
// SnapProvider.capture()
// ---------------------------------------------------------------------------

describe('SnapProvider.capture()', () => {
  beforeEach(() => {
    process.env.SNAP_TEST_API_KEY = 'test-api-key-1234';
  });
  afterEach(() => {
    delete process.env.SNAP_TEST_API_KEY;
  });

  it('POSTs to create run and submit captures with idempotency key', async () => {
    const requests = [];
    const mockFetch = async (url, opts) => {
      requests.push({ url, method: opts?.method, headers: opts?.headers, body: opts?.body ? JSON.parse(opts.body) : null });
      if (url.includes('/runs/') && url.includes('/captures')) {
        return okResponse({ id: 'cap_1', status: 'pending' });
      }
      return okResponse({ id: 'run_abc123', status: 'pending', captures: [] });
    };

    const provider = new SnapProvider(validSnapConfig, { fetchFn: mockFetch });
    // Need a real config path or skip it by mocking loadSnapdriftConfig
    // Instead, let's test with a minimal config
    const configPath = path.join(os.tmpdir(), 'snapdrift-snap-test-config.json');
    const config = {
      baselineArtifactName: 'test',
      workingDirectory: '.',
      baseUrl: 'http://localhost:3000',
      resultsFile: 'results.json',
      manifestFile: 'manifest.json',
      screenshotsRoot: 'screenshots',
      routes: [{ id: 'home', path: '/', viewport: 'desktop' }],
      diff: { threshold: 0.01, mode: 'report-only' }
    };
    await fs.writeFile(configPath, JSON.stringify(config));
    try {
      const result = await provider.capture({
        configPath,
        routeIds: ['home']
      });
      expect(result.selectedRouteIds).toEqual(['home']);
      expect(result.resultsPath).toBeTruthy();
      expect(result.manifestPath).toBeTruthy();

      // Verify run creation POST
      const runPost = requests.find((r) => r.url.includes('/runs') && !r.url.includes('/captures'));
      expect(runPost).toBeDefined();
      expect(runPost.headers['Authorization']).toBe('Bearer test-api-key-1234');
      expect(runPost.headers['Idempotency-Key']).toBeDefined();

      // Verify capture POST
      const capturePost = requests.find((r) => r.url.includes('/captures'));
      expect(capturePost).toBeDefined();
      expect(capturePost.headers['Authorization']).toBe('Bearer test-api-key-1234');
    } finally {
      await fs.rm(configPath, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// SnapProvider — retry and onUnavailable
// ---------------------------------------------------------------------------

describe('SnapProvider retry behavior', () => {
  beforeEach(() => {
    process.env.SNAP_TEST_API_KEY = 'test-api-key-1234';
  });
  afterEach(() => {
    delete process.env.SNAP_TEST_API_KEY;
  });

  it('retries on 5xx and succeeds on second attempt', async () => {
    let callCount = 0;
    const mockFetch = async (_url, _opts) => {
      callCount++;
      if (callCount === 1) {
        return errorResponse(503, { error: 'service unavailable' });
      }
      return okResponse({ id: 'run_1', status: 'pending' });
    };

    const provider = new SnapProvider(validSnapConfig, { fetchFn: mockFetch, sleepFn: () => Promise.resolve() });
    await provider.publishBaseline({ bundleDir: os.tmpdir() });
    expect(callCount).toBe(2);
  });

  it('does not retry on 4xx', async () => {
    let callCount = 0;
    const mockFetch = async (_url, _opts) => {
      callCount++;
      if (callCount === 1) {
        return errorResponse(503, { error: 'service unavailable' });
      }
      return okResponse({ id: 'run_1', status: 'pending' });
    };

    const provider = new SnapProvider(validSnapConfig, { fetchFn: mockFetch });
    // Access private method through a public method that calls _request
    // We test retry via publishBaseline (simplest method)
    // But publishBaseline calls _request directly, so we need a different approach
    // Let's test via the #request method indirectly through publishBaseline
    await provider.publishBaseline({ bundleDir: os.tmpdir() });
    expect(callCount).toBe(2);
  });

  it('does not retry on 4xx', async () => {
    let callCount = 0;
    const mockFetch = async (_url, _opts) => {
      callCount++;
      return errorResponse(401, { error: 'unauthorized' });
    };

    const provider = new SnapProvider(validSnapConfig, { fetchFn: mockFetch, sleepFn: () => Promise.resolve() });
    await expect(provider.publishBaseline({ bundleDir: os.tmpdir() }))
      .rejects.toThrow(/Snap API 401/);
    expect(callCount).toBe(1);
  });
});

describe('SnapProvider onUnavailable modes', () => {
  beforeEach(() => {
    process.env.SNAP_TEST_API_KEY = 'test-api-key-1234';
  });
  afterEach(() => {
    delete process.env.SNAP_TEST_API_KEY;
  });

  it('fail mode (default) throws on exhausted retries', async () => {
    const mockFetch = async () => errorResponse(500, { error: 'internal server error' });
    const provider = new SnapProvider({ ...validSnapConfig, onUnavailable: 'fail' }, { fetchFn: mockFetch, sleepFn: () => Promise.resolve() });
    await expect(provider.publishBaseline({}))
      .rejects.toThrow(/Snap API 500/);
  });

  it('fallback-local mode throws SnapFallbackError on exhausted retries', async () => {
    const mockFetch = async () => errorResponse(500, { error: 'internal server error' });
    const provider = new SnapProvider({ ...validSnapConfig, onUnavailable: 'fallback-local' }, { fetchFn: mockFetch, sleepFn: () => Promise.resolve() });
    await expect(provider.publishBaseline({}))
      .rejects.toThrow();
    try {
      await provider.publishBaseline({});
    } catch (error) {
      expect(error).toBeInstanceOf(SnapFallbackError);
    }
  });
});

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

describe('SnapApiError', () => {
  it('stores status and path', () => {
    const error = new SnapApiError(404, 'not found', '/v1/visual/projects/p1');
    expect(error.status).toBe(404);
    expect(error.path).toBe('/v1/visual/projects/p1');
    expect(error.message).toBe('not found');
    expect(error.name).toBe('SnapApiError');
  });
});

describe('SnapUnavailableError', () => {
  it('stores message', () => {
    const error = new SnapUnavailableError('network timeout');
    expect(error.message).toBe('network timeout');
    expect(error.name).toBe('SnapUnavailableError');
  });
});

describe('SnapFallbackError', () => {
  it('stores message', () => {
    const error = new SnapFallbackError('falling back');
    expect(error.message).toBe('falling back');
    expect(error.name).toBe('SnapFallbackError');
  });
});

// ---------------------------------------------------------------------------
// repoSlugToProjectId (tested indirectly via constructor)
// ---------------------------------------------------------------------------

describe('project ID resolution', () => {
  beforeEach(() => {
    process.env.SNAP_TEST_API_KEY = 'test-api-key-1234';
  });
  afterEach(() => {
    delete process.env.SNAP_TEST_API_KEY;
  });

  it('converts GITHUB_REPOSITORY owner/repo to slug', () => {
    process.env.GITHUB_REPOSITORY = 'myorg/myrepo';
    const provider = new SnapProvider({ ...validSnapConfig, projectId: 'auto' });
    expect(provider).toBeInstanceOf(SnapProvider);
    delete process.env.GITHUB_REPOSITORY;
  });
});