// @ts-check

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadSnapdriftConfig, readFirstDefinedEnv } from './config.mjs';
import { comparePngs, resolveImagePath, loadJson, clearFileIndexCache } from './compare-files.mjs';
import {
  selectConfiguredRoutes,
  splitCommaList,
  resolveFromWorkingDirectory,
  indexManifestEntries,
  indexRouteResults,
  determineDriftStatus,
  shouldFailDriftCheck
} from '@snapdrift/manifest';
import { makeMarkdown, formatDriftFailureMessage } from '@snapdrift/adapter-report-md';

/** @typedef {import('../../manifest/types/index').VisualBaselineResults} BaselineResults */
/** @typedef {import('../../manifest/types/index').VisualDiffChangedItem} DriftChangedItem */
/** @typedef {import('../../manifest/types/index').VisualDiffDimensionItem} DriftDimensionItem */
/** @typedef {import('../../manifest/types/index').VisualDiffErrorItem} DriftErrorItem */
/** @typedef {import('../../manifest/types/index').VisualDiffSummary} DriftSummary */
/** @typedef {import('../../manifest/types/index').VisualScreenshotManifest} ScreenshotManifest */
/** @typedef {import('../../manifest/types/index').VisualScreenshotManifestEntry} ScreenshotManifestEntry */

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
  clearFileIndexCache();

  const { config } = await loadSnapdriftConfig(options.configPath);
  const selectedRouteIds = selectConfiguredRoutes(
    config,
    options.routeIds || splitCommaList(readFirstDefinedEnv(['SNAPDRIFT_ROUTE_IDS']))
  ).selectedRouteIds;

  const resolvedBaselineResultsPath = path.resolve(
    options.baselineResultsPath || readFirstDefinedEnv(['SNAPDRIFT_BASELINE_RESULTS_PATH']) || resolveFromWorkingDirectory(config, config.resultsFile)
  );
  const resolvedBaselineManifestPath = path.resolve(
    options.baselineManifestPath || readFirstDefinedEnv(['SNAPDRIFT_BASELINE_MANIFEST_PATH']) || resolveFromWorkingDirectory(config, config.manifestFile)
  );
  const resolvedCurrentResultsPath = path.resolve(
    options.currentResultsPath || readFirstDefinedEnv(['SNAPDRIFT_CURRENT_RESULTS_PATH']) || resolveFromWorkingDirectory(config, config.resultsFile)
  );
  const resolvedCurrentManifestPath = path.resolve(
    options.currentManifestPath || readFirstDefinedEnv(['SNAPDRIFT_CURRENT_MANIFEST_PATH']) || resolveFromWorkingDirectory(config, config.manifestFile)
  );
  const resolvedBaselineRunDir = path.resolve(options.baselineRunDir || readFirstDefinedEnv(['SNAPDRIFT_BASELINE_RUN_DIR']) || 'baseline');
  const resolvedCurrentRunDir = path.resolve(
    options.currentRunDir || readFirstDefinedEnv(['SNAPDRIFT_CURRENT_RUN_DIR']) || resolveFromWorkingDirectory(config, config.screenshotsRoot)
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

  const envBaselineArtifactName = readFirstDefinedEnv(['SNAPDRIFT_BASELINE_ARTIFACT_NAME']) || '';
  const envBaselineSourceSha = readFirstDefinedEnv(['SNAPDRIFT_BASELINE_SOURCE_SHA']) || '';

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
    baselineArtifactName: options.baselineArtifactName || envBaselineArtifactName || undefined,
    baselineSourceSha: options.baselineSourceSha || envBaselineSourceSha || undefined,
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
        mismatchRatio: comparison.mismatchRatio,
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
  const resolvedOutDir = path.resolve(
    options.outDir || readFirstDefinedEnv(['SNAPDRIFT_DRIFT_OUT_DIR']) || path.join('qa-artifacts', 'snapdrift', 'drift', 'current')
  );
  const resolvedSummaryPath = path.resolve(
    options.summaryPath || readFirstDefinedEnv(['SNAPDRIFT_SUMMARY_PATH']) || path.join(resolvedOutDir, 'summary.json')
  );
  const resolvedMarkdownPath = path.resolve(
    options.markdownPath || readFirstDefinedEnv(['SNAPDRIFT_SUMMARY_MARKDOWN_PATH']) || path.join(resolvedOutDir, 'summary.md')
  );
  const shouldEnforceOutcome = options.enforceOutcome ?? (readFirstDefinedEnv(['SNAPDRIFT_ENFORCE_OUTCOME']) !== '0');

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