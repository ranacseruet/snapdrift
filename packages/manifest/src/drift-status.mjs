// @ts-check

/** @typedef {import('../types/index.d.ts').VisualDiffSummary} DriftSummary */
/** @typedef {import('../types/index.d.ts').VisualDriftSkippedSummary} DriftSkippedSummary */

/**
 * True when the summary reports something that leaves the run incomplete —
 * an error, a dimension change, or a screenshot missing on either side.
 *
 * @param {Partial<DriftSummary>} summaryData
 * @returns {boolean}
 */
function hasIncompleteSignal(summaryData) {
  return (
    (summaryData.errors || []).length > 0 ||
    (summaryData.dimensionChanges || []).length > 0 ||
    (summaryData.missingInBaseline || 0) > 0 ||
    (summaryData.missingInCurrent || 0) > 0
  );
}

/**
 * @param {Partial<DriftSummary>} summaryData
 * @returns {'clean' | 'changes-detected' | 'incomplete'}
 */
export function determineDriftStatus(summaryData) {
  if (hasIncompleteSignal(summaryData)) {
    return 'incomplete';
  }
  if ((summaryData.changedScreenshots || 0) > 0) {
    return 'changes-detected';
  }
  return 'clean';
}

/**
 * A skipped summary — written by `writeDriftSummary` for scope skips, missing
 * baselines, and Snap outages — carries only `status`, `reason`, `message` and
 * `selectedRoutes`. There is no diff to enforce against, so it never fails.
 *
 * @param {Partial<DriftSummary> | DriftSkippedSummary} summaryData
 * @returns {boolean}
 */
export function shouldFailDriftCheck(summaryData) {
  // Narrowing on `status` takes the skipped shape out of the union, so the
  // counter reads below only ever see a (partial) diff summary.
  if (summaryData.status === 'skipped' || !summaryData.diffMode) {
    return false;
  }
  if (summaryData.diffMode === 'report-only') {
    return false;
  }
  if (summaryData.diffMode === 'fail-on-changes') {
    return (summaryData.changedScreenshots || 0) > 0;
  }
  if (summaryData.diffMode === 'fail-on-incomplete') {
    return hasIncompleteSignal(summaryData);
  }
  return (summaryData.changedScreenshots || 0) > 0 || hasIncompleteSignal(summaryData);
}