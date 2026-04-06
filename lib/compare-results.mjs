// @ts-check

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pngjs from 'pngjs';

import {
  loadSnapdriftConfig,
  readFirstDefinedEnv,
  resolveFromWorkingDirectory,
  selectConfiguredRoutes,
  splitCommaList
} from './snapdrift-config.mjs';

const { PNG } = pngjs;

/** @typedef {import('../types/visual-diff-types').VisualBaselineResults} BaselineResults */
/** @typedef {import('../types/visual-diff-types').VisualDiffChangedItem} DriftChangedItem */
/** @typedef {import('../types/visual-diff-types').VisualDiffDimensionItem} DriftDimensionItem */
/** @typedef {import('../types/visual-diff-types').VisualDiffErrorItem} DriftErrorItem */
/** @typedef {import('../types/visual-diff-types').VisualDiffSummary} DriftSummary */
/** @typedef {import('../types/visual-diff-types').VisualRegressionConfig['diff']['mode']} DriftMode */
/** @typedef {import('../types/visual-diff-types').VisualScreenshotManifest} ScreenshotManifest */
/** @typedef {import('../types/visual-diff-types').VisualScreenshotManifestEntry} ScreenshotManifestEntry */

const baselineResultsPath = readFirstDefinedEnv(['SNAPDRIFT_BASELINE_RESULTS_PATH']);
const baselineManifestPath = readFirstDefinedEnv(['SNAPDRIFT_BASELINE_MANIFEST_PATH']);
const currentResultsPath = readFirstDefinedEnv(['SNAPDRIFT_CURRENT_RESULTS_PATH']);
const currentManifestPath = readFirstDefinedEnv(['SNAPDRIFT_CURRENT_MANIFEST_PATH']);
const baselineRunDir = path.resolve(readFirstDefinedEnv(['SNAPDRIFT_BASELINE_RUN_DIR']) || 'baseline');
const currentRunDirValue = readFirstDefinedEnv(['SNAPDRIFT_CURRENT_RUN_DIR']);
const currentRunDir = currentRunDirValue ? path.resolve(currentRunDirValue) : '';
const outDir = path.resolve(
  readFirstDefinedEnv(['SNAPDRIFT_DRIFT_OUT_DIR']) || path.join('qa-artifacts', 'snapdrift', 'drift', 'current')
);
const summaryPath = path.resolve(
  readFirstDefinedEnv(['SNAPDRIFT_SUMMARY_PATH']) || path.join(outDir, 'summary.json')
);
const markdownPath = path.resolve(
  readFirstDefinedEnv(['SNAPDRIFT_SUMMARY_MARKDOWN_PATH']) || path.join(outDir, 'summary.md')
);
const baselineArtifactName = readFirstDefinedEnv(['SNAPDRIFT_BASELINE_ARTIFACT_NAME']) || '';
const baselineSourceSha = readFirstDefinedEnv(['SNAPDRIFT_BASELINE_SOURCE_SHA']) || '';
const shouldEnforceOutcomeFromEnv = readFirstDefinedEnv(['SNAPDRIFT_ENFORCE_OUTCOME']) !== '0';
const DEFAULT_SNAPDRIFT_REPO_URL = 'https://github.com/ranacseruet/snapdrift';
const DEFAULT_SNAPDRIFT_ICON_URL = 'https://raw.githubusercontent.com/ranacseruet/snapdrift/main/assets/snapdrift-logo-icon.png';

const fileIndexCache = new Map();

/**
 * @param {import('../types/visual-diff-types').VisualViewport | undefined} viewport
 * @returns {string}
 */
function formatViewport(viewport) {
  if (!viewport) return '';
  return typeof viewport === 'string' ? viewport : `${viewport.width}x${viewport.height}`;
}

/**
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * @template T
 * @param {string} filePath
 * @param {string} label
 * @returns {Promise<T>}
 */
async function loadJson(filePath, label) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Unable to load ${label} at ${filePath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/**
 * @param {BaselineResults} results
 * @returns {Map<string, BaselineResults['routes'][number]>}
 */
function indexRouteResults(results) {
  return new Map((results.routes || []).map((route) => [route.id, route]));
}

/**
 * @param {ScreenshotManifest} manifest
 * @param {string[]} selectedRouteIds
 * @returns {Map<string, ScreenshotManifestEntry>}
 */
function indexManifestEntries(manifest, selectedRouteIds) {
  const selected = new Set(selectedRouteIds);
  const entries = new Map();
  for (const screenshot of manifest.screenshots || []) {
    if (!selected.has(screenshot.id)) {
      continue;
    }
    if (entries.has(screenshot.id)) {
      throw new Error(`Duplicate screenshot id ${screenshot.id} detected in the SnapDrift screenshot manifest.`);
    }
    entries.set(screenshot.id, screenshot);
  }
  return entries;
}

/**
 * @param {string} rootDir
 * @returns {Promise<Map<string, string[]>>}
 */
async function buildFileIndex(rootDir) {
  const cached = fileIndexCache.get(rootDir);
  if (cached) {
    return cached;
  }

  /** @type {Map<string, string[]>} */
  const filesByBasename = new Map();

  /**
   * @param {string} currentDir
   * @returns {Promise<void>}
   */
  async function visit(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      const list = filesByBasename.get(entry.name) || [];
      list.push(fullPath);
      filesByBasename.set(entry.name, list);
    }
  }

  if (await exists(rootDir)) {
    await visit(rootDir);
  }

  fileIndexCache.set(rootDir, filesByBasename);
  return filesByBasename;
}

/**
 * @param {string} runDir
 * @param {string} relativeImagePath
 * @returns {Promise<string>}
 */
export async function resolveImagePath(runDir, relativeImagePath) {
  const directPath = path.resolve(runDir, relativeImagePath);
  if (await exists(directPath)) {
    return directPath;
  }

  const fileIndex = await buildFileIndex(runDir);
  const basename = path.basename(relativeImagePath);
  const matches = fileIndex.get(basename) || [];

  if (matches.length === 1) {
    return matches[0];
  }

  if (matches.length > 1) {
    const normalizedRelativePath = relativeImagePath.replace(/\\/g, '/');
    const suffixMatches = matches.filter((candidate) => candidate.replace(/\\/g, '/').endsWith(normalizedRelativePath));
    if (suffixMatches.length === 1) {
      return suffixMatches[0];
    }
  }

  throw new Error(`Unable to locate screenshot ${relativeImagePath} under ${runDir}.`);
}

/**
 * @param {string} baselinePath
 * @param {string} currentPath
 * @returns {Promise<{ width: number, height: number, differentPixels: number, totalPixels: number, mismatchRatio: number }>}
 */
async function comparePngs(baselinePath, currentPath) {
  const [baselineBuffer, currentBuffer] = await Promise.all([
    fs.readFile(baselinePath),
    fs.readFile(currentPath)
  ]);
  const baselinePng = PNG.sync.read(baselineBuffer);
  const currentPng = PNG.sync.read(currentBuffer);

  if (baselinePng.width !== currentPng.width || baselinePng.height !== currentPng.height) {
    throw new Error(
      `Dimension mismatch: baseline ${baselinePng.width}x${baselinePng.height}, current ${currentPng.width}x${currentPng.height}.`
    );
  }

  let differentPixels = 0;
  for (let index = 0; index < baselinePng.data.length; index += 4) {
    if (
      baselinePng.data[index] !== currentPng.data[index] ||
      baselinePng.data[index + 1] !== currentPng.data[index + 1] ||
      baselinePng.data[index + 2] !== currentPng.data[index + 2] ||
      baselinePng.data[index + 3] !== currentPng.data[index + 3]
    ) {
      differentPixels += 1;
    }
  }

  const totalPixels = baselinePng.width * baselinePng.height;
  return {
    width: baselinePng.width,
    height: baselinePng.height,
    differentPixels,
    totalPixels,
    mismatchRatio: totalPixels === 0 ? 0 : differentPixels / totalPixels
  };
}

/**
 * @param {DriftSummary} summaryData
 * @returns {'clean' | 'changes-detected' | 'incomplete'}
 */
export function determineDriftStatus(summaryData) {
  if (
    summaryData.errors.length > 0 ||
    (summaryData.dimensionChanges || []).length > 0 ||
    summaryData.missingInBaseline > 0 ||
    summaryData.missingInCurrent > 0
  ) {
    return 'incomplete';
  }
  if (summaryData.changedScreenshots > 0) {
    return 'changes-detected';
  }
  return 'clean';
}

/**
 * @param {DriftSummary} summaryData
 * @returns {boolean}
 */
export function shouldFailDriftCheck(summaryData) {
  if (summaryData.diffMode === 'report-only') {
    return false;
  }
  if (summaryData.diffMode === 'fail-on-changes') {
    return summaryData.changedScreenshots > 0;
  }
  if (summaryData.diffMode === 'fail-on-incomplete') {
    return (
      summaryData.errors.length > 0 ||
      (summaryData.dimensionChanges || []).length > 0 ||
      summaryData.missingInBaseline > 0 ||
      summaryData.missingInCurrent > 0
    );
  }
  return (
    summaryData.changedScreenshots > 0 ||
    summaryData.errors.length > 0 ||
    (summaryData.dimensionChanges || []).length > 0 ||
    summaryData.missingInBaseline > 0 ||
    summaryData.missingInCurrent > 0
  );
}

/**
 * @param {DriftSummary} summaryData
 * @returns {string}
 */
function makeMarkdown(summaryData) {
  const statusIconMap = {
    clean: '✅',
    'changes-detected': '🟡',
    incomplete: '⚠️',
    skipped: '⏭️'
  };
  const statusLabelMap = {
    clean: 'Clean',
    'changes-detected': 'Drift detected',
    incomplete: 'Incomplete',
    skipped: 'Skipped'
  };
  const status = summaryData.status || 'incomplete';
  const statusIcon = statusIconMap[status] || '⚠️';
  const statusLabel = statusLabelMap[status] || status;
  const dimensionChanges = summaryData.dimensionChanges || [];
  const selectedRoutes = summaryData.selectedRoutes?.length || 0;

  const lines = [
    `<img src="${DEFAULT_SNAPDRIFT_ICON_URL}" alt="SnapDrift" width="24" height="24" />`,
    '',
    `# ${statusIcon} SnapDrift Report — ${statusLabel}`,
    '',
    '| Selected routes | Stable captures | Diff mode | Threshold |',
    '|---------------:|----------------:|:----------|----------:|',
    `| ${selectedRoutes} | ${summaryData.matchedScreenshots} | \`${summaryData.diffMode}\` | ${summaryData.threshold} |`,
    '',
    '| Signal | Count |',
    '|:-------|------:|',
    `| Drift signals | ${summaryData.changedScreenshots} |`,
    `| Missing in baseline | ${summaryData.missingInBaseline} |`,
    `| Missing in current capture | ${summaryData.missingInCurrent} |`,
    `| Dimension shifts | ${dimensionChanges.length} |`,
    `| Errors | ${summaryData.errors.length} |`,
    ''
  ];

  const metaItems = [];
  if (summaryData.baselineArtifactName) {
    metaItems.push(`baseline \`${summaryData.baselineArtifactName}\``);
  }
  if (summaryData.baselineSourceSha) {
    metaItems.push(`sha \`${summaryData.baselineSourceSha}\``);
  }
  if (metaItems.length > 0) {
    lines.push('');
    lines.push(`<sub>SnapDrift · ${metaItems.join(' · ')}</sub>`);
  }

  lines.push('');
  lines.push('## Drift signals');

  if (summaryData.changed.length === 0) {
    lines.push('');
    lines.push('None');
  } else {
    lines.push('');
    lines.push('| Route | Viewport | Mismatch | Pixels changed |');
    lines.push('|:------|:---------|:---------|:---------------|');
    for (const item of summaryData.changed) {
      lines.push(`| ${item.id} | ${formatViewport(item.viewport)} | ${(item.mismatchRatio * 100).toFixed(2)}% | ${item.differentPixels}/${item.totalPixels} |`);
    }
  }

  lines.push('');
  lines.push('## Capture gaps');
  if (summaryData.missing.length === 0) {
    lines.push('');
    lines.push('None');
  } else {
    lines.push('');
    lines.push('| Route | Reason |');
    lines.push('|:------|:-------|');
    for (const item of summaryData.missing) {
      lines.push(`| ${item.id} | ${item.reason} |`);
    }
  }

  lines.push('');
  lines.push('## Dimension shifts');
  if (dimensionChanges.length === 0) {
    lines.push('');
    lines.push('None');
  } else {
    lines.push('');
    lines.push('> SnapDrift detected a dimension shift between the baseline and current capture. Pixel comparison was skipped for these routes.');
    lines.push('>');
    lines.push('> **Next step:** refresh the baseline after this change lands so SnapDrift can compare like-for-like frames.');
    lines.push('');
    lines.push('| Route | Viewport | Baseline | Current |');
    lines.push('|:------|:---------|:---------|:--------|');
    for (const item of dimensionChanges) {
      lines.push(`| ${item.id} | ${formatViewport(item.viewport)} | ${item.baselineWidth}×${item.baselineHeight} | ${item.currentWidth}×${item.currentHeight} |`);
    }
  }

  lines.push('');
  lines.push('## Comparison errors');
  if (summaryData.errors.length === 0) {
    lines.push('');
    lines.push('None');
  } else {
    lines.push('');
    lines.push('| Route | Error |');
    lines.push('|:------|:------|');
    for (const item of summaryData.errors) {
      lines.push(`| ${item.id} | ${item.message} |`);
    }
  }

  lines.push('');
  lines.push(`<sub>SnapDrift · baseline results \`${summaryData.baselineResultsPath}\` · current results \`${summaryData.currentResultsPath}\`</sub>`);
  lines.push('');
  lines.push(`<div align="right"><sub>Powered by <a href="${DEFAULT_SNAPDRIFT_REPO_URL}">SnapDrift</a></sub></div>`);

  return lines.join('\n') + '\n';
}

/**
 * @param {DriftMode} diffMode
 * @param {{ changedScreenshots?: number }} summary
 * @returns {string}
 */
export function formatDriftFailureMessage(diffMode, summary) {
  if (diffMode === 'fail-on-changes') {
    return `SnapDrift detected drift in ${summary.changedScreenshots} capture(s), above the configured threshold.`;
  }
  if (diffMode === 'fail-on-incomplete') {
    return 'SnapDrift stopped the run because the comparison finished incomplete.';
  }
  return 'SnapDrift strict mode detected drift or incomplete comparisons.';
}

/**
 * @param {{
 *   configPath?: string,
 *   baselineResultsPath?: string,
 *   baselineManifestPath?: string,
 *   currentResultsPath?: string,
 *   currentManifestPath?: string,
 *   baselineRunDir?: string,
 *   currentRunDir?: string,
 *   routeIds?: Iterable<string>,
 *   baselineArtifactName?: string,
 *   baselineSourceSha?: string
 * }} [options]
 * @returns {Promise<{ summary: DriftSummary, markdown: string }>}
 */
export async function generateDriftReport(options = {}) {
  fileIndexCache.clear();

  const { config } = await loadSnapdriftConfig(options.configPath);
  const selectedRouteIds = selectConfiguredRoutes(
    config,
    options.routeIds || splitCommaList(readFirstDefinedEnv(['SNAPDRIFT_ROUTE_IDS']))
  ).selectedRouteIds;

  const resolvedBaselineResultsPath = path.resolve(
    options.baselineResultsPath || baselineResultsPath || resolveFromWorkingDirectory(config, config.resultsFile)
  );
  const resolvedBaselineManifestPath = path.resolve(
    options.baselineManifestPath || baselineManifestPath || resolveFromWorkingDirectory(config, config.manifestFile)
  );
  const resolvedCurrentResultsPath = path.resolve(
    options.currentResultsPath || currentResultsPath || resolveFromWorkingDirectory(config, config.resultsFile)
  );
  const resolvedCurrentManifestPath = path.resolve(
    options.currentManifestPath || currentManifestPath || resolveFromWorkingDirectory(config, config.manifestFile)
  );
  const resolvedBaselineRunDir = path.resolve(options.baselineRunDir || baselineRunDir);
  const resolvedCurrentRunDir = path.resolve(
    options.currentRunDir || currentRunDir || resolveFromWorkingDirectory(config, config.screenshotsRoot)
  );

  const [baselineResults, currentResults, baselineManifest, currentManifest] = await Promise.all([
    loadJson(resolvedBaselineResultsPath, 'baseline SnapDrift results'),
    loadJson(resolvedCurrentResultsPath, 'current SnapDrift results'),
    loadJson(resolvedBaselineManifestPath, 'baseline screenshot manifest'),
    loadJson(resolvedCurrentManifestPath, 'current screenshot manifest')
  ]);

  const baselineRouteResults = indexRouteResults(/** @type {BaselineResults} */ (baselineResults));
  const currentRouteResults = indexRouteResults(/** @type {BaselineResults} */ (currentResults));
  const baselineEntries = indexManifestEntries(/** @type {ScreenshotManifest} */ (baselineManifest), selectedRouteIds);
  const currentEntries = indexManifestEntries(/** @type {ScreenshotManifest} */ (currentManifest), selectedRouteIds);

  /** @type {DriftSummary} */
  const summary = {
    startedAt: new Date().toISOString(),
    baselineResultsPath: resolvedBaselineResultsPath,
    currentResultsPath: resolvedCurrentResultsPath,
    baselineManifestPath: resolvedBaselineManifestPath,
    currentManifestPath: resolvedCurrentManifestPath,
    diffMode: config.diff.mode,
    threshold: config.diff.threshold,
    totalScreenshots: selectedRouteIds.length,
    matchedScreenshots: 0,
    changedScreenshots: 0,
    missingInBaseline: 0,
    missingInCurrent: 0,
    changed: [],
    missing: [],
    errors: [],
    dimensionChanges: [],
    selectedRoutes: selectedRouteIds,
    baselineArtifactName: options.baselineArtifactName || baselineArtifactName || undefined,
    baselineSourceSha: options.baselineSourceSha || baselineSourceSha || undefined,
    baselineAvailable: true
  };

  for (const routeId of selectedRouteIds) {
    const routeConfig = config.routes.find((route) => route.id === routeId);
    const baselineEntry = baselineEntries.get(routeId);
    const currentEntry = currentEntries.get(routeId);
    const baselineRouteResult = baselineRouteResults.get(routeId);
    const currentRouteResult = currentRouteResults.get(routeId);

    if (!baselineEntry && !currentEntry) {
      /** @type {DriftErrorItem} */
      const errorRecord = {
        id: routeId,
        path: routeConfig?.path,
        viewport: routeConfig?.viewport,
        status: 'error',
        message: [
          'Screenshot missing from both manifests.',
          baselineRouteResult?.status === 'failed' ? `Baseline capture failed: ${baselineRouteResult.error || 'unknown error'}` : '',
          currentRouteResult?.status === 'failed' ? `Current capture failed: ${currentRouteResult.error || 'unknown error'}` : ''
        ]
          .filter(Boolean)
          .join(' ')
      };
      summary.errors.push(errorRecord);
      continue;
    }

    if (!baselineEntry) {
      summary.missingInBaseline += 1;
      summary.missing.push({
        id: routeId,
        path: currentEntry?.path || routeConfig?.path,
        viewport: currentEntry?.viewport || routeConfig?.viewport,
        location: 'baseline',
        reason: 'missing baseline capture'
      });
      continue;
    }

    if (!currentEntry) {
      summary.missingInCurrent += 1;
      summary.missing.push({
        id: routeId,
        path: baselineEntry.path || routeConfig?.path,
        viewport: baselineEntry.viewport || routeConfig?.viewport,
        location: 'current',
        reason: 'missing current capture'
      });
      continue;
    }

    try {
      if (baselineEntry.width !== currentEntry.width || baselineEntry.height !== currentEntry.height) {
      /** @type {DriftDimensionItem} */
      const dimensionRecord = {
          id: routeId,
          path: currentEntry.path || baselineEntry.path || routeConfig?.path,
          viewport: currentEntry.viewport || baselineEntry.viewport || routeConfig?.viewport,
          baselineWidth: baselineEntry.width,
          baselineHeight: baselineEntry.height,
          currentWidth: currentEntry.width,
          currentHeight: currentEntry.height,
          status: 'dimension-changed'
        };
        summary.dimensionChanges.push(dimensionRecord);
        continue;
      }

      const [resolvedBaselineImagePath, resolvedCurrentImagePath] = await Promise.all([
        resolveImagePath(resolvedBaselineRunDir, baselineEntry.imagePath),
        resolveImagePath(resolvedCurrentRunDir, currentEntry.imagePath)
      ]);
      const comparison = await comparePngs(resolvedBaselineImagePath, resolvedCurrentImagePath);

      if (comparison.mismatchRatio <= config.diff.threshold) {
        summary.matchedScreenshots += 1;
        continue;
      }

      /** @type {DriftChangedItem} */
      const changedRecord = {
        id: routeId,
        path: currentEntry.path,
        viewport: currentEntry.viewport,
        baselineImagePath: baselineEntry.imagePath,
        currentImagePath: currentEntry.imagePath,
        width: comparison.width,
        height: comparison.height,
        differentPixels: comparison.differentPixels,
        totalPixels: comparison.totalPixels,
        mismatchRatio: Number(comparison.mismatchRatio.toFixed(6)),
        status: 'changed'
      };
      summary.changedScreenshots += 1;
      summary.changed.push(changedRecord);
    } catch (error) {
      /** @type {DriftErrorItem} */
      const errorRecord = {
        id: routeId,
        path: currentEntry.path || baselineEntry.path || routeConfig?.path,
        viewport: currentEntry.viewport || baselineEntry.viewport || routeConfig?.viewport,
        status: 'error',
        message: error instanceof Error ? error.message : String(error)
      };
      summary.errors.push(errorRecord);
    }
  }

  summary.status = determineDriftStatus(summary);
  summary.finishedAt = new Date().toISOString();
  summary.completed = true;

  return {
    summary,
    markdown: makeMarkdown(summary)
  };
}

/**
 * @param {Parameters<typeof generateDriftReport>[0] & {
 *   outDir?: string,
 *   summaryPath?: string,
 *   markdownPath?: string,
 *   enforceOutcome?: boolean
 * }} [options]
 * @returns {Promise<void>}
 */
export async function runDriftCheckCli(options = {}) {
  const resolvedOutDir = path.resolve(options.outDir || outDir);
  const resolvedSummaryPath = path.resolve(options.summaryPath || summaryPath);
  const resolvedMarkdownPath = path.resolve(options.markdownPath || markdownPath);
  const shouldEnforceOutcome = options.enforceOutcome ?? shouldEnforceOutcomeFromEnv;

  await fs.mkdir(resolvedOutDir, { recursive: true });
  const { summary, markdown } = await generateDriftReport(options);
  await Promise.all([
    fs.writeFile(resolvedSummaryPath, JSON.stringify(summary, null, 2)),
    fs.writeFile(resolvedMarkdownPath, markdown)
  ]);

  if (shouldEnforceOutcome && shouldFailDriftCheck(summary)) {
    throw new Error(formatDriftFailureMessage(summary.diffMode, summary));
  }
}

const isDirectRun = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isDirectRun) {
  runDriftCheckCli().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
