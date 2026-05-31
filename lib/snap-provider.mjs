// @ts-check

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { makeMarkdown, buildReportCommentBody } from '@snapdrift/adapter-report-md';
import { loadSnapdriftConfig, runBaselineCapture } from '@snapdrift/adapter-fs';
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

// Snap reports a run as "new" when it has no baseline to compare against (first
// capture for a project, or any baseline-publish run that intentionally omits a
// baseline). It is a terminal state — the run never advances past it — so the
// client must stop polling on it just like pass/fail/error.
const TERMINAL_RUN_STATUSES = new Set(['pass', 'fail', 'error', 'new']);

/**
 * @param {string | undefined} baseUrl
 * @returns {boolean}
 */
export function isLocalBaseUrl(baseUrl) {
  if (!baseUrl) {
    return false;
  }

  let hostname;
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }

  const normalized = hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) {
    return true;
  }
  if (normalized === '::1' || normalized === '0.0.0.0') {
    return true;
  }
  return net.isIP(normalized) === 4 && normalized.startsWith('127.');
}

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
  /** @type {(options?: { configPath?: string, routeIds?: Iterable<string>, outDir?: string }) => Promise<CaptureResult>} */
  #localCaptureFn;
  /** @type {string} */
  #apiKey;
  /** @type {string} */
  #apiUrl;
  /** @type {string} */
  #projectId;

  /**
   * @param {SnapConfig} snapConfig — validated snap section from config
   * @param {{
   *   fetchFn?: typeof globalThis.fetch,
   *   sleepFn?: (ms: number) => Promise<void>,
   *   localCaptureFn?: (options?: { configPath?: string, routeIds?: Iterable<string>, outDir?: string }) => Promise<CaptureResult>
   * }} [options]
   */
  constructor(snapConfig, options = {}) {
    this.#snapConfig = snapConfig;
    this.#fetchFn = options.fetchFn ?? globalThis.fetch;
    this.#sleepFn = options.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#localCaptureFn = options.localCaptureFn ?? runBaselineCapture;
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
    const purpose = options.purpose ?? 'diff';

    if (isLocalBaseUrl(config.baseUrl)) {
      return this.#captureLocalAndUpload({
        configPath: options.configPath,
        routeIds: requestedRouteIds,
        outDir: options.outDir,
        config,
        routes,
        selectedRouteIds,
        purpose
      });
    }

    const idempotencyKey = this.#generateIdempotencyKey();
    const runId = `run_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;

    // For a diff run, resolve the latest accepted baseline so the Snap backend
    // can attach it to this run's captures. Without a baselineId the server has
    // nothing to diff against and short-circuits every capture to "diffed" with
    // no comparison data, leaving the dashboard baseline + diff panes empty.
    //
    // For a baseline run we deliberately omit the baselineId: the run is
    // establishing new ground truth, not comparing against the old baseline.
    // Attaching one would make the backend diff the fresh captures against the
    // prior baseline — wasteful at best, and on a dimension mismatch it errors
    // the run and fails the publish.
    const baselineId = purpose === 'baseline' ? null : await this.#resolveLatestBaselineId();

    // We intentionally do NOT send captureProfileJson on run creation. SnapDrift
    // submits routes for server-side rendering, so the render environment
    // (browser/platform/fonts/viewport) is owned by Snap's render worker, not
    // this client. When a baselineId is attached, the run-creation endpoint
    // compares the run's capture profile against the baseline's, dereferencing
    // nested fields (browser, platform, fonts, viewport) that our minimal
    // profile does not populate — which crashes the server with a 500. The
    // render worker already defaults locale/timezone/viewport when no profile
    // is present, so omitting it here is behaviour-preserving.
    await this.#request('POST', `/v1/visual/projects/${this.#projectId}/runs`, {
      id: runId,
      baseUrl: config.baseUrl,
      trigger: 'ci',
      ...(baselineId ? { baselineId } : {}),
      // A baseline run must not be diffed. Suppress the server's
      // auto-resolve-by-branch so no prior baseline is attached.
      ...(purpose === 'baseline' ? { skipBaselineResolution: true } : {}),
      ...this.#gitRunContext(),
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
   * When called with a `resultsPath` that contains a `runId` (written by
   * `capture()`), this method polls the run until all renders complete, then
   * creates a snap baseline from the captured S3 keys. This is the primary
   * path used by the baseline action with `provider: "snap"`.
   *
   * @param {PublishBaselineOptions} options
   * @returns {Promise<PublishBaselineResult>}
   */
  async publishBaseline(options) {
    const resultsPath = options.resultsPath
      ?? (options.bundleDir ? path.join(path.resolve(options.bundleDir), 'results.json') : undefined);

    // Snap-native baseline: poll the run that capture() submitted, then
    // create a baseline from the rendered S3 keys.
    if (resultsPath) {
      let metadata;
      try {
        metadata = JSON.parse(await fs.readFile(resultsPath, 'utf-8'));
      } catch { /* fall through to legacy path */ }

      if (metadata?.runId) {
        const { runId } = metadata;
        const idempotencyKey = `baseline-${runId}`;

        // Poll until the run reaches a terminal state (renders + auto-diffs finish)
        const run = await this.#pollRun(runId);

        if (run.status === 'error') {
          throw new Error(
            `Snap baseline run ${runId} ended with status "error" — cannot publish baseline. ` +
            `Check the snap dashboard for capture error details.`
          );
        }

        const captures = run.captures ?? [];
        const rendered = captures.filter((c) => c.currentObjectKey);

        if (rendered.length === 0) {
          throw new Error(
            `Snap baseline run ${runId} completed but no captures produced a screenshot ` +
            `(${captures.length} capture(s) found, 0 rendered). Cannot publish an empty baseline.`
          );
        }

        if (rendered.length < captures.length) {
          const failed = captures.length - rendered.length;
          process.stderr.write(
            `[SnapDrift] Warning: ${failed} of ${captures.length} capture(s) did not produce ` +
            `a screenshot and will be excluded from the baseline.\n`
          );
        }

        // Build a manifest from the rendered captures
        const routes = rendered.map((c) => ({
            routeId: c.routeId,
            routePath: c.routePath,
            viewportDescriptorJson: c.viewportDescriptorJson,
            objectKey: c.currentObjectKey
          }));

        const manifestJson = JSON.stringify({
          schemaVersion: 1,
          sourceRunId: runId,
          routes
        });

        const baselineId = `bsl_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
        await this.#request(
          'POST',
          `/v1/visual/projects/${this.#projectId}/baselines`,
          {
            id: baselineId,
            refBranch: process.env.GITHUB_REF_NAME || process.env.GITHUB_HEAD_REF || 'main',
            refSha: process.env.GITHUB_SHA || 'unknown',
            manifestJson,
            captureProfileJson: JSON.stringify(this.#buildCaptureProfile())
          },
          idempotencyKey
        );

        const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-snap-baseline-'));
        return { bundleDir };
      }
    }

    // Legacy / migration path: bundle dir with pre-built results/manifest
    const idempotencyKey = this.#generateIdempotencyKey();
    const body = { idempotencyKey };

    if (options.bundleDir) {
      const bundleDir = path.resolve(options.bundleDir);
      const bResultsPath = options.resultsPath || path.join(bundleDir, 'results.json');
      const manifestPath = options.manifestPath || path.join(bundleDir, 'manifest.json');

      try {
        const results = JSON.parse(await fs.readFile(bResultsPath, 'utf-8'));
        body.results = results;
      } catch { /* results.json may not exist */ }

      try {
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
        body.manifest = manifest;
      } catch { /* manifest.json may not exist */ }

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
   * Resolve the id of the latest accepted baseline for this project so it can
   * be attached to a new run. Returns null when no baseline exists yet (the
   * legitimate first-run case), so capture can still proceed.
   *
   * @returns {Promise<string | null>}
   */
  async #resolveLatestBaselineId() {
    try {
      const baseline = await this.#request('GET', `/v1/visual/projects/${this.#projectId}/baselines/latest`);
      return baseline?.id ?? null;
    } catch (error) {
      if (error instanceof SnapApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Collect git ref context from the GitHub Actions environment so the Snap
   * dashboard can attribute the run to a branch. Uses GITHUB_HEAD_REF (the
   * source branch on pull_request events) and falls back to GITHUB_REF_NAME
   * (the branch on push events).
   *
   * @returns {{ branch?: string }}
   */
  #gitRunContext() {
    const branch = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME;
    return branch ? { branch } : {};
  }

  /**
   * @returns {string}
   */
  #generateIdempotencyKey() {
    return crypto.randomUUID();
  }

  /**
   * @param {{
   *   configPath?: string,
   *   routeIds: string[],
   *   outDir?: string,
   *   config: VisualRegressionConfig,
   *   routes: VisualRegressionConfig['routes'],
   *   selectedRouteIds: string[],
   *   purpose: 'baseline' | 'diff'
   * }} options
   * @returns {Promise<CaptureResult>}
   */
  async #captureLocalAndUpload(options) {
    const localCapture = await this.#localCaptureFn({
      configPath: options.configPath,
      routeIds: options.routeIds,
      outDir: options.outDir
    });

    const localResults = JSON.parse(await fs.readFile(localCapture.resultsPath, 'utf-8'));
    const manifest = JSON.parse(await fs.readFile(localCapture.manifestPath, 'utf-8'));
    // Route ids are unique per the v1 schema (one viewport per route), so keying
    // the manifest by id is an unambiguous join against the configured routes.
    const manifestById = new Map((manifest.screenshots || []).map((entry) => [entry.id, entry]));

    // Resolve every selected route to its screenshot up front, before any server
    // call. A missing local capture then fails fast instead of leaving an
    // orphaned run on Snap that can never complete.
    const uploads = options.routes.map((route) => {
      const manifestEntry = manifestById.get(route.id);
      if (!manifestEntry) {
        throw new Error(`Local Snap capture did not produce a screenshot for route "${route.id}".`);
      }
      return { route, manifestEntry };
    });

    const runId = `run_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    // A baseline run establishes new ground truth and must not be diffed, so we
    // omit the baselineId. Captures then settle to "new" server-side (no
    // comparison), and publishBaseline harvests their object keys. A diff run
    // attaches the latest baseline so the backend can compare against it.
    const baselineId = options.purpose === 'baseline' ? null : await this.#resolveLatestBaselineId();

    await this.#request('POST', `/v1/visual/projects/${this.#projectId}/runs`, {
      id: runId,
      baseUrl: options.config.baseUrl,
      trigger: 'ci',
      ...(baselineId ? { baselineId } : {}),
      // A baseline run must not be diffed. Suppress the server's
      // auto-resolve-by-branch so no prior baseline is attached.
      ...(options.purpose === 'baseline' ? { skipBaselineResolution: true } : {}),
      ...this.#gitRunContext()
    }, this.#generateIdempotencyKey());

    for (const { route, manifestEntry } of uploads) {
      const captureId = `cap_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
      const viewportDescriptor = typeof route.viewport === 'string'
        ? (VIEWPORT_PRESETS[route.viewport] ?? { width: 1280, height: 720 })
        : route.viewport;

      await this.#request('POST', `/v1/visual/runs/${runId}/captures`, {
        id: captureId,
        routeId: route.id,
        routePath: route.path,
        viewportDescriptorJson: JSON.stringify(viewportDescriptor),
        // The screenshot is captured locally and uploaded below, not rendered by
        // Snap. This flag tells the backend to keep the capture out of the render
        // worker's queue — without it the worker would try to render baseUrl
        // (a client-only/loopback address it can't reach) and error the run.
        localCapture: true,
      }, this.#generateIdempotencyKey());

      const imagePath = path.resolve(localCapture.screenshotsRoot, manifestEntry.imagePath);
      const imageBytes = await fs.readFile(imagePath);

      await this.#request('POST', `/v1/visual/captures/${captureId}/local-result`, {
        imageBase64: imageBytes.toString('base64'),
        width: manifestEntry.width,
        height: manifestEntry.height
      }, this.#generateIdempotencyKey());
    }

    const snapResults = {
      ...localResults,
      provider: 'snap',
      captureMode: 'local-upload',
      runId,
      projectId: this.#projectId,
      snapStartedAt: new Date().toISOString()
    };
    await fs.writeFile(localCapture.resultsPath, JSON.stringify(snapResults, null, 2));

    return localCapture;
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

      if (capture.status === 'new') {
        // The backend rendered this capture but had no baseline to diff against
        // (first run for the route). Surface it as a missing baseline rather than
        // a silent match — there is nothing to compare yet.
        missingInBaseline++;
        missing.push({
          id: capture.routeId || capture.id,
          reason: 'no baseline capture found on Snap',
          path: capture.routePath,
          viewport: capture.viewport,
          location: 'baseline'
        });
        continue;
      }

      if (capture.status === 'diffed') {
        if (!capture.baselineObjectKey) {
          // No baseline was attached to this capture: the backend short-circuits
          // to "diffed" with no comparison data (no diffPct / diff image). Surface
          // it as a missing baseline instead of silently counting it as a match.
          missingInBaseline++;
          missing.push({
            id: capture.routeId || capture.id,
            reason: 'no baseline capture found on Snap',
            path: capture.routePath,
            viewport: capture.viewport,
            location: 'baseline'
          });
        } else if (capture.diffPct != null && capture.diffPct > config.diff.threshold) {
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
