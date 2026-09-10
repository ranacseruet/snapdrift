// @ts-check

import { DEFAULT_SNAPDRIFT_ICON_URL, DEFAULT_SNAPDRIFT_REPO_URL, STATUS_ICONS, STATUS_LABELS } from './constants.mjs';

/** @typedef {import('../../manifest/types/index').VisualDiffSummary} DriftSummary */
/** @typedef {import('../../manifest/types/index').VisualDiffSummary['diffMode']} DriftMode */

/**
 * @param {import('../../manifest/types/index').VisualViewport | undefined} viewport
 * @returns {string}
 */
export function formatViewport(viewport) {
  if (!viewport) return '';
  return typeof viewport === 'string' ? viewport : `${viewport.width}x${viewport.height}`;
}

/**
 * @param {{ width: number, height: number } | undefined} dimensions
 * @returns {string}
 */
function formatDimensions(dimensions) {
  return dimensions ? `${dimensions.width}×${dimensions.height}` : '—';
}

/**
 * @param {DriftSummary['changed']} changed
 * @returns {DriftSummary['changed']}
 */
function getComparisonDimensionChanges(changed) {
  return changed.filter((item) => item.comparison?.dimensionsChanged);
}

/**
 * @param {DriftSummary['changed'][number]} item
 * @returns {boolean}
 */
function hasComparisonDetails(item) {
  return Boolean(item.comparison || item.diffImagePath);
}

/**
 * @param {string | undefined} diffImagePath
 * @returns {string}
 */
function formatDiffImage(diffImagePath) {
  return diffImagePath ? `![Diff image](${diffImagePath})` : '—';
}

/**
 * @param {DriftSummary} summaryData
 * @returns {string}
 */
export function makeMarkdown(summaryData) {
  const status = summaryData.status || 'incomplete';
  const statusIcon = STATUS_ICONS[status] || '⚠️';
  const statusLabel = STATUS_LABELS[status] || status;
  const dimensionChanges = summaryData.dimensionChanges || [];
  const comparisonDimensionChanges = getComparisonDimensionChanges(summaryData.changed);
  const dimensionShiftCount = dimensionChanges.length + comparisonDimensionChanges.length;
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
    `| Dimension shifts | ${dimensionShiftCount} |`,
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
    const comparisonDetails = summaryData.changed.some(hasComparisonDetails);
    if (comparisonDetails) {
      lines.push('| Route | Viewport | Baseline | Current | Canvas | Mismatch | Pixels changed | Diff image |');
      lines.push('|:------|:---------|:---------|:--------|:-------|:---------|:---------------|:-----------|');
    } else {
      lines.push('| Route | Viewport | Mismatch | Pixels changed |');
      lines.push('|:------|:---------|:---------|:---------------|');
    }
    for (const item of summaryData.changed) {
      if (comparisonDetails) {
        lines.push(`| ${item.id} | ${formatViewport(item.viewport)} | ${formatDimensions(item.comparison?.baseline)} | ${formatDimensions(item.comparison?.current)} | ${formatDimensions(item.comparison?.canvas)} | ${(item.mismatchRatio * 100).toFixed(2)}% | ${item.differentPixels}/${item.totalPixels} | ${formatDiffImage(item.diffImagePath)} |`);
      } else {
        lines.push(`| ${item.id} | ${formatViewport(item.viewport)} | ${(item.mismatchRatio * 100).toFixed(2)}% | ${item.differentPixels}/${item.totalPixels} |`);
      }
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
  if (dimensionShiftCount === 0) {
    lines.push('');
    lines.push('None');
  } else if (comparisonDimensionChanges.length === 0) {
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
  } else {
    lines.push('');
    lines.push('> Pixel comparison included for opted-in unequal dimensions on a top-left-aligned union canvas.');
    lines.push('>');
    lines.push('> One-sided pixels count as changes, while `diff.comparisonPolicy.threshold` remains the per-route aggregation threshold.');
    lines.push('');
    lines.push('| Route | Viewport | Baseline | Current | Canvas | Diff image |');
    lines.push('|:------|:---------|:---------|:--------|:-------|:-----------|');
    for (const item of dimensionChanges) {
      lines.push(`| ${item.id} | ${formatViewport(item.viewport)} | ${item.baselineWidth}×${item.baselineHeight} | ${item.currentWidth}×${item.currentHeight} | — | — |`);
    }
    for (const item of comparisonDimensionChanges) {
      lines.push(`| ${item.id} | ${formatViewport(item.viewport)} | ${formatDimensions(item.comparison?.baseline)} | ${formatDimensions(item.comparison?.current)} | ${formatDimensions(item.comparison?.canvas)} | ${formatDiffImage(item.diffImagePath)} |`);
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
