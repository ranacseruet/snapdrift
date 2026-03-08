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
 * @param {{ mode?: string, threshold?: number }} [diff]
 */
function makeConfig(routes, diff = {}) {
    return {
        baselineArtifactName: 'test-visual-baseline',
        workingDirectory: '.',
        baseUrl: 'http://localhost:3000',
        resultsFile: 'qa-artifacts/snapdrift/baseline/current/results.json',
        manifestFile: 'qa-artifacts/snapdrift/baseline/current/manifest.json',
        screenshotsRoot: 'qa-artifacts/snapdrift/baseline/current',
        routes,
        diff: { threshold: diff.threshold ?? 0.01, mode: diff.mode ?? 'report-only' }
    };
}

/** @param {string[]} routeIds */
function makeResults(routeIds) {
    return {
        startedAt: new Date().toISOString(),
        baseUrl: 'http://localhost:3000',
        suite: 'visual',
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
 * Writes all fixture files needed by generateVisualDiffReport / runVisualDiffCli.
 */
async function setupFixtures(tempDir, { routes, baselineEntries, currentEntries, baselinePngs = [], currentPngs = [], diffMode, threshold }) {
    const configPath = path.join(tempDir, 'snapdrift.json');
    const baselineResultsPath = path.join(tempDir, 'baseline', 'results.json');
    const baselineManifestPath = path.join(tempDir, 'baseline', 'manifest.json');
    const currentResultsPath = path.join(tempDir, 'current', 'results.json');
    const currentManifestPath = path.join(tempDir, 'current', 'manifest.json');
    const baselineRunDir = path.join(tempDir, 'baseline');
    const currentRunDir = path.join(tempDir, 'current');

    await writeJson(configPath, makeConfig(routes, { mode: diffMode, threshold }));
    await writeJson(baselineResultsPath, makeResults(routes.map((r) => r.id)));
    await writeJson(currentResultsPath, makeResults(routes.map((r) => r.id)));
    await writeJson(baselineManifestPath, {
        generatedAt: new Date().toISOString(),
        baseUrl: 'http://localhost',
        screenshots: baselineEntries
    });
    await writeJson(currentManifestPath, {
        generatedAt: new Date().toISOString(),
        baseUrl: 'http://localhost',
        screenshots: currentEntries
    });

    for (const { relPath, width, height, r, g, b } of baselinePngs) {
        await writePng(path.join(baselineRunDir, relPath), width, height, r, g, b);
    }
    for (const { relPath, width, height, r, g, b } of currentPngs) {
        await writePng(path.join(currentRunDir, relPath), width, height, r, g, b);
    }

    return { configPath, baselineResultsPath, baselineManifestPath, currentResultsPath, currentManifestPath, baselineRunDir, currentRunDir };
}

// ---------------------------------------------------------------------------
// Pure helper tests
// ---------------------------------------------------------------------------

describe('determineVisualDiffStatus', () => {
    let determineVisualDiffStatus;

    beforeAll(async () => {
        ({ determineVisualDiffStatus } = await import('../lib/compare-visual-results.mjs'));
    });

    const base = { errors: [], dimensionChanges: [], missingInBaseline: 0, missingInCurrent: 0, changedScreenshots: 0 };

    it('returns incomplete when there are errors', () => {
        expect(determineVisualDiffStatus({ ...base, errors: [{ id: 'x', status: 'error', message: 'oops' }] })).toBe('incomplete');
    });

    it('returns incomplete when there are dimension changes', () => {
        expect(determineVisualDiffStatus({ ...base, dimensionChanges: [{ id: 'x', status: 'dimension-changed' }] })).toBe('incomplete');
    });

    it('returns incomplete when there are screenshots missing in baseline', () => {
        expect(determineVisualDiffStatus({ ...base, missingInBaseline: 1 })).toBe('incomplete');
    });

    it('returns incomplete when there are screenshots missing in current', () => {
        expect(determineVisualDiffStatus({ ...base, missingInCurrent: 1 })).toBe('incomplete');
    });

    it('returns changes-detected when changedScreenshots > 0', () => {
        expect(determineVisualDiffStatus({ ...base, changedScreenshots: 2 })).toBe('changes-detected');
    });

    it('returns clean when everything is fine', () => {
        expect(determineVisualDiffStatus(base)).toBe('clean');
    });
});

// ---------------------------------------------------------------------------

describe('shouldFailVisualDiff', () => {
    let shouldFailVisualDiff;

    beforeAll(async () => {
        ({ shouldFailVisualDiff } = await import('../lib/compare-visual-results.mjs'));
    });

    const clean = { errors: [], dimensionChanges: [], missingInBaseline: 0, missingInCurrent: 0, changedScreenshots: 0 };

    it('report-only never fails regardless of changes or errors', () => {
        expect(shouldFailVisualDiff({ ...clean, changedScreenshots: 1, diffMode: 'report-only' })).toBe(false);
        expect(shouldFailVisualDiff({ ...clean, errors: [{}], diffMode: 'report-only' })).toBe(false);
    });

    it('fail-on-changes fails only on changed screenshots', () => {
        expect(shouldFailVisualDiff({ ...clean, changedScreenshots: 1, diffMode: 'fail-on-changes' })).toBe(true);
        expect(shouldFailVisualDiff({ ...clean, errors: [{}], diffMode: 'fail-on-changes' })).toBe(false);
        expect(shouldFailVisualDiff({ ...clean, diffMode: 'fail-on-changes' })).toBe(false);
    });

    it('fail-on-incomplete fails on comparison errors', () => {
        expect(shouldFailVisualDiff({ ...clean, errors: [{}], diffMode: 'fail-on-incomplete' })).toBe(true);
    });

    it('fail-on-incomplete fails on dimension changes', () => {
        expect(shouldFailVisualDiff({ ...clean, dimensionChanges: [{}], diffMode: 'fail-on-incomplete' })).toBe(true);
    });

    it('fail-on-incomplete fails on missing screenshots', () => {
        expect(shouldFailVisualDiff({ ...clean, missingInBaseline: 1, diffMode: 'fail-on-incomplete' })).toBe(true);
        expect(shouldFailVisualDiff({ ...clean, missingInCurrent: 1, diffMode: 'fail-on-incomplete' })).toBe(true);
    });

    it('fail-on-incomplete passes when everything is clean', () => {
        expect(shouldFailVisualDiff({ ...clean, diffMode: 'fail-on-incomplete' })).toBe(false);
    });

    it('strict fails on changed screenshots', () => {
        expect(shouldFailVisualDiff({ ...clean, changedScreenshots: 1, diffMode: 'strict' })).toBe(true);
    });

    it('strict fails on dimension changes', () => {
        expect(shouldFailVisualDiff({ ...clean, dimensionChanges: [{}], diffMode: 'strict' })).toBe(true);
    });

    it('strict fails on missing screenshots', () => {
        expect(shouldFailVisualDiff({ ...clean, missingInBaseline: 1, diffMode: 'strict' })).toBe(true);
    });

    it('strict passes when everything is clean', () => {
        expect(shouldFailVisualDiff({ ...clean, diffMode: 'strict' })).toBe(false);
    });
});

// ---------------------------------------------------------------------------

describe('formatVisualDiffFailureMessage', () => {
    let formatVisualDiffFailureMessage;

    beforeAll(async () => {
        ({ formatVisualDiffFailureMessage } = await import('../lib/compare-visual-results.mjs'));
    });

    it('fail-on-changes includes the screenshot count', () => {
        const msg = formatVisualDiffFailureMessage('fail-on-changes', { changedScreenshots: 3 });
        expect(msg).toContain('3');
        expect(msg).toMatch(/capture|drift/i);
    });

    it('fail-on-incomplete mentions incomplete comparison', () => {
        const msg = formatVisualDiffFailureMessage('fail-on-incomplete', { changedScreenshots: 0 });
        expect(msg).toMatch(/incomplete/i);
    });

    it('strict and unknown modes return a generic strict message', () => {
        const msg = formatVisualDiffFailureMessage('strict', { changedScreenshots: 1 });
        expect(msg).toMatch(/strict/i);
    });
});

// ---------------------------------------------------------------------------
// generateVisualDiffReport integration tests
// ---------------------------------------------------------------------------

describe('generateVisualDiffReport', () => {
    let generateVisualDiffReport;
    let tempDir;

    beforeAll(async () => {
        ({ generateVisualDiffReport } = await import('../lib/compare-visual-results.mjs'));
    });

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'compare-visual-results-'));
    });

    afterEach(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
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

        const { summary } = await generateVisualDiffReport({ ...opts, routeIds: [routeId] });

        expect(summary.status).toBe('clean');
        expect(summary.matchedScreenshots).toBe(1);
        expect(summary.changedScreenshots).toBe(0);
        expect(summary.errors).toHaveLength(0);
        expect(summary.dimensionChanges).toHaveLength(0);
        expect(summary.completed).toBe(true);
        expect(summary.finishedAt).toBeDefined();
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
        await writeJson(configPath, makeConfig([{ id: routeId, path: '/', viewport: 'desktop' }], { threshold: 0.01 }));
        const baselineResultsPath = path.join(tempDir, 'baseline', 'results.json');
        const currentResultsPath = path.join(tempDir, 'current', 'results.json');
        const baselineManifestPath = path.join(tempDir, 'baseline', 'manifest.json');
        const currentManifestPath = path.join(tempDir, 'current', 'manifest.json');
        await writeJson(baselineResultsPath, makeResults([routeId]));
        await writeJson(currentResultsPath, makeResults([routeId]));
        await writeJson(baselineManifestPath, { generatedAt: new Date().toISOString(), baseUrl: 'http://localhost', screenshots: [makeManifestEntry(routeId, 'desktop', 'screenshots/r.png', 10, 10)] });
        await writeJson(currentManifestPath, { generatedAt: new Date().toISOString(), baseUrl: 'http://localhost', screenshots: [makeManifestEntry(routeId, 'desktop', 'screenshots/r.png', 10, 10)] });

        const { summary } = await generateVisualDiffReport({
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

        const { summary } = await generateVisualDiffReport({ ...opts, routeIds: [routeId] });

        expect(summary.status).toBe('changes-detected');
        expect(summary.changedScreenshots).toBe(1);
        expect(summary.changed).toHaveLength(1);
        expect(summary.changed[0].id).toBe(routeId);
        expect(summary.changed[0].mismatchRatio).toBeGreaterThan(0.01);
        expect(summary.changed[0].differentPixels).toBeGreaterThan(0);
        expect(summary.changed[0].totalPixels).toBe(100);
        expect(summary.changed[0].status).toBe('changed');
    });

    it('records dimension-changed and skips PNG comparison when manifest dimensions differ', async () => {
        const routeId = 'root-index-desktop';

        const opts = await setupFixtures(tempDir, {
            routes: [{ id: routeId, path: '/', viewport: 'desktop' }],
            baselineEntries: [makeManifestEntry(routeId, 'desktop', 'screenshots/r.png', 1440, 1266)],
            currentEntries: [makeManifestEntry(routeId, 'desktop', 'screenshots/r.png', 1440, 1092)],
            // No PNG files created — dimension check happens before any PNG read.
        });

        const { summary } = await generateVisualDiffReport({ ...opts, routeIds: [routeId] });

        expect(summary.status).toBe('incomplete');
        expect(summary.dimensionChanges).toHaveLength(1);
        expect(summary.dimensionChanges[0]).toMatchObject({
            id: routeId,
            viewport: 'desktop',
            baselineWidth: 1440,
            baselineHeight: 1266,
            currentWidth: 1440,
            currentHeight: 1092,
            status: 'dimension-changed'
        });
        expect(summary.errors).toHaveLength(0);
        expect(summary.matchedScreenshots).toBe(0);
        expect(summary.changedScreenshots).toBe(0);
    });

    it('records missingInCurrent when a route is absent from the current manifest', async () => {
        const routeId = 'root-index-desktop';

        const opts = await setupFixtures(tempDir, {
            routes: [{ id: routeId, path: '/', viewport: 'desktop' }],
            baselineEntries: [makeManifestEntry(routeId, 'desktop', 'screenshots/r.png', 10, 10)],
            currentEntries: []
        });

        const { summary } = await generateVisualDiffReport({ ...opts, routeIds: [routeId] });

        expect(summary.status).toBe('incomplete');
        expect(summary.missingInCurrent).toBe(1);
        expect(summary.missing).toHaveLength(1);
        expect(summary.missing[0]).toMatchObject({ id: routeId, location: 'current', reason: expect.stringMatching(/missing/i) });
    });

    it('records missingInBaseline when a route is absent from the baseline manifest', async () => {
        const routeId = 'root-index-desktop';

        const opts = await setupFixtures(tempDir, {
            routes: [{ id: routeId, path: '/', viewport: 'desktop' }],
            baselineEntries: [],
            currentEntries: [makeManifestEntry(routeId, 'desktop', 'screenshots/r.png', 10, 10)]
        });

        const { summary } = await generateVisualDiffReport({ ...opts, routeIds: [routeId] });

        expect(summary.status).toBe('incomplete');
        expect(summary.missingInBaseline).toBe(1);
        expect(summary.missing[0]).toMatchObject({ id: routeId, location: 'baseline' });
    });

    it('records an error when a route is absent from both manifests', async () => {
        const routeId = 'root-index-desktop';

        const opts = await setupFixtures(tempDir, {
            routes: [{ id: routeId, path: '/', viewport: 'desktop' }],
            baselineEntries: [],
            currentEntries: []
        });

        const { summary } = await generateVisualDiffReport({ ...opts, routeIds: [routeId] });

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
            suite: 'visual',
            routes: [{ id: routeId, path: '/', viewport: 'desktop', status: 'failed', durationMs: 10, error: 'Navigation timeout' }]
        });
        await writeJson(currentResultsPath, makeResults([routeId]));
        await writeJson(baselineManifestPath, { generatedAt: new Date().toISOString(), baseUrl: 'http://localhost', screenshots: [] });
        await writeJson(currentManifestPath, { generatedAt: new Date().toISOString(), baseUrl: 'http://localhost', screenshots: [] });

        const { summary } = await generateVisualDiffReport({
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

        const { summary } = await generateVisualDiffReport({ ...opts, routeIds: [routeId] });

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
            baselinePngs: [{ relPath: 'screenshots/nested/r.png', width: 10, height: 10, r: 100, g: 100, b: 100 }],
            currentPngs: [{ relPath: 'screenshots/nested/r.png', width: 10, height: 10, r: 100, g: 100, b: 100 }]
        });

        const { summary } = await generateVisualDiffReport({ ...opts, routeIds: [routeId] });

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
                makeManifestEntry('dim-changed', 'mobile', 'screenshots/dim-changed.png', 1170, 6315),
                makeManifestEntry('no-current', 'desktop', 'screenshots/no-current.png', 10, 10)
            ],
            currentEntries: [
                makeManifestEntry('matched', 'desktop', 'screenshots/matched.png', 10, 10),
                makeManifestEntry('changed', 'desktop', 'screenshots/changed.png', 10, 10),
                makeManifestEntry('dim-changed', 'mobile', 'screenshots/dim-changed.png', 1170, 5853),
                makeManifestEntry('no-baseline', 'desktop', 'screenshots/no-baseline.png', 10, 10)
            ],
            baselinePngs: [
                { relPath: 'screenshots/matched.png', width: 10, height: 10, r: 200, g: 200, b: 200 },
                { relPath: 'screenshots/changed.png', width: 10, height: 10, r: 255, g: 255, b: 255 }
            ],
            currentPngs: [
                { relPath: 'screenshots/matched.png', width: 10, height: 10, r: 200, g: 200, b: 200 },
                { relPath: 'screenshots/changed.png', width: 10, height: 10, r: 0, g: 0, b: 0 }
            ]
        });

        const { summary } = await generateVisualDiffReport({ ...opts, routeIds: routes.map((r) => r.id) });

        expect(summary.matchedScreenshots).toBe(1);
        expect(summary.changedScreenshots).toBe(1);
        expect(summary.dimensionChanges).toHaveLength(1);
        expect(summary.dimensionChanges[0].id).toBe('dim-changed');
        expect(summary.missingInBaseline).toBe(1);
        expect(summary.missing.find((m) => m.id === 'no-baseline')).toMatchObject({ location: 'baseline' });
        expect(summary.missingInCurrent).toBe(1);
        expect(summary.missing.find((m) => m.id === 'no-current')).toMatchObject({ location: 'current' });
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

        const { summary } = await generateVisualDiffReport({
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
            generateVisualDiffReport({
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
        const imagePath = 'screenshots/r.png';

        const opts = await setupFixtures(tempDir, {
            routes: [
                { id: selectedId, path: '/', viewport: 'desktop' },
                { id: extraId, path: '/', viewport: 'mobile' }
            ],
            baselineEntries: [
                makeManifestEntry(selectedId, 'desktop', imagePath, 10, 10),
                makeManifestEntry(extraId, 'mobile', imagePath, 10, 10)
            ],
            currentEntries: [
                makeManifestEntry(selectedId, 'desktop', imagePath, 10, 10),
                makeManifestEntry(extraId, 'mobile', imagePath, 10, 10)
            ],
            baselinePngs: [{ relPath: imagePath, width: 10, height: 10, r: 50, g: 50, b: 50 }],
            currentPngs: [{ relPath: imagePath, width: 10, height: 10, r: 50, g: 50, b: 50 }]
        });

        // Only request the selected route — the extra entry should be ignored.
        const { summary } = await generateVisualDiffReport({ ...opts, routeIds: [selectedId] });

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
            baselineEntries: [
                makeManifestEntry(routeA, 'desktop', 'screenshots/a.png', 10, 10),
                makeManifestEntry(routeB, 'desktop', 'screenshots/b.png', 10, 10)
            ],
            currentEntries: [
                makeManifestEntry(routeA, 'desktop', 'screenshots/a.png', 10, 10),
                makeManifestEntry(routeB, 'desktop', 'screenshots/b.png', 10, 10)
            ],
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

        const { summary } = await generateVisualDiffReport({ ...opts, routeIds: [routeA, routeB] });

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
                { relPath: 'captures/route-a/r.png', width: 10, height: 10, r: 10, g: 10, b: 10 },
                { relPath: 'captures/route-b/r.png', width: 10, height: 10, r: 20, g: 20, b: 20 }
            ],
            currentPngs: [
                { relPath: 'captures/route-a/r.png', width: 10, height: 10, r: 10, g: 10, b: 10 },
                { relPath: 'captures/route-b/r.png', width: 10, height: 10, r: 20, g: 20, b: 20 }
            ]
        });

        const { summary } = await generateVisualDiffReport({ ...opts, routeIds: [routeId] });

        // Both sides resolve to captures/route-b/r.png (same colour) → matched.
        expect(summary.matchedScreenshots).toBe(1);
        expect(summary.errors).toHaveLength(0);
    });

    it('records an error when actual PNG dimensions differ even though manifest dimensions match', async () => {
        // Manifest says both are 10x10, but the actual current PNG is 10x20.
        // The manifest pre-check passes, comparePngs reads the files and throws.
        const routeId = 'root-index-desktop';
        const imagePath = 'screenshots/r.png';

        const opts = await setupFixtures(tempDir, {
            routes: [{ id: routeId, path: '/', viewport: 'desktop' }],
            baselineEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 10, 10)],
            currentEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 10, 10)],  // manifest says 10x10
            baselinePngs: [{ relPath: imagePath, width: 10, height: 10, r: 100, g: 100, b: 100 }],
            currentPngs: [{ relPath: imagePath, width: 10, height: 20, r: 100, g: 100, b: 100 }]  // actual PNG is 10x20
        });

        const { summary } = await generateVisualDiffReport({ ...opts, routeIds: [routeId] });

        expect(summary.errors).toHaveLength(1);
        expect(summary.errors[0].message).toMatch(/Dimension mismatch/);
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

        await expect(
            generateVisualDiffReport({ ...opts, routeIds: [routeId] })
        ).rejects.toThrow(/Duplicate screenshot id/);
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

            const { markdown } = await generateVisualDiffReport({ ...opts, routeIds: [routeId] });

            expect(markdown).toContain('SnapDrift Report');
            expect(markdown).toContain('Clean');
            expect(markdown).toContain('## Drift signals');
            expect(markdown).toContain('## Dimension shifts');
            expect(markdown).toContain('## Comparison errors');
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

            const { markdown } = await generateVisualDiffReport({ ...opts, routeIds: [routeId] });

            expect(markdown).toContain(routeId);
            expect(markdown).toContain('Mismatch');
        });

        it('describes dimension changes with baseline/current dimensions and next-step guidance', async () => {
            const routeId = 'root-index-desktop';

            const opts = await setupFixtures(tempDir, {
                routes: [{ id: routeId, path: '/', viewport: 'desktop' }],
                baselineEntries: [makeManifestEntry(routeId, 'desktop', 'screenshots/r.png', 1440, 1266)],
                currentEntries: [makeManifestEntry(routeId, 'desktop', 'screenshots/r.png', 1440, 1092)]
            });

            const { markdown } = await generateVisualDiffReport({ ...opts, routeIds: [routeId] });

            expect(markdown).toContain('1440×1266');
            expect(markdown).toContain('1440×1092');
            expect(markdown).toMatch(/Next step/i);
            expect(markdown).toMatch(/refresh the baseline/i);
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

            const { markdown } = await generateVisualDiffReport({
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

// ---------------------------------------------------------------------------
// runVisualDiffCli integration tests
// ---------------------------------------------------------------------------

describe('runVisualDiffCli', () => {
    let runVisualDiffCli;
    let tempDir;

    beforeAll(async () => {
        ({ runVisualDiffCli } = await import('../lib/compare-visual-results.mjs'));
    });

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'compare-visual-cli-'));
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
        return { ...opts, routeIds: [routeId], ...cliOutputPaths(path.join(tempDir, 'out')) };
    }

    it('writes summary JSON and markdown files to the output directory', async () => {
        const opts = await buildCleanOpts();

        await runVisualDiffCli({ ...opts, enforceOutcome: false });

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
            runVisualDiffCli({ ...fixtures, ...cliOutputPaths(path.join(tempDir, 'out')), routeIds: [routeId], enforceOutcome: true })
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
            runVisualDiffCli({ ...fixtures, ...cliOutputPaths(path.join(tempDir, 'out')), routeIds: [routeId], enforceOutcome: true })
        ).rejects.toThrow(/capture|drift/i);
    });

    it('does not throw in fail-on-changes mode when all screenshots are clean', async () => {
        const opts = await buildCleanOpts('fail-on-changes');

        await expect(
            runVisualDiffCli({ ...opts, enforceOutcome: true })
        ).resolves.toBeUndefined();
    });
});
