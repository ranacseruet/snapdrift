// @ts-check

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { makeMarkdown, buildReportCommentBody } from '@snapdrift/adapter-report-md';
import { loadSnapdriftConfig } from '@snapdrift/adapter-fs';
import { selectConfiguredRoutes, splitCommaList, determineDriftStatus, VIEWPORT_PRESETS } from '@snapdrift/manifest';

/** @typedef {import('../types/visual-diff-types').VisualProvider} VisualProvider */
/** @typedef {import('../types/visual-diff-types').ProviderCaptureOptions} CaptureOptions */
/** @typedef {import('../types/visual-diff-types').ProviderCaptureResult} CaptureResult */
/** @typedef {import('../types/visual-diff-types').ProviderDiffOptions} DiffOptions */
/** @typedef {import('../types/visual-diff-types').ProviderDiffResult} DiffResult */
/** @typedef {import('../types/visual-diff-types').ProviderPublishBaselineOptions} PublishBaselineOptions */
/** @typedef {import('../types/visual-diff-types').ProviderPublishBaselineResult} PublishBaselineResult */
/** @typedef {import('../types/visual-diff-types').ProviderFetchBaselineOptions} FetchBaselineOptions */
/** @typedef {import('../types/visual-diff-types').ProviderBaselineData} BaselineData */
/** @typedef {import('../types/visual-diff-types').SnapConfig} SnapConfig */
/** @typedef {import('../types/visual-diff-types').VisualRegressionConfig} VisualRegressionConfig */

const DEFAULT_API_URL = 'https://snap.i2dev.com';
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;
const RETRY_MULTIPLIER = 2;
const MAX_RETRY_TOTAL_MS = 30000;
const POLL_INTERVAL_MS = 2000;
const MAX_POLL_DURATION_MS = 10 * 60 * 1000;

const TERMINAL_RUN_STATUSES = new Set(['pass', 'fail', 'error']);

/**
 * @param {string} repoSlug
 * @returns {string}
 */
function repoSlugToProjectId(repoSlug) {
  return repoSlug.replace(/[/.]/g, '--');
}

/**
 * Read the package version from package.json.
 * @returns {string}
 */
function getPackageVersion() {
  try {
    const pkgUrl = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(fsSync.readFileSync(pkgUrl, 'utf-8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * SnapProvider — VisualProvider that delegates capture + diff to Snap's
 * hosted /v1/visual/* API.
 *
 * @implements {VisualProvider}
 */
export class SnapProvider {
  /** @type {SnapConfig} */
  #snapConfig;
  /** @type {typeof globalThis.fetch} */
  #fetchFn;
  /** @type {(ms: number) => Promise<void>} */
  #sleepFn;
  /** @type {string} */
  #apiKey;
  /** @type {string} */
  #apiUrl;
  /** @type {string} */
  #projectId;

  /**
   * @param {SnapConfig} snapConfig — validated snap section from config
   * @param {{ fetchFn?: typeof globalThis.fetch, sleepFn?: (ms: number) => Promise<void> }} [options]
   */
  constructor(snapConfig, options = {}) {
    this.#snapConfig = snapConfig;
    this.#fetchFn = options.fetchFn ?? globalThis.fetch;
    this.#sleepFn = options.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#apiUrl = (snapConfig.apiUrl || DEFAULT_API_URL).replace(/\/+$/, '');
    this.#apiKey = this.#resolveApiKey(snapConfig);
    this.#projectId = this.#resolveProjectId(snapConfig);
  }

  // ---------------------------------------------------------------------------
  // VisualProvider interface
  // ---------------------------------------------------------------------------

  /**
   * Submit routes to Snap for server-side rendering.
   *
   * Creates a run via POST /v1/visual/projects/:id/runs, then submits each
   * route as a capture via POST /v1/visual/runs/:run_id/captures. Writes run
   * metadata to a temp file so diff() can pick it up.
   *
   * @param {CaptureOptions} options
   * @returns {Promise<CaptureResult>}
   */
  async capture(options) {
    const { config } = await loadSnapdriftConfig(options.configPath);
    const requestedRouteIds = options.routeIds
      ? [...options.routeIds]
      : splitCommaList(process.env.SNAPDRIFT_ROUTE_IDS);
    const { routes, selectedRouteIds } = selectConfiguredRoutes(config, requestedRouteIds);

    const idempotencyKey = this.#generateIdempotencyKey();
    const runId = `run_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    await this.#request('POST', `/v1/visual/projects/${this.#projectId}/runs`, {
      id: runId,
      baseUrl: config.baseUrl,
      captureProfileJson: JSON.stringify(this.#buildCaptureProfile()),
      trigger: 'ci',
    }, idempotencyKey);

    // Submit each route as a capture with its own idempotency key
    for (const route of routes) {
      const captureKey = this.#generateIdempotencyKey();
      const captureId = `cap_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
      const viewportDescriptor = typeof route.viewport === 'string'
        ? (VIEWPORT_PRESETS[route.viewport] ?? { width: 1280, height: 720 })
        : route.viewport;
      await this.#request('POST', `/v1/visual/runs/${runId}/captures`, {
        id: captureId,
        routeId: route.id,
        routePath: route.path,
        viewportDescriptorJson: JSON.stringify(viewportDescriptor),
      }, captureKey);
    }

    // Write run metadata to a temp file so diff() can thread the run_id
    const outDir = options.outDir
      ? path.resolve(options.outDir)
      : await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-snap-'));

    await fs.mkdir(outDir, { recursive: true });

    const resultsPath = path.join(outDir, 'results.json');
    const manifestPath = path.join(outDir, 'manifest.json');

    const runMetadata = { runId, projectId: this.#projectId, startedAt: new Date().toISOString() };
    await Promise.all([
      fs.writeFile(resultsPath, JSON.stringify(runMetadata, null, 2)),
      fs.writeFile(manifestPath, JSON.stringify({
        generatedAt: new Date().toISOString(),
        baseUrl: config.baseUrl,
        screenshots: routes.map((r) => ({
          id: r.id,
          path: r.path,
          viewport: r.viewport,
          imagePath: `screenshots/${r.id}.png`,
          width: 0,
          height: 0
        }))
      }, null, 2))
    ]);

    return {
      resultsPath,
      manifestPath,
      screenshotsRoot: outDir,
      selectedRouteIds
    };
  }

  /**
   * Poll Snap for run completion and map the result to a drift summary.
   *
   * @param {DiffOptions} options
   * @returns {Promise<DiffResult>}
   */
  async diff(options) {
    // Read run metadata from the capture step
    const currentResultsPath = options.currentResultsPath;
    if (!currentResultsPath) {
      throw new Error('SnapProvider.diff requires currentResultsPath from a prior capture() call.');
    }

    const metadata = JSON.parse(await fs.readFile(currentResultsPath, 'utf-8'));
    const runId = metadata.runId;

    // Poll until the run reaches a terminal state
    const run = await this.#pollRun(runId);

    const { config } = await loadSnapdriftConfig(options.configPath);
    const summary = this.#mapRunToSummary(run, config);

    return {
      summary,
      markdown: makeMarkdown(summary)
    };
  }

  /**
   * Publish a baseline to Snap.
   *
   * @param {PublishBaselineOptions} options
   * @returns {Promise<PublishBaselineResult>}
   */
  async publishBaseline(options) {
    const idempotencyKey = this.#generateIdempotencyKey();
    const body = { idempotencyKey };

    // If a bundle directory is provided, read files from it
    if (options.bundleDir) {
      const bundleDir = path.resolve(options.bundleDir);
      const resultsPath = options.resultsPath || path.join(bundleDir, 'results.json');
      const manifestPath = options.manifestPath || path.join(bundleDir, 'manifest.json');

      try {
        const results = JSON.parse(await fs.readFile(resultsPath, 'utf-8'));
        body.results = results;
      } catch { /* results.json may not exist */ }

      try {
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
        body.manifest = manifest;
      } catch { /* manifest.json may not exist */ }

      // If results contain a runId, use it for idempotency
      if (body.results?.runId) {
        body.idempotencyKey = `baseline-${body.results.runId}`;
      }
    }

    await this.#request('POST', `/v1/visual/projects/${this.#projectId}/baselines`, body, idempotencyKey);

    const bundleDir = options.bundleDir
      ? path.resolve(options.bundleDir)
      : await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-snap-baseline-'));

    return { bundleDir };
  }

  /**
   * Fetch the latest baseline from Snap.
   *
   * @param {FetchBaselineOptions} _options
   * @returns {Promise<BaselineData | null>}
   */
  async fetchLatestBaseline(_options) {
    try {
      const baseline = await this.#request('GET', `/v1/visual/projects/${this.#projectId}/baselines/latest`);

      const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-snap-baseline-'));
      const resultsPath = path.join(runDir, 'results.json');
      const manifestPath = path.join(runDir, 'manifest.json');

      if (baseline.results) {
        await fs.writeFile(resultsPath, JSON.stringify(baseline.results, null, 2));
      }
      if (baseline.manifest) {
        await fs.writeFile(manifestPath, JSON.stringify(baseline.manifest, null, 2));
      }

      return {
        resultsPath,
        manifestPath,
        runDir,
        screenshotsDir: path.join(runDir, 'screenshots'),
        artifactName: baseline.artifactName || 'snap-baseline',
        headSha: baseline.headSha || ''
      };
    } catch (error) {
      if (error instanceof SnapApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // PR comment
  // ---------------------------------------------------------------------------

  /**
   * Build a PR comment body from a diff summary.
   * SnapProvider includes the dashboard URL from the summary when available.
   *
   * @param {Record<string, unknown>} summary
   * @param {import('../types/visual-diff-types').ProviderCommentMeta} [meta]
   * @returns {string}
   */
  buildCommentBody(summary, meta = {}) {
    const dashboardUrl = summary.dashboardUrl || meta.dashboardUrl;
    return buildReportCommentBody(summary, { ...meta, dashboardUrl });
  }

  // ---------------------------------------------------------------------------
  // Migration methods
  // ---------------------------------------------------------------------------

  /**
   * Check whether a baseline already exists for a given commit SHA.
   *
   * @param {string} headSha
   * @returns {Promise<object | null>} Baseline data if found, null on 404
   */
  async checkBaselineExists(headSha) {
    try {
      const baseline = await this.#request('GET', `/v1/visual/projects/${this.#projectId}/baselines/latest?sha=${encodeURIComponent(headSha)}`);
      return baseline;
    } catch (error) {
      if (error instanceof SnapApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Upload local baselines to Snap as the initial accepted baseline.
   * Used by `snapdrift migrate-baselines --to snap`.
   *
   * Reads local baseline files and POSTs them to the Snap baselines API.
   * Screenshots are base64-encoded and included in the request body.
   * Idempotent: uses a commit-SHA-derived idempotency key.
   *
   * @param {{
   *   results: object,
   *   manifest: object,
   *   screenshots: Array<{ filename: string, data: string }>,
   *   headSha: string
   * }} options
   * @returns {Promise<{ uploaded: number, skipped: number, baselineId: string }>}
   */
  async migrateBaselineFromLocal(options) {
    const { results, manifest, screenshots, headSha } = options;
    const idempotencyKey = `baseline-migrate-${headSha}`;

    const body = {
      idempotencyKey,
      results,
      manifest,
      screenshots,
      headSha,
      captureProfile: this.#buildCaptureProfile()
    };

    const response = await this.#request('POST', `/v1/visual/projects/${this.#projectId}/baselines`, body, idempotencyKey);

    const screenshotCount = screenshots?.length ?? 0;
    return {
      uploaded: screenshotCount,
      skipped: 0,
      baselineId: response.id || idempotencyKey
    };
  }

  /**
   * Export baselines from Snap for local import.
   * Used by `snapdrift migrate-baselines --to local --from snap`.
   *
   * @param {{ tag?: string }} _options
   * @returns {Promise<{
   *   results: object,
   *   manifest: object,
   *   screenshots: Array<{ filename: string, data: Buffer }>,
   *   engine: { name: string, version: string }
   * }>}
   * @throws {Error} The Snap export endpoint is not yet available.
   */
  async exportBaselines(_options) {
    throw new Error(
      'The Snap export endpoint is not yet available. ' +
      'This command will be functional once the Snap API adds GET /v1/visual/projects/:id/export. ' +
      'See Snap repo issue #482 for tracking.'
    );
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolve API key from config.
   * @param {SnapConfig} snapConfig
   * @returns {string}
   */
  #resolveApiKey(snapConfig) {
    if (snapConfig.apiKeyEnv) {
      const value = process.env[snapConfig.apiKeyEnv];
      if (!value) {
        throw new Error(`Snap API key not found in environment variable: ${snapConfig.apiKeyEnv}`);
      }
      return value;
    }

    if (snapConfig.apiKey) {
      return snapConfig.apiKey.replace(/\$\{(\w+)\}/g, (_, varName) => {
        const value = process.env[varName];
        if (!value) {
          throw new Error(`Snap API key interpolation failed: environment variable ${varName} is not set.`);
        }
        return value;
      });
    }

    // Should not reach here if config was validated, but defensive
    throw new Error('Snap provider requires exactly one of snap.apiKeyEnv or snap.apiKey.');
  }

  /**
   * Resolve project ID from config.
   * @param {SnapConfig} snapConfig
   * @returns {string}
   */
  #resolveProjectId(snapConfig) {
    const projectId = snapConfig.projectId || 'auto';
    if (projectId === 'auto') {
      const repo = process.env.GITHUB_REPOSITORY;
      if (!repo) {
        throw new Error(
          'Snap project ID is set to "auto" but GITHUB_REPOSITORY is not set. ' +
          'Set the GITHUB_REPOSITORY environment variable or provide an explicit snap.projectId.'
        );
      }
      return repoSlugToProjectId(repo);
    }
    return projectId;
  }

  /**
   * Build a capture profile for the Snap API.
   * @returns {object}
   */
  #buildCaptureProfile() {
    return {
      schemaVersion: 1,
      engine: {
        name: 'snapdrift-local',
        version: `v${getPackageVersion().split('.')[0]}`
      }
    };
  }

  /**
   * @returns {string}
   */
  #generateIdempotencyKey() {
    return crypto.randomUUID();
  }

  /**
   * Make an HTTP request to the Snap API with retry logic.
   *
   * @param {string} method
   * @param {string} path
   * @param {object} [body]
   * @param {string} [idempotencyKey]
   * @returns {Promise<any>} Parsed JSON response
   */
  async #request(method, path, body, idempotencyKey) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const headers = {
          'Authorization': `Bearer ${this.#apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        };
        if (idempotencyKey && method === 'POST') {
          headers['Idempotency-Key'] = idempotencyKey;
        }

        const url = `${this.#apiUrl}${path}`;
        const response = await this.#fetchFn(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined
        });

        if (response.ok) {
          const text = await response.text();
          return text ? JSON.parse(text) : {};
        }

        // 4xx — never retry
        if (response.status >= 400 && response.status < 500) {
          const errorBody = await response.text().catch(() => '');
          let detail = '';
          try {
            const parsed = JSON.parse(errorBody);
            detail = parsed.error || parsed.message || '';
          } catch { /* use default message */ }
          const errorMessage = detail ? `Snap API ${response.status}: ${detail}` : `Snap API ${response.status}`;
          throw new SnapApiError(response.status, errorMessage, path);
        }

        // 5xx — retry with backoff (unless this is the last attempt)
        if (attempt < MAX_RETRIES) {
          const delay = Math.min(INITIAL_RETRY_DELAY_MS * (RETRY_MULTIPLIER ** (attempt - 1)), MAX_RETRY_TOTAL_MS);
          await this.#sleepFn(delay);
          continue;
        }

        // Exhausted retries
        const errorBody = await response.text().catch(() => '');
        let detail = '';
        try {
          const parsed = JSON.parse(errorBody);
          detail = parsed.error || parsed.message || '';
        } catch { /* use default message */ }
        const errorMessage = detail ? `Snap API ${response.status}: ${detail}` : `Snap API ${response.status}`;
        return this.#handleUnavailable(new SnapApiError(response.status, errorMessage, path));

      } catch (error) {
        if (error instanceof SnapApiError) {
          throw error;
        }

        // Network error — retry
        if (attempt < MAX_RETRIES) {
          const delay = Math.min(INITIAL_RETRY_DELAY_MS * (RETRY_MULTIPLIER ** (attempt - 1)), MAX_RETRY_TOTAL_MS);
          await this.#sleepFn(delay);
          continue;
        }

        return this.#handleUnavailable(new SnapUnavailableError(error instanceof Error ? error.message : String(error)));
      }
    }

    // Unreachable, but satisfies the type checker
    return this.#handleUnavailable(new SnapUnavailableError('Max retries exceeded'));
  }

  /**
   * Handle unavailable behavior based on onUnavailable config.
   * @param {Error} error
   * @returns {never | object}
   */
  #handleUnavailable(error) {
    const mode = this.#snapConfig.onUnavailable || 'fail';

    if (mode === 'fail') {
      throw error;
    }

    if (mode === 'warn-and-skip') {
      process.stderr.write(`[SnapDrift] Snap unavailable: ${error.message}. Skipping visual regression.\n`);
      throw new SnapSkipError(error.message);
    }

    if (mode === 'fallback-local') {
      process.stderr.write(`[SnapDrift] Snap unavailable: ${error.message}. Falling back to local provider.\n`);
      throw new SnapFallbackError(error.message);
    }

    throw error;
  }

  /**
   * Poll a run until it reaches a terminal state.
   * @param {string} runId
   * @returns {Promise<object>}
   */
  async #pollRun(runId) {
    const startTime = Date.now();

    while (Date.now() - startTime < MAX_POLL_DURATION_MS) {
      const run = await this.#request('GET', `/v1/visual/runs/${runId}`);

      if (TERMINAL_RUN_STATUSES.has(run.status)) {
        return run;
      }

      await this.#sleepFn(POLL_INTERVAL_MS);
    }

    throw new Error(`Snap run ${runId} did not complete within 10 minutes.`);
  }

  /**
   * Map a Snap run result to a VisualDiffSummary.
   * @param {object} run
   * @param {VisualRegressionConfig} config
   * @returns {import('../types/visual-diff-types').VisualDiffSummary}
   */
  #mapRunToSummary(run, config) {
    const captures = run.captures || [];
    const totalScreenshots = captures.length;
    let matchedScreenshots = 0;
    let changedScreenshots = 0;
    let missingInBaseline = 0;
    let missingInCurrent = 0;

    /** @type {import('../types/visual-diff-types').VisualDiffChangedItem[]} */
    const changed = [];
    /** @type {import('../types/visual-diff-types').VisualDiffMissingItem[]} */
    const missing = [];
    /** @type {import('../types/visual-diff-types').VisualDiffErrorItem[]} */
    const errors = [];

    for (const capture of captures) {
      if (capture.status === 'error') {
        errors.push({
          id: capture.routeId || capture.id,
          path: capture.routePath,
          viewport: capture.viewport,
          status: 'error',
          message: capture.errorDetails?.message || capture.errorCode || 'Unknown error'
        });
        continue;
      }

      if (capture.status === 'diffed') {
        if (capture.diffPct !== null && capture.diffPct > config.diff.threshold) {
          changedScreenshots++;
          changed.push({
            id: capture.routeId || capture.id,
            path: capture.routePath || '',
            viewport: capture.viewport,
            baselineImagePath: capture.baselineObjectKey || '',
            currentImagePath: capture.currentObjectKey || '',
            width: capture.width || 0,
            height: capture.height || 0,
            differentPixels: capture.diffPixels || 0,
            totalPixels: (capture.width || 0) * (capture.height || 0),
            mismatchRatio: capture.diffPct,
            status: 'changed'
          });
        } else {
          matchedScreenshots++;
        }

        if (capture.baselineObjectKey === null && capture.diffPct === null) {
          missingInBaseline++;
          missing.push({
            id: capture.routeId || capture.id,
            reason: 'no baseline capture found on Snap',
            path: capture.routePath,
            viewport: capture.viewport,
            location: 'baseline'
          });
        }
      }
    }

    /** @type {import('../types/visual-diff-types').VisualDiffSummary} */
    const summary = {
      startedAt: run.startedAt || new Date().toISOString(),
      finishedAt: run.finishedAt || new Date().toISOString(),
      completed: true,
      status: run.status === 'pass' ? 'clean' : run.status === 'fail' ? 'changes-detected' : 'incomplete',
      selectedRoutes: captures.map((c) => c.routeId || c.id),
      baselineManifestPath: '',
      currentManifestPath: '',
      diffMode: config.diff.mode,
      threshold: config.diff.threshold,
      baselineResultsPath: '',
      currentResultsPath: '',
      totalScreenshots,
      matchedScreenshots,
      changedScreenshots,
      missingInBaseline,
      missingInCurrent,
      changed,
      missing,
      errors,
      dimensionChanges: [],
      dashboardUrl: `${this.#apiUrl}/dashboard/visual/${this.#projectId}/runs/${run.id}`
    };

    summary.status = determineDriftStatus(summary);
    return summary;
  }
}

/**
 * Error thrown when the Snap API returns a non-retryable HTTP error.
 */
export class SnapApiError extends Error {
  /** @type {number} */
  status;
  /** @type {string} */
  path;

  /**
   * @param {number} status
   * @param {string} message
   * @param {string} path
   */
  constructor(status, message, path) {
    super(message);
    this.name = 'SnapApiError';
    this.status = status;
    this.path = path;
  }
}

/**
 * Error thrown when the Snap API is unreachable after all retries.
 */
export class SnapUnavailableError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'SnapUnavailableError';
  }
}

/**
 * Error thrown when Snap is unavailable and onUnavailable is "fallback-local".
 * The caller should catch this and delegate to LocalProvider.
 */
export class SnapFallbackError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'SnapFallbackError';
  }
}

/**
 * Error thrown when Snap is unavailable and onUnavailable is "warn-and-skip".
 * The caller should catch this and exit cleanly (skip visual regression).
 */
export class SnapSkipError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'SnapSkipError';
  }
}