// @ts-check

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import pngjs from 'pngjs';

import { loadSnapdriftConfig } from './config.mjs';
import {
  selectConfiguredRoutes,
  splitCommaList,
  resolveFromWorkingDirectory,
  VIEWPORT_PRESETS,
  sanitizeRouteId,
  CAPTURE_PROFILE_SCHEMA_VERSION,
  validateCaptureProfile,
  isLocalBaseUrl
} from '@snapdrift/manifest';

const { PNG } = pngjs;
const require = createRequire(import.meta.url);
const engineVersion = require('../package.json').version;

export const DEFAULT_SNAP_API_URL = 'https://snap.i2dev.com';
export const DEFAULT_POLL_INTERVAL_MS = 1500;
export const DEFAULT_BATCH_TIMEOUT_MS = 5 * 60 * 1000;
export const REQUEST_TIMEOUT_MS = 30 * 1000;
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch helper for idempotent GET requests with retry on 5xx, 429, or network errors.
 *
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {Record<string, string>} [headers]
 * @returns {Promise<Response>}
 */
async function fetchGetWithRetry(fetchImpl, url, headers = {}) {
  let attempt = 0;
  let delay = INITIAL_RETRY_DELAY_MS;

  while (true) {
    attempt++;
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      if ((response.status < 500 && response.status !== 429) || attempt >= MAX_RETRIES) {
        return response;
      }
      if (response.status === 429) {
        const retryAfter = response.headers?.get?.('retry-after');
        const seconds = retryAfter ? Number.parseInt(retryAfter, 10) : 0;
        if (Number.isFinite(seconds) && seconds > 0) {
          delay = seconds * 1000;
        }
      }
    } catch (error) {
      if (attempt >= MAX_RETRIES) {
        throw error;
      }
    }
    await sleep(delay);
    delay *= 2;
  }
}

/**
 * Execute Snap Cloud batch screenshot capture.
 *
 * @param {{
 *   configPath?: string,
 *   routeIds?: Iterable<string>,
 *   outDir?: string,
 *   fetchFn?: typeof fetch,
 *   pollIntervalMs?: number,
 *   timeoutMs?: number
 * }} [options]
 * @returns {Promise<{
 *   resultsPath: string,
 *   manifestPath: string,
 *   screenshotsRoot: string,
 *   selectedRouteIds: string[]
 * }>}
 */
export async function runSnapBatchCapture(options) {
  const startedAt = new Date().toISOString();
  const { config, configPath: resolvedConfigPath } = await loadSnapdriftConfig(options?.configPath);

  if (isLocalBaseUrl(config.baseUrl)) {
    throw new Error(
      `Cannot use Snap Cloud batch capture with local baseUrl "${config.baseUrl}". ` +
      `Snap Cloud cannot reach loopback or private addresses. Use a public/preview URL or switch capture to "playwright".`
    );
  }

  const apiKeyEnvName = config.snap?.apiKeyEnv || 'SNAP_API_KEY';
  const apiKey = config.snap?.apiKey || process.env[apiKeyEnvName] || process.env.SNAP_API_KEY;
  if (!apiKey) {
    throw new Error(
      `Missing or invalid API key for Snap Cloud batch screenshot capture. Set the ${apiKeyEnvName} environment variable.`
    );
  }

  const apiUrl = (config.snap?.apiUrl || DEFAULT_SNAP_API_URL).replace(/\/+$/, '');
  const requestedRouteIds = options?.routeIds ? [...options.routeIds] : splitCommaList(process.env.SNAPDRIFT_ROUTE_IDS);
  const { routes, selectedRouteIds } = selectConfiguredRoutes(config, requestedRouteIds);

  if (routes.length === 0) {
    throw new Error('No routes selected for Snap Cloud batch capture.');
  }

  const localOutDir = options?.outDir ? path.resolve(options.outDir) : null;
  const resultsPath = localOutDir
    ? path.join(localOutDir, path.basename(config.resultsFile))
    : resolveFromWorkingDirectory(config, config.resultsFile);
  const manifestPath = localOutDir
    ? path.join(localOutDir, path.basename(config.manifestFile))
    : resolveFromWorkingDirectory(config, config.manifestFile);
  const screenshotsRoot = localOutDir || resolveFromWorkingDirectory(config, config.screenshotsRoot);
  const screenshotsDir = path.join(screenshotsRoot, 'screenshots');

  await Promise.all([
    fs.mkdir(path.dirname(resultsPath), { recursive: true }),
    fs.mkdir(path.dirname(manifestPath), { recursive: true }),
    fs.mkdir(screenshotsDir, { recursive: true })
  ]);

  const fetchImpl = options?.fetchFn || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('global fetch is not available; provide a fetchFn option.');
  }

  // 1. Build batch items
  // Note: Snap Cloud batch screenshot API contract guarantees items are returned in the exact order submitted.
  const items = routes.map((route) => {
    const targetUrl = new URL(route.path, config.baseUrl).href;
    let width = 1440;
    let height = 900;
    if (typeof route.viewport === 'string') {
      const preset = VIEWPORT_PRESETS[route.viewport];
      if (preset) {
        width = preset.width;
        height = preset.height;
      }
    } else if (route.viewport && typeof route.viewport === 'object') {
      width = route.viewport.width;
      height = route.viewport.height;
    }
    /** @type {{ url: string, viewport: { width: number, height: number }, navTimeoutMs?: number }} */
    const item = {
      url: targetUrl,
      viewport: { width, height }
    };
    if (typeof route.navigationTimeout === 'number' && route.navigationTimeout > 0) {
      item.navTimeoutMs = route.navigationTimeout;
    }
    return item;
  });

  // 2. Submit batch to Snap Cloud (POST is non-idempotent; do not retry 5xx to avoid duplicate billable batches)
  let submitResponse;
  try {
    submitResponse = await fetchImpl(`${apiUrl}/v1/screenshots`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        format: 'png',
        fullPage: true,
        items
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    throw new Error(`Failed to submit Snap Cloud batch screenshot request: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }

  if (submitResponse.status === 401) {
    throw new Error('Unauthorized: Missing or invalid SNAP_API_KEY for Snap Cloud batch screenshot capture.');
  }
  if (submitResponse.status === 429) {
    let errorDetail = 'Rate limit or quota exceeded';
    try {
      const body = await submitResponse.json();
      if (body.error) errorDetail = body.error;
    } catch {
      // ignore json parse error
    }
    throw new Error(`Rate limited: Snap Cloud batch screenshot request rejected (${errorDetail}).`);
  }
  if (!submitResponse.ok) {
    let errorDetail = submitResponse.statusText;
    try {
      const body = await submitResponse.json();
      if (body.error) errorDetail = body.error;
    } catch {
      // ignore json parse error
    }
    throw new Error(`Snap Cloud batch screenshot request failed (${submitResponse.status}): ${errorDetail}`);
  }

  const submitData = await submitResponse.json();
  const batchId = submitData.batchId;
  if (!batchId) {
    throw new Error('Snap Cloud batch response did not include a batchId.');
  }

  // 3. Poll batch status until completed
  const pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_BATCH_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let batchResult;

  while (true) {
    if (Date.now() > deadline) {
      throw new Error(`Snap Cloud batch screenshot job "${batchId}" timed out after ${timeoutMs}ms.`);
    }

    const pollResponse = await fetchGetWithRetry(fetchImpl, `${apiUrl}/v1/screenshots/${batchId}`, {
      'Authorization': `Bearer ${apiKey}`
    });

    if (!pollResponse.ok) {
      throw new Error(`Failed to poll Snap Cloud batch job "${batchId}" (${pollResponse.status}): ${pollResponse.statusText}`);
    }

    const pollData = await pollResponse.json();
    if (pollData.status === 'completed') {
      batchResult = pollData;
      break;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`Snap Cloud batch screenshot job "${batchId}" timed out after ${timeoutMs}ms.`);
    }
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }

  // 4. Validate results
  if (!batchResult || !Array.isArray(batchResult.items) || batchResult.items.length !== routes.length) {
    throw new Error(
      `Snap Cloud batch result for "${batchId}" was malformed or item count mismatch: ` +
      `expected ${routes.length}, got ${batchResult?.items?.length ?? 0}.`
    );
  }

  for (let i = 0; i < routes.length; i++) {
    const item = batchResult.items[i];
    const route = routes[i];
    if (item.status === 'failed' || item.error) {
      const errDetail = item.error?.error || item.error?.code || 'Capture failed';
      throw new Error(`Route "${route.id}" failed Snap Cloud batch capture: ${errDetail}`);
    }
  }

  // 5. Download PNGs in parallel and assemble manifest/results
  /** @type {import('@snapdrift/manifest').VisualScreenshotManifestEntry[]} */
  const manifestScreenshots = [];
  /** @type {import('@snapdrift/manifest').VisualBaselineRouteResult[]} */
  const resultRoutes = [];

  await Promise.all(
    routes.map(async (route, index) => {
      const item = batchResult.items[index];
      const imageUrl = item.imageUrl;
      if (!imageUrl) {
        throw new Error(`Route "${route.id}" completed without an imageUrl.`);
      }

      const imgResponse = await fetchGetWithRetry(fetchImpl, imageUrl);
      if (!imgResponse.ok) {
        throw new Error(`Failed to download screenshot for route "${route.id}" (${imgResponse.status}): ${imgResponse.statusText}`);
      }

      const buffer = Buffer.from(await imgResponse.arrayBuffer());
      const parsedPng = PNG.sync.read(buffer);

      const filename = `${sanitizeRouteId(route.id)}.png`;
      const relativeImagePath = `screenshots/${filename}`;
      const absoluteImagePath = path.join(screenshotsDir, filename);

      await fs.writeFile(absoluteImagePath, buffer);

      manifestScreenshots[index] = {
        id: route.id,
        path: route.path,
        viewport: route.viewport,
        imagePath: relativeImagePath,
        width: parsedPng.width,
        height: parsedPng.height
      };

      resultRoutes[index] = {
        id: route.id,
        path: route.path,
        viewport: route.viewport,
        status: 'passed',
        durationMs: item.durationMs || 0,
        imagePath: relativeImagePath,
        width: parsedPng.width,
        height: parsedPng.height
      };
    })
  );

  // 6. Write results.json and manifest.json
  /** @type {import('@snapdrift/manifest').VisualScreenshotManifest} */
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    baseUrl: config.baseUrl,
    captureProfile: validateCaptureProfile({
      schemaVersion: CAPTURE_PROFILE_SCHEMA_VERSION,
      engineVersion,
      engine: { name: 'snap-batch', version: engineVersion },
      browser: 'chromium',
      browserRevision: 'cloud',
      playwrightVersion: 'cloud',
      platform: { name: os.platform(), architecture: os.arch(), release: os.release(), version: os.version() },
      locale: 'en-US',
      timezone: 'UTC',
      settings: {
        screenshot: { fullPage: true, animations: 'disabled', caret: 'hide', scale: 'device', omitBackground: false, type: 'png' },
        readiness: { waitUntil: 'load', settleDelayMs: 300 },
        context: { isolation: 'cloud-batch', colorScheme: 'light', reducedMotion: 'no-preference', forcedColors: 'none', javaScriptEnabled: true, serviceWorkers: 'allow' },
        launch: { headless: true, args: [] }
      }
    }),
    screenshots: manifestScreenshots
  };

  /** @type {import('@snapdrift/manifest').VisualBaselineResults} */
  const results = {
    startedAt,
    finishedAt: new Date().toISOString(),
    passed: true,
    engine: 'snap-batch',
    baseUrl: config.baseUrl,
    suite: 'snapdrift-capture',
    configPath: path.relative(path.resolve('.'), resolvedConfigPath),
    manifestPath: path.relative(path.resolve('.'), manifestPath),
    screenshotsRoot: path.relative(path.resolve('.'), screenshotsRoot),
    routes: resultRoutes
  };

  await Promise.all([
    fs.writeFile(resultsPath, JSON.stringify(results, null, 2)),
    fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2))
  ]);

  return {
    resultsPath,
    manifestPath,
    screenshotsRoot,
    selectedRouteIds
  };
}
