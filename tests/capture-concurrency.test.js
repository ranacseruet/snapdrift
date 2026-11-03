/** @jest-environment node */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';
import { PNG } from 'pngjs';

// SNAPDRIFT_CAPTURE_CONCURRENCY is a module-scope constant, so it must be set
// before the module under test is imported. A limit of 1 across two viewport
// groups distinguishes a shared run-wide limiter (max 1 capture in flight)
// from per-viewport limiters (max 2, one per group).
process.env.SNAPDRIFT_CAPTURE_CONCURRENCY = '1';

const launchMock = jest.fn();

jest.unstable_mockModule('playwright', () => ({
    chromium: {
        launch: launchMock
    }
}));

const { runBaselineCapture } = await import('../packages/adapter-fs/src/capture.mjs');

function makeConfig(tempDir, routes) {
    return {
        baselineArtifactName: 'test-snapdrift-baseline',
        workingDirectory: tempDir,
        baseUrl: 'http://localhost:3000',
        resultsFile: 'qa-artifacts/snapdrift/baseline/current/results.json',
        manifestFile: 'qa-artifacts/snapdrift/baseline/current/manifest.json',
        screenshotsRoot: 'qa-artifacts/snapdrift/baseline/current',
        routes,
        diff: {
            threshold: 0.01,
            mode: 'report-only'
        }
    };
}

function createTrackingPage(tracker) {
    return {
        goto: jest.fn(async () => {
            tracker.active += 1;
            tracker.max = Math.max(tracker.max, tracker.active);
            await new Promise((resolve) => setTimeout(resolve, 20));
            tracker.active -= 1;
        }),
        waitForTimeout: jest.fn().mockResolvedValue(undefined),
        screenshot: jest.fn(async ({ path: screenshotPath }) => {
            const png = new PNG({ width: 10, height: 10 });
            for (let index = 0; index < png.data.length; index += 4) {
                png.data[index] = 255;
                png.data[index + 1] = 255;
                png.data[index + 2] = 255;
                png.data[index + 3] = 255;
            }
            const pngBuffer = PNG.sync.write(png);
            await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
            await fs.writeFile(screenshotPath, pngBuffer);
            return pngBuffer;
        }),
        close: jest.fn().mockResolvedValue(undefined)
    };
}

function createHarness(tracker) {
    const contexts = [];
    const browser = {
        version: () => '149.0.0.1',
        newContext: jest.fn(async () => {
            const context = {
                newPage: jest.fn(async () => createTrackingPage(tracker)),
                close: jest.fn().mockResolvedValue(undefined)
            };
            contexts.push(context);
            return context;
        }),
        close: jest.fn().mockResolvedValue(undefined)
    };

    launchMock.mockResolvedValue(browser);

    return { browser, contexts };
}

describe('runBaselineCapture concurrency', () => {
    let tempDir;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-capture-concurrency-'));
        launchMock.mockReset();
    });

    afterEach(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('shares one concurrency limit across all viewport groups', async () => {
        const routes = [
            { id: 'home-desktop', path: '/', viewport: 'desktop' },
            { id: 'about-desktop', path: '/about', viewport: 'desktop' },
            { id: 'home-mobile', path: '/', viewport: 'mobile' },
            { id: 'about-mobile', path: '/about', viewport: 'mobile' }
        ];
        const configPath = path.join(tempDir, 'snapdrift.json');
        await fs.writeFile(configPath, JSON.stringify(makeConfig(tempDir, routes), null, 2));
        const tracker = { active: 0, max: 0 };
        createHarness(tracker);

        const result = await runBaselineCapture({ configPath });

        expect(result.resultsPath).toBeTruthy();
        const results = JSON.parse(await fs.readFile(result.resultsPath, 'utf8'));
        const routeErrors = results.routes.filter((route) => route.status !== 'passed');
        if (routeErrors.length > 0) {
            throw new Error(`capture failures: ${JSON.stringify(routeErrors, null, 2)}`);
        }
        expect(results.passed).toBe(true);
        expect(results.routes).toHaveLength(4);
        // With SNAPDRIFT_CAPTURE_CONCURRENCY=1, a run-wide limiter allows at
        // most one capture in flight even though two viewport groups run in
        // parallel. Per-group limiters would have allowed two.
        expect(tracker.max).toBe(1);
    });
});