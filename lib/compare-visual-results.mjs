// @ts-check

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pngjs from 'pngjs';

import {
  loadVisualRegressionConfig,
  resolveFromWorkingDirectory,
  selectConfiguredRoutes,
  splitCommaList
} from './visual-regression-config.mjs';

const { PNG } = pngjs;

/** @typedef {import('../types/visual-diff-types').VisualBaselineResults} VisualBaselineResults */
/** @typedef {import('../types/visual-diff-types').VisualDiffChangedItem} VisualDiffChangedItem */
/** @typedef {import('../types/visual-diff-types').VisualDiffDimensionItem} VisualDiffDimensionItem */
/** @typedef {import('../types/visual-diff-types').VisualDiffErrorItem} VisualDiffErrorItem */
/** @typedef {import('../types/visual-diff-types').VisualDiffSummary} VisualDiffSummary */
/** @typedef {import('../types/visual-diff-types').VisualRegressionConfig['diff']['mode']} VisualDiffMode */
/** @typedef {import('../types/visual-diff-types').VisualScreenshotManifest} VisualScreenshotManifest */
/** @typedef {import('../types/visual-diff-types').VisualScreenshotManifestEntry} VisualScreenshotManifestEntry */

const baselineResultsPath = process.env.QA_VISUAL_BASELINE_RESULTS_PATH;
const baselineManifestPath = process.env.QA_VISUAL_BASELINE_MANIFEST_PATH;
const currentResultsPath = process.env.QA_VISUAL_CURRENT_RESULTS_PATH;
const currentManifestPath = process.env.QA_VISUAL_CURRENT_MANIFEST_PATH;
const baselineRunDir = path.resolve(process.env.QA_VISUAL_BASELINE_RUN_DIR || 'baseline');
const currentRunDir = process.env.QA_VISUAL_CURRENT_RUN_DIR ? path.resolve(process.env.QA_VISUAL_CURRENT_RUN_DIR) : '';
const outDir = path.resolve(process.env.QA_VISUAL_DIFF_OUT_DIR || path.join('qa-artifacts', 'visual-diffs', 'current'));
const summaryPath = path.resolve(process.env.QA_VISUAL_DIFF_SUMMARY_PATH || path.join(outDir, 'visual-diff-summary.json'));
const markdownPath = path.resolve(process.env.QA_VISUAL_DIFF_SUMMARY_MARKDOWN || path.join(outDir, 'visual-diff-summary.md'));
const baselineArtifactName = process.env.QA_VISUAL_BASELINE_ARTIFACT_NAME || '';
const baselineSourceSha = process.env.QA_VISUAL_BASELINE_SOURCE_SHA || '';
const shouldEnforceOutcomeFromEnv = process.env.QA_VISUAL_ENFORCE_OUTCOME !== '0';

const fileIndexCache = new Map();

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
    throw new Error(`Unable to load ${label} at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * @param {VisualBaselineResults} results
 * @returns {Map<string, VisualBaselineResults['routes'][number]>}
 */
function indexRouteResults(results) {
  return new Map((results.routes || []).map((route) => [route.id, route]));
}

/**
 * @param {VisualScreenshotManifest} manifest
 * @param {string[]} selectedRouteIds
 * @returns {Map<string, VisualScreenshotManifestEntry>}
 */
function indexManifestEntries(manifest, selectedRouteIds) {
  const selected = new Set(selectedRouteIds);
  const entries = new Map();
  for (const screenshot of manifest.screenshots || []) {
    if (!selected.has(screenshot.id)) {
      continue;
    }
    if (entries.has(screenshot.id)) {
      throw new Error(`Duplicate screenshot id ${screenshot.id} detected in visual screenshot manifest.`);
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
async function resolveImagePath(runDir, relativeImagePath) {
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
 * @param {VisualDiffSummary} summaryData
 * @returns {'clean' | 'changes-detected' | 'incomplete'}
 */
export function determineVisualDiffStatus(summaryData) {
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
 * @param {VisualDiffSummary} summaryData
 * @returns {boolean}
 */
export function shouldFailVisualDiff(summaryData) {
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
 * @param {VisualDiffSummary} summaryData
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
    'changes-detected': 'Changes detected',
    incomplete: 'Incomplete',
    skipped: 'Skipped'
  };
  const status = summaryData.status || 'incomplete';
  const statusIcon = statusIconMap[status] || '⚠️';
  const statusLabel = statusLabelMap[status] || status;
  const dimensionChanges = summaryData.dimensionChanges || [];

  const lines = [
    `# ${statusIcon} Visual Diff Summary — ${statusLabel}`,
    '',
    '| Metric | Count |',
    '|:-------|------:|',
    `| Selected routes | ${summaryData.selectedRoutes?.length || 0} |`,
    `| Matched | ${summaryData.matchedScreenshots} |`,
    `| Changed | ${summaryData.changedScreenshots} |`,
    `| Missing in baseline | ${summaryData.missingInBaseline} |`,
    `| Missing in current | ${summaryData.missingInCurrent} |`,
    `| Dimension changes | ${dimensionChanges.length} |`,
    `| Errors | ${summaryData.errors.length} |`,
    '',
    '| Setting | Value |',
    '|:--------|:------|',
    `| Diff mode | \`${summaryData.diffMode}\` |`,
    `| Threshold | ${summaryData.threshold} |`
  ];

  const metaItems = [];
  if (summaryData.baselineArtifactName) {
    metaItems.push(`Baseline: \`${summaryData.baselineArtifactName}\``);
  }
  if (summaryData.baselineSourceSha) {
    metaItems.push(`SHA: \`${summaryData.baselineSourceSha}\``);
  }
  if (metaItems.length > 0) {
    lines.push('');
    lines.push(`<sub>${metaItems.join(' · ')}</sub>`);
  }

  lines.push('');
  lines.push('## Changed screenshots');

  if (summaryData.changed.length === 0) {
    lines.push('');
    lines.push('None');
  } else {
    lines.push('');
    lines.push('| Route | Viewport | Mismatch | Pixels changed |');
    lines.push('|:------|:---------|:---------|:---------------|');
    for (const item of summaryData.changed) {
      lines.push(`| ${item.id} | ${item.viewport} | ${(item.mismatchRatio * 100).toFixed(2)}% | ${item.differentPixels}/${item.totalPixels} |`);
    }
  }

  lines.push('');
  lines.push('## Missing screenshots');
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
  lines.push('## Viewport dimension changes');
  if (dimensionChanges.length === 0) {
    lines.push('');
    lines.push('None');
  } else {
    lines.push('');
    lines.push('> Viewport dimensions changed between baseline and current capture. Pixel diff was skipped for these routes.');
    lines.push('>');
    lines.push('> **Next step:** merge this PR and re-capture the baseline on `main` to update it.');
    lines.push('');
    lines.push('| Route | Viewport | Baseline | Current |');
    lines.push('|:------|:---------|:---------|:--------|');
    for (const item of dimensionChanges) {
      lines.push(`| ${item.id} | ${item.viewport} | ${item.baselineWidth}×${item.baselineHeight} | ${item.currentWidth}×${item.currentHeight} |`);
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
  lines.push(`<sub>Baseline results: \`${summaryData.baselineResultsPath}\` · Current results: \`${summaryData.currentResultsPath}\`</sub>`);

  return lines.join('\n') + '\n';
}

/**
 * @param {VisualDiffMode} diffMode
 * @param {Pick<VisualDiffSummary, 'changedScreenshots'>} summary
 * @returns {string}
 */
export function formatVisualDiffFailureMessage(diffMode, summary) {
  if (diffMode === 'fail-on-changes') {
    return `Visual diff failed because ${summary.changedScreenshots} screenshot(s) exceeded the mismatch threshold.`;
  }
  if (diffMode === 'fail-on-incomplete') {
    return 'Visual diff failed because the comparison was incomplete.';
  }
  return 'Visual diff failed because strict mode detected changes or incomplete comparisons.';
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
 * @returns {Promise<{ summary: VisualDiffSummary, markdown: string }>}
 */
export async function generateVisualDiffReport(options = {}) {
  const { config } = await loadVisualRegressionConfig(options.configPath);
  const selectedRouteIds = selectConfiguredRoutes(
    config,
    options.routeIds || splitCommaList(process.env.QA_VISUAL_ROUTE_IDS)
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
    loadJson(resolvedBaselineResultsPath, 'baseline visual results'),
    loadJson(resolvedCurrentResultsPath, 'current visual results'),
    loadJson(resolvedBaselineManifestPath, 'baseline screenshot manifest'),
    loadJson(resolvedCurrentManifestPath, 'current screenshot manifest')
  ]);

  const baselineRouteResults = indexRouteResults(/** @type {VisualBaselineResults} */ (baselineResults));
  const currentRouteResults = indexRouteResults(/** @type {VisualBaselineResults} */ (currentResults));
  const baselineEntries = indexManifestEntries(/** @type {VisualScreenshotManifest} */ (baselineManifest), selectedRouteIds);
  const currentEntries = indexManifestEntries(/** @type {VisualScreenshotManifest} */ (currentManifest), selectedRouteIds);

  /** @type {VisualDiffSummary} */
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
      /** @type {VisualDiffErrorItem} */
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
        /** @type {VisualDiffDimensionItem} */
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

      /** @type {VisualDiffChangedItem} */
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
      /** @type {VisualDiffErrorItem} */
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

  summary.status = determineVisualDiffStatus(summary);
  summary.finishedAt = new Date().toISOString();
  summary.completed = true;

  return {
    summary,
    markdown: makeMarkdown(summary)
  };
}

/**
 * @param {Parameters<typeof generateVisualDiffReport>[0] & {
 *   outDir?: string,
 *   summaryPath?: string,
 *   markdownPath?: string,
 *   enforceOutcome?: boolean
 * }} [options]
 * @returns {Promise<void>}
 */
export async function runVisualDiffCli(options = {}) {
  const resolvedOutDir = path.resolve(options.outDir || outDir);
  const resolvedSummaryPath = path.resolve(options.summaryPath || summaryPath);
  const resolvedMarkdownPath = path.resolve(options.markdownPath || markdownPath);
  const shouldEnforceOutcome = options.enforceOutcome ?? shouldEnforceOutcomeFromEnv;

  await fs.mkdir(resolvedOutDir, { recursive: true });
  const { summary, markdown } = await generateVisualDiffReport(options);
  await Promise.all([
    fs.writeFile(resolvedSummaryPath, JSON.stringify(summary, null, 2)),
    fs.writeFile(resolvedMarkdownPath, markdown)
  ]);

  if (shouldEnforceOutcome && shouldFailVisualDiff(summary)) {
    throw new Error(formatVisualDiffFailureMessage(summary.diffMode, summary));
  }
}

const isDirectRun = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isDirectRun) {
  runVisualDiffCli().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
