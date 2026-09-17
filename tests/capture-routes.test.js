/** @jest-environment node */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';
import { PNG } from 'pngjs';

const launchMock = jest.fn();
const expectedContextSettings = {
    locale: 'en-US', timezoneId: 'UTC', colorScheme: 'light', reducedMotion: 'no-preference',
    forcedColors: 'none', javaScriptEnabled: true, serviceWorkers: 'allow'
};

jest.unstable_mockModule('playwright', () => ({
    chromium: {
        launch: launchMock
    }
}));

const originalConcurrency = process.env.SNAPDRIFT_CAPTURE_CONCURRENCY;
process.env.SNAPDRIFT_CAPTURE_CONCURRENCY = '5';
const { runBaselineCapture } = await import('../lib/capture-routes.mjs');
if (originalConcurrency === undefined) {
    delete process.env.SNAPDRIFT_CAPTURE_CONCURRENCY;
} else {
    process.env.SNAPDRIFT_CAPTURE_CONCURRENCY = originalConcurrency;
}
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

function createHarness({ desktopPage, mobilePage, customPage, pageFactory } = {}) {
    const contexts = [];
    const browser = {
        version: () => '149.0.0.1',
        newContext: jest.fn(async (options) => {
            const storage = new Map();
            const pages = [];
            const context = {
                options,
                storage,
                pages,
                newPage: jest.fn(async () => {
                    const preset = Object.keys(SNAPDRIFT_VIEWPORT_PRESETS).find((name) => {
                        const { width, height } = SNAPDRIFT_VIEWPORT_PRESETS[name];
                        return options.viewport.width === width && options.viewport.height === height;
                    });
                    const behavior = preset === 'desktop' ? desktopPage : preset === 'mobile' ? mobilePage : customPage;
                    const page = pageFactory ? await pageFactory(options, storage) : (behavior || createPage());
                    pages.push(page);
                    return page;
                }),
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

function expectContextsClosed(contexts, browser) {
    expect(new Set(contexts).size).toBe(contexts.length);
    for (const context of contexts) {
        expect(context.newPage).toHaveBeenCalledTimes(1);
        expect(context.close).toHaveBeenCalledTimes(1);
        expect(context.close.mock.invocationCallOrder[0]).toBeLessThan(browser.close.mock.invocationCallOrder[0]);
        for (const page of context.pages) {
            expect(page.close).not.toHaveBeenCalled();
        }
    }
    expect(browser.close).toHaveBeenCalledTimes(1);
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

    it('captures selected routes, writes outputs, and configures per-attempt viewport contexts', async () => {
        const routes = [
            { id: 'home-desktop', path: '/', viewport: 'desktop' },
            { id: 'home-mobile', path: '/', viewport: 'mobile' }
        ];
        const configPath = await writeConfig(tempDir, routes);
        const desktopPage = createPage({}, { width: 144, height: 126 });
        const mobilePage = createPage({}, { width: 39, height: 132 });
        const { browser, contexts } = createHarness({ desktopPage, mobilePage });

        const result = await runBaselineCapture({
            configPath,
            routeIds: routes.map((route) => route.id)
        });

        const results = JSON.parse(await fs.readFile(result.resultsPath, 'utf8'));
        const manifest = JSON.parse(await fs.readFile(result.manifestPath, 'utf8'));
        const desktopShot = path.join(result.screenshotsRoot, 'screenshots', 'home-desktop.png');
        const mobileShot = path.join(result.screenshotsRoot, 'screenshots', 'home-mobile.png');

        expect(launchMock).toHaveBeenCalledWith({ headless: true, args: ['--disable-gpu'] });
        expect(browser.newContext).toHaveBeenNthCalledWith(1, {
            ...expectedContextSettings,
            viewport: {
                width: SNAPDRIFT_VIEWPORT_PRESETS.desktop.width,
                height: SNAPDRIFT_VIEWPORT_PRESETS.desktop.height
            },
            deviceScaleFactor: SNAPDRIFT_VIEWPORT_PRESETS.desktop.deviceScaleFactor,
            isMobile: SNAPDRIFT_VIEWPORT_PRESETS.desktop.isMobile,
            hasTouch: SNAPDRIFT_VIEWPORT_PRESETS.desktop.hasTouch
        });
        expect(browser.newContext).toHaveBeenNthCalledWith(2, {
            ...expectedContextSettings,
            viewport: {
                width: SNAPDRIFT_VIEWPORT_PRESETS.mobile.width,
                height: SNAPDRIFT_VIEWPORT_PRESETS.mobile.height
            },
            deviceScaleFactor: SNAPDRIFT_VIEWPORT_PRESETS.mobile.deviceScaleFactor,
            isMobile: SNAPDRIFT_VIEWPORT_PRESETS.mobile.isMobile,
            hasTouch: SNAPDRIFT_VIEWPORT_PRESETS.mobile.hasTouch
        });
        expect(desktopPage.goto).toHaveBeenCalledWith('http://localhost:3000/', {
            waitUntil: 'load',
            timeout: SNAPDRIFT_NAVIGATION_TIMEOUT_MS
        });
        expect(mobilePage.goto).toHaveBeenCalledWith('http://localhost:3000/', {
            waitUntil: 'load',
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
        expect(manifest.captureProfile).toMatchObject({
            schemaVersion: 2,
            engine: { name: 'snapdrift-local', version: expect.any(String) },
            engineVersion: expect.any(String),
            browser: 'chromium',
            browserRevision: '149.0.0.1',
            playwrightVersion: expect.stringMatching(/^\d+\./),
            platform: { name: os.platform(), architecture: os.arch(), release: os.release(), version: os.version() },
            locale: 'en-US', timezone: 'UTC',
            settings: {
                screenshot: { fullPage: true, animations: 'disabled', caret: 'hide', scale: 'device', omitBackground: false, type: 'png' },
                readiness: { waitUntil: 'load', settleDelayMs: SNAPDRIFT_SETTLE_DELAY_MS },
                context: { isolation: 'fresh-context-per-attempt' },
                launch: { headless: true, args: ['--disable-gpu'] }
            }
        });
        expect(manifest.captureProfile.engineVersion).toBe(manifest.captureProfile.engine.version);
        expect(desktopPage.screenshot).toHaveBeenCalledWith({ path: desktopShot, ...manifest.captureProfile.settings.screenshot });
        expect(manifest.screenshots.map((entry) => entry.id)).toEqual(['home-desktop', 'home-mobile']);
        expect(manifest.screenshots).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'home-desktop', width: 144, height: 126 }),
            expect.objectContaining({ id: 'home-mobile', width: 39, height: 132 })
        ]));
        expect((await fs.readFile(desktopShot)).length).toBeGreaterThan(0);
        expect((await fs.readFile(mobileShot)).length).toBeGreaterThan(0);
        expect(browser.newContext).toHaveBeenCalledTimes(2);
        expectContextsClosed(contexts, browser);
    });

    it.each(['desktop', 'mobile', { width: 800, height: 600 }])('isolates storage between concurrent routes sharing viewport %j', async (viewport) => {
        const configPath = await writeConfig(tempDir, [
            { id: 'writer', path: '/writer', viewport },
            { id: 'reader', path: '/reader', viewport }
        ]);
        let releaseReader;
        const written = new Promise((resolve) => { releaseReader = resolve; });
        const { browser, contexts } = createHarness({
            pageFactory: (options, storage) => {
                const imageSize = { width: 10, height: 10 };
                return createPage({
                    goto: jest.fn(async (url) => {
                        if (url.endsWith('/writer')) {
                            storage.set('recent', 'tool');
                            releaseReader();
                        } else {
                            await written;
                            imageSize.height = storage.has('recent') ? 54 : 10;
                        }
                    })
                }, imageSize);
            }
        });

        const result = await runBaselineCapture({ configPath });
        const results = JSON.parse(await fs.readFile(result.resultsPath, 'utf8'));

        expect(results.passed).toBe(true);
        expect(results.routes.find((route) => route.id === 'reader').height).toBe(10);
        expect(contexts).toHaveLength(2);
        expectContextsClosed(contexts, browser);
    });

    it('retries failed captures in a fresh context so storage from the failed attempt does not leak', async () => {
        const configPath = await writeConfig(tempDir, [
            { id: 'flaky', path: '/flaky', viewport: 'desktop' }
        ]);
        let attempt = 0;
        const { browser, contexts } = createHarness({
            pageFactory: (options, storage) => {
                attempt += 1;
                const currentAttempt = attempt;
                const imageSize = { width: 10, height: 10 };
                return createPage({
                    goto: jest.fn(async () => {
                        const leaked = storage.has('recent');
                        if (currentAttempt === 1) {
                            storage.set('recent', 'tool');
                            throw new Error('Navigation timeout');
                        }
                        imageSize.height = leaked ? 54 : 10;
                    })
                }, imageSize);
            }
        });

        const result = await runBaselineCapture({ configPath, routeIds: ['flaky'] });
        const results = JSON.parse(await fs.readFile(result.resultsPath, 'utf8'));

        expect(results.passed).toBe(true);
        expect(results.routes[0]).toEqual(expect.objectContaining({
            id: 'flaky',
            status: 'passed',
            width: 10,
            height: 10
        }));
        expect(contexts).toHaveLength(2);
        expect(contexts[0].storage.get('recent')).toBe('tool');
        expect(contexts[1].storage.size).toBe(0);
        expect(contexts[1].pages[0].goto).toHaveBeenCalledTimes(1);
        expectContextsClosed(contexts, browser);
    });

    it('marks routes as failed without crashing when browser.newContext rejects, and closes the browser', async () => {
        const configPath = await writeConfig(tempDir, [
            { id: 'home-desktop', path: '/', viewport: 'desktop' }
        ]);
        const browser = {
            version: () => '149.0.0.1',
            newContext: jest.fn().mockRejectedValue(new Error('context quota exceeded')),
            close: jest.fn().mockResolvedValue(undefined)
        };
        launchMock.mockResolvedValue(browser);

        await expect(runBaselineCapture({ configPath, routeIds: ['home-desktop'] }))
            .rejects.toThrow('SnapDrift capture failed for 1 route(s).');

        const results = JSON.parse(await fs.readFile(path.join(tempDir, 'qa-artifacts', 'snapdrift', 'baseline', 'current', 'results.json'), 'utf8'));
        expect(results.passed).toBe(false);
        expect(results.routes).toEqual([
            expect.objectContaining({
                id: 'home-desktop',
                status: 'failed',
                error: 'context quota exceeded'
            })
        ]);
        expect(browser.newContext).toHaveBeenCalledTimes(2);
        expect(browser.close).toHaveBeenCalledTimes(1);
    });

    it('closes the context when context.newPage rejects, and retries in a fresh context', async () => {
        const configPath = await writeConfig(tempDir, [
            { id: 'home-desktop', path: '/', viewport: 'desktop' }
        ]);
        const { browser, contexts } = createHarness({
            pageFactory: async () => {
                throw new Error('page crashed on open');
            }
        });

        await expect(runBaselineCapture({ configPath, routeIds: ['home-desktop'] }))
            .rejects.toThrow('SnapDrift capture failed for 1 route(s).');

        const results = JSON.parse(await fs.readFile(path.join(tempDir, 'qa-artifacts', 'snapdrift', 'baseline', 'current', 'results.json'), 'utf8'));
        expect(results.passed).toBe(false);
        expect(results.routes).toEqual([
            expect.objectContaining({
                id: 'home-desktop',
                status: 'failed',
                error: 'page crashed on open'
            })
        ]);
        expect(contexts).toHaveLength(2);
        expectContextsClosed(contexts, browser);
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

    it('rejects colliding sanitized route ids before launching the browser or creating output', async () => {
        const routes = [
            { id: 'a/b', path: '/', viewport: 'desktop' },
            { id: 'a_b', path: '/about', viewport: 'mobile' }
        ];
        const configPath = await writeConfig(tempDir, routes);

        await expect(runBaselineCapture({ configPath, routeIds: ['a/b'] }))
            .rejects.toThrow(/screenshots\/a_b\.png.*Rename.*recapture/);
        expect(launchMock).not.toHaveBeenCalled();
        await expect(fs.access(path.join(tempDir, 'qa-artifacts'))).rejects.toThrow();
    });

    it('uses SNAPDRIFT_ROUTE_IDS when explicit routeIds are omitted', async () => {
        const routes = [
            { id: 'home-desktop', path: '/', viewport: 'desktop' },
            { id: 'home-mobile', path: '/', viewport: 'mobile' }
        ];
        const configPath = await writeConfig(tempDir, routes);
        const desktopPage = createPage();
        const mobilePage = createPage();
        const { browser, contexts } = createHarness({ desktopPage, mobilePage });

        process.env.SNAPDRIFT_ROUTE_IDS = 'home-mobile';

        const result = await runBaselineCapture({ configPath });
        const results = JSON.parse(await fs.readFile(result.resultsPath, 'utf8'));

        expect(result.selectedRouteIds).toEqual(['home-mobile']);
        expect(results.routes).toHaveLength(1);
        expect(results.routes[0].id).toBe('home-mobile');
        expect(contexts).toHaveLength(1);
        expect(contexts[0].options.viewport).toEqual({ width: 390, height: 844 });
        expect(desktopPage.goto).not.toHaveBeenCalled();
        expect(mobilePage.goto).toHaveBeenCalledTimes(1);
        expectContextsClosed(contexts, browser);
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
        let releaseFirst;
        const otherRoutesStarted = new Promise((resolve) => { releaseFirst = resolve; });
        const started = [];
        const goto = jest.fn(async (url) => {
            started.push(url);
            if (started.length === routes.length) releaseFirst();
            if (url.endsWith('/a')) await otherRoutesStarted;
        });
        const { browser, contexts } = createHarness({
            pageFactory: (options) => createPage(
                { goto },
                options.viewport.width === 1440 ? { width: 20, height: 30 } : { width: 10, height: 15 }
            )
        });

        const result = await runBaselineCapture({
            configPath,
            routeIds: routes.map((r) => r.id)
        });

        const results = JSON.parse(await fs.readFile(result.resultsPath, 'utf8'));
        const manifest = JSON.parse(await fs.readFile(result.manifestPath, 'utf8'));

        expect(contexts).toHaveLength(3);
        expect(contexts.filter(({ options }) => options.viewport.width === 1440)).toHaveLength(2);
        expect(contexts.filter(({ options }) => options.viewport.width === 390)).toHaveLength(1);
        expect(new Set(contexts.flatMap(({ pages }) => pages)).size).toBe(3);
        expectContextsClosed(contexts, browser);

        // All 3 routes captured successfully
        expect(results.passed).toBe(true);
        expect(results.routes).toHaveLength(3);

        // Original order preserved: page-a (desktop), page-b (mobile), page-c (desktop)
        expect(results.routes.map((r) => r.id)).toEqual(['page-a', 'page-b', 'page-c']);
        expect(manifest.screenshots.map((s) => s.id)).toEqual(['page-a', 'page-b', 'page-c']);

        // Correct viewports recorded per route
        expect(results.routes[0]).toEqual(expect.objectContaining({ id: 'page-a', viewport: 'desktop', width: 20, height: 30 }));
        expect(results.routes[1]).toEqual(expect.objectContaining({ id: 'page-b', viewport: 'mobile' }));
        expect(results.routes[2]).toEqual(expect.objectContaining({ id: 'page-c', viewport: 'desktop' }));
    });

    it('captures a route with a custom object viewport using the specified dimensions', async () => {
        const routes = [{ id: 'tablet-view', path: '/tablet', viewport: { width: 800, height: 600 } }];
        const configPath = await writeConfig(tempDir, routes);
        const customPage = createPage({}, { width: 800, height: 600 });
        const { browser, contexts } = createHarness({ customPage });

        const result = await runBaselineCapture({ configPath, routeIds: ['tablet-view'] });
        const results = JSON.parse(await fs.readFile(result.resultsPath, 'utf8'));
        const manifest = JSON.parse(await fs.readFile(result.manifestPath, 'utf8'));

        expect(browser.newContext).toHaveBeenCalledTimes(1);
        expect(browser.newContext).toHaveBeenCalledWith({
            ...expectedContextSettings,
            viewport: { width: 800, height: 600 },
            deviceScaleFactor: 1,
            isMobile: false,
            hasTouch: false
        });
        expect(contexts).toHaveLength(1);
        expect(contexts[0].pages[0]).toBe(customPage);
        expectContextsClosed(contexts, browser);
        expect(results.routes).toHaveLength(1);
        expect(results.routes[0]).toEqual(expect.objectContaining({
            id: 'tablet-view',
            viewport: { width: 800, height: 600 }
        }));
        expect(manifest.screenshots).toHaveLength(1);
        expect(manifest.screenshots[0]).toEqual(expect.objectContaining({
            id: 'tablet-view',
            viewport: { width: 800, height: 600 }
        }));
    });

    it('preserves profiles through capture, baseline staging, and comparison with full-page growth', async () => {
        const { stageArtifacts } = await import('../lib/stage-artifacts.mjs');
        const { generateDriftReport } = await import('../lib/compare-results.mjs');
        const configPath = await writeConfig(tempDir, [{ id: 'home', path: '/', viewport: 'desktop' }]);
        createHarness({ desktopPage: createPage({}, { width: 10, height: 10 }) });
        const baseline = await runBaselineCapture({ configPath, outDir: path.join(tempDir, 'baseline') });
        const bundleDir = path.join(tempDir, 'bundle');
        await stageArtifacts({ artifactType: 'baseline', bundleDir, resultsPath: baseline.resultsPath, manifestPath: baseline.manifestPath, screenshotsDir: path.join(baseline.screenshotsRoot, 'screenshots') });
        createHarness({ desktopPage: createPage({}, { width: 10, height: 20 }) });
        const current = await runBaselineCapture({ configPath, outDir: path.join(tempDir, 'current') });
        const { summary } = await generateDriftReport({
            configPath, baselineResultsPath: path.join(bundleDir, 'results.json'), baselineManifestPath: path.join(bundleDir, 'manifest.json'),
            currentResultsPath: current.resultsPath, currentManifestPath: current.manifestPath, baselineRunDir: bundleDir, currentRunDir: current.screenshotsRoot
        });
        expect(summary.captureCompatibility).toEqual({ status: 'verified' });
        expect(summary.errors).toEqual([]);
        expect(summary.status).toBe('changes-detected');
        expect(summary.changed[0].comparison.dimensionsChanged).toBe(true);
    });

    it('writes outputs into outDir when outDir is provided', async () => {
        const routes = [{ id: 'home-desktop', path: '/', viewport: 'desktop' }];
        const configPath = await writeConfig(tempDir, routes);
        const desktopPage = createPage({}, { width: 10, height: 10 });
        const mobilePage = createPage();
        const outDir = path.join(tempDir, 'my-local-baseline');
        createHarness({ desktopPage, mobilePage });

        const result = await runBaselineCapture({ configPath, outDir });

        // All output paths must be inside outDir
        expect(result.resultsPath.startsWith(outDir)).toBe(true);
        expect(result.manifestPath.startsWith(outDir)).toBe(true);
        expect(result.screenshotsRoot).toBe(outDir);

        // Files must exist in outDir
        const results = JSON.parse(await fs.readFile(result.resultsPath, 'utf8'));
        const manifest = JSON.parse(await fs.readFile(result.manifestPath, 'utf8'));
        expect(results.routes).toHaveLength(1);
        expect(manifest.screenshots).toHaveLength(1);
        const shot = path.join(outDir, 'screenshots', 'home-desktop.png');
        expect((await fs.readFile(shot)).length).toBeGreaterThan(0);
    });

    it('forwards per-route navigationTimeout to page.goto, falling back to the global default', async () => {
        const routes = [
            { id: 'fast-page', path: '/fast', viewport: 'desktop', navigationTimeout: 5000 },
            { id: 'slow-page', path: '/slow', viewport: 'mobile' }
        ];
        const configPath = await writeConfig(tempDir, routes);
        const fastPage = createPage({}, { width: 10, height: 10 });
        const slowPage = createPage({}, { width: 10, height: 10 });
        const { browser, contexts } = createHarness({ desktopPage: fastPage, mobilePage: slowPage });

        await runBaselineCapture({ configPath, routeIds: routes.map((r) => r.id) });

        expect(fastPage.goto).toHaveBeenCalledWith('http://localhost:3000/fast', {
            waitUntil: 'load',
            timeout: 5000
        });
        expect(slowPage.goto).toHaveBeenCalledWith('http://localhost:3000/slow', {
            waitUntil: 'load',
            timeout: SNAPDRIFT_NAVIGATION_TIMEOUT_MS
        });
        expect(contexts).toHaveLength(2);
        expectContextsClosed(contexts, browser);
    });

    it('writes results and manifest before throwing when one or more captures fail', async () => {
        const routes = [{ id: 'home-desktop', path: '/', viewport: 'desktop' }];
        const configPath = await writeConfig(tempDir, routes);
        const desktopPage = createPage({
            goto: jest.fn().mockRejectedValue(new Error('Navigation timeout'))
        });
        const mobilePage = createPage();
        const { browser, contexts } = createHarness({ desktopPage, mobilePage });
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
        expect(contexts).toHaveLength(2);
        expectContextsClosed(contexts, browser);
        expect(browser.close).toHaveBeenCalledTimes(1);
    });
});
