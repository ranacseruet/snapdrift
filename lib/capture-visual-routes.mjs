// @ts-check

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

import {
  loadVisualRegressionConfig,
  resolveFromWorkingDirectory,
  selectConfiguredRoutes,
  splitCommaList,
  VIEWPORT_PRESETS,
  VISUAL_NAVIGATION_TIMEOUT_MS,
  VISUAL_SETTLE_DELAY_MS
} from './visual-regression-config.mjs';

/** @typedef {import('../types/visual-diff-types').VisualBaselineResults} VisualBaselineResults */
/** @typedef {import('../types/visual-diff-types').VisualBaselineRouteResult} VisualBaselineRouteResult */
/** @typedef {import('../types/visual-diff-types').VisualRegressionRouteConfig} VisualRegressionRouteConfig */
/** @typedef {import('../types/visual-diff-types').VisualScreenshotManifest} VisualScreenshotManifest */

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
 * @param {import('playwright').Browser} browser
 * @returns {Promise<Map<'desktop' | 'mobile', import('playwright').BrowserContext>>}
 */
async function createViewportContexts(browser) {
  return new Map([
    ['desktop', await browser.newContext({
      viewport: { width: VIEWPORT_PRESETS.desktop.width, height: VIEWPORT_PRESETS.desktop.height },
      deviceScaleFactor: VIEWPORT_PRESETS.desktop.deviceScaleFactor,
      isMobile: VIEWPORT_PRESETS.desktop.isMobile,
      hasTouch: VIEWPORT_PRESETS.desktop.hasTouch
    })],
    ['mobile', await browser.newContext({
      viewport: { width: VIEWPORT_PRESETS.mobile.width, height: VIEWPORT_PRESETS.mobile.height },
      deviceScaleFactor: VIEWPORT_PRESETS.mobile.deviceScaleFactor,
      isMobile: VIEWPORT_PRESETS.mobile.isMobile,
      hasTouch: VIEWPORT_PRESETS.mobile.hasTouch
    })]
  ]);
}

/**
 * @param {Map<'desktop' | 'mobile', import('playwright').BrowserContext>} contexts
 * @param {VisualRegressionRouteConfig} route
 * @param {string} baseUrl
 * @param {string} screenshotsRoot
 * @returns {Promise<VisualBaselineRouteResult & { manifestEntry?: VisualScreenshotManifest['screenshots'][number] }>}
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
      timeout: VISUAL_NAVIGATION_TIMEOUT_MS
    });
    await page.waitForTimeout(VISUAL_SETTLE_DELAY_MS);

    const imagePath = path.join('screenshots', `${route.id}.png`);
    const absoluteImagePath = path.join(screenshotsRoot, imagePath);
    await ensureParentDirectory(absoluteImagePath);
    await page.screenshot({
      path: absoluteImagePath,
      fullPage: true
    });

    const preset = VIEWPORT_PRESETS[route.viewport];
    return {
      id: route.id,
      path: route.path,
      viewport: route.viewport,
      status: 'passed',
      durationMs: Date.now() - startedAt,
      imagePath,
      width: preset.width,
      height: preset.height,
      manifestEntry: {
        id: route.id,
        path: route.path,
        viewport: route.viewport,
        imagePath,
        width: preset.width,
        height: preset.height
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

/**
 * @param {{
 *   configPath?: string,
 *   routeIds?: Iterable<string>
 * }} [options]
 * @returns {Promise<{ resultsPath: string, manifestPath: string, screenshotsRoot: string, selectedRouteIds: string[] }>}
 */
export async function runVisualBaselineCapture(options = {}) {
  const requestedRouteIds = [...(options.routeIds || splitCommaList(process.env.QA_VISUAL_ROUTE_IDS))];
  const { config, configPath } = await loadVisualRegressionConfig(options.configPath);
  const { routes, selectedRouteIds } = selectConfiguredRoutes(config, requestedRouteIds);

  const resultsPath = resolveFromWorkingDirectory(config, config.resultsFile);
  const manifestPath = resolveFromWorkingDirectory(config, config.manifestFile);
  const screenshotsRoot = resolveFromWorkingDirectory(config, config.screenshotsRoot);

  await Promise.all([
    ensureParentDirectory(resultsPath),
    ensureParentDirectory(manifestPath),
    ensureDirectory(path.join(screenshotsRoot, 'screenshots'))
  ]);

  /** @type {VisualBaselineResults} */
  const results = {
    startedAt: new Date().toISOString(),
    baseUrl: config.baseUrl,
    suite: 'visual-regression-capture',
    configPath: path.relative(path.resolve('.'), configPath),
    manifestPath: path.relative(path.resolve('.'), manifestPath),
    screenshotsRoot: path.relative(path.resolve('.'), screenshotsRoot),
    routes: []
  };

  /** @type {VisualScreenshotManifest} */
  const manifest = {
    generatedAt: new Date().toISOString(),
    baseUrl: config.baseUrl,
    screenshots: []
  };

  const browser = await chromium.launch({ headless: true });
  const contexts = await createViewportContexts(browser);
  let failures = 0;

  try {
    for (const route of routes) {
      const capture = await captureRoute(contexts, route, config.baseUrl, screenshotsRoot);
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
    throw new Error(`Visual regression capture failed for ${failures} route(s).`);
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
  runVisualBaselineCapture().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
