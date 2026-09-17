// @ts-check

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import pngjs from 'pngjs';

import { loadSnapdriftConfig, readFirstDefinedEnv, SNAPDRIFT_CAPTURE_CONCURRENCY } from './config.mjs';
import { createConcurrencyLimiter } from './concurrency.mjs';
import {
  selectConfiguredRoutes,
  splitCommaList,
  resolveFromWorkingDirectory,
  VIEWPORT_PRESETS,
  SNAPDRIFT_NAVIGATION_TIMEOUT_MS,
  SNAPDRIFT_SETTLE_DELAY_MS,
  sanitizeRouteId,
  CAPTURE_PROFILE_SCHEMA_VERSION,
  validateCaptureProfile
} from '@snapdrift/manifest';

const { PNG } = pngjs;
const require = createRequire(import.meta.url);
const engineVersion = require('../package.json').version;
const playwrightVersion = require('playwright/package.json').version;
const launchSettings = { headless: true, args: ['--disable-gpu'] };
const screenshotSettings = Object.freeze({ fullPage: true, animations: 'disabled', caret: 'hide', scale: 'device', omitBackground: false, type: 'png' });
const contextSettings = Object.freeze({ locale: 'en-US', timezoneId: 'UTC', colorScheme: 'light', reducedMotion: 'no-preference', forcedColors: 'none', javaScriptEnabled: true, serviceWorkers: 'allow' });

/** @typedef {import('../../manifest/types/index').VisualBaselineResults} BaselineResults */
/** @typedef {import('../../manifest/types/index').VisualBaselineRouteResult} BaselineRouteResult */
/** @typedef {import('../../manifest/types/index').VisualRegressionRouteConfig} SnapdriftRouteConfig */
/** @typedef {import('../../manifest/types/index').VisualScreenshotManifest} ScreenshotManifest */

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
 * Throws if a navigation resolved to an HTTP error status (>= 400).
 *
 * `page.goto` resolves even on a 404/500 because the error body still "loads",
 * so without this guard a broken route (wrong slug, outage) silently
 * screenshots its error page and uploads it as a valid baseline. `response` is
 * null only for non-navigation schemes (e.g. about:blank), which we treat as
 * fine. Redirects are already followed by Playwright, so `status()` is the
 * final response's status.
 *
 * @param {{ status: () => number } | null} response
 * @param {SnapdriftRouteConfig} route
 * @param {string} targetUrl
 * @returns {void}
 */
export function assertNavigationOk(response, route, targetUrl) {
  if (response && response.status() >= 400) {
    throw new Error(
      `Route "${route.id}" returned HTTP ${response.status()} for ${targetUrl} — ` +
      `refusing to capture an error page as a screenshot. Check the route path/baseUrl.`
    );
  }
}

/** @typedef {import('../../manifest/types/index').VisualViewport} VisualViewport */

/**
 * Returns a stable string key for a viewport value (preset name or custom dimensions).
 * @param {VisualViewport} viewport
 * @returns {string}
 */
function viewportKey(viewport) {
  return typeof viewport === 'string' ? viewport : `custom:${viewport.width}x${viewport.height}`;
}

/**
 * Returns a human-readable label for a viewport.
 * @param {VisualViewport} viewport
 * @returns {string}
 */
function viewportLabel(viewport) {
  return typeof viewport === 'string' ? viewport : `${viewport.width}x${viewport.height}`;
}

/**
 * Returns Playwright context options for a viewport.
 * @param {VisualViewport} viewport
 * @returns {import('playwright').BrowserContextOptions}
 */
function viewportContextOptions(viewport) {
  if (typeof viewport === 'string') {
    const preset = VIEWPORT_PRESETS[viewport];
    return {
      viewport: { width: preset.width, height: preset.height },
      deviceScaleFactor: preset.deviceScaleFactor,
      isMobile: preset.isMobile,
      hasTouch: preset.hasTouch
    };
  }
  return {
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false
  };
}

/**
 * @param {import('playwright').Browser} browser
 * @param {SnapdriftRouteConfig} route
 * @param {string} baseUrl
 * @param {string} screenshotsRoot
 * @returns {Promise<BaselineRouteResult & { manifestEntry?: ScreenshotManifest['screenshots'][number] }>}
 */
async function captureRoute(browser, route, baseUrl, screenshotsRoot) {
  const startedAt = Date.now();
  let context;

  try {
    context = await browser.newContext({ ...viewportContextOptions(route.viewport), ...contextSettings });
    const page = await context.newPage();
    const targetUrl = new URL(route.path, baseUrl).toString();
    const response = await page.goto(targetUrl, {
      waitUntil: 'load',
      timeout: route.navigationTimeout ?? SNAPDRIFT_NAVIGATION_TIMEOUT_MS
    });

    assertNavigationOk(response, route, targetUrl);

    await page.waitForTimeout(SNAPDRIFT_SETTLE_DELAY_MS);

    const imagePath = path.join('screenshots', `${sanitizeRouteId(route.id)}.png`);
    const absoluteImagePath = path.join(screenshotsRoot, imagePath);
    await ensureParentDirectory(absoluteImagePath);
    const screenshotBuffer = await page.screenshot({
      path: absoluteImagePath,
      ...screenshotSettings
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
    await context?.close();
  }
}

const CAPTURE_MAX_RETRIES = 1;

/**
 * @param {import('playwright').Browser} browser
 * @param {SnapdriftRouteConfig} route
 * @param {string} baseUrl
 * @param {string} screenshotsRoot
 * @returns {Promise<BaselineRouteResult & { manifestEntry?: ScreenshotManifest['screenshots'][number] }>}
 */
async function captureRouteWithRetry(browser, route, baseUrl, screenshotsRoot) {
  let result = await captureRoute(browser, route, baseUrl, screenshotsRoot);
  for (let attempt = 1; attempt <= CAPTURE_MAX_RETRIES && result.status !== 'passed'; attempt++) {
    console.log(`[SnapDrift] Retrying route ${route.id} (attempt ${attempt + 1}/${CAPTURE_MAX_RETRIES + 1})...`);
    result = await captureRoute(browser, route, baseUrl, screenshotsRoot);
  }
  return result;
}

/**
 * @param {import('playwright').Browser} browser
 * @param {Array<{ route: SnapdriftRouteConfig, originalIndex: number }>} entries
 * @param {string} baseUrl
 * @param {string} screenshotsRoot
 * @param {number} totalRoutes
 * @param {Array<BaselineRouteResult & { manifestEntry?: ScreenshotManifest['screenshots'][number] }>} out
 * @returns {Promise<void>}
 */
async function captureViewportRoutes(browser, entries, baseUrl, screenshotsRoot, totalRoutes, out) {
  const limit = createConcurrencyLimiter(SNAPDRIFT_CAPTURE_CONCURRENCY);
  await Promise.all(entries.map(({ route, originalIndex }) =>
    limit(async () => {
      // Log the fully resolved target URL, not just the route id. When a run
      // captures a stale or wrong page (e.g. baseUrl points at production
      // instead of the PR preview), the resolved URL in the CI log is the
      // fastest way to spot it. See issue #93. A malformed route.path is left
      // for captureRoute to surface as a per-route failure, so fall back to the
      // raw path here rather than letting URL parsing abort the whole batch.
      let targetUrl = route.path;
      try {
        targetUrl = new URL(route.path, baseUrl).toString();
      } catch { /* keep the raw path for the log line */ }
      console.log(`[SnapDrift] Capturing route ${originalIndex + 1}/${totalRoutes}: ${route.id} (${viewportLabel(route.viewport)}) -> ${targetUrl}`);
      out[originalIndex] = await captureRouteWithRetry(browser, route, baseUrl, screenshotsRoot);
    })
  ));
}

/**
 * @param {{
 *   configPath?: string,
 *   routeIds?: Iterable<string>,
 *   outDir?: string
 * }} [options]
 * @returns {Promise<{ resultsPath: string, manifestPath: string, screenshotsRoot: string, selectedRouteIds: string[] }>}
 */
export async function runBaselineCapture(options = {}) {
  const requestedRouteIds = [...(
    options.routeIds || splitCommaList(readFirstDefinedEnv(['SNAPDRIFT_ROUTE_IDS']))
  )];
  const { config, configPath } = await loadSnapdriftConfig(options.configPath);
  const { routes, selectedRouteIds } = selectConfiguredRoutes(config, requestedRouteIds);

  // When outDir is provided (e.g. by the local CLI), store all outputs flat inside that directory
  // using just the basename of each configured path.  Otherwise, use the config-resolved paths.
  const localOutDir = options.outDir ? path.resolve(options.outDir) : null;
  const resultsPath = localOutDir
    ? path.join(localOutDir, path.basename(config.resultsFile))
    : resolveFromWorkingDirectory(config, config.resultsFile);
  const manifestPath = localOutDir
    ? path.join(localOutDir, path.basename(config.manifestFile))
    : resolveFromWorkingDirectory(config, config.manifestFile);
  const screenshotsRoot = localOutDir || resolveFromWorkingDirectory(config, config.screenshotsRoot);

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

  const browser = await chromium.launch(launchSettings);
  let failures = 0;

  try {
    manifest.captureProfile = validateCaptureProfile({
      schemaVersion: CAPTURE_PROFILE_SCHEMA_VERSION,
      engineVersion,
      engine: { name: 'snapdrift-local', version: engineVersion },
      browser: 'chromium',
      browserRevision: browser.version(),
      playwrightVersion,
      platform: { name: os.platform(), architecture: os.arch(), release: os.release(), version: os.version() },
      locale: contextSettings.locale,
      timezone: contextSettings.timezoneId,
      settings: {
        screenshot: { ...screenshotSettings },
        readiness: { waitUntil: 'load', settleDelayMs: SNAPDRIFT_SETTLE_DELAY_MS },
        context: {
          isolation: 'fresh-context-per-attempt',
          colorScheme: contextSettings.colorScheme,
          reducedMotion: contextSettings.reducedMotion,
          forcedColors: contextSettings.forcedColors,
          javaScriptEnabled: contextSettings.javaScriptEnabled,
          serviceWorkers: contextSettings.serviceWorkers
        },
        launch: { ...launchSettings }
      }
    });
    // Group routes by viewport key, preserving each route's original index for result ordering.
    /** @type {Map<string, Array<{ route: SnapdriftRouteConfig, originalIndex: number }>>} */
    const byViewport = new Map();
    for (const [i, route] of routes.entries()) {
      const key = viewportKey(route.viewport);
      const existing = byViewport.get(key);
      if (existing) {
        existing.push({ route, originalIndex: i });
      } else {
        byViewport.set(key, [{ route, originalIndex: i }]);
      }
    }

    // Pre-allocate results array; captureViewportRoutes fills slots by originalIndex.
    /** @type {Array<BaselineRouteResult & { manifestEntry?: ScreenshotManifest['screenshots'][number] }>} */
    const captureResults = new Array(routes.length);

    await Promise.all([...byViewport.values()].map((entries) =>
      captureViewportRoutes(browser, entries, config.baseUrl, screenshotsRoot, routes.length, captureResults)
    ));

    // Merge results in original route order.
    for (const capture of captureResults) {
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
