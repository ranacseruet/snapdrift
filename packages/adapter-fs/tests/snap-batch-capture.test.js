import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import pngjs from 'pngjs';

import { runSnapBatchCapture } from '../src/snap-batch-capture.mjs';
import { runBaselineCapture } from '../src/capture.mjs';

const { PNG } = pngjs;

function createTestPng(width = 10, height = 10) {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 100;
    png.data[i + 1] = 150;
    png.data[i + 2] = 200;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

const DEFAULT_TEST_PNG = createTestPng(10, 10);

describe('@snapdrift/adapter-fs — runSnapBatchCapture', () => {
  let tempDir;
  let configPath;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snap-batch-test-'));
    configPath = path.join(tempDir, 'snapdrift.json');
  });

  afterEach(async () => {
    delete process.env.SNAP_API_KEY;
    delete process.env.SNAPDRIFT_CAPTURE_ENGINE;
    delete process.env.CUSTOM_KEY;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('rejects local baseUrl (localhost, 127.0.0.1, ::1)', async () => {
    process.env.SNAP_API_KEY = 'test-key';
    const config = {
      baselineArtifactName: 'baseline',
      workingDirectory: tempDir,
      baseUrl: 'http://localhost:3000',
      resultsFile: 'results.json',
      manifestFile: 'manifest.json',
      screenshotsRoot: 'screenshots',
      capture: 'snap',
      routes: [{ id: 'home', path: '/', viewport: 'desktop' }],
      diff: { threshold: 0.01, mode: 'report-only' }
    };
    await fs.writeFile(configPath, JSON.stringify(config));

    await expect(runSnapBatchCapture({ configPath })).rejects.toThrow(
      /Cannot use Snap Cloud batch capture with local baseUrl "http:\/\/localhost:3000"/
    );
  });

  test('rejects when API key is missing', async () => {
    const config = {
      baselineArtifactName: 'baseline',
      workingDirectory: tempDir,
      baseUrl: 'https://preview.example.com',
      resultsFile: 'results.json',
      manifestFile: 'manifest.json',
      screenshotsRoot: 'screenshots',
      capture: 'snap',
      routes: [{ id: 'home', path: '/', viewport: 'desktop' }],
      diff: { threshold: 0.01, mode: 'report-only' }
    };
    await fs.writeFile(configPath, JSON.stringify(config));

    await expect(runSnapBatchCapture({ configPath })).rejects.toThrow(
      /Missing or invalid API key for Snap Cloud batch screenshot capture/
    );
  });

  test('reads custom apiKeyEnv when configured', async () => {
    process.env.CUSTOM_KEY = 'custom-secret-key';
    const config = {
      baselineArtifactName: 'baseline',
      workingDirectory: tempDir,
      baseUrl: 'https://preview.example.com',
      resultsFile: 'results.json',
      manifestFile: 'manifest.json',
      screenshotsRoot: 'screenshots',
      capture: 'snap',
      snap: { apiKeyEnv: 'CUSTOM_KEY' },
      routes: [{ id: 'home', path: '/', viewport: 'desktop' }],
      diff: { threshold: 0.01, mode: 'report-only' }
    };
    await fs.writeFile(configPath, JSON.stringify(config));

    const mockFetch = async (url, options = {}) => {
      if (url.endsWith('/v1/screenshots') && options.method === 'POST') {
        expect(options.headers['Authorization']).toBe('Bearer custom-secret-key');
        return {
          ok: true,
          status: 200,
          json: async () => ({ batchId: 'batch_custom', status: 'queued' })
        };
      }
      if (url.endsWith('/v1/screenshots/batch_custom')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'completed',
            items: [{ status: 'succeeded', imageUrl: 'https://cdn.example.com/home.png', durationMs: 120 }]
          })
        };
      }
      if (url === 'https://cdn.example.com/home.png') {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => DEFAULT_TEST_PNG
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const result = await runSnapBatchCapture({ configPath, fetchFn: mockFetch, pollIntervalMs: 10 });
    expect(result.selectedRouteIds).toEqual(['home']);
  });

  test('successfully submits batch, polls status, and downloads images', async () => {
    process.env.SNAP_API_KEY = 'snap-test-token';
    const config = {
      baselineArtifactName: 'baseline',
      workingDirectory: tempDir,
      baseUrl: 'https://preview.example.com',
      resultsFile: 'results.json',
      manifestFile: 'manifest.json',
      screenshotsRoot: 'screenshots',
      capture: 'snap',
      routes: [
        { id: 'home', path: '/', viewport: 'desktop' },
        { id: 'mobile-pricing', path: '/pricing', viewport: 'mobile' }
      ],
      diff: { threshold: 0.01, mode: 'report-only' }
    };
    await fs.writeFile(configPath, JSON.stringify(config));

    let pollCount = 0;

    const mockFetch = async (url, options = {}) => {
      if (url.endsWith('/v1/screenshots') && options.method === 'POST') {
        const payload = JSON.parse(options.body);
        expect(payload.format).toBe('png');
        expect(payload.fullPage).toBe(true);
        expect(payload.items).toHaveLength(2);
        expect(payload.items[0]).toEqual({
          url: 'https://preview.example.com/',
          viewport: { width: 1440, height: 900 }
        });
        expect(payload.items[1]).toEqual({
          url: 'https://preview.example.com/pricing',
          viewport: { width: 390, height: 844 }
        });
        return {
          ok: true,
          status: 200,
          json: async () => ({ batchId: 'batch_456', status: 'queued' })
        };
      }

      if (url.endsWith('/v1/screenshots/batch_456')) {
        pollCount++;
        if (pollCount === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ status: 'running', items: [] })
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'completed',
            items: [
              { status: 'succeeded', imageUrl: 'https://cdn.example.com/home.png', durationMs: 150 },
              { status: 'succeeded', imageUrl: 'https://cdn.example.com/pricing.png', durationMs: 200 }
            ]
          })
        };
      }

      if (url === 'https://cdn.example.com/home.png' || url === 'https://cdn.example.com/pricing.png') {
        return { ok: true, status: 200, arrayBuffer: async () => DEFAULT_TEST_PNG };
      }

      throw new Error(`Unexpected URL: ${url}`);
    };

    const outDir = path.join(tempDir, 'output');
    const result = await runSnapBatchCapture({
      configPath,
      outDir,
      fetchFn: mockFetch,
      pollIntervalMs: 10
    });

    expect(result.selectedRouteIds).toEqual(['home', 'mobile-pricing']);
    expect(result.screenshotsRoot).toBe(outDir);

    // Verify manifest
    const manifest = JSON.parse(await fs.readFile(result.manifestPath, 'utf8'));
    expect(manifest.baseUrl).toBe('https://preview.example.com');
    expect(manifest.captureProfile.engine.name).toBe('snap-batch');
    expect(manifest.screenshots).toHaveLength(2);
    expect(manifest.screenshots[0]).toEqual({
      id: 'home',
      path: '/',
      viewport: 'desktop',
      imagePath: 'screenshots/home.png',
      width: 10,
      height: 10
    });
    expect(manifest.screenshots[1]).toEqual({
      id: 'mobile-pricing',
      path: '/pricing',
      viewport: 'mobile',
      imagePath: 'screenshots/mobile-pricing.png',
      width: 10,
      height: 10
    });

    // Verify results.json
    const results = JSON.parse(await fs.readFile(result.resultsPath, 'utf8'));
    expect(results.passed).toBe(true);
    expect(results.routes).toHaveLength(2);
    expect(results.routes[0].status).toBe('passed');
    expect(results.routes[1].status).toBe('passed');

    // Verify PNG files on disk
    const homeFile = await fs.readFile(path.join(outDir, 'screenshots', 'home.png'));
    expect(homeFile).toHaveLength(DEFAULT_TEST_PNG.length);
    const pricingFile = await fs.readFile(path.join(outDir, 'screenshots', 'mobile-pricing.png'));
    expect(pricingFile).toHaveLength(DEFAULT_TEST_PNG.length);
  });

  test('throws when an item in batch fails', async () => {
    process.env.SNAP_API_KEY = 'test-token';
    const config = {
      baselineArtifactName: 'baseline',
      workingDirectory: tempDir,
      baseUrl: 'https://preview.example.com',
      resultsFile: 'results.json',
      manifestFile: 'manifest.json',
      screenshotsRoot: 'screenshots',
      capture: 'snap',
      routes: [
        { id: 'home', path: '/', viewport: 'desktop' },
        { id: 'broken', path: '/broken', viewport: 'desktop' }
      ],
      diff: { threshold: 0.01, mode: 'report-only' }
    };
    await fs.writeFile(configPath, JSON.stringify(config));

    const mockFetch = async (url, options = {}) => {
      if (url.endsWith('/v1/screenshots') && options.method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ batchId: 'batch_err', status: 'queued' })
        };
      }
      if (url.endsWith('/v1/screenshots/batch_err')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'completed',
            items: [
              { status: 'succeeded', imageUrl: 'https://cdn.example.com/home.png' },
              { status: 'failed', error: { error: 'Navigation timeout', code: 'nav_timeout' } }
            ]
          })
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    await expect(runSnapBatchCapture({ configPath, fetchFn: mockFetch, pollIntervalMs: 10 }))
      .rejects.toThrow(/Route "broken" failed Snap Cloud batch capture: Navigation timeout/);
  });

  test('handles 401 unauthorized response', async () => {
    process.env.SNAP_API_KEY = 'bad-token';
    const config = {
      baselineArtifactName: 'baseline',
      workingDirectory: tempDir,
      baseUrl: 'https://preview.example.com',
      resultsFile: 'results.json',
      manifestFile: 'manifest.json',
      screenshotsRoot: 'screenshots',
      capture: 'snap',
      routes: [{ id: 'home', path: '/', viewport: 'desktop' }],
      diff: { threshold: 0.01, mode: 'report-only' }
    };
    await fs.writeFile(configPath, JSON.stringify(config));

    const mockFetch = async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: 'Unauthorized' })
    });

    await expect(runSnapBatchCapture({ configPath, fetchFn: mockFetch }))
      .rejects.toThrow(/Unauthorized: Missing or invalid SNAP_API_KEY/);
  });

  test('handles 429 rate limit response', async () => {
    process.env.SNAP_API_KEY = 'test-token';
    const config = {
      baselineArtifactName: 'baseline',
      workingDirectory: tempDir,
      baseUrl: 'https://preview.example.com',
      resultsFile: 'results.json',
      manifestFile: 'manifest.json',
      screenshotsRoot: 'screenshots',
      capture: 'snap',
      routes: [{ id: 'home', path: '/', viewport: 'desktop' }],
      diff: { threshold: 0.01, mode: 'report-only' }
    };
    await fs.writeFile(configPath, JSON.stringify(config));

    const mockFetch = async () => ({
      ok: false,
      status: 429,
      json: async () => ({ error: 'quota_exceeded' })
    });

    await expect(runSnapBatchCapture({ configPath, fetchFn: mockFetch }))
      .rejects.toThrow(/Rate limited: Snap Cloud batch screenshot request rejected \(quota_exceeded\)/);
  });

  test('retries on 500 error and recovers', async () => {
    process.env.SNAP_API_KEY = 'test-token';
    const config = {
      baselineArtifactName: 'baseline',
      workingDirectory: tempDir,
      baseUrl: 'https://preview.example.com',
      resultsFile: 'results.json',
      manifestFile: 'manifest.json',
      screenshotsRoot: 'screenshots',
      capture: 'snap',
      routes: [{ id: 'home', path: '/', viewport: 'desktop' }],
      diff: { threshold: 0.01, mode: 'report-only' }
    };
    await fs.writeFile(configPath, JSON.stringify(config));

    let pollAttempts = 0;

    const mockFetch = async (url, options = {}) => {
      if (url.endsWith('/v1/screenshots') && options.method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ batchId: 'batch_recovered', status: 'queued' })
        };
      }
      if (url.endsWith('/v1/screenshots/batch_recovered')) {
        pollAttempts++;
        if (pollAttempts === 1) {
          return { ok: false, status: 500, statusText: 'Internal Server Error' };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'completed',
            items: [{ status: 'succeeded', imageUrl: 'https://cdn.example.com/recovered.png' }]
          })
        };
      }
      if (url === 'https://cdn.example.com/recovered.png') {
        return { ok: true, status: 200, arrayBuffer: async () => DEFAULT_TEST_PNG };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const result = await runSnapBatchCapture({ configPath, fetchFn: mockFetch, pollIntervalMs: 10 });
    expect(pollAttempts).toBe(2);
    expect(result.selectedRouteIds).toEqual(['home']);
  });

  test('delegates from runBaselineCapture when config has capture: "snap"', async () => {
    process.env.SNAP_API_KEY = 'test-token';
    const config = {
      baselineArtifactName: 'baseline',
      workingDirectory: tempDir,
      baseUrl: 'https://preview.example.com',
      resultsFile: 'results.json',
      manifestFile: 'manifest.json',
      screenshotsRoot: 'screenshots',
      capture: 'snap',
      routes: [{ id: 'home', path: '/', viewport: 'desktop' }],
      diff: { threshold: 0.01, mode: 'report-only' }
    };
    await fs.writeFile(configPath, JSON.stringify(config));

    const mockFetch = async (url, options = {}) => {
      if (typeof url === 'string' && url.endsWith('/v1/screenshots') && options.method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ batchId: 'batch_delegated', status: 'queued' })
        };
      }
      if (typeof url === 'string' && url.endsWith('/v1/screenshots/batch_delegated')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'completed',
            items: [{ status: 'succeeded', imageUrl: 'https://cdn.example.com/delegated.png' }]
          })
        };
      }
      if (url === 'https://cdn.example.com/delegated.png') {
        return { ok: true, status: 200, arrayBuffer: async () => DEFAULT_TEST_PNG };
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    };

    const result = await runBaselineCapture({ configPath, fetchFn: mockFetch, pollIntervalMs: 10 });
    expect(result.selectedRouteIds).toEqual(['home']);
    const manifest = JSON.parse(await fs.readFile(result.manifestPath, 'utf8'));
    expect(manifest.captureProfile.engine.name).toBe('snap-batch');
  });

  test('SNAPDRIFT_CAPTURE_ENGINE=snap environment variable overrides config default', async () => {
    process.env.SNAP_API_KEY = 'test-token';
    process.env.SNAPDRIFT_CAPTURE_ENGINE = 'snap';
    const config = {
      baselineArtifactName: 'baseline',
      workingDirectory: tempDir,
      baseUrl: 'https://preview.example.com',
      resultsFile: 'results.json',
      manifestFile: 'manifest.json',
      screenshotsRoot: 'screenshots',
      routes: [{ id: 'home', path: '/', viewport: 'desktop' }],
      diff: { threshold: 0.01, mode: 'report-only' }
    };
    await fs.writeFile(configPath, JSON.stringify(config));

    const mockFetch = async (url, options = {}) => {
      if (typeof url === 'string' && url.endsWith('/v1/screenshots') && options.method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ batchId: 'batch_env_override', status: 'queued' })
        };
      }
      if (typeof url === 'string' && url.endsWith('/v1/screenshots/batch_env_override')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'completed',
            items: [{ status: 'succeeded', imageUrl: 'https://cdn.example.com/env.png' }]
          })
        };
      }
      if (url === 'https://cdn.example.com/env.png') {
        return { ok: true, status: 200, arrayBuffer: async () => DEFAULT_TEST_PNG };
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    };

    const result = await runBaselineCapture({ configPath, fetchFn: mockFetch, pollIntervalMs: 10 });
    expect(result.selectedRouteIds).toEqual(['home']);
    const manifest = JSON.parse(await fs.readFile(result.manifestPath, 'utf8'));
    expect(manifest.captureProfile.engine.name).toBe('snap-batch');
  });

  test('handles nested resultsFile and manifestFile paths without duplicate nesting', async () => {
    process.env.SNAP_API_KEY = 'test-token';
    const config = {
      baselineArtifactName: 'baseline',
      workingDirectory: tempDir,
      baseUrl: 'https://preview.example.com',
      resultsFile: 'qa-artifacts/snapdrift/baseline/current/results.json',
      manifestFile: 'qa-artifacts/snapdrift/baseline/current/manifest.json',
      screenshotsRoot: 'qa-artifacts/snapdrift/baseline/current',
      capture: 'snap',
      routes: [
        { id: 'home', path: '/', viewport: 'desktop', navigationTimeout: 45000 }
      ],
      diff: { threshold: 0.01, mode: 'report-only' }
    };
    await fs.writeFile(configPath, JSON.stringify(config));

    let capturedPostItem;
    const mockFetch = async (url, options = {}) => {
      if (typeof url === 'string' && url.endsWith('/v1/screenshots') && options.method === 'POST') {
        const body = JSON.parse(options.body);
        capturedPostItem = body.items[0];
        return {
          ok: true,
          status: 200,
          json: async () => ({ batchId: 'batch_nested', status: 'queued' })
        };
      }
      if (typeof url === 'string' && url.endsWith('/v1/screenshots/batch_nested')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'completed',
            items: [{ status: 'succeeded', imageUrl: 'https://cdn.example.com/nested.png', durationMs: 120 }]
          })
        };
      }
      if (url === 'https://cdn.example.com/nested.png') {
        return { ok: true, status: 200, arrayBuffer: async () => DEFAULT_TEST_PNG };
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    };

    const result = await runSnapBatchCapture({ configPath, fetchFn: mockFetch, pollIntervalMs: 10 });

    const expectedResultsPath = path.join(tempDir, 'qa-artifacts/snapdrift/baseline/current/results.json');
    const expectedManifestPath = path.join(tempDir, 'qa-artifacts/snapdrift/baseline/current/manifest.json');
    const expectedScreenshotsRoot = path.join(tempDir, 'qa-artifacts/snapdrift/baseline/current');

    expect(result.resultsPath).toBe(expectedResultsPath);
    expect(result.manifestPath).toBe(expectedManifestPath);
    expect(result.screenshotsRoot).toBe(expectedScreenshotsRoot);

    // Verify navTimeoutMs was passed from navigationTimeout
    expect(capturedPostItem.navTimeoutMs).toBe(45000);

    // Verify files were actually written to disk at the expected paths
    const writtenResults = JSON.parse(await fs.readFile(expectedResultsPath, 'utf8'));
    expect(writtenResults.engine).toBe('snap-batch');
    expect(writtenResults.routes[0].id).toBe('home');

    const writtenManifest = JSON.parse(await fs.readFile(expectedManifestPath, 'utf8'));
    expect(writtenManifest.captureProfile.engine.name).toBe('snap-batch');
    expect(writtenManifest.screenshots[0].id).toBe('home');
  });

  test('writes flat files when outDir is provided', async () => {
    process.env.SNAP_API_KEY = 'test-token';
    const outDir = path.join(tempDir, 'custom-flat-out');
    const config = {
      baselineArtifactName: 'baseline',
      workingDirectory: tempDir,
      baseUrl: 'https://preview.example.com',
      resultsFile: 'nested/dir/results.json',
      manifestFile: 'nested/dir/manifest.json',
      screenshotsRoot: 'nested/dir',
      capture: 'snap',
      routes: [{ id: 'home', path: '/', viewport: 'desktop' }],
      diff: { threshold: 0.01, mode: 'report-only' }
    };
    await fs.writeFile(configPath, JSON.stringify(config));

    const mockFetch = async (url, options = {}) => {
      if (typeof url === 'string' && url.endsWith('/v1/screenshots') && options.method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ batchId: 'batch_flat', status: 'queued' })
        };
      }
      if (typeof url === 'string' && url.endsWith('/v1/screenshots/batch_flat')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'completed',
            items: [{ status: 'succeeded', imageUrl: 'https://cdn.example.com/flat.png' }]
          })
        };
      }
      if (url === 'https://cdn.example.com/flat.png') {
        return { ok: true, status: 200, arrayBuffer: async () => DEFAULT_TEST_PNG };
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    };

    const result = await runSnapBatchCapture({ configPath, outDir, fetchFn: mockFetch, pollIntervalMs: 10 });
    expect(result.resultsPath).toBe(path.join(outDir, 'results.json'));
    expect(result.manifestPath).toBe(path.join(outDir, 'manifest.json'));
    expect(result.screenshotsRoot).toBe(outDir);
  });

  test('retries on 429 during polling and recovers', async () => {
    process.env.SNAP_API_KEY = 'test-token';
    const config = {
      baselineArtifactName: 'baseline',
      workingDirectory: tempDir,
      baseUrl: 'https://preview.example.com',
      resultsFile: 'results.json',
      manifestFile: 'manifest.json',
      screenshotsRoot: 'screenshots',
      capture: 'snap',
      routes: [{ id: 'home', path: '/', viewport: 'desktop' }],
      diff: { threshold: 0.01, mode: 'report-only' }
    };
    await fs.writeFile(configPath, JSON.stringify(config));

    let pollAttempts = 0;
    const mockFetch = async (url, options = {}) => {
      if (typeof url === 'string' && url.endsWith('/v1/screenshots') && options.method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ batchId: 'batch_429_test', status: 'queued' })
        };
      }
      if (typeof url === 'string' && url.endsWith('/v1/screenshots/batch_429_test')) {
        pollAttempts++;
        if (pollAttempts === 1) {
          return {
            ok: false,
            status: 429,
            statusText: 'Too Many Requests',
            headers: new Map([['retry-after', '1']]),
            json: async () => ({ error: 'too_many_inflight' })
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'completed',
            items: [{ status: 'succeeded', imageUrl: 'https://cdn.example.com/img429.png' }]
          })
        };
      }
      if (url === 'https://cdn.example.com/img429.png') {
        return { ok: true, status: 200, arrayBuffer: async () => DEFAULT_TEST_PNG };
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    };

    const result = await runSnapBatchCapture({ configPath, fetchFn: mockFetch, pollIntervalMs: 10 });
    expect(pollAttempts).toBe(2);
    expect(result.selectedRouteIds).toEqual(['home']);
  });
});

