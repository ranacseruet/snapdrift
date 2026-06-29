/** @jest-environment node */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { SnapProvider, SnapApiError, SnapUnavailableError, SnapFallbackError, SnapSkipError, isLocalBaseUrl } = await import('../lib/snap-provider.mjs');

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

describe('isLocalBaseUrl()', () => {
  it('detects loopback and localhost URLs only', () => {
    expect(isLocalBaseUrl('http://localhost:3000')).toBe(true);
    expect(isLocalBaseUrl('http://app.localhost:3000')).toBe(true);
    expect(isLocalBaseUrl('http://127.0.0.1:3000')).toBe(true);
    expect(isLocalBaseUrl('http://127.42.0.9:3000')).toBe(true);
    expect(isLocalBaseUrl('http://[::1]:3000')).toBe(true);
    expect(isLocalBaseUrl('http://0.0.0.0:3000')).toBe(true);

    expect(isLocalBaseUrl('https://example.com')).toBe(false);
    expect(isLocalBaseUrl('http://10.0.0.5:3000')).toBe(false);
    expect(isLocalBaseUrl('not a url')).toBe(false);
  });
});

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
      baseUrl: 'https://example.com',
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
      // id is required by the Snap API
      expect(typeof runPost.body.id).toBe('string');
      expect(runPost.body.id).toMatch(/^run_/);
      // captureProfileJson is intentionally NOT sent: the render environment is
      // owned by Snap's render worker, and a partial profile makes the server's
      // capture-profile comparison crash with a 500 when a baseline is attached.
      expect('captureProfileJson' in runPost.body).toBe(false);
      // baseUrl must be forwarded so the render worker knows what to render
      expect(runPost.body.baseUrl).toBe('https://example.com');

      // Verify capture POST
      const capturePost = requests.find((r) => r.url.includes('/captures'));
      expect(capturePost).toBeDefined();
      expect(capturePost.headers['Authorization']).toBe('Bearer test-api-key-1234');
      // id and viewportDescriptorJson are required by the Snap API
      expect(typeof capturePost.body.id).toBe('string');
      expect(capturePost.body.id).toMatch(/^cap_/);
      // Server-rendered captures must NOT be flagged local — Snap renders them.
      expect(capturePost.body.localCapture).toBeUndefined();
      expect(typeof capturePost.body.viewportDescriptorJson).toBe('string');
      const parsedViewport = JSON.parse(capturePost.body.viewportDescriptorJson);
      expect(typeof parsedViewport.width).toBe('number');
      expect(typeof parsedViewport.height).toBe('number');
      // "desktop" preset should expand to 1440×900
      expect(parsedViewport.width).toBe(1440);
      expect(parsedViewport.height).toBe(900);
    } finally {
      await fs.rm(configPath, { force: true });
    }
  });

  it('attaches the latest accepted baseline id and branch to the run', async () => {
    const requests = [];
    const mockFetch = async (url, opts) => {
      requests.push({ url, method: opts?.method, body: opts?.body ? JSON.parse(opts.body) : null });
      if (url.includes('/baselines/latest')) {
        return okResponse({ id: 'bsl_latest_123', refBranch: 'main' });
      }
      if (url.includes('/runs/') && url.includes('/captures')) {
        return okResponse({ id: 'cap_1', status: 'pending' });
      }
      return okResponse({ id: 'run_abc123', status: 'pending', captures: [] });
    };

    process.env.GITHUB_HEAD_REF = 'feature/login';
    const provider = new SnapProvider(validSnapConfig, { fetchFn: mockFetch });
    const configPath = path.join(os.tmpdir(), 'snapdrift-snap-baseline-config.json');
    const config = {
      baselineArtifactName: 'test',
      workingDirectory: '.',
      baseUrl: 'https://example.com',
      resultsFile: 'results.json',
      manifestFile: 'manifest.json',
      screenshotsRoot: 'screenshots',
      routes: [{ id: 'home', path: '/', viewport: 'desktop' }],
      diff: { threshold: 0.01, mode: 'report-only' }
    };
    await fs.writeFile(configPath, JSON.stringify(config));
    try {
      await provider.capture({ configPath, routeIds: ['home'] });

      // Latest baseline is resolved before the run is created.
      const latestGet = requests.find((r) => r.url.includes('/baselines/latest'));
      expect(latestGet).toBeDefined();
      expect(latestGet.method).toBe('GET');

      const runPost = requests.find((r) => r.url.includes('/runs') && !r.url.includes('/captures'));
      expect(runPost.body.baselineId).toBe('bsl_latest_123');
      expect(runPost.body.branch).toBe('feature/login');
      // Diff runs must keep the server's baseline auto-resolution — only baseline
      // publishes opt out.
      expect('skipBaselineResolution' in runPost.body).toBe(false);
      // Regression guard: with a baseline attached the server runs a
      // capture-profile comparison; sending a partial profile 500s it.
      expect('captureProfileJson' in runPost.body).toBe(false);
    } finally {
      delete process.env.GITHUB_HEAD_REF;
      await fs.rm(configPath, { force: true });
    }
  });

  it('omits baselineId when no baseline exists yet (first run)', async () => {
    const requests = [];
    const mockFetch = async (url, opts) => {
      requests.push({ url, method: opts?.method, body: opts?.body ? JSON.parse(opts.body) : null });
      if (url.includes('/baselines/latest')) {
        return errorResponse(404, { error: 'no baseline' });
      }
      if (url.includes('/runs/') && url.includes('/captures')) {
        return okResponse({ id: 'cap_1', status: 'pending' });
      }
      return okResponse({ id: 'run_abc123', status: 'pending', captures: [] });
    };

    const provider = new SnapProvider(validSnapConfig, { fetchFn: mockFetch, sleepFn: () => Promise.resolve() });
    const configPath = path.join(os.tmpdir(), 'snapdrift-snap-firstrun-config.json');
    const config = {
      baselineArtifactName: 'test',
      workingDirectory: '.',
      baseUrl: 'https://example.com',
      resultsFile: 'results.json',
      manifestFile: 'manifest.json',
      screenshotsRoot: 'screenshots',
      routes: [{ id: 'home', path: '/', viewport: 'desktop' }],
      diff: { threshold: 0.01, mode: 'report-only' }
    };
    await fs.writeFile(configPath, JSON.stringify(config));
    try {
      await provider.capture({ configPath, routeIds: ['home'] });
      const runPost = requests.find((r) => r.url.includes('/runs') && !r.url.includes('/captures'));
      expect('baselineId' in runPost.body).toBe(false);
    } finally {
      await fs.rm(configPath, { force: true });
    }
  });

  it('omits the baseline (and skips the latest-baseline lookup) for a baseline-purpose run', async () => {
    const requests = [];
    const mockFetch = async (url, opts) => {
      requests.push({ url, method: opts?.method, body: opts?.body ? JSON.parse(opts.body) : null });
      // A baseline DOES exist — but a baseline-publish run must not diff against
      // it, so the provider should never even ask for it.
      if (url.includes('/baselines/latest')) {
        return okResponse({ id: 'bsl_existing_999', refBranch: 'main' });
      }
      if (url.includes('/runs/') && url.includes('/captures')) {
        return okResponse({ id: 'cap_1', status: 'pending' });
      }
      return okResponse({ id: 'run_abc123', status: 'pending', captures: [] });
    };

    const provider = new SnapProvider(validSnapConfig, { fetchFn: mockFetch });
    const configPath = path.join(os.tmpdir(), 'snapdrift-snap-baselinepurpose-config.json');
    const config = {
      baselineArtifactName: 'test',
      workingDirectory: '.',
      baseUrl: 'https://example.com',
      resultsFile: 'results.json',
      manifestFile: 'manifest.json',
      screenshotsRoot: 'screenshots',
      routes: [{ id: 'home', path: '/', viewport: 'desktop' }],
      diff: { threshold: 0.01, mode: 'report-only' }
    };
    await fs.writeFile(configPath, JSON.stringify(config));
    try {
      await provider.capture({ configPath, routeIds: ['home'], purpose: 'baseline' });

      const latestGet = requests.find((r) => r.url.includes('/baselines/latest'));
      expect(latestGet).toBeUndefined();

      const runPost = requests.find((r) => r.url.includes('/runs') && !r.url.includes('/captures'));
      expect('baselineId' in runPost.body).toBe(false);
      // Suppress the server's auto-resolve-by-branch so a baseline run is never diffed.
      expect(runPost.body.skipBaselineResolution).toBe(true);
    } finally {
      await fs.rm(configPath, { force: true });
    }
  });

  it('captures loopback baseUrl locally and uploads current PNGs to Snap', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-snap-local-'));
    const requests = [];
    const mockFetch = async (url, opts) => {
      requests.push({ url, method: opts?.method, headers: opts?.headers, body: opts?.body ? JSON.parse(opts.body) : null });
      if (url.includes('/baselines/latest')) {
        return errorResponse(404, { error: 'no baseline' });
      }
      if (url.includes('/runs/') && url.includes('/captures')) {
        return okResponse({ id: 'cap_1', status: 'pending' });
      }
      if (url.includes('/local-result')) {
        return okResponse({ id: 'cap_1', status: 'rendered' });
      }
      return okResponse({ id: 'run_abc123', status: 'pending', captures: [] });
    };

    const localCaptureFn = async () => {
      const screenshotsRoot = path.join(tempDir, 'capture');
      const screenshotsDir = path.join(screenshotsRoot, 'screenshots');
      await fs.mkdir(screenshotsDir, { recursive: true });
      await fs.writeFile(path.join(screenshotsDir, 'home.png'), 'png-bytes');
      const resultsPath = path.join(screenshotsRoot, 'results.json');
      const manifestPath = path.join(screenshotsRoot, 'manifest.json');
      await fs.writeFile(resultsPath, JSON.stringify({
        baseUrl: 'http://127.0.0.1:3000',
        routes: [{ id: 'home', status: 'passed', imagePath: 'screenshots/home.png' }]
      }));
      await fs.writeFile(manifestPath, JSON.stringify({
        baseUrl: 'http://127.0.0.1:3000',
        screenshots: [{
          id: 'home',
          path: '/',
          viewport: 'desktop',
          imagePath: 'screenshots/home.png',
          width: 1440,
          height: 900
        }]
      }));
      return {
        resultsPath,
        manifestPath,
        screenshotsRoot,
        selectedRouteIds: ['home']
      };
    };

    const provider = new SnapProvider(validSnapConfig, { fetchFn: mockFetch, localCaptureFn });
    const configPath = path.join(tempDir, 'snapdrift.json');
    const config = {
      baselineArtifactName: 'test',
      workingDirectory: '.',
      baseUrl: 'http://127.0.0.1:3000',
      resultsFile: 'results.json',
      manifestFile: 'manifest.json',
      screenshotsRoot: 'screenshots',
      routes: [{ id: 'home', path: '/', viewport: 'desktop' }],
      diff: { threshold: 0.01, mode: 'report-only' }
    };
    await fs.writeFile(configPath, JSON.stringify(config));

    try {
      const result = await provider.capture({ configPath, routeIds: ['home'] });
      expect(result.selectedRouteIds).toEqual(['home']);

      const runPost = requests.find((r) => r.url.includes('/runs') && !r.url.includes('/captures'));
      expect(runPost.body.baseUrl).toBe('http://127.0.0.1:3000');
      expect('captureProfileJson' in runPost.body).toBe(false);

      const capturePost = requests.find((r) => r.url.includes('/runs/') && r.url.includes('/captures'));
      expect(capturePost.body.routeId).toBe('home');
      // Locally-captured screenshots are uploaded, not rendered by Snap — the
      // capture must be flagged so the backend keeps it out of the render queue.
      expect(capturePost.body.localCapture).toBe(true);

      const uploadPost = requests.find((r) => r.url.includes('/local-result'));
      expect(uploadPost).toBeDefined();
      expect(uploadPost.body.imageBase64).toBe(Buffer.from('png-bytes').toString('base64'));
      expect(uploadPost.body.width).toBe(1440);
      expect(uploadPost.body.height).toBe(900);

      const rewrittenResults = JSON.parse(await fs.readFile(result.resultsPath, 'utf-8'));
      expect(rewrittenResults.provider).toBe('snap');
      expect(rewrittenResults.captureMode).toBe('local-upload');
      expect(rewrittenResults.runId).toMatch(/^run_/);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('local-upload baseline run omits the baseline so captures are never diffed', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-snap-local-baseline-'));
    const requests = [];
    const mockFetch = async (url, opts) => {
      requests.push({ url, method: opts?.method, body: opts?.body ? JSON.parse(opts.body) : null });
      // A baseline exists, but a baseline-publish run must not diff against it.
      if (url.includes('/baselines/latest')) {
        return okResponse({ id: 'bsl_existing_999', refBranch: 'main' });
      }
      if (url.includes('/runs/') && url.includes('/captures')) {
        return okResponse({ id: 'cap_1', status: 'pending' });
      }
      if (url.includes('/local-result')) {
        return okResponse({ id: 'cap_1', status: 'new' });
      }
      return okResponse({ id: 'run_abc123', status: 'pending', captures: [] });
    };

    const localCaptureFn = async () => {
      const screenshotsRoot = path.join(tempDir, 'capture');
      const screenshotsDir = path.join(screenshotsRoot, 'screenshots');
      await fs.mkdir(screenshotsDir, { recursive: true });
      await fs.writeFile(path.join(screenshotsDir, 'home.png'), 'png-bytes');
      const resultsPath = path.join(screenshotsRoot, 'results.json');
      const manifestPath = path.join(screenshotsRoot, 'manifest.json');
      await fs.writeFile(resultsPath, JSON.stringify({ baseUrl: 'http://127.0.0.1:3000', routes: [] }));
      await fs.writeFile(manifestPath, JSON.stringify({
        baseUrl: 'http://127.0.0.1:3000',
        screenshots: [{ id: 'home', path: '/', viewport: 'desktop', imagePath: 'screenshots/home.png', width: 1440, height: 900 }]
      }));
      return { resultsPath, manifestPath, screenshotsRoot, selectedRouteIds: ['home'] };
    };

    const provider = new SnapProvider(validSnapConfig, { fetchFn: mockFetch, localCaptureFn });
    const configPath = path.join(tempDir, 'snapdrift.json');
    await fs.writeFile(configPath, JSON.stringify({
      baselineArtifactName: 'test',
      workingDirectory: '.',
      baseUrl: 'http://127.0.0.1:3000',
      resultsFile: 'results.json',
      manifestFile: 'manifest.json',
      screenshotsRoot: 'screenshots',
      routes: [{ id: 'home', path: '/', viewport: 'desktop' }],
      diff: { threshold: 0.01, mode: 'report-only' }
    }));

    try {
      await provider.capture({ configPath, routeIds: ['home'], purpose: 'baseline' });

      const latestGet = requests.find((r) => r.url.includes('/baselines/latest'));
      expect(latestGet).toBeUndefined();

      const runPost = requests.find((r) => r.url.includes('/runs') && !r.url.includes('/captures'));
      expect('baselineId' in runPost.body).toBe(false);
      // Suppress the server's auto-resolve-by-branch so a baseline run is never diffed.
      expect(runPost.body.skipBaselineResolution).toBe(true);

      const uploadPost = requests.find((r) => r.url.includes('/local-result'));
      expect(uploadPost).toBeDefined();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('throws when local capture does not produce a selected route screenshot', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-snap-local-missing-'));
    const requests = [];
    const mockFetch = async (url, opts) => {
      requests.push({ url, method: opts?.method });
      if (url.includes('/baselines/latest')) {
        return errorResponse(404, { error: 'no baseline' });
      }
      return okResponse({ id: 'run_abc123', status: 'pending', captures: [] });
    };

    const localCaptureFn = async () => {
      const screenshotsRoot = path.join(tempDir, 'capture');
      await fs.mkdir(screenshotsRoot, { recursive: true });
      const resultsPath = path.join(screenshotsRoot, 'results.json');
      const manifestPath = path.join(screenshotsRoot, 'manifest.json');
      await fs.writeFile(resultsPath, JSON.stringify({ routes: [] }));
      await fs.writeFile(manifestPath, JSON.stringify({ screenshots: [] }));
      return {
        resultsPath,
        manifestPath,
        screenshotsRoot,
        selectedRouteIds: ['home']
      };
    };

    const provider = new SnapProvider(validSnapConfig, { fetchFn: mockFetch, localCaptureFn });
    const configPath = path.join(tempDir, 'snapdrift.json');
    await fs.writeFile(configPath, JSON.stringify({
      baselineArtifactName: 'test',
      workingDirectory: '.',
      baseUrl: 'http://127.0.0.1:3000',
      resultsFile: 'results.json',
      manifestFile: 'manifest.json',
      screenshotsRoot: 'screenshots',
      routes: [{ id: 'home', path: '/', viewport: 'desktop' }],
      diff: { threshold: 0.01, mode: 'report-only' }
    }));

    try {
      await expect(provider.capture({ configPath, routeIds: ['home'] }))
        .rejects.toThrow(/did not produce a screenshot for route "home"/);

      // Fail-fast guard: the missing screenshot must be detected before any run
      // is created, so Snap is never left with an orphaned run.
      const runCreatePost = requests.find((r) =>
        r.method === 'POST' && /\/projects\/.+\/runs$/.test(r.url));
      expect(runCreatePost).toBeUndefined();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// SnapProvider.diff() — run → summary mapping
// ---------------------------------------------------------------------------

describe('SnapProvider.diff() baseline mapping', () => {
  beforeEach(() => {
    process.env.SNAP_TEST_API_KEY = 'test-api-key-1234';
  });
  afterEach(() => {
    delete process.env.SNAP_TEST_API_KEY;
  });

  it('reports a capture with no baseline as missing (status incomplete), not matched', async () => {
    const mockFetch = async (url) => {
      if (url.includes('/visual/runs/')) {
        return okResponse({
          id: 'run_x',
          status: 'pass',
          captures: [
            // Rendered current but no baseline attached → server short-circuits to "diffed".
            { routeId: 'home', routePath: '/', status: 'diffed', currentObjectKey: 'k/current.png' }
          ]
        });
      }
      return okResponse({});
    };

    const provider = new SnapProvider(validSnapConfig, { fetchFn: mockFetch, sleepFn: () => Promise.resolve() });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-snap-diff-'));
    const resultsPath = path.join(dir, 'results.json');
    await fs.writeFile(resultsPath, JSON.stringify({ runId: 'run_x', projectId: 'test-project-42' }));
    const configPath = path.join(dir, 'config.json');
    await fs.writeFile(configPath, JSON.stringify({
      baselineArtifactName: 'test',
      workingDirectory: '.',
      baseUrl: 'https://example.com',
      resultsFile: 'results.json',
      manifestFile: 'manifest.json',
      screenshotsRoot: 'screenshots',
      routes: [{ id: 'home', path: '/', viewport: 'desktop' }],
      diff: { threshold: 0.01, mode: 'report-only' }
    }));
    try {
      const { summary } = await provider.diff({ configPath, currentResultsPath: resultsPath });
      expect(summary.missingInBaseline).toBe(1);
      expect(summary.matchedScreenshots).toBe(0);
      expect(summary.missing[0].location).toBe('baseline');
      expect(summary.status).toBe('incomplete');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('treats a terminal "new" run/capture as a missing baseline rather than polling forever', async () => {
    const mockFetch = async (url) => {
      if (url.includes('/visual/runs/')) {
        // No baseline existed, so the backend rendered the capture and settled
        // the run to the terminal "new" state. The client must stop polling.
        return okResponse({
          id: 'run_new',
          status: 'new',
          captures: [
            { routeId: 'home', routePath: '/', status: 'new', currentObjectKey: 'k/current.png' }
          ]
        });
      }
      return okResponse({});
    };

    const provider = new SnapProvider(validSnapConfig, { fetchFn: mockFetch, sleepFn: () => Promise.resolve() });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-snap-diff-new-'));
    const resultsPath = path.join(dir, 'results.json');
    await fs.writeFile(resultsPath, JSON.stringify({ runId: 'run_new', projectId: 'test-project-42' }));
    const configPath = path.join(dir, 'config.json');
    await fs.writeFile(configPath, JSON.stringify({
      baselineArtifactName: 'test',
      workingDirectory: '.',
      baseUrl: 'https://example.com',
      resultsFile: 'results.json',
      manifestFile: 'manifest.json',
      screenshotsRoot: 'screenshots',
      routes: [{ id: 'home', path: '/', viewport: 'desktop' }],
      diff: { threshold: 0.01, mode: 'report-only' }
    }));
    try {
      const { summary } = await provider.diff({ configPath, currentResultsPath: resultsPath });
      expect(summary.missingInBaseline).toBe(1);
      expect(summary.matchedScreenshots).toBe(0);
      expect(summary.missing[0].location).toBe('baseline');
      expect(summary.status).toBe('incomplete');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // Issue #93: a stale/wrong captured page diffs at 0% against the baseline,
  // silently hiding real regressions. Warn when every compared route is an
  // exact pixel-identical match.
  async function runDiffWith(captures) {
    const mockFetch = async (url) => {
      if (url.includes('/visual/runs/')) {
        return okResponse({ id: 'run_zero', status: 'pass', captures });
      }
      return okResponse({});
    };
    const provider = new SnapProvider(validSnapConfig, { fetchFn: mockFetch, sleepFn: () => Promise.resolve() });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-snap-diff-zero-'));
    const resultsPath = path.join(dir, 'results.json');
    await fs.writeFile(resultsPath, JSON.stringify({ runId: 'run_zero', projectId: 'test-project-42' }));
    const configPath = path.join(dir, 'config.json');
    await fs.writeFile(configPath, JSON.stringify({
      baselineArtifactName: 'test',
      workingDirectory: '.',
      baseUrl: 'https://example.com',
      resultsFile: 'results.json',
      manifestFile: 'manifest.json',
      screenshotsRoot: 'screenshots',
      routes: [{ id: 'home', path: '/', viewport: 'desktop' }],
      diff: { threshold: 0.01, mode: 'report-only' }
    }));
    const writes = [];
    const original = process.stderr.write;
    process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
    try {
      const { summary } = await provider.diff({ configPath, currentResultsPath: resultsPath });
      return { summary, stderr: writes.join('') };
    } finally {
      process.stderr.write = original;
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  it('warns when every compared route is a pixel-identical 0% match (stale-capture guard)', async () => {
    const { summary, stderr } = await runDiffWith([
      { routeId: 'home', routePath: '/', status: 'diffed', baselineObjectKey: 'b/home.png', currentObjectKey: 'c/home.png', diffPct: 0 },
      { routeId: 'about', routePath: '/about', status: 'diffed', baselineObjectKey: 'b/about.png', currentObjectKey: 'c/about.png', diffPct: 0 }
    ]);
    expect(summary.matchedScreenshots).toBe(2);
    expect(stderr).toMatch(/pixel-identical/);
    expect(stderr).toMatch(/issue #93/);
  });

  it('does not warn when at least one route shows non-zero drift', async () => {
    const { stderr } = await runDiffWith([
      { routeId: 'home', routePath: '/', status: 'diffed', baselineObjectKey: 'b/home.png', currentObjectKey: 'c/home.png', diffPct: 0 },
      { routeId: 'about', routePath: '/about', status: 'diffed', baselineObjectKey: 'b/about.png', currentObjectKey: 'c/about.png', diffPct: 0.005 }
    ]);
    expect(stderr).not.toMatch(/pixel-identical/);
  });

  it('does not warn for a single pixel-identical route (indistinguishable from a clean diff)', async () => {
    const { stderr } = await runDiffWith([
      { routeId: 'home', routePath: '/', status: 'diffed', baselineObjectKey: 'b/home.png', currentObjectKey: 'c/home.png', diffPct: 0 }
    ]);
    expect(stderr).not.toMatch(/pixel-identical/);
  });
});

// ---------------------------------------------------------------------------
// SnapProvider.publishBaseline() — run-poll path
// ---------------------------------------------------------------------------

describe('SnapProvider.publishBaseline() run-poll path', () => {
  beforeEach(() => {
    process.env.SNAP_TEST_API_KEY = 'test-api-key-1234';
  });
  afterEach(() => {
    delete process.env.SNAP_TEST_API_KEY;
  });

  it('publishes a baseline from a run that settles to terminal "new" (no prior baseline diffed)', async () => {
    const requests = [];
    const mockFetch = async (url, opts) => {
      requests.push({ url, method: opts?.method, body: opts?.body ? JSON.parse(opts.body) : null });
      if (url.includes('/visual/runs/')) {
        return okResponse({
          id: 'run_pub',
          status: 'new',
          captures: [
            { routeId: 'home', routePath: '/', status: 'new', currentObjectKey: 'k/home/current.png', viewportDescriptorJson: '{"width":1440,"height":900}' }
          ]
        });
      }
      return okResponse({ id: 'bsl_new_1' });
    };

    const provider = new SnapProvider(validSnapConfig, { fetchFn: mockFetch, sleepFn: () => Promise.resolve() });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-snap-pub-new-'));
    const resultsPath = path.join(dir, 'results.json');
    await fs.writeFile(resultsPath, JSON.stringify({ runId: 'run_pub', projectId: 'test-project-42' }));
    try {
      const result = await provider.publishBaseline({ resultsPath });
      expect(result.bundleDir).toBeTruthy();

      // A baseline create POST is issued from the rendered capture's object key.
      const baselinePost = requests.find((r) => r.method === 'POST' && /\/baselines$/.test(r.url));
      expect(baselinePost).toBeDefined();
      const manifest = JSON.parse(baselinePost.body.manifestJson);
      expect(manifest.routes[0].objectKey).toBe('k/home/current.png');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
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
      .rejects.toBeInstanceOf(SnapFallbackError);
  });

  it('warn-and-skip mode throws SnapSkipError on exhausted retries', async () => {
    const mockFetch = async () => errorResponse(500, { error: 'internal server error' });
    const provider = new SnapProvider({ ...validSnapConfig, onUnavailable: 'warn-and-skip' }, { fetchFn: mockFetch, sleepFn: () => Promise.resolve() });
    await expect(provider.publishBaseline({}))
      .rejects.toBeInstanceOf(SnapSkipError);
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

describe('SnapSkipError', () => {
  it('stores message', () => {
    const error = new SnapSkipError('skipping');
    expect(error.message).toBe('skipping');
    expect(error.name).toBe('SnapSkipError');
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

// ---------------------------------------------------------------------------
// SnapProvider — migration methods
// ---------------------------------------------------------------------------

describe('SnapProvider.checkBaselineExists()', () => {
  beforeEach(() => {
    process.env.SNAP_TEST_API_KEY = 'test-api-key-1234';
  });
  afterEach(() => {
    delete process.env.SNAP_TEST_API_KEY;
  });

  it('returns baseline data when found', async () => {
    const mockFetch = async () => okResponse({ id: 'baseline-1', headSha: 'abc123' });
    const provider = new SnapProvider(validSnapConfig, { fetchFn: mockFetch, sleepFn: () => Promise.resolve() });
    const result = await provider.checkBaselineExists('abc123');
    expect(result).toEqual({ id: 'baseline-1', headSha: 'abc123' });
  });

  it('returns null on 404', async () => {
    const mockFetch = async () => errorResponse(404, { error: 'not found' });
    const provider = new SnapProvider(validSnapConfig, { fetchFn: mockFetch, sleepFn: () => Promise.resolve() });
    const result = await provider.checkBaselineExists('nonexistent');
    expect(result).toBeNull();
  });
});

describe('SnapProvider.migrateBaselineFromLocal()', () => {
  beforeEach(() => {
    process.env.SNAP_TEST_API_KEY = 'test-api-key-1234';
  });
  afterEach(() => {
    delete process.env.SNAP_TEST_API_KEY;
  });

  it('POSTs baseline data with screenshots and returns result', async () => {
    const requests = [];
    const mockFetch = async (url, opts) => {
      requests.push({ url, method: opts?.method, body: opts?.body ? JSON.parse(opts.body) : null });
      return okResponse({ id: 'baseline-new-1' });
    };

    const provider = new SnapProvider(validSnapConfig, { fetchFn: mockFetch, sleepFn: () => Promise.resolve() });
    const result = await provider.migrateBaselineFromLocal({
      results: { routes: [], startedAt: new Date().toISOString() },
      manifest: { screenshots: [], generatedAt: new Date().toISOString() },
      screenshots: [{ filename: 'home.png', data: 'base64data' }],
      headSha: 'abc123def456'
    });

    expect(result.uploaded).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.baselineId).toBe('baseline-new-1');

    // Verify the POST request
    const post = requests[0];
    expect(post.method).toBe('POST');
    expect(post.body.idempotencyKey).toBe('baseline-migrate-abc123def456');
    expect(post.body.screenshots).toHaveLength(1);
    expect(post.body.headSha).toBe('abc123def456');
  });

  it('uses SHA-derived idempotency key', async () => {
    const requests = [];
    const mockFetch = async (url, opts) => {
      requests.push({ url, body: opts?.body ? JSON.parse(opts.body) : null });
      return okResponse({ id: 'b1' });
    };

    const provider = new SnapProvider(validSnapConfig, { fetchFn: mockFetch, sleepFn: () => Promise.resolve() });
    await provider.migrateBaselineFromLocal({
      results: {},
      manifest: {},
      screenshots: [],
      headSha: 'deadbeef'
    });

    expect(requests[0].body.idempotencyKey).toBe('baseline-migrate-deadbeef');
  });
});

describe('SnapProvider.exportBaselines()', () => {
  beforeEach(() => {
    process.env.SNAP_TEST_API_KEY = 'test-api-key-1234';
  });
  afterEach(() => {
    delete process.env.SNAP_TEST_API_KEY;
  });

  it('throws clear error (endpoint not yet available)', async () => {
    const provider = new SnapProvider(validSnapConfig);
    await expect(provider.exportBaselines())
      .rejects.toThrow(/not yet available/);
  });
});
