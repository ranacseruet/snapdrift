// @ts-check

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { readPngDimensions } from '@snapdrift/compare-core';

import { loadSnapdriftConfig, readFirstDefinedEnv, SNAPDRIFT_CAPTURE_CONCURRENCY } from './config.mjs';
import { createConcurrencyLimiter } from './concurrency.mjs';
import { runSnapBatchCapture } from './snap-batch-capture.mjs';
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
    const error = new Error(
      `Route "${route.id}" returned HTTP ${response.status()} for ${targetUrl} — ` +
      `refusing to capture an error page as a screenshot. Check the route path/baseUrl.`
    );
    // 4xx (other than the transient 408/429) means the page answered with an
    // error and a retry with identical inputs will get the same answer, so
    // captureRouteWithRetry does not burn the retry budget on it.
    if (response.status() < 500 && response.status() !== 408 && response.status() !== 429) {
      /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (error)).deterministic = true;
    }
    throw error;
  }
}

/**
 * Reads width/height from a screenshot's PNG header without decoding it.
 *
 * A full `PNG.sync.read` inflates the whole image synchronously, which blocks
 * the event loop for every in-flight route, just to learn two integers. A
 * buffer without a valid header is rejected so it is never recorded as a valid
 * screenshot; pixel data is not validated.
 *
 * @param {Buffer} buffer
 * @returns {{ width: number, height: number }}
 */
export function requirePngDimensions(buffer) {
  const dimensions = readPngDimensions(buffer);
  if (!dimensions) {
    throw new Error('Screenshot is not a valid PNG (missing signature or IHDR chunk, or invalid dimensions).');
  }
  return dimensions;
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
 * @param {boolean} [defaultFullPage]
 * @returns {Promise<BaselineRouteResult & { manifestEntry?: ScreenshotManifest['screenshots'][number], deterministic?: boolean }>}
 */
async function captureRoute(browser, route, baseUrl, screenshotsRoot, defaultFullPage = true) {
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
    const fullPage = route.fullPage ?? defaultFullPage;
    const screenshotBuffer = await page.screenshot({
      path: absoluteImagePath,
      ...screenshotSettings,
      fullPage
    });
    const { width, height } = requirePngDimensions(screenshotBuffer);

    return {
      id: route.id,
      path: route.path,
      viewport: route.viewport,
      status: 'passed',
      durationMs: Date.now() - startedAt,
      imagePath,
      width,
      height,
      manifestEntry: {
        id: route.id,
        path: route.path,
        viewport: route.viewport,
        imagePath,
        width,
        height
      }
    };
  } catch (error) {
    return {
      id: route.id,
      path: route.path,
      viewport: route.viewport,
      status: 'failed',
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      // Internal flag: a deterministic failure (e.g. HTTP 404) skips the
      // retry. Not copied into results.json by runBaselineCapture.
      deterministic: /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (error))?.deterministic === true
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
 * @param {boolean} [defaultFullPage]
 * @returns {Promise<BaselineRouteResult & { manifestEntry?: ScreenshotManifest['screenshots'][number], deterministic?: boolean }>}
 */
async function captureRouteWithRetry(browser, route, baseUrl, screenshotsRoot, defaultFullPage = true) {
  let result = await captureRoute(browser, route, baseUrl, screenshotsRoot, defaultFullPage);
  for (let attempt = 1; attempt <= CAPTURE_MAX_RETRIES && result.status !== 'passed'; attempt++) {
    if (result.deterministic) {
      // Same inputs will return the same HTTP error; retrying only doubles
      // the capture time for permanently broken routes.
      break;
    }
    console.log(`[SnapDrift] Retrying route ${route.id} (attempt ${attempt + 1}/${CAPTURE_MAX_RETRIES + 1})...`);
    result = await captureRoute(browser, route, baseUrl, screenshotsRoot, defaultFullPage);
  }
  return result;
}

/**
 * Capture a group of routes that share a viewport.
 *
 * `limit` is the run-wide concurrency limiter created once in
 * `runBaselineCapture` and shared across all viewport groups: per-group
 * limiters would multiply the effective concurrency by the number of
 * distinct viewports, since every group runs in parallel against one
 * shared browser instance.
 *
 * @param {any} browser
 * @param {<T>(fn: () => Promise<T>) => Promise<T>} limit
 * @param {Array<{ route: SnapdriftRouteConfig, originalIndex: number }>} entries
 * @param {string} baseUrl
 * @param {string} screenshotsRoot
 * @param {number} totalRoutes
 * @param {Array<BaselineRouteResult & { manifestEntry?: ScreenshotManifest['screenshots'][number], deterministic?: boolean }>} out
 * @param {boolean} [defaultFullPage]
 * @returns {Promise<void>}
 */
async function captureViewportRoutes(browser, limit, entries, baseUrl, screenshotsRoot, totalRoutes, out, defaultFullPage = true) {
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
      out[originalIndex] = await captureRouteWithRetry(browser, route, baseUrl, screenshotsRoot, defaultFullPage);
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
  const { config, configPath } = await loadSnapdriftConfig(options.configPath);
  const captureEngine = process.env.SNAPDRIFT_CAPTURE_ENGINE || config.capture || 'playwright';
  if (captureEngine === 'snap') {
    return runSnapBatchCapture(options);
  }

  const requestedRouteIds = [...(
    options.routeIds || splitCommaList(readFirstDefinedEnv(['SNAPDRIFT_ROUTE_IDS']))
  )];
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

  const captureStartedAt = Date.now();
  let failures = 0;
  let browser;

  try {
    try {
      browser = await chromium.launch(launchSettings);
    } catch (error) {
      // The most common CI capture failure is a missing browser binary or a
      // launch sandbox error. Record it per route and still write the
      // results/manifest in the finally below, so downstream reports show
      // what actually broke instead of a confusing "unable to load baseline
      // results" for a file that was never written.
      failures = routes.length;
      for (const route of routes) {
        results.routes.push({
          id: route.id,
          path: route.path,
          viewport: route.viewport,
          status: 'failed',
          durationMs: 0,
          error: `Browser launch failed: ${error instanceof Error ? error.message : String(error)}`
        });
      }
      throw error;
    }

    const defaultFullPage = config.screenshot?.fullPage ?? config.fullPage ?? (routes.length > 0 && routes.every((r) => r.fullPage === false) ? false : true);

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
        screenshot: { ...screenshotSettings, fullPage: defaultFullPage },
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
    /** @type {Array<BaselineRouteResult & { manifestEntry?: ScreenshotManifest['screenshots'][number], deterministic?: boolean }>} */
    const captureResults = new Array(routes.length);

    // One run-wide limiter shared by every viewport group: all groups run in
    // parallel against one browser, so a per-group limit would scale effective
    // concurrency with the number of configured viewports (e.g. 4 viewports ×
    // SNAPDRIFT_CAPTURE_CONCURRENCY contexts) and risk OOM on small runners.
    const limit = createConcurrencyLimiter(SNAPDRIFT_CAPTURE_CONCURRENCY);

    await Promise.all([...byViewport.values()].map((entries) =>
      captureViewportRoutes(browser, limit, entries, config.baseUrl, screenshotsRoot, routes.length, captureResults, defaultFullPage)
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
    console.log(`[SnapDrift] Captured ${routes.length - failures}/${routes.length} route(s) in ${((Date.now() - captureStartedAt) / 1000).toFixed(1)}s.`);
  } finally {
    // Write the artifacts before closing the browser, and never let a
    // browser.close() rejection mask a write failure (or the original capture
    // error): writes always run first, close always runs, close failures are
    // logged rather than thrown.
    results.finishedAt = new Date().toISOString();
    results.passed = failures === 0;
    manifest.generatedAt = new Date().toISOString();

    try {
      await Promise.all([
        fs.writeFile(resultsPath, JSON.stringify(results, null, 2)),
        fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2))
      ]);
    } finally {
      if (browser) {
        await browser.close().catch((closeError) => {
          console.error(`[SnapDrift] Browser close failed: ${closeError instanceof Error ? closeError.message : String(closeError)}`);
        });
      }
    }
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
