// @ts-check

/** @typedef {import('../types/index.d.ts').VisualDiffSummary} DriftSummary */

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