/** @jest-environment node */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';
import { PNG } from 'pngjs';

const launchMock = jest.fn();

jest.unstable_mockModule('playwright', () => ({
    chromium: {
        launch: launchMock
    }
}));

const { runBaselineCapture } = await import('../lib/capture-routes.mjs');
const {
    SNAPDRIFT_NAVIGATION_TIMEOUT_MS,
    SNAPDRIFT_SETTLE_DELAY_MS,
    SNAPDRIFT_VIEWPORT_PRESETS
} = await import('../lib/snapdrift-config.mjs');

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

async function writeConfig(tempDir, routes) {
    const configPath = path.join(tempDir, 'snapdrift.json');
    await fs.writeFile(configPath, JSON.stringify(makeConfig(tempDir, routes), null, 2));
    return configPath;
}

function createPngBuffer(width, height) {
    const png = new PNG({ width, height });
    for (let index = 0; index < png.data.length; index += 4) {
        png.data[index] = 255;
        png.data[index + 1] = 255;
        png.data[index + 2] = 255;
        png.data[index + 3] = 255;
    }
    return PNG.sync.write(png);
}

function createPage(behavior = {}, imageSize = { width: 10, height: 10 }) {
    return {
        goto: behavior.goto || jest.fn().mockResolvedValue(undefined),
        waitForTimeout: behavior.waitForTimeout || jest.fn().mockResolvedValue(undefined),
        screenshot: behavior.screenshot || jest.fn(async ({ path: screenshotPath }) => {
            const pngBuffer = createPngBuffer(imageSize.width, imageSize.height);
            await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
            await fs.writeFile(screenshotPath, pngBuffer);
            return pngBuffer;
        }),
        close: behavior.close || jest.fn().mockResolvedValue(undefined)
    };
}

function createHarness({ desktopPage, mobilePage, customPage = null }) {
    const desktopContext = {
        newPage: jest.fn().mockResolvedValue(desktopPage),
        close: jest.fn().mockResolvedValue(undefined)
    };
    const mobileContext = {
        newPage: jest.fn().mockResolvedValue(mobilePage),
        close: jest.fn().mockResolvedValue(undefined)
    };

    const newContextMock = jest.fn()
        .mockResolvedValueOnce(desktopContext)
        .mockResolvedValueOnce(mobileContext);

    let customContext = null;
    if (customPage !== null) {
        customContext = {
            newPage: jest.fn().mockResolvedValue(customPage),
            close: jest.fn().mockResolvedValue(undefined)
        };
        newContextMock.mockResolvedValueOnce(customContext);
    }

    const browser = {
        newContext: newContextMock,
        close: jest.fn().mockResolvedValue(undefined)
    };

    launchMock.mockResolvedValue(browser);

    return {
        browser,
        desktopContext,
        mobileContext,
        customContext
    };
}

describe('runBaselineCapture', () => {
    const envNames = ['SNAPDRIFT_ROUTE_IDS'];
    let tempDir;
    let originalEnv;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-capture-'));
        originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
        launchMock.mockReset();
        for (const envName of envNames) {
            delete process.env[envName];
        }
    });

    afterEach(async () => {
        for (const envName of envNames) {
            if (originalEnv[envName] === undefined) {
                delete process.env[envName];
            } else {
                process.env[envName] = originalEnv[envName];
            }
        }
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('captures selected routes, writes outputs, and configures both viewport contexts', async () => {
        const routes = [
            { id: 'home-desktop', path: '/', viewport: 'desktop' },
            { id: 'home-mobile', path: '/', viewport: 'mobile' }
        ];
        const configPath = await writeConfig(tempDir, routes);
        const desktopPage = createPage({}, { width: 144, height: 126 });
        const mobilePage = createPage({}, { width: 39, height: 132 });
        const { browser, desktopContext, mobileContext } = createHarness({ desktopPage, mobilePage });

        const result = await runBaselineCapture({
            configPath,
            routeIds: routes.map((route) => route.id)
        });

        const results = JSON.parse(await fs.readFile(result.resultsPath, 'utf8'));
        const manifest = JSON.parse(await fs.readFile(result.manifestPath, 'utf8'));
        const desktopShot = path.join(result.screenshotsRoot, 'screenshots', 'home-desktop.png');
        const mobileShot = path.join(result.screenshotsRoot, 'screenshots', 'home-mobile.png');

        expect(launchMock).toHaveBeenCalledWith({ headless: true });
        expect(browser.newContext).toHaveBeenNthCalledWith(1, {
            viewport: {
                width: SNAPDRIFT_VIEWPORT_PRESETS.desktop.width,
                height: SNAPDRIFT_VIEWPORT_PRESETS.desktop.height
            },
            deviceScaleFactor: SNAPDRIFT_VIEWPORT_PRESETS.desktop.deviceScaleFactor,
            isMobile: SNAPDRIFT_VIEWPORT_PRESETS.desktop.isMobile,
            hasTouch: SNAPDRIFT_VIEWPORT_PRESETS.desktop.hasTouch
        });
        expect(browser.newContext).toHaveBeenNthCalledWith(2, {
            viewport: {
                width: SNAPDRIFT_VIEWPORT_PRESETS.mobile.width,
                height: SNAPDRIFT_VIEWPORT_PRESETS.mobile.height
            },
            deviceScaleFactor: SNAPDRIFT_VIEWPORT_PRESETS.mobile.deviceScaleFactor,
            isMobile: SNAPDRIFT_VIEWPORT_PRESETS.mobile.isMobile,
            hasTouch: SNAPDRIFT_VIEWPORT_PRESETS.mobile.hasTouch
        });
        expect(desktopPage.goto).toHaveBeenCalledWith('http://localhost:3000/', {
            waitUntil: 'networkidle',
            timeout: SNAPDRIFT_NAVIGATION_TIMEOUT_MS
        });
        expect(mobilePage.goto).toHaveBeenCalledWith('http://localhost:3000/', {
            waitUntil: 'networkidle',
            timeout: SNAPDRIFT_NAVIGATION_TIMEOUT_MS
        });
        expect(desktopPage.waitForTimeout).toHaveBeenCalledWith(SNAPDRIFT_SETTLE_DELAY_MS);
        expect(mobilePage.waitForTimeout).toHaveBeenCalledWith(SNAPDRIFT_SETTLE_DELAY_MS);
        expect(result.selectedRouteIds).toEqual(['home-desktop', 'home-mobile']);
        expect(results.passed).toBe(true);
        expect(results.routes).toHaveLength(2);
        expect(results.routes).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'home-desktop', width: 144, height: 126 }),
            expect.objectContaining({ id: 'home-mobile', width: 39, height: 132 })
        ]));
        expect(manifest.screenshots.map((entry) => entry.id)).toEqual(['home-desktop', 'home-mobile']);
        expect(manifest.screenshots).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'home-desktop', width: 144, height: 126 }),
            expect.objectContaining({ id: 'home-mobile', width: 39, height: 132 })
        ]));
        expect((await fs.readFile(desktopShot)).length).toBeGreaterThan(0);
        expect((await fs.readFile(mobileShot)).length).toBeGreaterThan(0);
        expect(desktopContext.close).toHaveBeenCalledTimes(1);
        expect(mobileContext.close).toHaveBeenCalledTimes(1);
        expect(browser.close).toHaveBeenCalledTimes(1);
    });

    it('sanitizes route id before using it as a filename, stripping path-traversal sequences', async () => {
        const routes = [{ id: '../../evil', path: '/', viewport: 'desktop' }];
        const configPath = await writeConfig(tempDir, routes);
        const desktopPage = createPage({}, { width: 10, height: 10 });
        const mobilePage = createPage();
        createHarness({ desktopPage, mobilePage });

        const result = await runBaselineCapture({ configPath, routeIds: ['../../evil'] });
        const results = JSON.parse(await fs.readFile(result.resultsPath, 'utf8'));

        const imagePath = results.routes[0].imagePath;
        const basename = path.basename(imagePath);
        // Basename must not contain path-traversal sequences or path separators
        expect(basename).not.toContain('..');
        expect(basename).not.toContain('/');
        expect(basename).not.toContain('\\');
        // Resolved screenshot must stay inside screenshotsRoot
        const screenshotPath = path.resolve(result.screenshotsRoot, imagePath);
        expect(screenshotPath.startsWith(result.screenshotsRoot)).toBe(true);
    });

    it('uses SNAPDRIFT_ROUTE_IDS when explicit routeIds are omitted', async () => {
        const routes = [
            { id: 'home-desktop', path: '/', viewport: 'desktop' },
            { id: 'home-mobile', path: '/', viewport: 'mobile' }
        ];
        const configPath = await writeConfig(tempDir, routes);
        const desktopPage = createPage();
        const mobilePage = createPage();
        const { desktopContext, mobileContext } = createHarness({ desktopPage, mobilePage });

        process.env.SNAPDRIFT_ROUTE_IDS = 'home-mobile';

        const result = await runBaselineCapture({ configPath });
        const results = JSON.parse(await fs.readFile(result.resultsPath, 'utf8'));

        expect(result.selectedRouteIds).toEqual(['home-mobile']);
        expect(results.routes).toHaveLength(1);
        expect(results.routes[0].id).toBe('home-mobile');
        expect(desktopContext.newPage).not.toHaveBeenCalled();
        expect(mobileContext.newPage).toHaveBeenCalledTimes(1);
    });

    it('captures multiple routes per viewport concurrently and preserves original ordering', async () => {
        // Routes deliberately interleave viewports: desktop, mobile, desktop
        // so that the parallel groups (desktop:[0,2], mobile:[1]) would produce
        // results in a different completion order without index-based ordering.
        const routes = [
            { id: 'page-a', path: '/a', viewport: 'desktop' },
            { id: 'page-b', path: '/b', viewport: 'mobile' },
            { id: 'page-c', path: '/c', viewport: 'desktop' }
        ];
        const configPath = await writeConfig(tempDir, routes);
        const desktopPage = createPage({}, { width: 20, height: 30 });
        const mobilePage = createPage({}, { width: 10, height: 15 });
        const { desktopContext, mobileContext } = createHarness({ desktopPage, mobilePage });

        const result = await runBaselineCapture({
            configPath,
            routeIds: routes.map((r) => r.id)
        });

        const results = JSON.parse(await fs.readFile(result.resultsPath, 'utf8'));
        const manifest = JSON.parse(await fs.readFile(result.manifestPath, 'utf8'));

        // Both desktop routes captured by desktopContext, one mobile by mobileContext
        expect(desktopContext.newPage).toHaveBeenCalledTimes(2);
        expect(mobileContext.newPage).toHaveBeenCalledTimes(1);

        // All 3 routes captured successfully
        expect(results.passed).toBe(true);
        expect(results.routes).toHaveLength(3);

        // Original order preserved: page-a (desktop), page-b (mobile), page-c (desktop)
        expect(results.routes.map((r) => r.id)).toEqual(['page-a', 'page-b', 'page-c']);
        expect(manifest.screenshots.map((s) => s.id)).toEqual(['page-a', 'page-b', 'page-c']);

        // Correct viewports recorded per route
        expect(results.routes[0]).toEqual(expect.objectContaining({ id: 'page-a', viewport: 'desktop' }));
        expect(results.routes[1]).toEqual(expect.objectContaining({ id: 'page-b', viewport: 'mobile' }));
        expect(results.routes[2]).toEqual(expect.objectContaining({ id: 'page-c', viewport: 'desktop' }));
    });

    it('captures a route with a custom object viewport using the specified dimensions', async () => {
        const routes = [{ id: 'tablet-view', path: '/tablet', viewport: { width: 800, height: 600 } }];
        const configPath = await writeConfig(tempDir, routes);
        const desktopPage = createPage();
        const mobilePage = createPage();
        const customPage = createPage({}, { width: 800, height: 600 });
        const { browser, desktopContext, mobileContext, customContext } = createHarness({ desktopPage, mobilePage, customPage });

        const result = await runBaselineCapture({ configPath, routeIds: ['tablet-view'] });
        const results = JSON.parse(await fs.readFile(result.resultsPath, 'utf8'));
        const manifest = JSON.parse(await fs.readFile(result.manifestPath, 'utf8'));

        // Preset contexts created first (calls 1 & 2), custom context created on demand (call 3)
        expect(browser.newContext).toHaveBeenCalledTimes(3);
        expect(browser.newContext).toHaveBeenNthCalledWith(3, {
            viewport: { width: 800, height: 600 },
            deviceScaleFactor: 1,
            isMobile: false,
            hasTouch: false
        });
        // Preset contexts opened but never used for this route
        expect(desktopContext.newPage).not.toHaveBeenCalled();
        expect(mobileContext.newPage).not.toHaveBeenCalled();
        expect(customContext.newPage).toHaveBeenCalledTimes(1);
        // All three contexts closed in finally
        expect(desktopContext.close).toHaveBeenCalledTimes(1);
        expect(mobileContext.close).toHaveBeenCalledTimes(1);
        expect(customContext.close).toHaveBeenCalledTimes(1);
        expect(results.passed).toBe(true);
        expect(results.routes).toHaveLength(1);
        expect(results.routes[0]).toEqual(expect.objectContaining({
            id: 'tablet-view',
            viewport: { width: 800, height: 600 },
            width: 800,
            height: 600
        }));
        expect(manifest.screenshots).toHaveLength(1);
        expect(manifest.screenshots[0]).toEqual(expect.objectContaining({
            id: 'tablet-view',
            viewport: { width: 800, height: 600 }
        }));
    });

    it('writes results and manifest before throwing when one or more captures fail', async () => {
        const routes = [{ id: 'home-desktop', path: '/', viewport: 'desktop' }];
        const configPath = await writeConfig(tempDir, routes);
        const desktopPage = createPage({
            goto: jest.fn().mockRejectedValue(new Error('Navigation timeout'))
        });
        const mobilePage = createPage();
        const { browser, desktopContext, mobileContext } = createHarness({ desktopPage, mobilePage });
        const resultsPath = path.join(tempDir, 'qa-artifacts', 'snapdrift', 'baseline', 'current', 'results.json');
        const manifestPath = path.join(tempDir, 'qa-artifacts', 'snapdrift', 'baseline', 'current', 'manifest.json');

        await expect(
            runBaselineCapture({
                configPath,
                routeIds: ['home-desktop']
            })
        ).rejects.toThrow('SnapDrift capture failed for 1 route(s).');

        const results = JSON.parse(await fs.readFile(resultsPath, 'utf8'));
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));

        expect(results.passed).toBe(false);
        expect(results.routes).toEqual([
            expect.objectContaining({
                id: 'home-desktop',
                status: 'failed',
                error: 'Navigation timeout'
            })
        ]);
        expect(manifest.screenshots).toEqual([]);
        // Each capture attempt opens and closes a page; retry adds one extra attempt.
        expect(desktopPage.close).toHaveBeenCalledTimes(2);
        expect(desktopContext.close).toHaveBeenCalledTimes(1);
        expect(mobileContext.close).toHaveBeenCalledTimes(1);
        expect(browser.close).toHaveBeenCalledTimes(1);
    });
});
