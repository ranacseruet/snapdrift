// @ts-check

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import pngjs from 'pngjs';

import {
  loadSnapdriftConfig,
  readFirstDefinedEnv,
  resolveFromWorkingDirectory,
  selectConfiguredRoutes,
  splitCommaList,
  SNAPDRIFT_VIEWPORT_PRESETS,
  SNAPDRIFT_NAVIGATION_TIMEOUT_MS,
  SNAPDRIFT_SETTLE_DELAY_MS
} from './snapdrift-config.mjs';

const { PNG } = pngjs;

/** @typedef {import('../types/visual-diff-types').VisualBaselineResults} BaselineResults */
/** @typedef {import('../types/visual-diff-types').VisualBaselineRouteResult} BaselineRouteResult */
/** @typedef {import('../types/visual-diff-types').VisualRegressionRouteConfig} SnapdriftRouteConfig */
/** @typedef {import('../types/visual-diff-types').VisualScreenshotManifest} ScreenshotManifest */

/**
 * @param {string} targetPath
 * @returns {Promise<void>}
 */
async function ensureParentDirectory(targetPath) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
}

/**
 * @param {string} targetPath
 * @returns {Promise<void>}
 */
async function ensureDirectory(targetPath) {
  await fs.mkdir(targetPath, { recursive: true });
}

/**
 * Strips characters that could cause path traversal or produce invalid filenames.
 * @param {string} id
 * @returns {string}
 */
function sanitizeRouteId(id) {
  return id
    .replace(/\.\./g, '_')
    .replace(/[/\\]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '');
}

/**
 * @param {import('playwright').Browser} browser
 * @returns {Promise<Map<'desktop' | 'mobile', import('playwright').BrowserContext>>}
 */
async function createViewportContexts(browser) {
  return new Map([
    ['desktop', await browser.newContext({
      viewport: { width: SNAPDRIFT_VIEWPORT_PRESETS.desktop.width, height: SNAPDRIFT_VIEWPORT_PRESETS.desktop.height },
      deviceScaleFactor: SNAPDRIFT_VIEWPORT_PRESETS.desktop.deviceScaleFactor,
      isMobile: SNAPDRIFT_VIEWPORT_PRESETS.desktop.isMobile,
      hasTouch: SNAPDRIFT_VIEWPORT_PRESETS.desktop.hasTouch
    })],
    ['mobile', await browser.newContext({
      viewport: { width: SNAPDRIFT_VIEWPORT_PRESETS.mobile.width, height: SNAPDRIFT_VIEWPORT_PRESETS.mobile.height },
      deviceScaleFactor: SNAPDRIFT_VIEWPORT_PRESETS.mobile.deviceScaleFactor,
      isMobile: SNAPDRIFT_VIEWPORT_PRESETS.mobile.isMobile,
      hasTouch: SNAPDRIFT_VIEWPORT_PRESETS.mobile.hasTouch
    })]
  ]);
}

/**
 * @param {Map<'desktop' | 'mobile', import('playwright').BrowserContext>} contexts
 * @param {SnapdriftRouteConfig} route
 * @param {string} baseUrl
 * @param {string} screenshotsRoot
 * @returns {Promise<BaselineRouteResult & { manifestEntry?: ScreenshotManifest['screenshots'][number] }>}
 */
async function captureRoute(contexts, route, baseUrl, screenshotsRoot) {
  const startedAt = Date.now();
  const context = contexts.get(route.viewport);
  if (!context) {
    throw new Error(`Unsupported viewport preset ${route.viewport} for route ${route.id}`);
  }

  const page = await context.newPage();
  try {
    const targetUrl = new URL(route.path, baseUrl).toString();
    await page.goto(targetUrl, {
      waitUntil: 'networkidle',
      timeout: SNAPDRIFT_NAVIGATION_TIMEOUT_MS
    });
    await page.waitForTimeout(SNAPDRIFT_SETTLE_DELAY_MS);

    const imagePath = path.join('screenshots', `${sanitizeRouteId(route.id)}.png`);
    const absoluteImagePath = path.join(screenshotsRoot, imagePath);
    await ensureParentDirectory(absoluteImagePath);
    const screenshotBuffer = await page.screenshot({
      path: absoluteImagePath,
      fullPage: true
    });
    const screenshot = PNG.sync.read(screenshotBuffer);

    return {
      id: route.id,
      path: route.path,
      viewport: route.viewport,
      status: 'passed',
      durationMs: Date.now() - startedAt,
      imagePath,
      width: screenshot.width,
      height: screenshot.height,
      manifestEntry: {
        id: route.id,
        path: route.path,
        viewport: route.viewport,
        imagePath,
        width: screenshot.width,
        height: screenshot.height
      }
    };
  } catch (error) {
    return {
      id: route.id,
      path: route.path,
      viewport: route.viewport,
      status: 'failed',
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await page.close();
  }
}

const CAPTURE_MAX_RETRIES = 1;

/**
 * @param {Map<'desktop' | 'mobile', import('playwright').BrowserContext>} contexts
 * @param {SnapdriftRouteConfig} route
 * @param {string} baseUrl
 * @param {string} screenshotsRoot
 * @returns {Promise<BaselineRouteResult & { manifestEntry?: ScreenshotManifest['screenshots'][number] }>}
 */
async function captureRouteWithRetry(contexts, route, baseUrl, screenshotsRoot) {
  let result = await captureRoute(contexts, route, baseUrl, screenshotsRoot);
  for (let attempt = 1; attempt <= CAPTURE_MAX_RETRIES && result.status !== 'passed'; attempt++) {
    console.log(`[SnapDrift] Retrying route ${route.id} (attempt ${attempt + 1}/${CAPTURE_MAX_RETRIES + 1})...`);
    result = await captureRoute(contexts, route, baseUrl, screenshotsRoot);
  }
  return result;
}

/**
 * @param {{
 *   configPath?: string,
 *   routeIds?: Iterable<string>
 * }} [options]
 * @returns {Promise<{ resultsPath: string, manifestPath: string, screenshotsRoot: string, selectedRouteIds: string[] }>}
 */
export async function runBaselineCapture(options = {}) {
  const requestedRouteIds = [...(
    options.routeIds || splitCommaList(readFirstDefinedEnv(['SNAPDRIFT_ROUTE_IDS']))
  )];
  const { config, configPath } = await loadSnapdriftConfig(options.configPath);
  const { routes, selectedRouteIds } = selectConfiguredRoutes(config, requestedRouteIds);

  const resultsPath = resolveFromWorkingDirectory(config, config.resultsFile);
  const manifestPath = resolveFromWorkingDirectory(config, config.manifestFile);
  const screenshotsRoot = resolveFromWorkingDirectory(config, config.screenshotsRoot);

  // Screenshots are written to a `screenshots/` subdirectory inside screenshotsRoot,
  // i.e. the actual PNG files land at `{screenshotsRoot}/screenshots/{id}.png`.
  await Promise.all([
    ensureParentDirectory(resultsPath),
    ensureParentDirectory(manifestPath),
    ensureDirectory(path.join(screenshotsRoot, 'screenshots'))
  ]);

  /** @type {BaselineResults} */
  const results = {
    startedAt: new Date().toISOString(),
    baseUrl: config.baseUrl,
    suite: 'snapdrift-capture',
    configPath: path.relative(path.resolve('.'), configPath),
    manifestPath: path.relative(path.resolve('.'), manifestPath),
    screenshotsRoot: path.relative(path.resolve('.'), screenshotsRoot),
    routes: []
  };

  /** @type {ScreenshotManifest} */
  const manifest = {
    generatedAt: new Date().toISOString(),
    baseUrl: config.baseUrl,
    screenshots: []
  };

  const browser = await chromium.launch({ headless: true });
  const contexts = await createViewportContexts(browser);
  let failures = 0;

  try {
    for (const [index, route] of routes.entries()) {
      console.log(`[SnapDrift] Capturing route ${index + 1}/${routes.length}: ${route.id} (${route.viewport})`);
      const capture = await captureRouteWithRetry(contexts, route, config.baseUrl, screenshotsRoot);
      results.routes.push({
        id: capture.id,
        path: capture.path,
        viewport: capture.viewport,
        status: capture.status,
        durationMs: capture.durationMs,
        imagePath: capture.imagePath,
        width: capture.width,
        height: capture.height,
        error: capture.error
      });

      if (capture.manifestEntry) {
        manifest.screenshots.push(capture.manifestEntry);
      }
      if (capture.status !== 'passed') {
        failures += 1;
      }
    }
  } finally {
    await Promise.all([...contexts.values()].map((context) => context.close()));
    await browser.close();
    results.finishedAt = new Date().toISOString();
    results.passed = failures === 0;
    manifest.generatedAt = new Date().toISOString();

    await Promise.all([
      fs.writeFile(resultsPath, JSON.stringify(results, null, 2)),
      fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2))
    ]);
  }

  if (failures > 0) {
    throw new Error(`SnapDrift capture failed for ${failures} route(s).`);
  }

  return {
    resultsPath,
    manifestPath,
    screenshotsRoot,
    selectedRouteIds
  };
}

const isDirectRun = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isDirectRun) {
  runBaselineCapture().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
