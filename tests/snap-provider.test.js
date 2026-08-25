/** @jest-environment node */

import crypto from 'node:crypto';
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

const DESKTOP_DESCRIPTOR_JSON = JSON.stringify({
  width: 1440,
  height: 900,
  deviceScaleFactor: 1,
  isMobile: false,
  hasTouch: false
});
const MOBILE_DESCRIPTOR_JSON = JSON.stringify({
  width: 390,
  height: 844,
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true
});

function overrideEnvironment(updates) {
  const previous = Object.fromEntries(
    Object.keys(updates).map((name) => [name, process.env[name]])
  );
  for (const [name, value] of Object.entries(updates)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

function useHostedBaselineEnvironment() {
  return overrideEnvironment({
    GITHUB_ACTIONS: 'true',
    GITHUB_REF_NAME: 'main',
    GITHUB_HEAD_REF: undefined,
    GITHUB_SHA: 'a'.repeat(40),
    GITHUB_WORKFLOW_REF: 'ranacseruet/codesamplez-tools/.github/workflows/ci.yml@refs/heads/main',
    GITHUB_RUN_NUMBER: '42'
  });
}

function baselineRunMetadata(overrides = {}) {
  return {
    runId: 'run_pub',
    projectId: 'test-project-42',
    purpose: 'baseline',
    refBranch: 'main',
    refSha: 'abc123def456',
    publicationWorkflowRef: 'ranacseruet/codesamplez-tools/.github/workflows/ci.yml@refs/heads/main',
    publicationSequence: 42,
    startedAt: '2026-08-24T00:00:00.000Z',
    configuredRouteIds: ['home'],
    selectedRouteIds: ['home'],
    expectedCaptures: [{
      routeId: 'home',
      routePath: '/',
      viewportDescriptorJson: DESKTOP_DESCRIPTOR_JSON
    }],
    ...overrides
  };
}

function twoRouteBaselineRunMetadata(overrides = {}) {
  return baselineRunMetadata({
    configuredRouteIds: ['home', 'about'],
    selectedRouteIds: ['home', 'about'],
    expectedCaptures: [
      { routeId: 'home', routePath: '/', viewportDescriptorJson: DESKTOP_DESCRIPTOR_JSON },
      { routeId: 'about', routePath: '/about', viewportDescriptorJson: MOBILE_DESCRIPTOR_JSON }
    ],
    ...overrides
  });
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

      const runMetadata = JSON.parse(await fs.readFile(result.resultsPath, 'utf-8'));
      expect(runMetadata).toMatchObject({
        projectId: 'test-project-42',
        purpose: 'diff',
        configuredRouteIds: ['home'],
        selectedRouteIds: ['home']
      });
      expect(runMetadata.expectedCaptures).toEqual([{
        routeId: 'home',
        routePath: '/',
        viewportDescriptorJson: DESKTOP_DESCRIPTOR_JSON
      }]);

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
    const restoreEnvironment = useHostedBaselineEnvironment();
    const expectedRef = {
      refBranch: 'main',
      refSha: 'a'.repeat(40),
      publicationWorkflowRef: 'ranacseruet/codesamplez-tools/.github/workflows/ci.yml@refs/heads/main',
      publicationSequence: 42
    };
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
      const result = await provider.capture({ configPath, routeIds: ['home'], purpose: 'baseline' });

      const latestGet = requests.find((r) => r.url.includes('/baselines/latest'));
      expect(latestGet).toBeUndefined();

      const runPost = requests.find((r) => r.url.includes('/runs') && !r.url.includes('/captures'));
      expect('baselineId' in runPost.body).toBe(false);
      // Suppress the server's auto-resolve-by-branch so a baseline run is never diffed.
      expect(runPost.body.skipBaselineResolution).toBe(true);
      expect(runPost.body.branch).toBe(expectedRef.refBranch);
      expect(runPost.body.prHeadSha).toBe(expectedRef.refSha);
      expect(runPost.body.capturePlan).toEqual({
        purpose: 'baseline',
        publicationWorkflowRef: expectedRef.publicationWorkflowRef,
        publicationSequence: expectedRef.publicationSequence,
        configuredRouteIds: ['home'],
        selectedRouteIds: ['home'],
        expectedCaptures: [{
          routeId: 'home',
          routePath: '/',
          viewportDescriptorJson: DESKTOP_DESCRIPTOR_JSON
        }]
      });

      const metadata = JSON.parse(await fs.readFile(result.resultsPath, 'utf-8'));
      expect(metadata).toMatchObject({
        purpose: 'baseline',
        refBranch: expectedRef.refBranch,
        refSha: expectedRef.refSha,
        publicationWorkflowRef: expectedRef.publicationWorkflowRef,
        publicationSequence: expectedRef.publicationSequence,
        configuredRouteIds: ['home'],
        selectedRouteIds: ['home']
      });
    } finally {
      restoreEnvironment();
      await fs.rm(configPath, { force: true });
    }
  });

  it('rejects a scoped hosted baseline before creating a run', async () => {
    const requests = [];
    const provider = new SnapProvider(validSnapConfig, {
      fetchFn: async (url) => {
        requests.push(url);
        return okResponse({});
      }
    });
    const configPath = path.join(os.tmpdir(), 'snapdrift-snap-partial-baseline-config.json');
    await fs.writeFile(configPath, JSON.stringify({
      baselineArtifactName: 'test',
      workingDirectory: '.',
      baseUrl: 'https://example.com',
      resultsFile: 'results.json',
      manifestFile: 'manifest.json',
      screenshotsRoot: 'screenshots',
      routes: [
        { id: 'home', path: '/', viewport: 'desktop' },
        { id: 'about', path: '/about', viewport: 'mobile' }
      ],
      diff: { threshold: 0.01, mode: 'report-only' }
    }));

    try {
      await expect(provider.capture({
        configPath,
        routeIds: ['home'],
        purpose: 'baseline'
      })).rejects.toThrow(/requires all 2 configured route\(s\).*only 1 were selected/);
      expect(requests).toEqual([]);
    } finally {
      await fs.rm(configPath, { force: true });
    }
  });

  it('rejects a complete hosted baseline without CI publication metadata', async () => {
    const restoreEnvironment = overrideEnvironment({
      GITHUB_ACTIONS: undefined,
      GITHUB_REF_NAME: undefined,
      GITHUB_HEAD_REF: undefined,
      GITHUB_SHA: undefined,
      GITHUB_WORKFLOW_REF: undefined,
      GITHUB_RUN_NUMBER: undefined,
      SNAPDRIFT_PUBLICATION_WORKFLOW_REF: undefined,
      SNAPDRIFT_PUBLICATION_SEQUENCE: undefined
    });
    const requests = [];
    const provider = new SnapProvider(validSnapConfig, {
      fetchFn: async (url) => {
        requests.push(url);
        return okResponse({});
      }
    });
    const configPath = path.join(os.tmpdir(), 'snapdrift-snap-non-ci-baseline-config.json');
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
      await expect(provider.capture({ configPath, purpose: 'baseline' }))
        .rejects.toThrow(/publication workflow identity.*publication sequence/);
      expect(requests).toEqual([]);
    } finally {
      restoreEnvironment();
      await fs.rm(configPath, { force: true });
    }
  });

  it('allows non-GitHub CI to publish with explicit publication metadata', async () => {
    const restoreEnvironment = overrideEnvironment({
      GITHUB_ACTIONS: undefined,
      GITHUB_REF_NAME: 'main',
      GITHUB_HEAD_REF: undefined,
      GITHUB_SHA: 'b'.repeat(40),
      GITHUB_WORKFLOW_REF: undefined,
      GITHUB_RUN_NUMBER: undefined,
      SNAPDRIFT_PUBLICATION_WORKFLOW_REF: 'gitlab/project/visual-baseline',
      SNAPDRIFT_PUBLICATION_SEQUENCE: '7'
    });
    const requests = [];
    const provider = new SnapProvider(validSnapConfig, {
      fetchFn: async (url, opts) => {
        requests.push({ url, body: opts?.body ? JSON.parse(opts.body) : null });
        return okResponse({});
      }
    });
    const configPath = path.join(os.tmpdir(), 'snapdrift-snap-explicit-ci-baseline-config.json');
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
      await provider.capture({ configPath, purpose: 'baseline' });
      const runPost = requests.find((request) => request.url.includes('/runs') && !request.url.includes('/captures'));
      expect(runPost.body.capturePlan).toMatchObject({
        publicationWorkflowRef: 'gitlab/project/visual-baseline',
        publicationSequence: 7
      });
    } finally {
      restoreEnvironment();
      await fs.rm(configPath, { force: true });
    }
  });

  it('allows a scoped non-publishing hosted capture outside GitHub Actions', async () => {
    const restoreEnvironment = overrideEnvironment({
      GITHUB_ACTIONS: undefined,
      GITHUB_REF_NAME: undefined,
      GITHUB_HEAD_REF: undefined,
      GITHUB_SHA: undefined,
      GITHUB_RUN_NUMBER: undefined
    });
    const requests = [];
    const provider = new SnapProvider(validSnapConfig, {
      fetchFn: async (url, opts) => {
        requests.push({
          url,
          method: opts?.method,
          body: opts?.body ? JSON.parse(opts.body) : null
        });
        return okResponse({});
      }
    });
    const configPath = path.join(os.tmpdir(), 'snapdrift-snap-scoped-capture-config.json');
    await fs.writeFile(configPath, JSON.stringify({
      baselineArtifactName: 'test',
      workingDirectory: '.',
      baseUrl: 'https://example.com',
      resultsFile: 'results.json',
      manifestFile: 'manifest.json',
      screenshotsRoot: 'screenshots',
      routes: [
        { id: 'home', path: '/', viewport: 'desktop' },
        { id: 'about', path: '/about', viewport: 'mobile' }
      ],
      diff: { threshold: 0.01, mode: 'report-only' }
    }));

    try {
      const result = await provider.capture({
        configPath,
        routeIds: ['home'],
        purpose: 'capture'
      });
      expect(requests.some((request) => request.url.includes('/baselines/latest'))).toBe(false);
      const runPost = requests.find(
        (request) => request.url.includes('/runs') && !request.url.includes('/captures')
      );
      expect(runPost.body.skipBaselineResolution).toBe(true);
      expect(runPost.body.capturePlan).toMatchObject({
        purpose: 'diff',
        configuredRouteIds: ['home', 'about'],
        selectedRouteIds: ['home']
      });
      const metadata = JSON.parse(await fs.readFile(result.resultsPath, 'utf8'));
      expect(metadata).toMatchObject({ purpose: 'capture', selectedRouteIds: ['home'] });
      expect(metadata.refBranch).toBeUndefined();
    } finally {
      restoreEnvironment();
      await fs.rm(configPath, { force: true });
    }
  });

  it('rejects a hosted baseline when GitHub Actions provides a non-commit SHA', async () => {
    const restoreEnvironment = overrideEnvironment({
      GITHUB_ACTIONS: 'true',
      GITHUB_REF_NAME: 'main',
      GITHUB_HEAD_REF: undefined,
      GITHUB_SHA: 'not-a-commit',
      GITHUB_RUN_NUMBER: '42'
    });
    const requests = [];
    const provider = new SnapProvider(validSnapConfig, {
      fetchFn: async (url) => {
        requests.push(url);
        return okResponse({});
      }
    });
    const configPath = path.join(os.tmpdir(), 'snapdrift-snap-invalid-sha-baseline-config.json');
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
      await expect(provider.capture({ configPath, purpose: 'baseline' }))
        .rejects.toThrow(/40-character commit SHA/);
      expect(requests).toEqual([]);
    } finally {
      restoreEnvironment();
      await fs.rm(configPath, { force: true });
    }
  });

  it('preserves route scoping for hosted PR-diff captures', async () => {
    const requests = [];
    const mockFetch = async (url, opts) => {
      requests.push({ url, method: opts?.method, body: opts?.body ? JSON.parse(opts.body) : null });
      if (url.includes('/baselines/latest')) return errorResponse(404, { error: 'no baseline' });
      return okResponse({});
    };
    const provider = new SnapProvider(validSnapConfig, { fetchFn: mockFetch });
    const configPath = path.join(os.tmpdir(), 'snapdrift-snap-scoped-diff-config.json');
    await fs.writeFile(configPath, JSON.stringify({
      baselineArtifactName: 'test',
      workingDirectory: '.',
      baseUrl: 'https://example.com',
      resultsFile: 'results.json',
      manifestFile: 'manifest.json',
      screenshotsRoot: 'screenshots',
      routes: [
        { id: 'home', path: '/', viewport: 'desktop' },
        { id: 'about', path: '/about', viewport: 'mobile' }
      ],
      diff: { threshold: 0.01, mode: 'report-only' }
    }));

    try {
      const result = await provider.capture({ configPath, routeIds: ['about'] });
      expect(result.selectedRouteIds).toEqual(['about']);
      const capturePosts = requests.filter((request) => /\/runs\/.+\/captures$/.test(request.url));
      expect(capturePosts).toHaveLength(1);
      expect(capturePosts[0].body.routeId).toBe('about');

      const metadata = JSON.parse(await fs.readFile(result.resultsPath, 'utf-8'));
      expect(metadata.configuredRouteIds).toEqual(['home', 'about']);
      expect(metadata.selectedRouteIds).toEqual(['about']);
      const runPost = requests.find((r) => r.url.includes('/runs') && !r.url.includes('/captures'));
      expect(runPost.body.capturePlan).toEqual({
        purpose: 'diff',
        configuredRouteIds: ['home', 'about'],
        selectedRouteIds: ['about'],
        expectedCaptures: [{
          routeId: 'about',
          routePath: '/about',
          viewportDescriptorJson: MOBILE_DESCRIPTOR_JSON
        }]
      });
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
      expect(rewrittenResults.configuredRouteIds).toEqual(['home']);
      expect(rewrittenResults.selectedRouteIds).toEqual(['home']);
      expect(rewrittenResults.expectedCaptures).toEqual([{
        routeId: 'home',
        routePath: '/',
        viewportDescriptorJson: DESKTOP_DESCRIPTOR_JSON
      }]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('local-upload baseline run omits the baseline so captures are never diffed', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-snap-local-baseline-'));
    const restoreEnvironment = useHostedBaselineEnvironment();
    const expectedRef = {
      refBranch: 'main',
      refSha: 'a'.repeat(40),
      publicationWorkflowRef: 'ranacseruet/codesamplez-tools/.github/workflows/ci.yml@refs/heads/main',
      publicationSequence: 42
    };
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
      expect(runPost.body.branch).toBe(expectedRef.refBranch);
      expect(runPost.body.prHeadSha).toBe(expectedRef.refSha);
      expect(runPost.body.capturePlan).toEqual({
        purpose: 'baseline',
        publicationWorkflowRef: expectedRef.publicationWorkflowRef,
        publicationSequence: expectedRef.publicationSequence,
        configuredRouteIds: ['home'],
        selectedRouteIds: ['home'],
        expectedCaptures: [{
          routeId: 'home',
          routePath: '/',
          viewportDescriptorJson: DESKTOP_DESCRIPTOR_JSON
        }]
      });

      const uploadPost = requests.find((r) => r.url.includes('/local-result'));
      expect(uploadPost).toBeDefined();

      const rewrittenResults = JSON.parse(await fs.readFile(
        path.join(tempDir, 'capture', 'results.json'),
        'utf-8'
      ));
      expect(rewrittenResults.refBranch).toBe(expectedRef.refBranch);
      expect(rewrittenResults.refSha).toBe(expectedRef.refSha);
      expect(rewrittenResults.publicationWorkflowRef).toBe(expectedRef.publicationWorkflowRef);
      expect(rewrittenResults.publicationSequence).toBe(expectedRef.publicationSequence);
    } finally {
      restoreEnvironment();
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
    let pollCount = 0;
    const mockFetch = async (url, opts) => {
      requests.push({ url, method: opts?.method, headers: opts?.headers, body: opts?.body ? JSON.parse(opts.body) : null });
      if (url.includes('/visual/runs/')) {
        const captures = [
          { routeId: 'home', routePath: '/', status: 'new', currentObjectKey: 'k/home/current.png', viewportDescriptorJson: DESKTOP_DESCRIPTOR_JSON },
          { routeId: 'about', routePath: '/about', status: 'new', currentObjectKey: 'k/about/current.png', viewportDescriptorJson: MOBILE_DESCRIPTOR_JSON }
        ];
        const responseCaptures = pollCount++ === 0
          ? [captures[0]]
          : (pollCount % 2 === 0 ? captures : captures.reverse());
        return okResponse({
          id: 'run_pub',
          status: 'new',
          captures: responseCaptures
        });
      }
      return okResponse({ id: 'bsl_new_1' });
    };

    const provider = new SnapProvider(validSnapConfig, { fetchFn: mockFetch, sleepFn: () => Promise.resolve() });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-snap-pub-new-'));
    const resultsPath = path.join(dir, 'results.json');
    await fs.writeFile(resultsPath, JSON.stringify(twoRouteBaselineRunMetadata()));
    const bundleDirs = [];
    try {
      bundleDirs.push(
        (await provider.publishBaseline({ resultsPath })).bundleDir,
        (await provider.publishBaseline({ resultsPath })).bundleDir
      );

      const baselinePosts = requests.filter((r) => r.method === 'POST' && /\/baselines$/.test(r.url));
      expect(baselinePosts).toHaveLength(2);
      expect(requests.filter((r) => r.method === 'GET' && r.url.includes('/visual/runs/run_pub')))
        .toHaveLength(3);
      expect(baselinePosts[0].body).toEqual(baselinePosts[1].body);
      expect(baselinePosts[0].headers['Idempotency-Key']).toBe('baseline-run_pub');
      expect(baselinePosts[1].headers['Idempotency-Key']).toBe('baseline-run_pub');

      const baselinePost = baselinePosts[0];
      const expectedBaselineId = `bsl_${crypto.createHash('sha256').update('run_pub').digest('hex').slice(0, 24)}`;
      expect(baselinePost.body).toMatchObject({
        id: expectedBaselineId,
        refBranch: 'main',
        refSha: 'abc123def456',
        publicationMode: 'complete',
        sourceRunId: 'run_pub'
      });
      const manifest = JSON.parse(baselinePost.body.manifestJson);
      expect(manifest.sourceRunId).toBe(baselinePost.body.sourceRunId);
      expect(manifest.routes.map((route) => route.routeId)).toEqual(['about', 'home']);
      expect(manifest.routes.find((route) => route.routeId === 'home')).toMatchObject({
        objectKey: 'k/home/current.png',
        viewportDescriptorJson: DESKTOP_DESCRIPTOR_JSON
      });
    } finally {
      await Promise.all(bundleDirs.map((bundleDir) => fs.rm(bundleDir, { recursive: true, force: true })));
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps polling an older terminal run while expected captures are still rendering', async () => {
    let pollCount = 0;
    const requests = [];
    const mockFetch = async (url, opts) => {
      requests.push({ url, method: opts?.method });
      if (url.includes('/visual/runs/')) {
        pollCount += 1;
        return okResponse({
          id: 'run_pub',
          status: 'new',
          captures: [{
            routeId: 'home',
            routePath: '/',
            status: pollCount < 5 ? 'rendering' : 'new',
            ...(pollCount < 5 ? {} : { currentObjectKey: 'k/home/current.png' }),
            viewportDescriptorJson: DESKTOP_DESCRIPTOR_JSON
          }]
        });
      }
      return okResponse({ id: 'bsl_new_1' });
    };
    const provider = new SnapProvider(validSnapConfig, {
      fetchFn: mockFetch,
      sleepFn: () => Promise.resolve()
    });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-snap-pub-slow-render-'));
    const resultsPath = path.join(dir, 'results.json');
    await fs.writeFile(resultsPath, JSON.stringify(baselineRunMetadata()));

    try {
      await expect(provider.publishBaseline({ resultsPath })).resolves.toBeDefined();
      expect(pollCount).toBe(5);
      expect(requests.some((request) => request.method === 'POST' && /\/baselines$/.test(request.url)))
        .toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('fails fast when a planned run has a stable incomplete capture set', async () => {
    let pollCount = 0;
    const requests = [];
    const mockFetch = async (url, opts) => {
      requests.push({ url, method: opts?.method });
      if (url.includes('/visual/runs/')) {
        pollCount += 1;
        return okResponse({
          id: 'run_pub',
          status: 'rendering',
          captures: [{
            routeId: 'home',
            routePath: '/',
            status: 'new',
            currentObjectKey: 'k/home/current.png',
            viewportDescriptorJson: DESKTOP_DESCRIPTOR_JSON
          }]
        });
      }
      return okResponse({});
    };
    const provider = new SnapProvider(validSnapConfig, {
      fetchFn: mockFetch,
      sleepFn: () => Promise.resolve()
    });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-snap-pub-stalled-'));
    const resultsPath = path.join(dir, 'results.json');
    await fs.writeFile(resultsPath, JSON.stringify(twoRouteBaselineRunMetadata()));

    try {
      await expect(provider.publishBaseline({ resultsPath }))
        .rejects.toThrow(/complete baseline publication requires "new"/);
      expect(pollCount).toBe(31);
      expect(requests.some((request) => request.method === 'POST' && /\/baselines$/.test(request.url))).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: 'a terminal error run',
      metadata: baselineRunMetadata(),
      runStatus: 'error',
      captures: [{
        routeId: 'home', routePath: '/', status: 'error',
        viewportDescriptorJson: DESKTOP_DESCRIPTOR_JSON
      }],
      expectedError: /complete baseline publication requires "new"/
    },
    {
      name: 'a failed capture',
      metadata: baselineRunMetadata(),
      captures: [{
        routeId: 'home', routePath: '/', status: 'error', currentObjectKey: 'k/home.png',
        viewportDescriptorJson: DESKTOP_DESCRIPTOR_JSON
      }],
      expectedError: /status "error"/
    },
    {
      name: 'a capture without currentObjectKey',
      metadata: baselineRunMetadata(),
      captures: [{
        routeId: 'home', routePath: '/', status: 'new',
        viewportDescriptorJson: DESKTOP_DESCRIPTOR_JSON
      }],
      expectedError: /has no currentObjectKey/
    },
    {
      name: 'a duplicate route/viewport identity',
      metadata: twoRouteBaselineRunMetadata(),
      captures: [
        { routeId: 'home', routePath: '/', status: 'new', currentObjectKey: 'k/home-1.png', viewportDescriptorJson: DESKTOP_DESCRIPTOR_JSON },
        { routeId: 'home', routePath: '/', status: 'new', currentObjectKey: 'k/home-2.png', viewportDescriptorJson: DESKTOP_DESCRIPTOR_JSON }
      ],
      expectedError: /duplicate source route\/viewport identity/
    },
    {
      name: 'a missing configured capture',
      metadata: twoRouteBaselineRunMetadata(),
      captures: [{
        routeId: 'home', routePath: '/', status: 'new', currentObjectKey: 'k/home.png',
        viewportDescriptorJson: DESKTOP_DESCRIPTOR_JSON
      }],
      expectedError: /has 1 capture\(s\), expected 2/
    },
    {
      name: 'an extra capture identity',
      metadata: baselineRunMetadata(),
      captures: [{
        routeId: 'about', routePath: '/about', status: 'new', currentObjectKey: 'k/about.png',
        viewportDescriptorJson: MOBILE_DESCRIPTOR_JSON
      }],
      expectedError: /unexpected route\/viewport capture/
    },
    {
      name: 'a source-project mismatch',
      metadata: baselineRunMetadata({ projectId: 'other-project' }),
      captures: [{
        routeId: 'home', routePath: '/', status: 'new', currentObjectKey: 'k/home.png',
        viewportDescriptorJson: DESKTOP_DESCRIPTOR_JSON
      }],
      expectedError: /belongs to project "other-project"/
    },
    {
      name: 'malformed expected-capture metadata',
      metadata: baselineRunMetadata({ expectedCaptures: [null] }),
      captures: [{
        routeId: 'home', routePath: '/', status: 'new', currentObjectKey: 'k/home.png',
        viewportDescriptorJson: DESKTOP_DESCRIPTOR_JSON
      }],
      expectedError: /duplicate or extra route "unknown"/
    }
  ])('fails closed without publishing when the run contains $name', async ({ metadata, runStatus = 'new', captures, expectedError }) => {
    const requests = [];
    const mockFetch = async (url, opts) => {
      requests.push({ url, method: opts?.method });
      if (url.includes('/visual/runs/')) {
        return okResponse({ id: metadata.runId, status: runStatus, captures });
      }
      return okResponse({});
    };
    const provider = new SnapProvider(validSnapConfig, { fetchFn: mockFetch, sleepFn: () => Promise.resolve() });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-snap-pub-invalid-'));
    const resultsPath = path.join(dir, 'results.json');
    await fs.writeFile(resultsPath, JSON.stringify(metadata));

    try {
      await expect(provider.publishBaseline({ resultsPath })).rejects.toThrow(expectedError);
      expect(requests.some((request) => request.method === 'POST' && /\/baselines$/.test(request.url))).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // Previously these fell through to a "legacy" branch that POSTed
  // manifest/results as objects — a body Snap has never read, which now returns
  // 400 unsupported_baseline_body. Failing with the real cause beats emitting a
  // request that is guaranteed to fail. See #109.
  it('fails with the real cause when results.json has no runId, without calling the API', async () => {
    const requests = [];
    const mockFetch = async (url) => {
      requests.push(url);
      return okResponse({});
    };
    const provider = new SnapProvider(validSnapConfig, { fetchFn: mockFetch, sleepFn: () => Promise.resolve() });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-snap-norunid-'));
    const resultsPath = path.join(dir, 'results.json');
    // A local-provider results.json: valid JSON, no runId.
    await fs.writeFile(resultsPath, JSON.stringify({ status: 'ok', screenshots: [] }));
    try {
      await expect(provider.publishBaseline({ resultsPath })).rejects.toThrow(/no run id found/);
      expect(requests).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('surfaces the read error when results.json is missing or unparseable', async () => {
    const provider = new SnapProvider(validSnapConfig, {
      fetchFn: async () => okResponse({}),
      sleepFn: () => Promise.resolve()
    });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-snap-badresults-'));
    try {
      // Missing file — the read error used to be swallowed by a bare catch.
      await expect(
        provider.publishBaseline({ resultsPath: path.join(dir, 'nope.json') })
      ).rejects.toThrow(/Could not read that file/);

      const badPath = path.join(dir, 'results.json');
      await fs.writeFile(badPath, '{not json');
      await expect(provider.publishBaseline({ resultsPath: badPath })).rejects.toThrow(
        /Could not read that file/
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('fails clearly when given neither resultsPath nor bundleDir', async () => {
    const provider = new SnapProvider(validSnapConfig, {
      fetchFn: async () => okResponse({}),
      sleepFn: () => Promise.resolve()
    });
    await expect(provider.publishBaseline({})).rejects.toThrow(
      /neither resultsPath nor bundleDir/
    );
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
    await provider.checkBaselineExists('abc123');
    expect(callCount).toBe(2);
  });

  it('does not retry on 4xx', async () => {
    let callCount = 0;
    const mockFetch = async (_url, _opts) => {
      callCount++;
      return errorResponse(401, { error: 'unauthorized' });
    };

    const provider = new SnapProvider(validSnapConfig, { fetchFn: mockFetch, sleepFn: () => Promise.resolve() });
    await expect(provider.checkBaselineExists('abc123'))
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
    await expect(provider.checkBaselineExists('abc123'))
      .rejects.toThrow(/Snap API 500/);
  });

  it('fallback-local mode throws SnapFallbackError on exhausted retries', async () => {
    const mockFetch = async () => errorResponse(500, { error: 'internal server error' });
    const provider = new SnapProvider({ ...validSnapConfig, onUnavailable: 'fallback-local' }, { fetchFn: mockFetch, sleepFn: () => Promise.resolve() });
    await expect(provider.checkBaselineExists('abc123'))
      .rejects.toBeInstanceOf(SnapFallbackError);
  });

  it('warn-and-skip mode throws SnapSkipError on exhausted retries', async () => {
    const mockFetch = async () => errorResponse(500, { error: 'internal server error' });
    const provider = new SnapProvider({ ...validSnapConfig, onUnavailable: 'warn-and-skip' }, { fetchFn: mockFetch, sleepFn: () => Promise.resolve() });
    await expect(provider.checkBaselineExists('abc123'))
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

describe('SnapProvider.migrateBaselineFromLocal() — removed in 0.7.0', () => {
  beforeEach(() => {
    process.env.SNAP_TEST_API_KEY = 'test-api-key-1234';
  });
  afterEach(() => {
    delete process.env.SNAP_TEST_API_KEY;
  });

  // Guards against reintroduction: the body it sent (manifest/results/screenshots
  // as objects) was never read by Snap, so it could only produce a baseline with
  // no stored pixels. Snap now rejects it with 400 unsupported_baseline_body.
  // publishBaseline() after capture() is the supported path.
  it('is no longer exposed on the provider', () => {
    const provider = new SnapProvider(validSnapConfig, {
      fetchFn: async () => okResponse({}),
      sleepFn: () => Promise.resolve()
    });

    expect(provider.migrateBaselineFromLocal).toBeUndefined();
    expect(typeof provider.publishBaseline).toBe('function');
  });
});

describe('SnapProvider.exportBaselines()', () => {
  beforeEach(() => {
    process.env.SNAP_TEST_API_KEY = 'test-api-key-1234';
  });
  afterEach(() => {
    delete process.env.SNAP_TEST_API_KEY;
  });

  // -- tar-building helpers (same plain ustar layout the Snap export endpoint emits) --

  function tarHeader(name, size) {
    const octal = (value, length) => value.toString(8).padStart(length - 1, '0') + '\0';
    const header = Buffer.alloc(512, 0);
    header.write(name.slice(0, 100), 0, 'utf8');
    header.write(octal(0o644, 8), 100, 'ascii');
    header.write(octal(0, 8), 108, 'ascii');
    header.write(octal(0, 8), 116, 'ascii');
    header.write(octal(size, 12), 124, 'ascii');
    header.write(octal(Math.floor(Date.now() / 1000), 12), 136, 'ascii');
    header.fill(' ', 148, 156);
    header.write('0', 156, 'ascii');
    header.write('ustar\0', 257, 'ascii');
    header.write('00', 263, 'ascii');
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(octal(checksum, 8), 148, 'ascii');
    return header;
  }

  function buildTar(entries) {
    const chunks = [];
    for (const entry of entries) {
      const body = typeof entry.body === 'string' ? Buffer.from(entry.body, 'utf8') : Buffer.from(entry.body);
      chunks.push(tarHeader(entry.name, body.length), body);
      const pad = (512 - (body.length % 512)) % 512;
      if (pad) chunks.push(Buffer.alloc(pad, 0));
    }
    chunks.push(Buffer.alloc(1024, 0));
    return Buffer.concat(chunks);
  }

  function tarResponse(buffer) {
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      text: async () => buffer.toString('utf-8')
    };
  }

  /** Minimal valid 2x3 PNG (IHDR only is enough for dimension parsing). */
  function tinyPng(width, height) {
    const png = Buffer.alloc(33, 0);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(13, 8); // IHDR length
    png.write('IHDR', 12, 'ascii');
    png.writeUInt32BE(width, 16);
    png.writeUInt32BE(height, 20);
    return png;
  }

  const DESKTOP_DESCRIPTOR_JSON = JSON.stringify({
    width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false
  });

  function makeBaseline(overrides = {}) {
    return {
      id: 'bsl_export_1',
      projectId: 'test-project-42',
      refBranch: 'main',
      refSha: 'abc123def456',
      status: 'accepted',
      createdAt: '2026-07-01T00:00:00.000Z',
      sourceManifest: {
        schemaVersion: 1,
        sourceRunId: 'run_src_1',
        routes: [{
          routeId: 'home',
          routePath: '/',
          viewportDescriptorJson: DESKTOP_DESCRIPTOR_JSON,
          objectKey: 'visual/p/home.png'
        }]
      },
      objects: [{ sourceKey: 'visual/p/home.png', archivePath: 'bsl_export_1/images/aaaa1111bbbb2222.png' }],
      ...overrides
    };
  }

  it('downloads the export tar and maps it to results/manifest/screenshots/engine', async () => {
    const png = tinyPng(2, 3);
    const baseline = makeBaseline();
    const tar = buildTar([
      { name: 'manifest.json', body: JSON.stringify({ project: { id: 'test-project-42', slug: 'test' }, baselines: [baseline] }) },
      { name: 'bsl_export_1/images/aaaa1111bbbb2222.png', body: png },
      { name: 'bsl_export_1/capture_profile.json', body: JSON.stringify({ schemaVersion: 1, engine: { name: 'snapdrift-local', version: 'v0' } }) },
      { name: 'MIGRATION_NOTES.md', body: '# notes\n' }
    ]);

    const requests = [];
    const mockFetch = async (url, opts) => {
      requests.push({ url, method: opts?.method, headers: opts?.headers });
      return tarResponse(tar);
    };

    const provider = new SnapProvider(validSnapConfig, { fetchFn: mockFetch, sleepFn: () => Promise.resolve() });
    const exported = await provider.exportBaselines();

    // Request shape
    expect(requests[0].url).toBe('https://snap.i2dev.com/v1/visual/projects/test-project-42/export');
    expect(requests[0].method).toBe('GET');
    expect(requests[0].headers['Authorization']).toBe('Bearer test-api-key-1234');

    // Screenshots: filename derived from the route id, bytes from the archive
    expect(exported.screenshots).toHaveLength(1);
    expect(exported.screenshots[0].filename).toBe('home.png');
    expect(Buffer.compare(exported.screenshots[0].data, png)).toBe(0);

    // Manifest entry references the same filename the caller will write,
    // with real image dimensions and the preset name round-tripped.
    const entry = exported.manifest.screenshots[0];
    expect(entry.id).toBe('home');
    expect(entry.path).toBe('/');
    expect(entry.imagePath).toBe('screenshots/home.png');
    expect(entry.viewport).toBe('desktop');
    expect(entry.width).toBe(2);
    expect(entry.height).toBe(3);
    expect(exported.manifest.captureProfile.engine.name).toBe('snapdrift-local');

    // Results mirror the manifest and carry migration provenance
    expect(exported.results.baselineId).toBe('bsl_export_1');
    expect(exported.results.headSha).toBe('abc123def456');
    expect(exported.results.refBranch).toBe('main');
    expect(exported.results.routes).toHaveLength(1);
    expect(exported.results.routes[0]).toMatchObject({
      id: 'home', path: '/', status: 'passed', imagePath: 'screenshots/home.png', width: 2, height: 3
    });

    // Engine passes through from the capture profile
    expect(exported.engine).toEqual({ name: 'snapdrift-local', version: 'v0' });
  });

  it('picks the newest accepted baseline of two by createdAt', async () => {
    const png = tinyPng(1, 1);
    const older = makeBaseline({
      id: 'bsl_old',
      createdAt: '2026-06-01T00:00:00.000Z',
      sourceManifest: {
        schemaVersion: 1,
        routes: [{ routeId: 'home', routePath: '/', viewportDescriptorJson: DESKTOP_DESCRIPTOR_JSON, objectKey: 'visual/p/old.png' }]
      },
      objects: [{ sourceKey: 'visual/p/old.png', archivePath: 'bsl_old/images/1111.png' }]
    });
    const newer = makeBaseline({
      id: 'bsl_new',
      createdAt: '2026-07-02T00:00:00.000Z',
      sourceManifest: {
        schemaVersion: 1,
        routes: [{ routeId: 'home', routePath: '/', viewportDescriptorJson: DESKTOP_DESCRIPTOR_JSON, objectKey: 'visual/p/new.png' }]
      },
      objects: [{ sourceKey: 'visual/p/new.png', archivePath: 'bsl_new/images/2222.png' }]
    });
    const tar = buildTar([
      // Older listed last so the pick is proven to come from createdAt, not array order.
      { name: 'manifest.json', body: JSON.stringify({ project: { id: 'p' }, baselines: [newer, older] }) },
      { name: 'bsl_old/images/1111.png', body: png },
      { name: 'bsl_new/images/2222.png', body: png },
      { name: 'bsl_old/capture_profile.json', body: '{}' },
      { name: 'bsl_new/capture_profile.json', body: JSON.stringify({ engine: { name: 'snapdrift-local', version: 'v0' } }) }
    ]);

    const provider = new SnapProvider(validSnapConfig, { fetchFn: async () => tarResponse(tar), sleepFn: () => Promise.resolve() });
    const exported = await provider.exportBaselines();

    expect(exported.results.baselineId).toBe('bsl_new');
    expect(exported.engine.name).toBe('snapdrift-local');
  });

  it('throws a clear error when the export has no accepted baselines', async () => {
    const tar = buildTar([
      { name: 'manifest.json', body: JSON.stringify({ project: { id: 'p' }, baselines: [] }) }
    ]);
    const provider = new SnapProvider(validSnapConfig, { fetchFn: async () => tarResponse(tar), sleepFn: () => Promise.resolve() });
    await expect(provider.exportBaselines())
      .rejects.toThrow(/no accepted baselines to export/);
  });

  it('throws a scope-specific error on 403', async () => {
    const mockFetch = async () => errorResponse(403, { error: 'insufficient scope', code: 'unauthorized_visual_scope' });
    const provider = new SnapProvider(validSnapConfig, { fetchFn: mockFetch, sleepFn: () => Promise.resolve() });
    await expect(provider.exportBaselines())
      .rejects.toThrow(/visual:export/);
  });

  it('throws a clear error for a legacy baseline with no source manifest', async () => {
    const legacy = makeBaseline({ sourceManifest: null, objects: [] });
    const tar = buildTar([
      { name: 'manifest.json', body: JSON.stringify({ project: { id: 'p' }, baselines: [legacy] }) },
      { name: 'bsl_export_1/capture_profile.json', body: '{}' }
    ]);
    const provider = new SnapProvider(validSnapConfig, { fetchFn: async () => tarResponse(tar), sleepFn: () => Promise.resolve() });
    await expect(provider.exportBaselines())
      .rejects.toThrow(/predates manifest tracking/);
  });
});
