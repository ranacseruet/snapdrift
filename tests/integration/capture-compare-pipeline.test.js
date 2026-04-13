/** @jest-environment node */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';

// ---------------------------------------------------------------------------
// Fixture helpers (reused from compare-results.test.js patterns)
// ---------------------------------------------------------------------------

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

function makeConfig(routes, diff = {}) {
    return {
        baselineArtifactName: 'integration-test-baseline',
        workingDirectory: '.',
        baseUrl: 'http://localhost:3000',
        resultsFile: 'qa-artifacts/snapdrift/baseline/current/results.json',
        manifestFile: 'qa-artifacts/snapdrift/baseline/current/manifest.json',
        screenshotsRoot: 'qa-artifacts/snapdrift/baseline/current',
        routes,
        diff: { threshold: diff.threshold ?? 0.01, mode: diff.mode ?? 'report-only' }
    };
}

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
 * Writes all fixture files for the integration pipeline.
 * Returns paths needed by both generateDriftReport and stageArtifacts.
 */
async function setupPipelineFixtures(tempDir, { routes, baselineEntries, currentEntries, baselinePngs = [], currentPngs = [], diffMode, threshold }) {
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
// Integration tests: compare → stage pipeline
// ---------------------------------------------------------------------------

describe('capture → compare → stage pipeline', () => {
    let generateDriftReport;
    let stageArtifacts;
    let tempDir;

    beforeAll(async () => {
        ({ generateDriftReport } = await import('../../lib/compare-results.mjs'));
        ({ stageArtifacts } = await import('../../lib/stage-artifacts.mjs'));
    });

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-pipeline-'));
    });

    afterEach(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('produces a clean diff bundle through the full compare → stage pipeline', async () => {
        const routeId = 'home-desktop';
        const imagePath = 'screenshots/home-desktop.png';

        const opts = await setupPipelineFixtures(tempDir, {
            routes: [{ id: routeId, path: '/', viewport: 'desktop' }],
            baselineEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 10, 10)],
            currentEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 10, 10)],
            baselinePngs: [{ relPath: imagePath, width: 10, height: 10, r: 128, g: 128, b: 128 }],
            currentPngs: [{ relPath: imagePath, width: 10, height: 10, r: 128, g: 128, b: 128 }]
        });

        // Step 1: Compare (generateDriftReport)
        const { summary, markdown } = await generateDriftReport({ ...opts, routeIds: [routeId] });
        expect(summary.status).toBe('clean');
        expect(summary.matchedScreenshots).toBe(1);
        expect(summary.completed).toBe(true);

        // Step 2: Write summary to disk (mimics what runDriftCheckCli does)
        const summaryJsonPath = path.join(tempDir, 'drift', 'summary.json');
        const summaryMarkdownPath = path.join(tempDir, 'drift', 'summary.md');
        await writeJson(summaryJsonPath, summary);
        await fs.mkdir(path.dirname(summaryMarkdownPath), { recursive: true });
        await fs.writeFile(summaryMarkdownPath, markdown);

        // Step 3: Stage the diff bundle
        const bundleDir = path.join(tempDir, 'drift-bundle');
        const result = await stageArtifacts({
            artifactType: 'diff',
            bundleDir,
            summaryJsonPath,
            summaryMarkdownPath,
            baselineResultsPath: opts.baselineResultsPath,
            currentResultsPath: opts.currentResultsPath,
            baselineManifestPath: opts.baselineManifestPath,
            currentManifestPath: opts.currentManifestPath,
            baselineScreenshotsDir: path.join(opts.baselineRunDir, 'screenshots'),
            currentScreenshotsDir: path.join(opts.currentRunDir, 'screenshots')
        });

        // Step 4: Verify bundle structure
        expect(result.bundleDir).toBe(bundleDir);

        const stagedSummary = JSON.parse(await fs.readFile(path.join(bundleDir, 'summary.json'), 'utf8'));
        expect(stagedSummary.status).toBe('clean');
        expect(stagedSummary.matchedScreenshots).toBe(1);

        const stagedMarkdown = await fs.readFile(path.join(bundleDir, 'summary.md'), 'utf8');
        expect(stagedMarkdown).toContain('SnapDrift Report');
        expect(stagedMarkdown).toContain('Clean');

        expect(await fs.readFile(path.join(bundleDir, 'baseline', 'results.json'), 'utf8')).toBeDefined();
        expect(await fs.readFile(path.join(bundleDir, 'current', 'results.json'), 'utf8')).toBeDefined();
        expect(await fs.readFile(path.join(bundleDir, 'baseline', 'manifest.json'), 'utf8')).toBeDefined();
        expect(await fs.readFile(path.join(bundleDir, 'current', 'manifest.json'), 'utf8')).toBeDefined();

        const baselinePng = await fs.readFile(path.join(bundleDir, 'baseline', 'screenshots', 'home-desktop.png'));
        expect(baselinePng).toBeDefined();
        const currentPng = await fs.readFile(path.join(bundleDir, 'current', 'screenshots', 'home-desktop.png'));
        expect(currentPng).toBeDefined();
    });

    it('produces a drift bundle when screenshots differ, preserving drift data through staging', async () => {
        const routeId = 'home-desktop';
        const imagePath = 'screenshots/home-desktop.png';

        const opts = await setupPipelineFixtures(tempDir, {
            routes: [{ id: routeId, path: '/', viewport: 'desktop' }],
            baselineEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 10, 10)],
            currentEntries: [makeManifestEntry(routeId, 'desktop', imagePath, 10, 10)],
            baselinePngs: [{ relPath: imagePath, width: 10, height: 10, r: 255, g: 255, b: 255 }],
            currentPngs: [{ relPath: imagePath, width: 10, height: 10, r: 0, g: 0, b: 0 }]
        });

        const { summary, markdown } = await generateDriftReport({ ...opts, routeIds: [routeId] });
        expect(summary.status).toBe('changes-detected');
        expect(summary.changedScreenshots).toBe(1);
        expect(summary.changed[0].mismatchRatio).toBeGreaterThan(0.01);

        const summaryJsonPath = path.join(tempDir, 'drift', 'summary.json');
        const summaryMarkdownPath = path.join(tempDir, 'drift', 'summary.md');
        await writeJson(summaryJsonPath, summary);
        await fs.mkdir(path.dirname(summaryMarkdownPath), { recursive: true });
        await fs.writeFile(summaryMarkdownPath, markdown);

        const bundleDir = path.join(tempDir, 'drift-bundle');
        await stageArtifacts({
            artifactType: 'diff',
            bundleDir,
            summaryJsonPath,
            summaryMarkdownPath,
            baselineResultsPath: opts.baselineResultsPath,
            currentResultsPath: opts.currentResultsPath,
            baselineManifestPath: opts.baselineManifestPath,
            currentManifestPath: opts.currentManifestPath,
            baselineScreenshotsDir: path.join(opts.baselineRunDir, 'screenshots'),
            currentScreenshotsDir: path.join(opts.currentRunDir, 'screenshots')
        });

        const stagedSummary = JSON.parse(await fs.readFile(path.join(bundleDir, 'summary.json'), 'utf8'));
        expect(stagedSummary.status).toBe('changes-detected');
        expect(stagedSummary.changedScreenshots).toBe(1);
        expect(stagedSummary.changed[0].id).toBe(routeId);
        expect(stagedSummary.changed[0].mismatchRatio).toBeGreaterThan(0.01);

        const stagedMarkdown = await fs.readFile(path.join(bundleDir, 'summary.md'), 'utf8');
        expect(stagedMarkdown).toContain('Drift detected');
        expect(stagedMarkdown).toContain(routeId);
    });

    it('handles multiple routes with mixed outcomes through the full pipeline', async () => {
        const routes = [
            { id: 'matched', path: '/matched', viewport: 'desktop' },
            { id: 'changed', path: '/changed', viewport: 'desktop' },
            { id: 'dim-shift', path: '/dim', viewport: 'mobile' }
        ];

        const opts = await setupPipelineFixtures(tempDir, {
            routes,
            baselineEntries: [
                makeManifestEntry('matched', 'desktop', 'screenshots/matched.png', 10, 10),
                makeManifestEntry('changed', 'desktop', 'screenshots/changed.png', 10, 10),
                makeManifestEntry('dim-shift', 'mobile', 'screenshots/dim-shift.png', 390, 844)
            ],
            currentEntries: [
                makeManifestEntry('matched', 'desktop', 'screenshots/matched.png', 10, 10),
                makeManifestEntry('changed', 'desktop', 'screenshots/changed.png', 10, 10),
                makeManifestEntry('dim-shift', 'mobile', 'screenshots/dim-shift.png', 390, 600)
            ],
            baselinePngs: [
                { relPath: 'screenshots/matched.png', width: 10, height: 10, r: 100, g: 100, b: 100 },
                { relPath: 'screenshots/changed.png', width: 10, height: 10, r: 255, g: 255, b: 255 }
            ],
            currentPngs: [
                { relPath: 'screenshots/matched.png', width: 10, height: 10, r: 100, g: 100, b: 100 },
                { relPath: 'screenshots/changed.png', width: 10, height: 10, r: 0, g: 0, b: 0 }
            ]
        });

        const { summary, markdown } = await generateDriftReport({ ...opts, routeIds: routes.map((r) => r.id) });

        expect(summary.matchedScreenshots).toBe(1);
        expect(summary.changedScreenshots).toBe(1);
        expect(summary.dimensionChanges).toHaveLength(1);
        expect(summary.dimensionChanges[0].id).toBe('dim-shift');
        expect(summary.status).toBe('incomplete');

        const summaryJsonPath = path.join(tempDir, 'drift', 'summary.json');
        const summaryMarkdownPath = path.join(tempDir, 'drift', 'summary.md');
        await writeJson(summaryJsonPath, summary);
        await fs.mkdir(path.dirname(summaryMarkdownPath), { recursive: true });
        await fs.writeFile(summaryMarkdownPath, markdown);

        const bundleDir = path.join(tempDir, 'drift-bundle');
        await stageArtifacts({
            artifactType: 'diff',
            bundleDir,
            summaryJsonPath,
            summaryMarkdownPath,
            baselineResultsPath: opts.baselineResultsPath,
            currentResultsPath: opts.currentResultsPath,
            baselineManifestPath: opts.baselineManifestPath,
            currentManifestPath: opts.currentManifestPath,
            baselineScreenshotsDir: path.join(opts.baselineRunDir, 'screenshots'),
            currentScreenshotsDir: path.join(opts.currentRunDir, 'screenshots')
        });

        const stagedSummary = JSON.parse(await fs.readFile(path.join(bundleDir, 'summary.json'), 'utf8'));
        expect(stagedSummary.matchedScreenshots).toBe(1);
        expect(stagedSummary.changedScreenshots).toBe(1);
        expect(stagedSummary.dimensionChanges).toHaveLength(1);
        expect(stagedSummary.status).toBe('incomplete');

        const stagedMarkdown = await fs.readFile(path.join(bundleDir, 'summary.md'), 'utf8');
        expect(stagedMarkdown).toContain('Incomplete');
        expect(stagedMarkdown).toContain('390\u00d7600');
    });

    it('produces a correct baseline bundle when staging a baseline capture', async () => {
        const routeId = 'home-desktop';
        const imagePath = 'screenshots/home-desktop.png';

        // For baseline staging, we only have one side of the data.
        const resultsPath = path.join(tempDir, 'capture', 'results.json');
        const manifestPath = path.join(tempDir, 'capture', 'manifest.json');
        const screenshotsDir = path.join(tempDir, 'capture', 'screenshots');

        await writeJson(resultsPath, makeResults([routeId]));
        await writeJson(manifestPath, {
            generatedAt: new Date().toISOString(),
            baseUrl: 'http://localhost',
            screenshots: [makeManifestEntry(routeId, 'desktop', imagePath, 10, 10)]
        });
        await writePng(path.join(screenshotsDir, 'home-desktop.png'), 10, 10, 64, 128, 255);

        const bundleDir = path.join(tempDir, 'baseline-bundle');
        const result = await stageArtifacts({
            artifactType: 'baseline',
            bundleDir,
            resultsPath,
            manifestPath,
            screenshotsDir
        });

        expect(result.bundleDir).toBe(bundleDir);

        const stagedResults = JSON.parse(await fs.readFile(path.join(bundleDir, 'results.json'), 'utf8'));
        expect(stagedResults.routes).toHaveLength(1);
        expect(stagedResults.routes[0].id).toBe(routeId);

        const stagedManifest = JSON.parse(await fs.readFile(path.join(bundleDir, 'manifest.json'), 'utf8'));
        expect(stagedManifest.screenshots).toHaveLength(1);
        expect(stagedManifest.screenshots[0].id).toBe(routeId);

        const stagedPng = await fs.readFile(path.join(bundleDir, 'screenshots', 'home-desktop.png'));
        expect(stagedPng).toBeDefined();
    });
});