/** @jest-environment node */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';

// ---------------------------------------------------------------------------
// PNG / fixture helpers
// ---------------------------------------------------------------------------

/**
 * Creates a solid-colour PNG buffer.
 * @param {number} width
 * @param {number} height
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {Buffer}
 */
function createPng(width, height, r = 255, g = 255, b = 255) {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height * 4; i += 4) {
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

async function writePng(filePath, width, height, r, g, b) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, createPng(width, height, r, g, b));
}

/**
 * Minimal valid SnapDrift config.
 * @param {Array<{ id: string, path: string, viewport: string }>} routes
 * @param {{ mode?: string, threshold?: number, comparisonPolicy?: { version: 1, threshold: number } }} [diff]
 */
function makeConfig(routes, diff = {}) {
  return {
    baselineArtifactName: 'test-snapdrift-baseline',
    workingDirectory: '.',
    baseUrl: 'http://localhost:3000',
    resultsFile: 'qa-artifacts/snapdrift/baseline/current/results.json',
    manifestFile: 'qa-artifacts/snapdrift/baseline/current/manifest.json',
    screenshotsRoot: 'qa-artifacts/snapdrift/baseline/current',
    routes,
    diff: {
      threshold: diff.threshold ?? diff.comparisonPolicy?.threshold ?? 0.01,
      mode: diff.mode ?? 'report-only',
      ...(diff.comparisonPolicy ? { comparisonPolicy: diff.comparisonPolicy } : {})
    }
  };
}

/** @param {string[]} routeIds */
function makeResults(routeIds) {
  return {
    startedAt: new Date().toISOString(),
    baseUrl: 'http://localhost:3000',
    suite: 'snapdrift',
    routes: routeIds.map((id) => ({
      id,
      path: `/${id}`,
      viewport: 'desktop',
      status: 'passed',
      durationMs: 100
    }))
  };
}

function makeManifestEntry(id, viewport, imagePath, width, height) {
  return { id, path: `/${id}`, viewport, imagePath, width, height };
}

/**
 * Writes all fixture files needed by generateDriftReport / runDriftCheckCli.
 */
async function setupFixtures(tempDir, { routes, baselineEntries, currentEntries, baselinePngs = [], currentPngs = [], diffMode, threshold, comparisonPolicy }) {
  const configPath = path.join(tempDir, 'snapdrift.json');
  const baselineResultsPath = path.join(tempDir, 'baseline', 'results.json');
  const baselineManifestPath = path.join(tempDir, 'baseline', 'manifest.json');
  const currentResultsPath = path.join(tempDir, 'current', 'results.json');
  const currentManifestPath = path.join(tempDir, 'current', 'manifest.json');
  const baselineRunDir = path.join(tempDir, 'baseline');
  const currentRunDir = path.join(tempDir, 'current');

  await writeJson(configPath, makeConfig(routes, { mode: diffMode, threshold, comparisonPolicy }));
  await writeJson(baselineResultsPath, makeResults(routes.map((r) => r.id)));
  await writeJson(currentResultsPath, makeResults(routes.map((r) => r.id)));
  await writeJson(baselineManifestPath, {
    generatedAt: new Date().toISOString(),
    baseUrl: 'http://localhost',
    screenshots: baselineEntries.map((entry) => ({ ...entry, path: routes.find((route) => route.id === entry.id)?.path ?? entry.path }))
  });
  await writeJson(currentManifestPath, {
    generatedAt: new Date().toISOString(),
    baseUrl: 'http://localhost',
    screenshots: currentEntries.map((entry) => ({ ...entry, path: routes.find((route) => route.id === entry.id)?.path ?? entry.path }))
  });

  for (const { relPath, width, height, r, g, b } of baselinePngs) {
    await writePng(path.join(baselineRunDir, relPath), width, height, r, g, b);
  }
  for (const { relPath, width, height, r, g, b } of currentPngs) {
    await writePng(path.join(currentRunDir, relPath), width, height, r, g, b);
  }

  return {
    configPath,
    baselineResultsPath,
    baselineManifestPath,
    currentResultsPath,
    currentManifestPath,
    baselineRunDir,
    currentRunDir
  };
}

// ---------------------------------------------------------------------------
// Pure helper tests
// ---------------------------------------------------------------------------

describe('determineDriftStatus', () => {
  let determineDriftStatus;

  beforeAll(async () => {
    ({ determineDriftStatus } = await import('../lib/compare-results.mjs'));
  });

  const base = {
    errors: [],
    dimensionChanges: [],
    missingInBaseline: 0,
    missingInCurrent: 0,
    changedScreenshots: 0
  };

  it('returns incomplete when there are errors', () => {
    expect(
      determineDriftStatus({
        ...base,
        errors: [{ id: 'x', status: 'error', message: 'oops' }]
      })
    ).toBe('incomplete');
  });

  it('returns incomplete when there are dimension changes', () => {
    expect(
      determineDriftStatus({
        ...base,
        dimensionChanges: [{ id: 'x', status: 'dimension-changed' }]
      })
    ).toBe('incomplete');
  });

  it('returns incomplete when there are screenshots missing in baseline', () => {
    expect(determineDriftStatus({ ...base, missingInBaseline: 1 })).toBe('incomplete');
  });

  it('returns incomplete when there are screenshots missing in current', () => {
    expect(determineDriftStatus({ ...base, missingInCurrent: 1 })).toBe('incomplete');
  });

  it('returns changes-detected when changedScreenshots > 0', () => {
    expect(determineDriftStatus({ ...base, changedScreenshots: 2 })).toBe('changes-detected');
  });

  it('returns clean when everything is fine', () => {
    expect(determineDriftStatus(base)).toBe('clean');
  });
});

// ---------------------------------------------------------------------------

describe('shouldFailDriftCheck', () => {
  let shouldFailDriftCheck;

  beforeAll(async () => {
    ({ shouldFailDriftCheck } = await import('../lib/compare-results.mjs'));
  });

  const clean = {
    errors: [],
    dimensionChanges: [],
    missingInBaseline: 0,
    missingInCurrent: 0,
    changedScreenshots: 0
  };

  it('report-only never fails regardless of changes or errors', () => {
    expect(
      shouldFailDriftCheck({
        ...clean,
        changedScreenshots: 1,
        diffMode: 'report-only'
      })
    ).toBe(false);
    expect(shouldFailDriftCheck({ ...clean, errors: [{}], diffMode: 'report-only' })).toBe(false);
  });

  it('fail-on-changes fails only on changed screenshots', () => {
    expect(
      shouldFailDriftCheck({
        ...clean,
        changedScreenshots: 1,
        diffMode: 'fail-on-changes'
      })
    ).toBe(true);
    expect(
      shouldFailDriftCheck({
        ...clean,
        errors: [{}],
        diffMode: 'fail-on-changes'
      })
    ).toBe(false);
    expect(shouldFailDriftCheck({ ...clean, diffMode: 'fail-on-changes' })).toBe(false);
  });

  it('fail-on-incomplete fails on comparison errors', () => {
    expect(
      shouldFailDriftCheck({
        ...clean,
        errors: [{}],
        diffMode: 'fail-on-incomplete'
      })
    ).toBe(true);
  });

  it('fail-on-incomplete fails on dimension changes', () => {
    expect(
      shouldFailDriftCheck({
        ...clean,
        dimensionChanges: [{}],
        diffMode: 'fail-on-incomplete'
      })
    ).toBe(true);
  });

  it('fail-on-incomplete fails on missing screenshots', () => {
    expect(
      shouldFailDriftCheck({
        ...clean,
        missingInBaseline: 1,
        diffMode: 'fail-on-incomplete'
      })
    ).toBe(true);
    expect(
      shouldFailDriftCheck({
        ...clean,
        missingInCurrent: 1,
        diffMode: 'fail-on-incomplete'
      })
    ).toBe(true);
  });

  it('fail-on-incomplete passes when everything is clean', () => {
    expect(shouldFailDriftCheck({ ...clean, diffMode: 'fail-on-incomplete' })).toBe(false);
  });

  it('strict fails on changed screenshots', () => {
    expect(
      shouldFailDriftCheck({
        ...clean,
        changedScreenshots: 1,
        diffMode: 'strict'
      })
    ).toBe(true);
  });

  it('strict fails on dimension changes', () => {
    expect(
      shouldFailDriftCheck({
        ...clean,
        dimensionChanges: [{}],
        diffMode: 'strict'
      })
    ).toBe(true);
  });

  it('strict fails on missing screenshots', () => {
    expect(
      shouldFailDriftCheck({
        ...clean,
        missingInBaseline: 1,
        diffMode: 'strict'
      })
    ).toBe(true);
  });

  it('strict passes when everything is clean', () => {
    expect(shouldFailDriftCheck({ ...clean, diffMode: 'strict' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('formatDriftFailureMessage', () => {
  let formatDriftFailureMessage;

  beforeAll(async () => {
    ({ formatDriftFailureMessage } = await import('../lib/compare-results.mjs'));
  });

  it('fail-on-changes includes the screenshot count', () => {
    const msg = formatDriftFailureMessage('fail-on-changes', {
      changedScreenshots: 3
    });
    expect(msg).toContain('3');
    expect(msg).toMatch(/capture|drift/i);
  });

  it('fail-on-incomplete mentions incomplete comparison', () => {
    const msg = formatDriftFailureMessage('fail-on-incomplete', {
      changedScreenshots: 0
    });
    expect(msg).toMatch(/incomplete/i);
  });

  it('strict and unknown modes return a generic strict message', () => {
    const msg = formatDriftFailureMessage('strict', { changedScreenshots: 1 });
    expect(msg).toMatch(/strict/i);
  });
});

// ---------------------------------------------------------------------------
// generateDriftReport integration tests
// ---------------------------------------------------------------------------

function makeCaptureProfile() {
  return {
    schemaVersion: 2, engineVersion: '1.3.0', engine: { name: 'snapdrift-local', version: '1.3.0' },
    browser: 'chromium', browserRevision: '149.0.0.1', playwrightVersion: '1.59.1',
    locale: 'en-US', timezone: 'UTC',
    platform: { name: 'linux', architecture: 'x64', release: '6.8', version: 'Ubuntu 24.04' },
    settings: {
      screenshot: { fullPage: true, animations: 'disabled', caret: 'hide', scale: 'device', omitBackground: false, type: 'png' },
      readiness: { waitUntil: 'load', settleDelayMs: 500 },
      context: { isolation: 'fresh-context-per-attempt', colorScheme: 'light', reducedMotion: 'no-preference', forcedColors: 'none', javaScriptEnabled: true, serviceWorkers: 'allow' },
      launch: { headless: true, args: ['--disable-gpu'] }
    }
  };
}

async function updateManifest(filePath, update) {
  const manifest = JSON.parse(await fs.readFile(filePath, 'utf8'));
  update(manifest);
  await writeJson(filePath, manifest);
}

describe('generateDriftReport', () => {
  let generateDriftReport;
  let tempDir;

  beforeAll(async () => {
    ({ generateDriftReport } = await import('../lib/compare-results.mjs'));
  });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'compare-drift-results-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it.each(['baseline', 'current', 'both'])('bypasses missing PNG resolution when %s route paths differ from selected config', async (side) => {
    const entry = makeManifestEntry('home', 'desktop', 'absent.png', 10, 10);
    const opts = await setupFixtures(tempDir, {
      routes: [{ id: 'home', path: '/', viewport: 'desktop' }], baselineEntries: [entry], currentEntries: [entry]
    });
    for (const location of side === 'both' ? ['baseline', 'current'] : [side]) {
      await updateManifest(opts[`${location}ManifestPath`], (manifest) => { manifest.screenshots[0].path = '/old'; });
    }
    const { summary, markdown } = await generateDriftReport(opts);
    expect(summary).toMatchObject({ status: 'incomplete', changedScreenshots: 0, matchedScreenshots: 0 });
    expect(summary.errors).toEqual([expect.objectContaining({ code: 'incompatible_capture', message: expect.stringMatching(/route path.*Refresh the baseline/) })]);
    expect(markdown).toContain('Incompatible capture');
    expect(markdown).not.toContain('Unable to locate');
  });

  it.each(['baseline', 'current', 'both'])('checks %s normalized viewport against configured identity before missing PNGs', async (side) => {
    const entry = makeManifestEntry('home', 'mobile', 'absent.png', 10, 10);
    const opts = await setupFixtures(tempDir, {
      routes: [{ id: 'home', path: '/', viewport: 'mobile' }], baselineEntries: [entry], currentEntries: [entry]
    });
    for (const location of side === 'both' ? ['baseline', 'current'] : [side]) {
      await updateManifest(opts[`${location}ManifestPath`], (manifest) => { manifest.screenshots[0].viewport = { width: 390, height: 844 }; });
    }
    const { summary } = await generateDriftReport(opts);
    expect(summary.errors).toEqual([expect.objectContaining({ code: 'incompatible_capture', message: expect.stringContaining('normalized viewport') })]);
    expect(summary.changedScreenshots).toBe(0);
  });

  it.each(['settings', 'browser', 'foreign'])('bypasses missing PNGs for incompatible %s profiles', async (change) => {
    const entry = makeManifestEntry('home', 'desktop', 'absent.png', 10, 10);
    const opts = await setupFixtures(tempDir, {
      routes: [{ id: 'home', path: '/', viewport: 'desktop' }], baselineEntries: [entry], currentEntries: [entry]
    });
    const baseline = makeCaptureProfile();
    if (change === 'settings') baseline.settings.screenshot.fullPage = false;
    if (change === 'browser') baseline.browserRevision = '148.0.0.1';
    if (change === 'foreign') baseline.engine.name = 'snap-hosted';
    await updateManifest(opts.baselineManifestPath, (manifest) => { manifest.captureProfile = baseline; });
    await updateManifest(opts.currentManifestPath, (manifest) => { manifest.captureProfile = makeCaptureProfile(); });
    const { summary, markdown } = await generateDriftReport(opts);
    expect(summary).toMatchObject({ status: 'incomplete', changedScreenshots: 0, matchedScreenshots: 0, captureCompatibility: { status: 'incompatible' } });
    expect(summary.errors).toEqual([expect.objectContaining({ code: 'incompatible_capture', message: expect.stringContaining('Refresh the baseline') })]);
    expect(markdown).toContain('report-only');
    expect(markdown).not.toContain('Unable to locate');
  });

  it.each(['baseline', 'current'])('validates malformed %s profiles before comparison', async (side) => {
    const entry = makeManifestEntry('home', 'desktop', 'absent.png', 10, 10);
    const opts = await setupFixtures(tempDir, {
      routes: [{ id: 'home', path: '/', viewport: 'desktop' }], baselineEntries: [entry], currentEntries: [entry]
    });
    await updateManifest(opts[`${side}ManifestPath`], (manifest) => { manifest.captureProfile = null; });
    await expect(generateDriftReport(opts)).rejects.toThrow(`${side} screenshot manifest.captureProfile`);
  });

  it.each([undefined, { schemaVersion: 1, engine: { name: 'snapdrift-local', version: 'v0' } }])('compares legacy baseline pixels with a new local profile as unverified: %j', async (profile) => {
    const imagePath = 'screenshots/home.png';
    const entry = makeManifestEntry('home', 'desktop', imagePath, 2, 2);
    const opts = await setupFixtures(tempDir, {
      routes: [{ id: 'home', path: '/', viewport: 'desktop' }], baselineEntries: [entry], currentEntries: [entry],
      baselinePngs: [{ relPath: imagePath, width: 2, height: 2, r: 0 }],
      currentPngs: [{ relPath: imagePath, width: 2, height: 2, r: 255 }]
    });
    await updateManifest(opts.baselineManifestPath, (manifest) => { manifest.captureProfile = profile; });
    await updateManifest(opts.currentManifestPath, (manifest) => { manifest.captureProfile = makeCaptureProfile(); });
    const { summary } = await generateDriftReport(opts);
    expect(summary.captureCompatibility.status).toBe('unverified');
    expect(summary.errors).toEqual([]);
    expect(summary.changedScreenshots).toBe(1);
  });

  it.each([false, true])('matching profiles normalize desktop identity and retain full-page size drift (growth=%s)', async (growth) => {
    const imagePath = 'screenshots/home.png';
    const opts = await setupFixtures(tempDir, {
      routes: [{ id: 'home', path: '/', viewport: 'desktop' }],
      baselineEntries: [makeManifestEntry('home', { width: 1440, height: 900 }, imagePath, 2, 2)],
      currentEntries: [makeManifestEntry('home', 'desktop', imagePath, 2, growth ? 3 : 2)],
      baselinePngs: [{ relPath: imagePath, width: 2, height: 2 }],
      currentPngs: [{ relPath: imagePath, width: 2, height: growth ? 3 : 2 }]
    });
    for (const manifestPath of [opts.baselineManifestPath, opts.currentManifestPath]) {
      await updateManifest(manifestPath, (manifest) => { manifest.captureProfile = makeCaptureProfile(); });
    }
    const { summary } = await generateDriftReport(opts);
    expect(summary.captureCompatibility.status).toBe('verified');
    expect(summary.errors).toEqual([]);
    expect(summary.status).toBe(growth ? 'changes-detected' : 'clean');
    expect(summary.changedScreenshots).toBe(growth ? 1 : 0);
  });

  it('returns clean status when all screenshots are identical', async () => {
    const routeId = 'root-index-desktop';
    const imagePath = 'screenshots/root-index-desktop.png';

    const opts = await setupFixtures(tempDir, {
      routes: [{ id: routeId, path: '/', viewport: 'desktop' }],
      baselineEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 10, 10)],
      currentEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 10, 10)],
      baselinePngs: [{ relPath: imagePath, width: 10, height: 10, r: 200, g: 200, b: 200 }],
      currentPngs: [{ relPath: imagePath, width: 10, height: 10, r: 200, g: 200, b: 200 }]
    });

    const { summary, markdown } = await generateDriftReport({
      ...opts,
      routeIds: [routeId]
    });

    expect(summary.status).toBe('clean');
    expect(summary.matchedScreenshots).toBe(1);
    expect(summary.changedScreenshots).toBe(0);
    expect(summary.errors).toHaveLength(0);
    expect(summary.dimensionChanges).toHaveLength(0);
    expect(summary.completed).toBe(true);
    expect(summary.finishedAt).toBeDefined();
    expect(summary.captureCompatibility.status).toBe('unverified');
    expect(summary.message).toContain('legacy manifest');
    expect(markdown).toContain(summary.message);
  });

  it('matches screenshots whose pixel difference is at or below the threshold', async () => {
    // 10x10 = 100 pixels total. threshold = 0.01 (1%). 1 different pixel = exactly 1% → matched (<=).
    const routeId = 'root-index-desktop';

    // Build a PNG pair differing by exactly 1 pixel in the bottom-right corner.
    const baselinePng = new PNG({ width: 10, height: 10 });
    baselinePng.data.fill(200);
    const currentPng = new PNG({ width: 10, height: 10 });
    currentPng.data.fill(200);
    // Change one pixel (last pixel, offset 99*4).
    currentPng.data[99 * 4] = 0;
    currentPng.data[99 * 4 + 1] = 0;
    currentPng.data[99 * 4 + 2] = 0;

    const baselineDir = path.join(tempDir, 'baseline', 'screenshots');
    const currentDir = path.join(tempDir, 'current', 'screenshots');
    await fs.mkdir(baselineDir, { recursive: true });
    await fs.mkdir(currentDir, { recursive: true });
    await fs.writeFile(path.join(baselineDir, 'r.png'), PNG.sync.write(baselinePng));
    await fs.writeFile(path.join(currentDir, 'r.png'), PNG.sync.write(currentPng));

    const configPath = path.join(tempDir, 'snapdrift.json');
    await writeJson(
      configPath,
      makeConfig([{ id: routeId, path: '/', viewport: 'desktop' }], {
        threshold: 0.01
      })
    );
    const baselineResultsPath = path.join(tempDir, 'baseline', 'results.json');
    const currentResultsPath = path.join(tempDir, 'current', 'results.json');
    const baselineManifestPath = path.join(tempDir, 'baseline', 'manifest.json');
    const currentManifestPath = path.join(tempDir, 'current', 'manifest.json');
    await writeJson(baselineResultsPath, makeResults([routeId]));
    await writeJson(currentResultsPath, makeResults([routeId]));
    await writeJson(baselineManifestPath, {
      generatedAt: new Date().toISOString(),
      baseUrl: 'http://localhost',
      screenshots: [{ ...makeManifestEntry(routeId, 'desktop', 'screenshots/r.png', 10, 10), path: '/' }]
    });
    await writeJson(currentManifestPath, {
      generatedAt: new Date().toISOString(),
      baseUrl: 'http://localhost',
      screenshots: [{ ...makeManifestEntry(routeId, 'desktop', 'screenshots/r.png', 10, 10), path: '/' }]
    });

    const { summary } = await generateDriftReport({
      configPath,
      baselineResultsPath,
      baselineManifestPath,
      currentResultsPath,
      currentManifestPath,
      baselineRunDir: path.join(tempDir, 'baseline'),
      currentRunDir: path.join(tempDir, 'current'),
      routeIds: [routeId]
    });

    expect(summary.status).toBe('clean');
    expect(summary.matchedScreenshots).toBe(1);
  });

  it('detects changed screenshots when pixel difference exceeds threshold', async () => {
    const routeId = 'root-index-desktop';
    const imagePath = 'screenshots/root-index-desktop.png';

    const opts = await setupFixtures(tempDir, {
      routes: [{ id: routeId, path: '/', viewport: 'desktop' }],
      baselineEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 10, 10)],
      currentEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 10, 10)],
      baselinePngs: [{ relPath: imagePath, width: 10, height: 10, r: 255, g: 255, b: 255 }],
      currentPngs: [{ relPath: imagePath, width: 10, height: 10, r: 0, g: 0, b: 0 }]
    });

    const { summary } = await generateDriftReport({
      ...opts,
      routeIds: [routeId]
    });

    expect(summary.status).toBe('changes-detected');
    expect(summary.changedScreenshots).toBe(1);
    expect(summary.changed).toHaveLength(1);
    expect(summary.changed[0].id).toBe(routeId);
    expect(summary.changed[0].mismatchRatio).toBeGreaterThan(0.01);
    expect(summary.changed[0].differentPixels).toBeGreaterThan(0);
    expect(summary.changed[0].totalPixels).toBe(100);
    expect(summary.changed[0].status).toBe('changed');
  });

  it('treats manifest dimension differences as a changed signal under the default v1 comparison', async () => {
    const routeId = 'root-index-desktop';
    const imagePath = 'screenshots/r.png';

    const opts = await setupFixtures(tempDir, {
      routes: [{ id: routeId, path: '/', viewport: 'desktop' }],
      baselineEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 4, 2)],
      currentEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 4, 1)],
      baselinePngs: [{ relPath: imagePath, width: 4, height: 2, r: 0, g: 0, b: 0 }],
      currentPngs: [{ relPath: imagePath, width: 4, height: 1, r: 0, g: 0, b: 0 }]
    });

    const { summary } = await generateDriftReport({
      ...opts,
      routeIds: [routeId]
    });

    expect(summary.status).toBe('changes-detected');
    expect(summary.comparisonPolicy).toEqual({ version: 1, threshold: 0.01 });
    expect(summary.dimensionChanges).toHaveLength(0);
    expect(summary.changedScreenshots).toBe(1);
    expect(summary.changed[0]).toMatchObject({
      id: routeId,
      differentPixels: 4,
      totalPixels: 8,
      mismatchRatio: 0.5,
      comparison: {
        baseline: { width: 4, height: 2 },
        current: { width: 4, height: 1 },
        canvas: { width: 4, height: 2 },
        dimensionsChanged: true,
        totalPixels: 8
      }
    });
    expect(summary.errors).toHaveLength(0);
    expect(summary.matchedScreenshots).toBe(0);
  });

  it('classifies v1 dimension changes as changed and preserves comparison metadata and diff path', async () => {
    const routeId = 'root-index-desktop';
    const imagePath = 'screenshots/r.png';
    const diffImagesDir = path.join(tempDir, 'out', 'diffs');

    const opts = await setupFixtures(tempDir, {
      routes: [{ id: routeId, path: '/', viewport: 'desktop' }],
      baselineEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 2, 1)],
      currentEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 3, 1)],
      baselinePngs: [{ relPath: imagePath, width: 2, height: 1, r: 0, g: 0, b: 0 }],
      currentPngs: [{ relPath: imagePath, width: 3, height: 1, r: 0, g: 0, b: 0 }],
      comparisonPolicy: { version: 1, threshold: 1 }
    });

    const { summary } = await generateDriftReport({
      ...opts,
      routeIds: [routeId],
      diffImagesDir
    });

    expect(summary.status).toBe('changes-detected');
    expect(summary.dimensionChanges).toHaveLength(0);
    expect(summary.changedScreenshots).toBe(1);
    expect(summary.comparisonPolicy).toEqual({ version: 1, threshold: 1 });
    expect(summary.changed[0]).toMatchObject({
      id: routeId,
      differentPixels: 1,
      totalPixels: 3,
      mismatchRatio: 1 / 3,
      comparison: {
        baseline: { width: 2, height: 1 },
        current: { width: 3, height: 1 },
        canvas: { width: 3, height: 1 },
        dimensionsChanged: true,
        totalPixels: 3
      },
      diffImagePath: 'diffs/root-index-desktop.png'
    });

    const diffPng = PNG.sync.read(await fs.readFile(path.join(diffImagesDir, 'root-index-desktop.png')));
    expect(diffPng.width).toBe(3);
    expect(diffPng.height).toBe(1);
    expect([...diffPng.data.slice(8, 12)]).toEqual([255, 0, 0, 255]);
  });

  it('falls back to diff.threshold when a programmatic policy omits threshold', async () => {
    const routeId = 'root-index-desktop';
    const imagePath = 'screenshots/r.png';

    const opts = await setupFixtures(tempDir, {
      routes: [{ id: routeId, path: '/', viewport: 'desktop' }],
      baselineEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 2, 2)],
      currentEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 2, 2)],
      baselinePngs: [{ relPath: imagePath, width: 2, height: 2, r: 0, g: 0, b: 0 }],
      currentPngs: [{ relPath: imagePath, width: 2, height: 2, r: 0, g: 0, b: 0 }],
      threshold: 0.5
    });

    const { summary } = await generateDriftReport({
      ...opts,
      routeIds: [routeId],
      comparisonPolicy: /** @type {any} */ ({ version: 1 })
    });

    expect(summary.threshold).toBe(0.5);
    expect(summary.comparisonPolicy).toEqual({ version: 1, threshold: 0.5 });
  });

  it('uses <= threshold for equal-size v1 comparisons while dimensions remain an independent signal', async () => {
    const routeId = 'threshold-route';
    const imagePath = 'screenshots/threshold.png';
    const opts = await setupFixtures(tempDir, {
      routes: [{ id: routeId, path: '/', viewport: 'desktop' }],
      baselineEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 2, 2)],
      currentEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 2, 2)],
      baselinePngs: [{ relPath: imagePath, width: 2, height: 2, r: 0, g: 0, b: 0 }],
      currentPngs: [{ relPath: imagePath, width: 2, height: 2, r: 0, g: 0, b: 0 }],
      comparisonPolicy: { version: 1, threshold: 0.25 }
    });
    const currentImagePath = path.join(opts.currentRunDir, imagePath);
    const currentPng = PNG.sync.read(await fs.readFile(currentImagePath));

    currentPng.data[0] = 255;
    currentPng.data[1] = 255;
    currentPng.data[2] = 255;
    await fs.writeFile(currentImagePath, PNG.sync.write(currentPng));

    const equalThreshold = await generateDriftReport({
      ...opts,
      routeIds: [routeId]
    });
    expect(equalThreshold.summary.status).toBe('clean');
    expect(equalThreshold.summary.matchedScreenshots).toBe(1);

    currentPng.data[4] = 255;
    currentPng.data[5] = 255;
    currentPng.data[6] = 255;
    await fs.writeFile(currentImagePath, PNG.sync.write(currentPng));

    const aboveThreshold = await generateDriftReport({
      ...opts,
      routeIds: [routeId]
    });
    expect(aboveThreshold.summary.status).toBe('changes-detected');
    expect(aboveThreshold.summary.changed[0].mismatchRatio).toBe(0.5);
  });

  it('writes diff images only for changed routes when diffImagesDir is provided', async () => {
    const diffImagesDir = path.join(tempDir, 'out', 'diffs');
    const routes = [
      { id: 'matched', path: '/matched', viewport: 'desktop' },
      { id: 'changed', path: '/changed', viewport: 'desktop' }
    ];

    const opts = await setupFixtures(tempDir, {
      routes,
      baselineEntries: [
        makeManifestEntry('matched', 'desktop', 'screenshots/matched.png', 4, 4),
        makeManifestEntry('changed', 'desktop', 'screenshots/changed.png', 4, 4)
      ],
      currentEntries: [
        makeManifestEntry('matched', 'desktop', 'screenshots/matched.png', 4, 4),
        makeManifestEntry('changed', 'desktop', 'screenshots/changed.png', 4, 4)
      ],
      baselinePngs: [
        { relPath: 'screenshots/matched.png', width: 4, height: 4, r: 10, g: 10, b: 10 },
        { relPath: 'screenshots/changed.png', width: 4, height: 4, r: 255, g: 255, b: 255 }
      ],
      currentPngs: [
        { relPath: 'screenshots/matched.png', width: 4, height: 4, r: 10, g: 10, b: 10 },
        { relPath: 'screenshots/changed.png', width: 4, height: 4, r: 0, g: 0, b: 0 }
      ]
    });

    const { summary } = await generateDriftReport({
      ...opts,
      routeIds: routes.map((route) => route.id),
      diffImagesDir
    });

    expect(summary.matchedScreenshots).toBe(1);
    expect(summary.changedScreenshots).toBe(1);
    expect(summary.changed[0].diffImagePath).toBe('diffs/changed.png');

    const written = (await fs.readdir(diffImagesDir)).sort();
    expect(written).toEqual(['changed.png']);
  });

  it('records missingInCurrent when a route is absent from the current manifest', async () => {
    const routeId = 'root-index-desktop';

    const opts = await setupFixtures(tempDir, {
      routes: [{ id: routeId, path: '/', viewport: 'desktop' }],
      baselineEntries: [makeManifestEntry(routeId, 'desktop', 'screenshots/r.png', 10, 10)],
      currentEntries: []
    });

    const { summary } = await generateDriftReport({
      ...opts,
      routeIds: [routeId]
    });

    expect(summary.status).toBe('incomplete');
    expect(summary.missingInCurrent).toBe(1);
    expect(summary.missing).toHaveLength(1);
    expect(summary.missing[0]).toMatchObject({
      id: routeId,
      location: 'current',
      reason: expect.stringMatching(/missing/i)
    });
  });

  it('records missingInBaseline when a route is absent from the baseline manifest', async () => {
    const routeId = 'root-index-desktop';

    const opts = await setupFixtures(tempDir, {
      routes: [{ id: routeId, path: '/', viewport: 'desktop' }],
      baselineEntries: [],
      currentEntries: [makeManifestEntry(routeId, 'desktop', 'screenshots/r.png', 10, 10)]
    });

    const { summary } = await generateDriftReport({
      ...opts,
      routeIds: [routeId]
    });

    expect(summary.status).toBe('incomplete');
    expect(summary.missingInBaseline).toBe(1);
    expect(summary.missing[0]).toMatchObject({
      id: routeId,
      location: 'baseline'
    });
  });

  it('records an error when a route is absent from both manifests', async () => {
    const routeId = 'root-index-desktop';

    const opts = await setupFixtures(tempDir, {
      routes: [{ id: routeId, path: '/', viewport: 'desktop' }],
      baselineEntries: [],
      currentEntries: []
    });

    const { summary } = await generateDriftReport({
      ...opts,
      routeIds: [routeId]
    });

    expect(summary.status).toBe('incomplete');
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0].id).toBe(routeId);
    expect(summary.errors[0].message).toMatch(/missing from both/i);
    expect(summary.errors[0].status).toBe('error');
  });

  it('records an error when the baseline capture failed (reflected in results)', async () => {
    const routeId = 'root-index-desktop';
    const configPath = path.join(tempDir, 'snapdrift.json');
    await writeJson(configPath, makeConfig([{ id: routeId, path: '/', viewport: 'desktop' }]));

    const baselineResultsPath = path.join(tempDir, 'baseline', 'results.json');
    const currentResultsPath = path.join(tempDir, 'current', 'results.json');
    const baselineManifestPath = path.join(tempDir, 'baseline', 'manifest.json');
    const currentManifestPath = path.join(tempDir, 'current', 'manifest.json');

    // Baseline shows a failed capture for routeId
    await writeJson(baselineResultsPath, {
      startedAt: new Date().toISOString(),
      baseUrl: 'http://localhost',
      suite: 'snapdrift',
      routes: [
        {
          id: routeId,
          path: '/',
          viewport: 'desktop',
          status: 'failed',
          durationMs: 10,
          error: 'Navigation timeout'
        }
      ]
    });
    await writeJson(currentResultsPath, makeResults([routeId]));
    await writeJson(baselineManifestPath, {
      generatedAt: new Date().toISOString(),
      baseUrl: 'http://localhost',
      screenshots: []
    });
    await writeJson(currentManifestPath, {
      generatedAt: new Date().toISOString(),
      baseUrl: 'http://localhost',
      screenshots: []
    });

    const { summary } = await generateDriftReport({
      configPath,
      baselineResultsPath,
      baselineManifestPath,
      currentResultsPath,
      currentManifestPath,
      baselineRunDir: path.join(tempDir, 'baseline'),
      currentRunDir: path.join(tempDir, 'current'),
      routeIds: [routeId]
    });

    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0].message).toMatch(/Baseline capture failed/);
    expect(summary.errors[0].message).toContain('Navigation timeout');
  });

  it('records an error when a PNG image file cannot be located', async () => {
    const routeId = 'root-index-desktop';

    const opts = await setupFixtures(tempDir, {
      routes: [{ id: routeId, path: '/', viewport: 'desktop' }],
      baselineEntries: [makeManifestEntry(routeId, 'desktop', 'screenshots/r.png', 10, 10)],
      currentEntries: [makeManifestEntry(routeId, 'desktop', 'screenshots/r.png', 10, 10)]
      // No PNG files written — both entries exist in manifests, dimensions match, but images are absent.
    });

    const { summary } = await generateDriftReport({
      ...opts,
      routeIds: [routeId]
    });

    expect(summary.status).toBe('incomplete');
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0].id).toBe(routeId);
  });

  it('resolves PNG via basename fallback when direct path does not exist', async () => {
    // File lives at screenshots/nested/r.png but manifest says imagePath: screenshots/r.png.
    // resolveImagePath should find it via the basename index.
    const routeId = 'root-index-desktop';
    const imagePath = 'screenshots/r.png';

    const opts = await setupFixtures(tempDir, {
      routes: [{ id: routeId, path: '/', viewport: 'desktop' }],
      baselineEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 10, 10)],
      currentEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 10, 10)],
      // Write PNGs at a different relative path than what the manifest declares.
      baselinePngs: [
        {
          relPath: 'screenshots/nested/r.png',
          width: 10,
          height: 10,
          r: 100,
          g: 100,
          b: 100
        }
      ],
      currentPngs: [
        {
          relPath: 'screenshots/nested/r.png',
          width: 10,
          height: 10,
          r: 100,
          g: 100,
          b: 100
        }
      ]
    });

    const { summary } = await generateDriftReport({
      ...opts,
      routeIds: [routeId]
    });

    expect(summary.status).toBe('clean');
    expect(summary.matchedScreenshots).toBe(1);
  });

  it('handles multiple routes with mixed outcomes in one report', async () => {
    const routes = [
      { id: 'matched', path: '/matched', viewport: 'desktop' },
      { id: 'changed', path: '/changed', viewport: 'desktop' },
      { id: 'dim-changed', path: '/dim', viewport: 'mobile' },
      { id: 'no-baseline', path: '/no-baseline', viewport: 'desktop' },
      { id: 'no-current', path: '/no-current', viewport: 'desktop' }
    ];

    const opts = await setupFixtures(tempDir, {
      routes,
      baselineEntries: [
        makeManifestEntry('matched', 'desktop', 'screenshots/matched.png', 10, 10),
        makeManifestEntry('changed', 'desktop', 'screenshots/changed.png', 10, 10),
        makeManifestEntry('dim-changed', 'mobile', 'screenshots/dim-changed.png', 4, 2),
        makeManifestEntry('no-current', 'desktop', 'screenshots/no-current.png', 10, 10)
      ],
      currentEntries: [
        makeManifestEntry('matched', 'desktop', 'screenshots/matched.png', 10, 10),
        makeManifestEntry('changed', 'desktop', 'screenshots/changed.png', 10, 10),
        makeManifestEntry('dim-changed', 'mobile', 'screenshots/dim-changed.png', 4, 1),
        makeManifestEntry('no-baseline', 'desktop', 'screenshots/no-baseline.png', 10, 10)
      ],
      baselinePngs: [
        { relPath: 'screenshots/matched.png', width: 10, height: 10, r: 200, g: 200, b: 200 },
        { relPath: 'screenshots/changed.png', width: 10, height: 10, r: 255, g: 255, b: 255 },
        { relPath: 'screenshots/dim-changed.png', width: 4, height: 2, r: 100, g: 100, b: 100 }
      ],
      currentPngs: [
        { relPath: 'screenshots/matched.png', width: 10, height: 10, r: 200, g: 200, b: 200 },
        { relPath: 'screenshots/changed.png', width: 10, height: 10, r: 0, g: 0, b: 0 },
        { relPath: 'screenshots/dim-changed.png', width: 4, height: 1, r: 100, g: 100, b: 100 }
      ]
    });

    const { summary } = await generateDriftReport({
      ...opts,
      routeIds: routes.map((r) => r.id)
    });

    expect(summary.matchedScreenshots).toBe(1);
    expect(summary.changedScreenshots).toBe(2);
    expect(summary.dimensionChanges).toHaveLength(0);
    expect(summary.changed.map((item) => item.id).sort()).toEqual(['changed', 'dim-changed']);
    expect(summary.changed.find((item) => item.id === 'dim-changed').comparison).toMatchObject({
      dimensionsChanged: true
    });
    expect(summary.missingInBaseline).toBe(1);
    expect(summary.missing.find((m) => m.id === 'no-baseline')).toMatchObject({
      location: 'baseline'
    });
    expect(summary.missingInCurrent).toBe(1);
    expect(summary.missing.find((m) => m.id === 'no-current')).toMatchObject({
      location: 'current'
    });
    expect(summary.status).toBe('incomplete');
  });

  it('includes baselineArtifactName and baselineSourceSha in the summary', async () => {
    const routeId = 'root-index-desktop';
    const imagePath = 'screenshots/r.png';

    const opts = await setupFixtures(tempDir, {
      routes: [{ id: routeId, path: '/', viewport: 'desktop' }],
      baselineEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 10, 10)],
      currentEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 10, 10)],
      baselinePngs: [{ relPath: imagePath, width: 10, height: 10, r: 50, g: 50, b: 50 }],
      currentPngs: [{ relPath: imagePath, width: 10, height: 10, r: 50, g: 50, b: 50 }]
    });

    const { summary } = await generateDriftReport({
      ...opts,
      routeIds: [routeId],
      baselineArtifactName: 'my-baseline-artifact',
      baselineSourceSha: 'abc1234'
    });

    expect(summary.baselineArtifactName).toBe('my-baseline-artifact');
    expect(summary.baselineSourceSha).toBe('abc1234');
  });

  it('throws when a manifest JSON file cannot be loaded', async () => {
    const routeId = 'root-index-desktop';
    const configPath = path.join(tempDir, 'snapdrift.json');
    await writeJson(configPath, makeConfig([{ id: routeId, path: '/', viewport: 'desktop' }]));

    await expect(
      generateDriftReport({
        configPath,
        baselineResultsPath: path.join(tempDir, 'missing.json'),
        baselineManifestPath: path.join(tempDir, 'missing.json'),
        currentResultsPath: path.join(tempDir, 'missing.json'),
        currentManifestPath: path.join(tempDir, 'missing.json'),
        baselineRunDir: path.join(tempDir, 'baseline'),
        currentRunDir: path.join(tempDir, 'current'),
        routeIds: [routeId]
      })
    ).rejects.toThrow(/Unable to load/);
  });

  it('ignores manifest entries whose id is not in the selected route ids', async () => {
    // The manifest has two screenshots; only one is in selectedRouteIds.
    // The other entry must be silently skipped (covers the !selected.has branch).
    const selectedId = 'root-index-desktop';
    const extraId = 'root-index-mobile';
    const selectedImagePath = 'screenshots/r-desktop.png';
    const extraImagePath = 'screenshots/r-mobile.png';

    const opts = await setupFixtures(tempDir, {
      routes: [
        { id: selectedId, path: '/', viewport: 'desktop' },
        { id: extraId, path: '/', viewport: 'mobile' }
      ],
      baselineEntries: [makeManifestEntry(selectedId, 'desktop', selectedImagePath, 10, 10), makeManifestEntry(extraId, 'mobile', extraImagePath, 10, 10)],
      currentEntries: [makeManifestEntry(selectedId, 'desktop', selectedImagePath, 10, 10), makeManifestEntry(extraId, 'mobile', extraImagePath, 10, 10)],
      baselinePngs: [
        {
          relPath: selectedImagePath,
          width: 10,
          height: 10,
          r: 50,
          g: 50,
          b: 50
        },
        { relPath: extraImagePath, width: 10, height: 10, r: 50, g: 50, b: 50 }
      ],
      currentPngs: [
        {
          relPath: selectedImagePath,
          width: 10,
          height: 10,
          r: 50,
          g: 50,
          b: 50
        },
        { relPath: extraImagePath, width: 10, height: 10, r: 50, g: 50, b: 50 }
      ]
    });

    // Only request the selected route — the extra entry should be ignored.
    const { summary } = await generateDriftReport({
      ...opts,
      routeIds: [selectedId]
    });

    expect(summary.matchedScreenshots).toBe(1);
    expect(summary.totalScreenshots).toBe(1);
  });

  it('hits the buildFileIndex cache on subsequent calls for the same run directory', async () => {
    // Two routes in the same runDir, both needing basename fallback.
    // The second route's resolveImagePath call hits the fileIndexCache.
    const routeA = 'page-a';
    const routeB = 'page-b';

    const opts = await setupFixtures(tempDir, {
      routes: [
        { id: routeA, path: '/a', viewport: 'desktop' },
        { id: routeB, path: '/b', viewport: 'desktop' }
      ],
      baselineEntries: [makeManifestEntry(routeA, 'desktop', 'screenshots/a.png', 10, 10), makeManifestEntry(routeB, 'desktop', 'screenshots/b.png', 10, 10)],
      currentEntries: [makeManifestEntry(routeA, 'desktop', 'screenshots/a.png', 10, 10), makeManifestEntry(routeB, 'desktop', 'screenshots/b.png', 10, 10)],
      // Files placed at a different relative path so direct resolve fails → basename fallback.
      baselinePngs: [
        { relPath: 'alt/a.png', width: 10, height: 10, r: 80, g: 80, b: 80 },
        { relPath: 'alt/b.png', width: 10, height: 10, r: 90, g: 90, b: 90 }
      ],
      currentPngs: [
        { relPath: 'alt/a.png', width: 10, height: 10, r: 80, g: 80, b: 80 },
        { relPath: 'alt/b.png', width: 10, height: 10, r: 90, g: 90, b: 90 }
      ]
    });

    const { summary } = await generateDriftReport({
      ...opts,
      routeIds: [routeA, routeB]
    });

    expect(summary.matchedScreenshots).toBe(2);
  });

  it('resolves PNG via suffix disambiguation when multiple files share the same basename', async () => {
    // Files live at captures/route-a/r.png and captures/route-b/r.png (both under runDir).
    // The manifest declares imagePath as 'route-b/r.png' (no file exists there directly).
    // resolveImagePath cannot find the direct path, finds both via basename search, then
    // uses the suffix 'route-b/r.png' to disambiguate — covering the suffix-match branch.
    const routeId = 'root-index-desktop';
    const imagePath = 'route-b/r.png'; // no file directly at runDir/route-b/r.png

    const opts = await setupFixtures(tempDir, {
      routes: [{ id: routeId, path: '/', viewport: 'desktop' }],
      baselineEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 10, 10)],
      currentEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 10, 10)],
      baselinePngs: [
        {
          relPath: 'captures/route-a/r.png',
          width: 10,
          height: 10,
          r: 10,
          g: 10,
          b: 10
        },
        {
          relPath: 'captures/route-b/r.png',
          width: 10,
          height: 10,
          r: 20,
          g: 20,
          b: 20
        }
      ],
      currentPngs: [
        {
          relPath: 'captures/route-a/r.png',
          width: 10,
          height: 10,
          r: 10,
          g: 10,
          b: 10
        },
        {
          relPath: 'captures/route-b/r.png',
          width: 10,
          height: 10,
          r: 20,
          g: 20,
          b: 20
        }
      ]
    });

    const { summary } = await generateDriftReport({
      ...opts,
      routeIds: [routeId]
    });

    // Both sides resolve to captures/route-b/r.png (same colour) → matched.
    expect(summary.matchedScreenshots).toBe(1);
    expect(summary.errors).toHaveLength(0);
  });

  it('compares using actual PNG dimensions when they differ from the manifest', async () => {
    // Manifest says both are 10x10, but the actual current PNG is 10x20.
    // The v1 comparator uses the decoded dimensions, not the manifest metadata.
    const routeId = 'root-index-desktop';
    const imagePath = 'screenshots/r.png';

    const opts = await setupFixtures(tempDir, {
      routes: [{ id: routeId, path: '/', viewport: 'desktop' }],
      baselineEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 10, 10)],
      currentEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 10, 10)], // manifest says 10x10
      baselinePngs: [{ relPath: imagePath, width: 10, height: 10, r: 100, g: 100, b: 100 }],
      currentPngs: [{ relPath: imagePath, width: 10, height: 20, r: 100, g: 100, b: 100 }] // actual PNG is 10x20
    });

    const { summary } = await generateDriftReport({
      ...opts,
      routeIds: [routeId]
    });

    expect(summary.errors).toHaveLength(0);
    expect(summary.changedScreenshots).toBe(1);
    expect(summary.changed[0].comparison).toMatchObject({
      baseline: { width: 10, height: 10 },
      current: { width: 10, height: 20 },
      canvas: { width: 10, height: 20 },
      dimensionsChanged: true
    });
  });

  it('throws when there are duplicate screenshot ids in a manifest', async () => {
    const routeId = 'root-index-desktop';

    const opts = await setupFixtures(tempDir, {
      routes: [{ id: routeId, path: '/', viewport: 'desktop' }],
      // Two entries with the same id — should throw.
      baselineEntries: [
        makeManifestEntry(routeId, 'desktop', 'screenshots/r.png', 10, 10),
        makeManifestEntry(routeId, 'desktop', 'screenshots/r2.png', 10, 10)
      ],
      currentEntries: [makeManifestEntry(routeId, 'desktop', 'screenshots/r.png', 10, 10)]
    });

    await expect(generateDriftReport({ ...opts, routeIds: [routeId] })).rejects.toThrow(/Duplicate screenshot id/);
  });

  it('rejects duplicate staged filenames before filtering selected routes', async () => {
    const opts = await setupFixtures(tempDir, {
      routes: [
        { id: 'route-a', path: '/', viewport: 'desktop' },
        { id: 'route-b', path: '/b', viewport: 'mobile' }
      ],
      baselineEntries: [
        makeManifestEntry('route-a', 'desktop', 'screenshots/a/shared.png', 10, 10),
        makeManifestEntry('route-b', 'mobile', 'screenshots/b/shared.png', 10, 10)
      ],
      currentEntries: [
        makeManifestEntry('route-a', 'desktop', 'screenshots/a.png', 10, 10),
        makeManifestEntry('route-b', 'mobile', 'screenshots/b.png', 10, 10)
      ]
    });

    await expect(generateDriftReport({ ...opts, routeIds: ['route-a'] })).rejects.toThrow(
      /Duplicate screenshot imagePath filename.*baseline screenshot manifest/
    );
  });

  describe('generated markdown', () => {
    it('contains all expected sections', async () => {
      const routeId = 'root-index-desktop';
      const imagePath = 'screenshots/r.png';

      const opts = await setupFixtures(tempDir, {
        routes: [{ id: routeId, path: '/', viewport: 'desktop' }],
        baselineEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 10, 10)],
        currentEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 10, 10)],
        baselinePngs: [{ relPath: imagePath, width: 10, height: 10, r: 255, g: 255, b: 255 }],
        currentPngs: [{ relPath: imagePath, width: 10, height: 10, r: 255, g: 255, b: 255 }]
      });

      const { markdown } = await generateDriftReport({
        ...opts,
        routeIds: [routeId]
      });

      expect(markdown).toContain(
        '<img src="https://raw.githubusercontent.com/ranacseruet/snapdrift/main/assets/snapdrift-logo-icon.png" alt="SnapDrift" width="24" height="24" />'
      );
      expect(markdown).toContain('SnapDrift Report');
      expect(markdown).toContain('Clean');
      expect(markdown).toContain('| Selected routes | Stable captures | Diff mode | Threshold |');
      expect(markdown).toContain('| 1 | 1 | `report-only` | 1% |');
      expect(markdown).toContain('## Drift signals');
      expect(markdown).toContain('## Dimension shifts');
      expect(markdown).toContain('## Comparison errors');
      expect(markdown).toContain('Powered by <a href="https://github.com/ranacseruet/snapdrift">SnapDrift</a>');
    });

    it('lists changed screenshots with mismatch details', async () => {
      const routeId = 'root-index-desktop';
      const imagePath = 'screenshots/r.png';

      const opts = await setupFixtures(tempDir, {
        routes: [{ id: routeId, path: '/', viewport: 'desktop' }],
        baselineEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 10, 10)],
        currentEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 10, 10)],
        baselinePngs: [{ relPath: imagePath, width: 10, height: 10, r: 255, g: 255, b: 255 }],
        currentPngs: [{ relPath: imagePath, width: 10, height: 10, r: 0, g: 0, b: 0 }]
      });

      const { markdown } = await generateDriftReport({
        ...opts,
        routeIds: [routeId]
      });

      expect(markdown).toContain(routeId);
      expect(markdown).toContain('Mismatch');
    });

    it('describes comparison dimension changes with baseline/current/canvas dimensions', async () => {
      const routeId = 'root-index-desktop';
      const imagePath = 'screenshots/r.png';

      const opts = await setupFixtures(tempDir, {
        routes: [{ id: routeId, path: '/', viewport: 'desktop' }],
        baselineEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 4, 2)],
        currentEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 4, 1)],
        baselinePngs: [{ relPath: imagePath, width: 4, height: 2, r: 0, g: 0, b: 0 }],
        currentPngs: [{ relPath: imagePath, width: 4, height: 1, r: 0, g: 0, b: 0 }]
      });

      const { markdown } = await generateDriftReport({
        ...opts,
        routeIds: [routeId]
      });

      expect(markdown).toContain('union canvas');
      expect(markdown).toContain('4×2');
      expect(markdown).toContain('4×1');
    });

    it('includes baseline artifact name and SHA when provided', async () => {
      const routeId = 'root-index-desktop';
      const imagePath = 'screenshots/r.png';

      const opts = await setupFixtures(tempDir, {
        routes: [{ id: routeId, path: '/', viewport: 'desktop' }],
        baselineEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 10, 10)],
        currentEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 10, 10)],
        baselinePngs: [{ relPath: imagePath, width: 10, height: 10, r: 0, g: 0, b: 0 }],
        currentPngs: [{ relPath: imagePath, width: 10, height: 10, r: 0, g: 0, b: 0 }]
      });

      const { markdown } = await generateDriftReport({
        ...opts,
        routeIds: [routeId],
        baselineArtifactName: 'my-artifact',
        baselineSourceSha: 'deadbeef'
      });

      expect(markdown).toContain('my-artifact');
      expect(markdown).toContain('deadbeef');
    });
  });
});

describe('runDriftCheckCli', () => {
  let runDriftCheckCli;
  let tempDir;

  beforeAll(async () => {
    ({ runDriftCheckCli } = await import('../lib/compare-results.mjs'));
  });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'compare-drift-cli-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('writes summary files before throwing when enforceOutcome is true and drift fails the diff mode', async () => {
    const routeId = 'root-index-desktop';
    const imagePath = 'screenshots/r.png';
    const opts = await setupFixtures(tempDir, {
      routes: [{ id: routeId, path: '/', viewport: 'desktop' }],
      baselineEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 10, 10)],
      currentEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 10, 10)],
      baselinePngs: [{ relPath: imagePath, width: 10, height: 10, r: 255, g: 255, b: 255 }],
      currentPngs: [{ relPath: imagePath, width: 10, height: 10, r: 0, g: 0, b: 0 }],
      diffMode: 'strict'
    });
    const outDir = path.join(tempDir, 'out');
    const summaryPath = path.join(outDir, 'summary.json');
    const markdownPath = path.join(outDir, 'summary.md');

    await expect(
      runDriftCheckCli({
        ...opts,
        outDir,
        summaryPath,
        markdownPath,
        routeIds: [routeId],
        enforceOutcome: true
      })
    ).rejects.toThrow(/strict mode detected drift/i);

    const summary = JSON.parse(await fs.readFile(summaryPath, 'utf8'));
    const markdown = await fs.readFile(markdownPath, 'utf8');

    expect(summary.status).toBe('changes-detected');
    expect(summary.changedScreenshots).toBe(1);
    expect(markdown).toContain('SnapDrift Report');
    expect(markdown).toContain('Drift detected');
  });
});

// ---------------------------------------------------------------------------
// runDriftCheckCli integration tests
// ---------------------------------------------------------------------------

describe('runDriftCheckCli', () => {
  let runDriftCheckCli;
  let tempDir;

  beforeAll(async () => {
    ({ runDriftCheckCli } = await import('../lib/compare-results.mjs'));
  });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'compare-drift-cli-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function cliOutputPaths(dir) {
    return {
      outDir: dir,
      summaryPath: path.join(dir, 'summary.json'),
      markdownPath: path.join(dir, 'summary.md')
    };
  }

  async function buildCleanOpts(mode = 'report-only') {
    const routeId = 'root-index-desktop';
    const imagePath = 'screenshots/r.png';
    const opts = await setupFixtures(tempDir, {
      routes: [{ id: routeId, path: '/', viewport: 'desktop' }],
      baselineEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 10, 10)],
      currentEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 10, 10)],
      baselinePngs: [{ relPath: imagePath, width: 10, height: 10, r: 128, g: 128, b: 128 }],
      currentPngs: [{ relPath: imagePath, width: 10, height: 10, r: 128, g: 128, b: 128 }],
      diffMode: mode
    });
    return {
      ...opts,
      routeIds: [routeId],
      ...cliOutputPaths(path.join(tempDir, 'out'))
    };
  }

  it('writes summary JSON and markdown files to the output directory', async () => {
    const opts = await buildCleanOpts();

    await runDriftCheckCli({ ...opts, enforceOutcome: false });

    const summary = JSON.parse(await fs.readFile(opts.summaryPath, 'utf8'));
    const markdown = await fs.readFile(opts.markdownPath, 'utf8');

    expect(summary.status).toBe('clean');
    expect(markdown).toContain('SnapDrift Report');
  });

  it('does not throw in report-only mode even when screenshots have changed', async () => {
    const routeId = 'root-index-desktop';
    const imagePath = 'screenshots/r.png';
    const fixtures = await setupFixtures(tempDir, {
      routes: [{ id: routeId, path: '/', viewport: 'desktop' }],
      baselineEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 10, 10)],
      currentEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 10, 10)],
      baselinePngs: [{ relPath: imagePath, width: 10, height: 10, r: 255, g: 255, b: 255 }],
      currentPngs: [{ relPath: imagePath, width: 10, height: 10, r: 0, g: 0, b: 0 }],
      diffMode: 'report-only'
    });

    await expect(
      runDriftCheckCli({
        ...fixtures,
        ...cliOutputPaths(path.join(tempDir, 'out')),
        routeIds: [routeId],
        enforceOutcome: true
      })
    ).resolves.toBeUndefined();
  });

  it('throws in fail-on-changes mode when screenshots have changed', async () => {
    const routeId = 'root-index-desktop';
    const imagePath = 'screenshots/r.png';
    const fixtures = await setupFixtures(tempDir, {
      routes: [{ id: routeId, path: '/', viewport: 'desktop' }],
      baselineEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 10, 10)],
      currentEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 10, 10)],
      baselinePngs: [{ relPath: imagePath, width: 10, height: 10, r: 255, g: 255, b: 255 }],
      currentPngs: [{ relPath: imagePath, width: 10, height: 10, r: 0, g: 0, b: 0 }],
      diffMode: 'fail-on-changes'
    });

    await expect(
      runDriftCheckCli({
        ...fixtures,
        ...cliOutputPaths(path.join(tempDir, 'out')),
        routeIds: [routeId],
        enforceOutcome: true
      })
    ).rejects.toThrow(/capture|drift/i);
  });

  it('does not throw in fail-on-changes mode when all screenshots are clean', async () => {
    const opts = await buildCleanOpts('fail-on-changes');

    await expect(runDriftCheckCli({ ...opts, enforceOutcome: true })).resolves.toBeUndefined();
  });

  it.each(['report-only', 'fail-on-changes', 'fail-on-incomplete', 'strict'])('enforces incompatible captures as incomplete in %s mode', async (mode) => {
    const entry = makeManifestEntry('home', 'desktop', 'absent.png', 10, 10);
    const fixtures = await setupFixtures(tempDir, {
      routes: [{ id: 'home', path: '/', viewport: 'desktop' }], baselineEntries: [entry], currentEntries: [entry], diffMode: mode
    });
    await updateManifest(fixtures.baselineManifestPath, (manifest) => { manifest.captureProfile = makeCaptureProfile(); });
    await updateManifest(fixtures.currentManifestPath, (manifest) => {
      manifest.captureProfile = makeCaptureProfile();
      manifest.captureProfile.settings.readiness.settleDelayMs += 1;
    });
    const output = cliOutputPaths(path.join(tempDir, 'out'));
    const run = runDriftCheckCli({ ...fixtures, ...output, enforceOutcome: true });
    if (mode === 'strict' || mode === 'fail-on-incomplete') {
      await expect(run).rejects.toThrow(/incomplete|strict/);
    } else {
      await expect(run).resolves.toBeUndefined();
    }
    const summary = JSON.parse(await fs.readFile(output.summaryPath, 'utf8'));
    expect(summary).toMatchObject({ status: 'incomplete', changedScreenshots: 0, matchedScreenshots: 0 });
    expect(summary.errors[0].code).toBe('incompatible_capture');
    await expect(fs.access(path.join(output.outDir, 'diffs'))).rejects.toThrow();
  });

  it('enforces v1 dimension changes as changed, except in report-only and fail-on-incomplete modes', async () => {
    const routeId = 'dimension-route';
    const imagePath = 'screenshots/dimension.png';
    const modes = ['report-only', 'fail-on-changes', 'strict', 'fail-on-incomplete'];

    for (const mode of modes) {
      const modeDir = path.join(tempDir, mode);
      const fixtures = await setupFixtures(modeDir, {
        routes: [{ id: routeId, path: '/', viewport: 'desktop' }],
        baselineEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 2, 1)],
        currentEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 3, 1)],
        baselinePngs: [{ relPath: imagePath, width: 2, height: 1, r: 0, g: 0, b: 0 }],
        currentPngs: [{ relPath: imagePath, width: 3, height: 1, r: 0, g: 0, b: 0 }],
        diffMode: mode,
        comparisonPolicy: { version: 1, threshold: 1 }
      });
      const output = cliOutputPaths(path.join(modeDir, 'out'));
      const run = runDriftCheckCli({
        ...fixtures,
        ...output,
        routeIds: [routeId],
        enforceOutcome: true
      });

      if (mode === 'fail-on-changes' || mode === 'strict') {
        await expect(run).rejects.toThrow(/drift|strict/i);
      } else {
        await expect(run).resolves.toBeUndefined();
      }

      const summary = JSON.parse(await fs.readFile(output.summaryPath, 'utf8'));
      expect(summary.changedScreenshots).toBe(1);
      expect(summary.status).toBe('changes-detected');
      expect(summary.dimensionChanges).toHaveLength(0);
    }
  });
});
