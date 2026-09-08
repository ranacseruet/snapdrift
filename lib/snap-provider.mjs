// @ts-check

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { makeMarkdown, buildReportCommentBody } from '@snapdrift/adapter-report-md';
import { loadSnapdriftConfig, runBaselineCapture } from '@snapdrift/adapter-fs';
import { selectConfiguredRoutes, splitCommaList, determineDriftStatus, VIEWPORT_PRESETS, viewportHash } from '@snapdrift/manifest';

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
/** @typedef {import('../types/visual-diff-types').JsonObject} JsonObject */

const DEFAULT_API_URL = 'https://snap.i2dev.com';
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;
const RETRY_MULTIPLIER = 2;
const MAX_RETRY_TOTAL_MS = 30000;
const POLL_INTERVAL_MS = 2000;
const MAX_POLL_DURATION_MS = 10 * 60 * 1000;
const MAX_STABLE_INCOMPLETE_POLLS = 30;
const BASELINE_RUN_SUCCESS_STATUS = 'new';
const BASELINE_CAPTURE_SUCCESS_STATUS = 'new';
const TERMINAL_CAPTURE_STATUSES = new Set(['new', 'diffed', 'error']);

// Snap reports a run as "new" when it has no baseline to compare against (first
// capture for a project, or any baseline-publish run that intentionally omits a
// baseline). It is a terminal state — the run never advances past it — so the
// client must stop polling on it just like pass/fail/error.
const TERMINAL_RUN_STATUSES = new Set(['pass', 'fail', 'error', 'new']);

/** @param {string} detail @returns {Error} */
function completeBaselineError(detail) {
  return new Error(`Cannot publish a complete Snap baseline: ${detail}`);
}

/** @param {string} detail @returns {Error} */
function hostedDiffError(detail) {
  return new Error(`Cannot compare a Snap visual diff: ${detail}`);
}

/**
 * @param {import('../types/visual-diff-types').VisualViewport} viewport
 * @returns {{ width: number, height: number, deviceScaleFactor?: number, isMobile?: boolean, hasTouch?: boolean }}
 */
function resolveViewportDescriptor(viewport) {
  return typeof viewport === 'string'
    ? (VIEWPORT_PRESETS[viewport] ?? { width: 1280, height: 720 })
    : viewport;
}

/** @param {VisualRegressionConfig['routes'][number]} route */
function expectedCaptureIdentity(route) {
  return {
    routeId: route.id,
    routePath: route.path,
    viewportDescriptorJson: JSON.stringify(resolveViewportDescriptor(route.viewport))
  };
}

/**
 * @param {unknown} value
 * @param {string} context
 * @param {(detail: string) => Error} [errorFactory]
 * @returns {string}
 */
function normalizeViewportDescriptor(value, context, errorFactory = completeBaselineError) {
  let descriptor;
  try {
    descriptor = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    throw errorFactory(`${context} has malformed viewportDescriptorJson.`);
  }
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor) ||
      !Number.isFinite(descriptor.width) || !Number.isFinite(descriptor.height)) {
    throw errorFactory(`${context} has an invalid viewport descriptor.`);
  }
  return JSON.stringify(Object.fromEntries(
    Object.entries(descriptor).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  ));
}

/**
 * @param {{ routeId?: unknown, viewportDescriptorJson?: unknown }} capture
 * @param {string} context
 * @param {(detail: string) => Error} [errorFactory]
 */
function captureIdentityKey(capture, context, errorFactory = completeBaselineError) {
  if (typeof capture.routeId !== 'string' || !capture.routeId) {
    throw errorFactory(`${context} has no routeId.`);
  }
  return `${capture.routeId}\u0000${normalizeViewportDescriptor(capture.viewportDescriptorJson, context, errorFactory)}`;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {(detail: string) => Error} [errorFactory]
 * @returns {Set<string>}
 */
function uniqueRouteIdSet(value, field, errorFactory = completeBaselineError) {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !id)) {
    throw errorFactory(`results metadata has no valid ${field}; capture again with SnapDrift 0.8.2 or newer.`);
  }
  const ids = new Set(value);
  if (ids.size !== value.length) {
    throw errorFactory(`results metadata ${field} contains duplicate route ids.`);
  }
  return ids;
}

/**
 * Validate the immutable capture plan written by SnapProvider.capture().
 *
 * Diff runs are allowed to be scoped, so this deliberately validates the
 * expected set against selectedRouteIds rather than requiring every configured
 * route as hosted baseline publication does.
 *
 * @param {JsonObject} metadata
 * @param {string} projectId
 * @returns {{
 *   runId: string,
 *   selectedRouteIds: string[],
 *   expectedCaptures: Array<{ routeId: string, routePath: string, viewportDescriptorJson: string }>,
 *   expectedByIdentity: Map<string, { routeId: string, routePath: string, viewportDescriptorJson: string }>
 * }}
 */
function validateHostedDiffMetadata(metadata, projectId) {
  if (!metadata || typeof metadata !== 'object') {
    throw hostedDiffError('capture results metadata is not an object; capture again with SnapDrift 0.8.2 or newer.');
  }
  if (typeof metadata.runId !== 'string' || !metadata.runId.trim()) {
    throw hostedDiffError('capture results metadata has no run id; capture again with SnapDrift 0.8.2 or newer.');
  }
  if (metadata.projectId !== projectId) {
    throw hostedDiffError(
      `capture results belong to project "${metadata.projectId || 'unknown'}", not "${projectId}".`
    );
  }

  if (!Array.isArray(metadata.expectedCaptures) || metadata.expectedCaptures.length === 0) {
    throw hostedDiffError(
      'capture results have no expected capture identities; recapture with SnapDrift 0.8.2 or newer.'
    );
  }
  const selected = uniqueRouteIdSet(metadata.selectedRouteIds, 'selectedRouteIds', hostedDiffError);
  if (selected.size === 0) {
    throw hostedDiffError('capture results selected no routes.');
  }
  if (metadata.expectedCaptures.length !== selected.size) {
    throw hostedDiffError(
      `capture results describe ${metadata.expectedCaptures.length} expected capture(s) for ${selected.size} selected route(s).`
    );
  }

  const expectedRouteIds = new Set();
  const expectedByIdentity = new Map();
  for (const [index, expected] of metadata.expectedCaptures.entries()) {
    if (!expected || typeof expected !== 'object' ||
        typeof expected.routeId !== 'string' || !expected.routeId ||
        typeof expected.routePath !== 'string' || !expected.routePath ||
        !selected.has(expected.routeId)) {
      throw hostedDiffError(`expected capture metadata at index ${index} is invalid or not selected.`);
    }
    if (expectedRouteIds.has(expected.routeId)) {
      throw hostedDiffError(`expected capture metadata contains duplicate route "${expected.routeId}".`);
    }
    expectedRouteIds.add(expected.routeId);
    const expectedCapture = {
      routeId: expected.routeId,
      routePath: expected.routePath,
      viewportDescriptorJson: normalizeViewportDescriptor(
        expected.viewportDescriptorJson,
        `expected capture "${expected.routeId}"`,
        hostedDiffError
      )
    };
    const identity = captureIdentityKey(expectedCapture, `expected capture "${expected.routeId}"`, hostedDiffError);
    if (expectedByIdentity.has(identity)) {
      throw hostedDiffError(`expected capture metadata contains duplicate route/viewport identity for "${expected.routeId}".`);
    }
    expectedByIdentity.set(identity, expectedCapture);
  }

  if (expectedRouteIds.size !== selected.size) {
    throw hostedDiffError('expected capture metadata does not cover every selected route.');
  }

  return {
    runId: metadata.runId,
    selectedRouteIds: [...selected],
    expectedCaptures: [...expectedByIdentity.values()],
    expectedByIdentity
  };
}

/** @param {string[]} configuredRouteIds @param {string[]} selectedRouteIds */
function assertCompleteHostedBaselineSelection(configuredRouteIds, selectedRouteIds) {
  const selected = new Set(selectedRouteIds);
  const missing = configuredRouteIds.filter((id) => !selected.has(id));
  if (missing.length === 0 && selected.size === configuredRouteIds.length) return;
  throw new Error(
    `Hosted Snap baseline publication requires all ${configuredRouteIds.length} configured route(s), ` +
    `but only ${selected.size} were selected. Remove route-ids/--routes scoping ` +
    `(missing: ${missing.join(', ') || 'unknown'}). Scoped runs remain supported for PR diffs ` +
    'and local-provider baselines.'
  );
}

/**
 * @param {import('../types/visual-diff-types').SnapRunMetadata} metadata
 * @param {JsonObject} run
 * @param {string} projectId
 */
function validateCompleteBaselineRun(metadata, run, projectId) {
  if (metadata.projectId !== projectId) {
    throw completeBaselineError(`source run belongs to project "${metadata.projectId || 'unknown'}", not "${projectId}".`);
  }
  if (metadata.purpose !== 'baseline') {
    throw completeBaselineError('source results were not recorded as a baseline capture.');
  }
  if (typeof metadata.refBranch !== 'string' || !metadata.refBranch ||
      typeof metadata.refSha !== 'string' || !metadata.refSha) {
    throw completeBaselineError('source results have no resolved ref; capture again with SnapDrift 0.8.2 or newer.');
  }
  if (
    typeof metadata.publicationSequence !== 'number' ||
    !Number.isSafeInteger(metadata.publicationSequence) ||
    metadata.publicationSequence <= 0
  ) {
    throw completeBaselineError(
      'source results have no valid publication sequence; capture again with SnapDrift 0.8.2 or newer.'
    );
  }
  if (typeof metadata.publicationWorkflowRef !== 'string' || !metadata.publicationWorkflowRef.trim()) {
    throw completeBaselineError(
      'source results have no publication workflow identity; capture again with SnapDrift 0.8.2 or newer.'
    );
  }

  const configured = uniqueRouteIdSet(metadata.configuredRouteIds, 'configuredRouteIds');
  const selected = uniqueRouteIdSet(metadata.selectedRouteIds, 'selectedRouteIds');
  assertCompleteHostedBaselineSelection([...configured], [...selected]);
  if (!Array.isArray(metadata.expectedCaptures) || metadata.expectedCaptures.length !== configured.size) {
    throw completeBaselineError(`expected capture metadata does not match ${configured.size} configured route(s).`);
  }

  const expectedRoutes = new Set();
  const expectedByIdentity = new Map();
  for (const expected of metadata.expectedCaptures) {
    if (!expected || typeof expected !== 'object' || typeof expected.routePath !== 'string' ||
        !configured.has(expected.routeId) || expectedRoutes.has(expected.routeId)) {
      throw completeBaselineError(`expected capture metadata has duplicate or extra route "${expected?.routeId || 'unknown'}".`);
    }
    expectedRoutes.add(expected.routeId);
    expectedByIdentity.set(
      captureIdentityKey(expected, `expected capture "${expected.routeId}"`),
      expected
    );
  }

  if (!Array.isArray(run.captures)) throw completeBaselineError('source run has no captures array.');
  if (run.captures.length !== expectedByIdentity.size) {
    throw completeBaselineError(`source run has ${run.captures.length} capture(s), expected ${expectedByIdentity.size}.`);
  }

  const seen = new Set();
  const routes = run.captures.map((capture) => {
    if (!capture || typeof capture !== 'object') {
      throw completeBaselineError('source run contains a malformed capture.');
    }
    const identity = captureIdentityKey(capture, `source capture "${capture.routeId || capture.id || 'unknown'}"`);
    if (seen.has(identity)) {
      throw completeBaselineError(`duplicate source route/viewport identity for "${capture.routeId}".`);
    }
    seen.add(identity);
    const expected = expectedByIdentity.get(identity);
    if (!expected) {
      throw completeBaselineError(`source run contains an unexpected route/viewport capture for "${capture.routeId}".`);
    }
    if (capture.routePath !== expected.routePath) {
      throw completeBaselineError(`source route "${capture.routeId}" used an unexpected path.`);
    }
    if (capture.status !== BASELINE_CAPTURE_SUCCESS_STATUS) {
      throw completeBaselineError(`source capture "${capture.routeId}" ended with status "${capture.status || 'unknown'}".`);
    }
    if (typeof capture.currentObjectKey !== 'string' || !capture.currentObjectKey) {
      throw completeBaselineError(`source capture "${capture.routeId}" has no currentObjectKey.`);
    }
    return {
      routeId: expected.routeId,
      routePath: expected.routePath,
      viewportDescriptorJson: expected.viewportDescriptorJson,
      objectKey: capture.currentObjectKey
    };
  });

  return routes.sort((left, right) => {
    const leftKey = captureIdentityKey(left, `route "${left.routeId}"`);
    const rightKey = captureIdentityKey(right, `route "${right.routeId}"`);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

/** @param {string} runId */
function baselineIdForRun(runId) {
  return `bsl_${crypto.createHash('sha256').update(runId).digest('hex').slice(0, 24)}`;
}

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
 * Run a git command, returning undefined outside a repository or when git is
 * unavailable. execFileSync (not execSync) so no argument reaches a shell.
 *
 * @param {string[]} args
 * @returns {string | undefined}
 */
function gitOutput(args) {
  try {
    const out = execFileSync('git', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    const trimmed = out.trim();
    return trimmed === '' ? undefined : trimmed;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the branch and commit a baseline should be attributed to.
 *
 * GitHub Actions exports these; a developer running `snapdrift baseline` from a
 * terminal does not. Without the git fallback every locally seeded baseline was
 * recorded as branch `main` at SHA `unknown`, which misattributes it in the
 * dashboard and in exported metadata — and makes two baselines cut from
 * different commits indistinguishable. Detached HEAD yields no branch name, so
 * `main` remains the last resort.
 *
 * @returns {{ refBranch: string, refSha: string }}
 */
export function resolveGitRef() {
  const branch = gitOutput(['rev-parse', '--abbrev-ref', 'HEAD']);
  return {
    refBranch:
      process.env.GITHUB_REF_NAME ||
      process.env.GITHUB_HEAD_REF ||
      (branch && branch !== 'HEAD' ? branch : undefined) ||
      'main',
    refSha: process.env.GITHUB_SHA || gitOutput(['rev-parse', 'HEAD']) || 'unknown'
  };
}

function resolveHostedBaselinePublicationRef() {
  const gitRef = resolveGitRef();
  const refBranch = process.env.GITHUB_REF_NAME || gitRef.refBranch;
  const refSha = process.env.GITHUB_SHA || gitRef.refSha;
  const publicationWorkflowRef =
    process.env.SNAPDRIFT_PUBLICATION_WORKFLOW_REF || process.env.GITHUB_WORKFLOW_REF;
  const sequenceValue = process.env.SNAPDRIFT_PUBLICATION_SEQUENCE || process.env.GITHUB_RUN_NUMBER;
  const publicationSequence = Number(sequenceValue);
  if (
    !refBranch ||
    !refSha ||
    !/^[0-9a-f]{40}$/i.test(refSha) ||
    !publicationWorkflowRef ||
    !Number.isSafeInteger(publicationSequence) ||
    publicationSequence <= 0
  ) {
    throw new Error(
      'Hosted Snap baseline publication requires a branch, a resolved 40-character commit SHA, ' +
      'a publication workflow identity, and a positive publication sequence. GitHub Actions ' +
      'provides these as GITHUB_REF_NAME/GITHUB_SHA/GITHUB_WORKFLOW_REF/GITHUB_RUN_NUMBER; ' +
      'other CI systems may use SNAPDRIFT_PUBLICATION_WORKFLOW_REF and ' +
      'SNAPDRIFT_PUBLICATION_SEQUENCE.'
    );
  }
  return { refBranch, refSha, publicationWorkflowRef, publicationSequence };
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

const TAR_BLOCK_SIZE = 512;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Strips characters that could cause path traversal or produce invalid
 * filenames when a route id is used as a screenshot filename. Mirrors the
 * sanitisation applied by `@snapdrift/adapter-fs` during local capture so
 * imported baselines land on the same filenames a local capture would produce.
 *
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
 * Parse a plain ustar-style tar archive (512-byte headers, bodies padded to
 * 512-byte blocks, terminated by zero blocks) into a map of entry name →
 * entry bytes. This is the exact layout Snap's export endpoint produces;
 * long-name extensions (GNU/pax) are not needed and not supported.
 *
 * @param {Buffer} archive
 * @returns {Map<string, Buffer>}
 */
function parseTarEntries(archive) {
  /** @type {Map<string, Buffer>} */
  const entries = new Map();
  let offset = 0;

  while (offset + TAR_BLOCK_SIZE <= archive.length) {
    const header = archive.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) {
      break; // end-of-archive marker
    }

    const nameField = header.subarray(0, 100);
    const nameEnd = nameField.indexOf(0);
    const name = nameField.toString('utf-8', 0, nameEnd === -1 ? 100 : nameEnd);
    const size = parseInt(header.toString('ascii', 124, 136).replace(/\0/g, '').trim(), 8);

    if (!name || !Number.isFinite(size) || size < 0) {
      throw new Error(`Snap export archive is corrupt: invalid tar header at offset ${offset}.`);
    }

    const bodyStart = offset + TAR_BLOCK_SIZE;
    if (bodyStart + size > archive.length) {
      throw new Error(`Snap export archive is truncated: entry "${name}" extends past the end of the archive.`);
    }

    entries.set(name, archive.subarray(bodyStart, bodyStart + size));
    offset = bodyStart + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }

  return entries;
}

/**
 * Read the pixel dimensions from a PNG's IHDR chunk. Returns null when the
 * bytes are not a PNG (e.g. a JPEG export) or are too short.
 *
 * @param {Buffer} bytes
 * @returns {{ width: number, height: number } | null}
 */
function readPngDimensions(bytes) {
  if (bytes.length < 24 || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return null;
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * @param {string | undefined} json
 * @returns {any}
 */
function safeJsonParse(json) {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Sort key for picking the newest baseline. Snap serialises createdAt as an
 * ISO string, but tolerate epoch numbers and treat unparsable values as
 * oldest so a legacy row never shadows a well-formed one.
 *
 * @param {{ createdAt?: unknown }} baseline
 * @returns {number}
 */
function baselineTimestamp(baseline) {
  const createdAt = baseline?.createdAt;
  if (typeof createdAt === 'number') return createdAt;
  const parsed = Date.parse(typeof createdAt === 'string' ? createdAt : '');
  return Number.isNaN(parsed) ? -Infinity : parsed;
}

/**
 * Derive the capture engine from a baseline's capture profile. A baseline
 * published by SnapDrift records `{ engine: { name: "snapdrift-local" } }`;
 * a baseline rendered by Snap's hosted worker records Snap's own engine.
 * When nothing is recorded (legacy hosted baselines export `{}`), fall back
 * to "snap-hosted" so the CLI's cross-engine flow engages truthfully.
 *
 * @param {any} captureProfile
 * @returns {{ name: string, version: string }}
 */
function resolveExportEngine(captureProfile) {
  const engine = captureProfile?.engine;
  if (engine && typeof engine.name === 'string' && engine.name) {
    return {
      name: engine.name,
      version: typeof engine.version === 'string' && engine.version ? engine.version : 'unknown'
    };
  }
  return { name: 'snap-hosted', version: 'unknown' };
}

/**
 * Extract a human-readable detail string from a Snap API error response.
 *
 * @param {{ text: () => Promise<string> }} response
 * @returns {Promise<string>}
 */
async function readErrorDetail(response) {
  const errorBody = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(errorBody);
    return parsed.error || parsed.message || '';
  } catch {
    return '';
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
    const configuredRouteIds = config.routes.map((route) => route.id);
    const expectedCaptures = routes.map(expectedCaptureIdentity);

    if (purpose === 'baseline') {
      assertCompleteHostedBaselineSelection(configuredRouteIds, selectedRouteIds);
    }

    const baselineRef = purpose === 'baseline' ? resolveHostedBaselinePublicationRef() : undefined;
    const runContext = baselineRef
      ? { branch: baselineRef.refBranch, prHeadSha: baselineRef.refSha }
      : this.#gitRunContext();

    if (isLocalBaseUrl(config.baseUrl)) {
      return this.#captureLocalAndUpload({
        configPath: options.configPath,
        routeIds: requestedRouteIds,
        outDir: options.outDir,
        config,
        routes,
        selectedRouteIds,
        purpose,
        configuredRouteIds,
        expectedCaptures,
        runContext,
        baselineRef
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
    const baselineId = purpose === 'diff' ? await this.#resolveLatestBaselineId() : null;

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
      ...(purpose !== 'diff' ? { skipBaselineResolution: true } : {}),
      capturePlan: {
        purpose: purpose === 'baseline' ? 'baseline' : 'diff',
        ...(baselineRef
          ? {
              publicationWorkflowRef: baselineRef.publicationWorkflowRef,
              publicationSequence: baselineRef.publicationSequence
            }
          : {}),
        configuredRouteIds,
        selectedRouteIds,
        expectedCaptures
      },
      ...runContext,
    }, idempotencyKey);

    // Submit each route as a capture with its own idempotency key
    for (const route of routes) {
      const captureKey = this.#generateIdempotencyKey();
      const captureId = `cap_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
      const viewportDescriptor = resolveViewportDescriptor(route.viewport);
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

    /** @type {import('../types/visual-diff-types').SnapRunMetadata} */
    const runMetadata = {
      runId,
      projectId: this.#projectId,
      purpose,
      ...(baselineRef ? baselineRef : {}),
      startedAt: new Date().toISOString(),
      configuredRouteIds,
      selectedRouteIds,
      expectedCaptures
    };
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

    let metadata;
    try {
      metadata = JSON.parse(await fs.readFile(currentResultsPath, 'utf-8'));
    } catch (error) {
      throw hostedDiffError(
        `capture results metadata is not valid JSON; recapture with SnapDrift 0.8.2 or newer. ` +
        `${error instanceof Error ? error.message : String(error)}`
      );
    }
    const { config } = await loadSnapdriftConfig(options.configPath);
    const diffPlan = validateHostedDiffMetadata(metadata, this.#projectId);

    // Poll until the run reaches a terminal state
    const run = await this.#pollRun(diffPlan.runId, diffPlan.expectedCaptures.length, hostedDiffError);
    if (!run || typeof run !== 'object' || run.id !== diffPlan.runId) {
      throw hostedDiffError(
        `Snap returned run "${run?.id || 'unknown'}" for requested run "${diffPlan.runId}".`
      );
    }

    const summary = this.#mapRunToSummary(run, config, diffPlan);

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
      /** @type {import('../types/visual-diff-types').SnapRunMetadata | undefined} */
      let metadata;
      /** @type {unknown} */
      let readError;
      try {
        metadata = JSON.parse(await fs.readFile(resultsPath, 'utf-8'));
      } catch (error) {
        readError = error;
      }

      if (typeof metadata?.runId !== 'string' || !metadata.runId) {
        // Previously this fell through to a "legacy" branch that POSTed
        // `manifest`/`results` as objects. Snap has never read those fields, so
        // the request could only ever fail — with an opaque 500 before, and with
        // `400 unsupported_baseline_body` since i2Dev-com/snap#653. Reporting the
        // real problem (no run id) beats emitting a request guaranteed to fail
        // and surfacing its body-shape error. See #109.
        throw new Error(
          `Cannot publish a Snap baseline: no run id found in ${resultsPath}. ` +
          'A baseline is created from the object keys of a completed Snap run, so the capture step ' +
          'must have recorded one. Run `snapdrift baseline` (or actions/baseline) with ' +
          `provider "snap".${readError ? ` Could not read that file: ${readError instanceof Error ? readError.message : String(readError)}` : ''}`
        );
      }

      {
        const { runId } = metadata;
        const idempotencyKey = `baseline-${runId}`;

        if (!Array.isArray(metadata.expectedCaptures) || metadata.expectedCaptures.length === 0) {
          throw completeBaselineError(
            'results metadata has no expected captures; capture again with SnapDrift 0.8.2 or newer.'
          );
        }

        // Older Snap servers could mark a baseline run terminal after the first
        // submitted capture. Keep polling until the complete planned capture set
        // is present and terminal so a mixed-version rollout remains fail-closed.
        const run = await this.#pollRun(runId, metadata.expectedCaptures.length);

        if (run.id && run.id !== runId) {
          throw new Error(
            `Cannot publish a complete Snap baseline: requested source run ${runId}, but Snap returned ${run.id}.`
          );
        }

        // Hosted baseline runs intentionally use `new` because they omit a
        // baseline comparison. The server accepts a wider terminal set for
        // legacy/intentional workflows, but this client is stricter: any other
        // terminal status means the baseline capture did not establish fresh
        // ground truth.
        if (run.status !== BASELINE_RUN_SUCCESS_STATUS) {
          throw new Error(
            `Snap baseline run ${runId} ended with status "${run.status || 'unknown'}"; ` +
            `complete baseline publication requires "${BASELINE_RUN_SUCCESS_STATUS}". ` +
            'Check the Snap dashboard for capture error details.'
          );
        }

        const routes = validateCompleteBaselineRun(metadata, run, this.#projectId);

        const manifestJson = JSON.stringify({
          schemaVersion: 1,
          sourceRunId: runId,
          publicationWorkflowRef: metadata.publicationWorkflowRef,
          routes
        });

        const baselineId = baselineIdForRun(runId);
        await this.#request(
          'POST',
          `/v1/visual/projects/${this.#projectId}/baselines`,
          {
            id: baselineId,
            refBranch: metadata.refBranch,
            refSha: metadata.refSha,
            publicationMode: 'complete',
            sourceRunId: runId,
            manifestJson,
            captureProfileJson: JSON.stringify(this.#buildCaptureProfile())
          },
          idempotencyKey
        );

        const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-snap-baseline-'));
        return { bundleDir };
      }
    }

    // No resultsPath and no bundleDir: there is no run to build a baseline from.
    throw new Error(
      'Cannot publish a Snap baseline: neither resultsPath nor bundleDir was provided, so there ' +
      'is no Snap run to harvest object keys from. Run `snapdrift baseline` (or actions/baseline) ' +
      'with provider "snap", which captures first and passes the run results through.'
    );
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

  // `migrateBaselineFromLocal()` was removed in 0.7.0. It POSTed a pre-built
  // local bundle (`manifest`/`results`/`screenshots` as objects) to the
  // baselines API, but the server never read those fields — the PNGs were never
  // stored and the manifest referenced local filenames rather than Snap object
  // keys, so the call could only ever produce an unexportable baseline. Snap now
  // rejects that body with `400 unsupported_baseline_body` (i2Dev-com/snap#653).
  // Use `publishBaseline()` after `capture()` — or the `snapdrift baseline`
  // command, which wires both together. See ranacseruet/snapdrift#106.

  /**
   * Export baselines from Snap for local import.
   * Used by `snapdrift migrate-baselines --to local --from snap`.
   *
   * Downloads the project's export archive from
   * `GET /v1/visual/projects/:id/export` (a plain ustar tar containing a
   * `manifest.json`, per-baseline screenshot images, and per-baseline
   * capture profiles; requires an API key with the `visual:export` scope),
   * selects the most recent accepted baseline, and maps it back to the
   * local baseline layout (`results.json` + `manifest.json` +
   * `screenshots/<routeId>.png`) that `LocalProvider` reads.
   *
   * @param {{ tag?: string }} [_options]
   * @returns {Promise<{
   *   results: JsonObject,
   *   manifest: JsonObject,
   *   screenshots: Array<{ filename: string, data: Buffer }>,
   *   engine: { name: string, version: string }
   * }>}
   * @throws {Error} When the project has no accepted baselines, the selected
   *   baseline predates manifest tracking, or the export request fails.
   */
  async exportBaselines(_options) {
    const exportPath = `/v1/visual/projects/${this.#projectId}/export`;
    let archive;
    try {
      archive = await this.#requestBinary('GET', exportPath);
    } catch (error) {
      if (error instanceof SnapApiError) {
        if (error.status === 403) {
          throw new Error(
            `Snap refused the export (403): the API key does not have the "visual:export" scope. ` +
            `Issue a key with visual:export access for project "${this.#projectId}" and retry.`,
            { cause: error }
          );
        }
        if (error.status === 404) {
          throw new Error(
            `Snap project "${this.#projectId}" was not found (404). ` +
            `Check snap.projectId in snapdrift.json (or GITHUB_REPOSITORY when projectId is "auto").`,
            { cause: error }
          );
        }
        if (error.status === 413) {
          throw new Error(
            `Snap export for project "${this.#projectId}" is too large (413): ${error.message}. ` +
            `The export endpoint caps the number of accepted baselines and total archive bytes.`,
            { cause: error }
          );
        }
      }
      throw error;
    }

    const entries = parseTarEntries(archive);
    const manifestBytes = entries.get('manifest.json');
    if (!manifestBytes) {
      throw new Error('Snap export archive is missing manifest.json.');
    }
    const exportManifest = JSON.parse(manifestBytes.toString('utf-8'));
    const baselines = Array.isArray(exportManifest.baselines) ? exportManifest.baselines : [];
    if (baselines.length === 0) {
      throw new Error(
        `Snap project "${this.#projectId}" has no accepted baselines to export. ` +
        `Publish a baseline first (snapdrift baseline with provider: "snap").`
      );
    }

    // Most recent accepted baseline wins; `>=` makes the later array entry win
    // a createdAt tie (the server appends newer rows last).
    let baseline = baselines[0];
    for (const candidate of baselines.slice(1)) {
      if (baselineTimestamp(candidate) >= baselineTimestamp(baseline)) {
        baseline = candidate;
      }
    }

    if (!baseline.sourceManifest) {
      throw new Error(
        `Snap baseline "${baseline.id}" predates manifest tracking (no source manifest was recorded ` +
        `at publish time) and cannot be migrated. Publish a fresh baseline with a current SnapDrift ` +
        `version, then re-run the migration.`
      );
    }
    const routes = Array.isArray(baseline.sourceManifest.routes) ? baseline.sourceManifest.routes : null;
    if (!routes) {
      throw new Error(
        `Snap baseline "${baseline.id}" has an unrecognised source manifest format ` +
        `(expected a "routes" array) and cannot be migrated.`
      );
    }

    const archivePathByKey = new Map(
      (baseline.objects || []).map((object) => [object.sourceKey, object.archivePath])
    );

    /** @type {Array<{ filename: string, data: Buffer }>} */
    const screenshots = [];
    /** @type {JsonObject[]} */
    const manifestEntries = [];

    for (const route of routes) {
      const archivePath = route.objectKey ? archivePathByKey.get(route.objectKey) : undefined;
      const bytes = archivePath ? entries.get(archivePath) : undefined;
      if (!bytes) {
        process.stderr.write(
          `[SnapDrift] Warning: Snap export has no image for route "${route.routeId}" ` +
          `in baseline ${baseline.id}. Skipping the route.\n`
        );
        continue;
      }

      const descriptor = safeJsonParse(route.viewportDescriptorJson) ?? {};
      const hasDescriptorDims = typeof descriptor.width === 'number' && typeof descriptor.height === 'number';
      // Map the viewport descriptor back to a preset name when it matches one
      // exactly; otherwise keep custom dimensions. This round-trips with the
      // descriptor expansion capture() applies on the way up.
      const presetName = hasDescriptorDims ? viewportHash(descriptor) : null;
      const dimensions = readPngDimensions(bytes)
        ?? (hasDescriptorDims ? { width: descriptor.width, height: descriptor.height } : { width: 1, height: 1 });
      const viewport = presetName && VIEWPORT_PRESETS[presetName]
        ? presetName
        : hasDescriptorDims
          ? { width: descriptor.width, height: descriptor.height }
          : { width: dimensions.width, height: dimensions.height };

      const extension = path.extname(archivePath) || '.png';
      const filename = `${sanitizeRouteId(route.routeId)}${extension}`;
      screenshots.push({ filename, data: Buffer.from(bytes) });
      manifestEntries.push({
        id: route.routeId,
        path: route.routePath ?? '',
        viewport,
        imagePath: `screenshots/${filename}`,
        width: dimensions.width,
        height: dimensions.height
      });
    }

    if (screenshots.length === 0) {
      throw new Error(
        `Snap baseline "${baseline.id}" contained no exportable screenshots — ` +
        `the export archive had no image bytes for any of its routes.`
      );
    }

    const captureProfile = safeJsonParse(
      entries.get(`${baseline.id}/capture_profile.json`)?.toString('utf-8')
    ) ?? {};
    const engine = resolveExportEngine(captureProfile);

    const generatedAt = new Date().toISOString();
    const manifest = {
      schemaVersion: 1,
      generatedAt,
      baseUrl: typeof baseline.sourceManifest.baseUrl === 'string' ? baseline.sourceManifest.baseUrl : '',
      screenshots: manifestEntries,
      captureProfile: { ...captureProfile, engine }
    };

    const results = {
      startedAt: typeof baseline.createdAt === 'string' ? baseline.createdAt : generatedAt,
      suite: 'snap-export',
      provider: 'snap',
      projectId: this.#projectId,
      baselineId: baseline.id,
      refBranch: baseline.refBranch,
      // readLocalBaselines() picks this up as the commit SHA if the baseline is
      // ever migrated back to Snap, keeping the idempotency key stable.
      headSha: baseline.refSha,
      routes: manifestEntries.map((entry) => ({
        id: entry.id,
        path: entry.path,
        viewport: entry.viewport,
        status: 'passed',
        durationMs: 0,
        imagePath: entry.imagePath,
        width: entry.width,
        height: entry.height
      }))
    };

    return { results, manifest, screenshots, engine };
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
   *   purpose: 'baseline' | 'capture' | 'diff',
   *   configuredRouteIds: string[],
   *   expectedCaptures: import('../types/visual-diff-types').SnapExpectedCaptureIdentity[],
   *   runContext: { branch?: string, prHeadSha?: string },
   *   baselineRef?: { refBranch: string, refSha: string, publicationWorkflowRef: string, publicationSequence: number }
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
    const baselineId = options.purpose === 'diff' ? await this.#resolveLatestBaselineId() : null;

    await this.#request('POST', `/v1/visual/projects/${this.#projectId}/runs`, {
      id: runId,
      baseUrl: options.config.baseUrl,
      trigger: 'ci',
      ...(baselineId ? { baselineId } : {}),
      // A baseline run must not be diffed. Suppress the server's
      // auto-resolve-by-branch so no prior baseline is attached.
      ...(options.purpose !== 'diff' ? { skipBaselineResolution: true } : {}),
      capturePlan: {
        purpose: options.purpose === 'baseline' ? 'baseline' : 'diff',
        ...(options.baselineRef
          ? {
              publicationWorkflowRef: options.baselineRef.publicationWorkflowRef,
              publicationSequence: options.baselineRef.publicationSequence
            }
          : {}),
        configuredRouteIds: options.configuredRouteIds,
        selectedRouteIds: options.selectedRouteIds,
        expectedCaptures: options.expectedCaptures
      },
      ...options.runContext
    }, this.#generateIdempotencyKey());

    for (const { route, manifestEntry } of uploads) {
      const captureId = `cap_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
      const viewportDescriptor = resolveViewportDescriptor(route.viewport);

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
      purpose: options.purpose,
      ...(options.baselineRef ? options.baselineRef : {}),
      configuredRouteIds: options.configuredRouteIds,
      selectedRouteIds: options.selectedRouteIds,
      expectedCaptures: options.expectedCaptures,
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
   * Make an HTTP request to the Snap API that returns a binary body (e.g. the
   * export tar). Mirrors #request's retry and error semantics — 4xx never
   * retries and throws SnapApiError, 5xx/network errors retry with backoff and
   * consult onUnavailable when exhausted — but returns the raw bytes instead
   * of parsed JSON.
   *
   * @param {string} method
   * @param {string} path
   * @returns {Promise<any>} Raw response bytes as a Buffer
   */
  async #requestBinary(method, path) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await this.#fetchFn(`${this.#apiUrl}${path}`, {
          method,
          headers: { 'Authorization': `Bearer ${this.#apiKey}` }
        });

        if (response.ok) {
          return Buffer.from(await response.arrayBuffer());
        }

        // 4xx — never retry
        if (response.status >= 400 && response.status < 500) {
          const detail = await readErrorDetail(response);
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
        const detail = await readErrorDetail(response);
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
   * @param {number} [expectedCaptureCount]
   * @param {(detail: string) => Error} [errorFactory]
   * @returns {Promise<JsonObject>}
   */
  async #pollRun(runId, expectedCaptureCount, errorFactory = (detail) => new Error(detail)) {
    const startTime = Date.now();
    let incompleteTerminalSignature;
    let stableIncompleteTerminalPolls = 0;
    let incompleteSignature;
    let stableIncompletePolls = 0;

    while (Date.now() - startTime < MAX_POLL_DURATION_MS) {
      const run = await this.#request('GET', `/v1/visual/runs/${runId}`);
      if (!run || typeof run !== 'object' || Array.isArray(run)) {
        throw errorFactory(`Snap returned a malformed run response for requested run "${runId}".`);
      }
      const captures = Array.isArray(run.captures) ? run.captures : [];
      const completeCaptureSet =
        expectedCaptureCount === undefined ||
        (captures.length >= expectedCaptureCount &&
          captures.every((capture) => TERMINAL_CAPTURE_STATUSES.has(capture?.status)));

      if (expectedCaptureCount !== undefined && !completeCaptureSet) {
        const signature = JSON.stringify(captures.map((capture) => [
          capture?.id,
          capture?.routeId,
          capture?.status,
          capture?.currentObjectKey
        ]).sort((left, right) => {
          const leftJson = JSON.stringify(left);
          const rightJson = JSON.stringify(right);
          return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
        }));
        if (signature === incompleteSignature) stableIncompletePolls += 1;
        else {
          incompleteSignature = signature;
          stableIncompletePolls = 0;
        }
        // A server-side run can remain rendering forever after a cancelled
        // worker. Do not spend the full ten-minute poll budget on a capture set
        // that has made no progress for roughly one minute.
        if (stableIncompletePolls >= MAX_STABLE_INCOMPLETE_POLLS) return run;
      } else {
        incompleteSignature = undefined;
        stableIncompletePolls = 0;
      }

      if (TERMINAL_RUN_STATUSES.has(run.status)) {
        if (expectedCaptureCount === undefined || run.status === 'error') {
          return run;
        }

        if (completeCaptureSet) return run;
        // An older server can report a terminal run after only an early subset
        // has settled. Keep polling for the full capture set until the normal
        // ten-minute deadline; ordinary renders routinely exceed a few seconds.
        if (
          captures.length < expectedCaptureCount &&
          captures.every((capture) => TERMINAL_CAPTURE_STATUSES.has(capture?.status))
        ) {
          const signature = JSON.stringify(captures.map((capture) => [
            capture?.id,
            capture?.routeId,
            capture?.status
          ]).sort((left, right) => {
            const leftJson = JSON.stringify(left);
            const rightJson = JSON.stringify(right);
            return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
          }));
          if (signature === incompleteTerminalSignature) stableIncompleteTerminalPolls += 1;
          else {
            incompleteTerminalSignature = signature;
            stableIncompleteTerminalPolls = 0;
          }
          // A stable terminal subset cannot make render progress. Return it for
          // precise fail-closed count validation instead of waiting ten minutes.
          if (stableIncompleteTerminalPolls >= 2) return run;
        } else {
          incompleteTerminalSignature = undefined;
          stableIncompleteTerminalPolls = 0;
        }
      }

      await this.#sleepFn(POLL_INTERVAL_MS);
    }

    throw new Error(`Snap run ${runId} did not complete within 10 minutes.`);
  }

  /**
   * Map a Snap run result to a VisualDiffSummary.
   * @param {JsonObject} run
   * @param {VisualRegressionConfig} config
   * @param {{
   *   selectedRouteIds: string[],
   *   expectedCaptures: Array<{ routeId: string, routePath: string, viewportDescriptorJson: string }>,
   *   expectedByIdentity: Map<string, { routeId: string, routePath: string, viewportDescriptorJson: string }>
   * }} diffPlan
   * @returns {import('../types/visual-diff-types').VisualDiffSummary}
   */
  #mapRunToSummary(run, config, diffPlan) {
    const captures = Array.isArray(run.captures) ? run.captures : [];
    const totalScreenshots = diffPlan.expectedCaptures.length;
    let matchedScreenshots = 0;
    let changedScreenshots = 0;
    let missingInBaseline = 0;
    let missingInCurrent = 0;
    // Track real comparisons (a baseline was attached) and how many came back
    // pixel-identical (0% drift) so we can flag the "captured a stale/wrong
    // page" pattern below. See issue #93.
    let comparedWithBaseline = 0;
    let exactZeroMatches = 0;

    /** @type {import('../types/visual-diff-types').VisualDiffChangedItem[]} */
    const changed = [];
    /** @type {import('../types/visual-diff-types').VisualDiffMissingItem[]} */
    const missing = [];
    /** @type {import('../types/visual-diff-types').VisualDiffErrorItem[]} */
    const errors = [];

    /**
     * @param {string} id
     * @param {string | undefined} path
     * @param {import('../types/visual-diff-types').VisualViewport | undefined} viewport
     * @param {string} message
     */
    const addError = (id, path, viewport, message) => {
      errors.push({ id, path, viewport, status: 'error', message });
    };

    if (!Array.isArray(run.captures)) {
      addError(`run:${run.id}`, undefined, undefined, 'Snap run returned no valid captures array.');
    }

    if (run.status === 'error') {
      addError(
        `run:${run.id}`,
        undefined,
        undefined,
        run.errorDetails?.message || run.errorCode || run.message || 'Snap run ended with status "error".'
      );
    }

    const seenIdentities = new Set();
    for (const capture of captures) {
      if (!capture || typeof capture !== 'object' || Array.isArray(capture)) {
        addError('unknown', undefined, undefined, 'Snap run returned a malformed capture.');
        continue;
      }

      let identity;
      try {
        identity = captureIdentityKey(
          capture,
          `source capture "${capture.routeId || capture.id || 'unknown'}"`,
          hostedDiffError
        );
      } catch (error) {
        addError(
          typeof capture.routeId === 'string' && capture.routeId ? capture.routeId : 'unknown',
          typeof capture.routePath === 'string' ? capture.routePath : undefined,
          capture.viewport,
          error instanceof Error ? error.message : String(error)
        );
        continue;
      }

      const expected = diffPlan.expectedByIdentity.get(identity);
      if (!expected) {
        addError(
          capture.routeId,
          capture.routePath,
          capture.viewport,
          `Snap run returned an unexpected route/viewport capture for "${capture.routeId}".`
        );
        continue;
      }
      if (seenIdentities.has(identity)) {
        addError(
          expected.routeId,
          expected.routePath,
          capture.viewport,
          `Snap run returned a duplicate route/viewport capture for "${expected.routeId}".`
        );
        continue;
      }
      seenIdentities.add(identity);

      if (capture.routePath !== expected.routePath) {
        addError(
          expected.routeId,
          capture.routePath,
          capture.viewport,
          `Snap run returned an unexpected path for "${expected.routeId}".`
        );
        continue;
      }

      if (capture.status === 'error') {
        addError(
          expected.routeId,
          expected.routePath,
          capture.viewport,
          capture.errorDetails?.message || capture.errorCode || 'Snap capture ended with status "error".'
        );
        continue;
      }

      if (typeof capture.currentObjectKey !== 'string' || !capture.currentObjectKey) {
        addError(
          expected.routeId,
          expected.routePath,
          capture.viewport,
          `Snap capture "${expected.routeId}" has no currentObjectKey.`
        );
        continue;
      }

      if (capture.status === 'new') {
        // The backend rendered this capture but had no baseline to diff against.
        missingInBaseline++;
        missing.push({
          id: expected.routeId,
          reason: 'no baseline capture found on Snap',
          path: expected.routePath,
          location: 'baseline'
        });
        continue;
      }

      if (capture.status !== 'diffed') {
        addError(
          expected.routeId,
          expected.routePath,
          capture.viewport,
          `Snap capture "${expected.routeId}" ended with unknown status "${capture.status || 'unknown'}".`
        );
        continue;
      }

      if (capture.baselineObjectKey !== undefined &&
          capture.baselineObjectKey !== null &&
          typeof capture.baselineObjectKey !== 'string') {
        addError(
          expected.routeId,
          expected.routePath,
          capture.viewport,
          `Snap capture "${expected.routeId}" has an invalid baselineObjectKey.`
        );
        continue;
      }

      if (!capture.baselineObjectKey) {
        // No baseline was attached to this capture: the backend short-circuits
        // to "diffed" with no comparison data.
        missingInBaseline++;
        missing.push({
          id: expected.routeId,
          reason: 'no baseline capture found on Snap',
          path: expected.routePath,
          location: 'baseline'
        });
        continue;
      }

      if (!Number.isFinite(capture.diffPct) || capture.diffPct < 0 || capture.diffPct > 1) {
        addError(
          expected.routeId,
          expected.routePath,
          capture.viewport,
          `Snap capture "${expected.routeId}" has an invalid diffPct.`
        );
        continue;
      }

      if (capture.diffPct > config.diff.threshold) {
        comparedWithBaseline++;
        changedScreenshots++;
        changed.push({
          id: expected.routeId,
          path: expected.routePath,
          viewport: capture.viewport,
          baselineImagePath: capture.baselineObjectKey,
          currentImagePath: capture.currentObjectKey,
          width: capture.width || 0,
          height: capture.height || 0,
          differentPixels: capture.diffPixels || 0,
          totalPixels: (capture.width || 0) * (capture.height || 0),
          mismatchRatio: capture.diffPct,
          status: 'changed'
        });
      } else {
        comparedWithBaseline++;
        if (capture.diffPct === 0) {
          exactZeroMatches++;
        }
        matchedScreenshots++;
      }
    }

    for (const expected of diffPlan.expectedCaptures) {
      const identity = captureIdentityKey(expected, `expected capture "${expected.routeId}"`, hostedDiffError);
      if (seenIdentities.has(identity)) continue;
      missingInCurrent++;
      missing.push({
        id: expected.routeId,
        reason: 'capture missing from Snap run',
        path: expected.routePath,
        location: 'current'
      });
    }

    // False-negative guard: when a diff run compared every route against a real
    // baseline yet every single comparison came back pixel-identical (0% drift),
    // the most likely explanation is that the client captured a stale or wrong
    // page (baseUrl pointing at production instead of the PR preview, the
    // preview not being deployed yet, or a caching layer) rather than a genuine
    // "nothing changed". Warn so a real regression isn't silently missed. We
    // only warn (never fail): a PR with no visual change legitimately produces
    // this same shape. We require more than one compared route — a single
    // pixel-identical route is indistinguishable from an ordinary clean diff,
    // whereas several independent routes all landing at exactly 0% is the
    // tell-tale signature of a single stale source page. See issue #93.
    if (comparedWithBaseline > 1 && exactZeroMatches === comparedWithBaseline) {
      process.stderr.write(
        `[SnapDrift] Warning: all ${comparedWithBaseline} compared route(s) were pixel-identical ` +
        `to the baseline (0% drift). If you expected a visual change, the captured page may be ` +
        `stale or wrong — verify the resolved baseUrl points at the PR preview and that the ` +
        `preview was deployed before capture ran. See issue #93.\n`
      );
    }

    /** @type {import('../types/visual-diff-types').VisualDiffSummary} */
    const summary = {
      startedAt: run.startedAt || new Date().toISOString(),
      finishedAt: run.finishedAt || new Date().toISOString(),
      completed: true,
      status: run.status === 'pass' ? 'clean' : run.status === 'fail' ? 'changes-detected' : 'incomplete',
      selectedRoutes: diffPlan.selectedRouteIds,
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
