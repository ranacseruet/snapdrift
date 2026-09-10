// @ts-check

import { DEFAULT_SNAPDRIFT_REPO_URL, STATUS_ICONS, STATUS_LABELS } from './constants.mjs';

export const PR_COMMENT_MARKER = '<!-- snapdrift-report -->';
export const PR_COMMENT_MARKERS = [PR_COMMENT_MARKER];

/**
 * Escape characters that could break markdown table cells or inject links.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeMarkdown(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/`/g, '\\`');
}

/**
 * @param {{ width: number, height: number } | undefined} dimensions
 * @returns {string}
 */
function formatDimensions(dimensions) {
  return dimensions ? `${dimensions.width}×${dimensions.height}` : '—';
}

/**
 * @param {import('@snapdrift/manifest').VisualDiffChangedItem[]} changed
 * @returns {import('@snapdrift/manifest').VisualDiffChangedItem[]}
 */
function getComparisonDimensionChanges(changed) {
  return changed.filter((item) => item.comparison?.dimensionsChanged);
}

/**
 * @param {import('@snapdrift/manifest').VisualDiffChangedItem} item
 * @returns {boolean}
 */
function hasComparisonDetails(item) {
  return Boolean(item.comparison || item.diffImagePath);
}

/**
 * @param {import('@snapdrift/manifest').VisualReportSummary} summary
 * @param {{ artifactName?: string, runUrl?: string, dashboardUrl?: string, maxChangedRows?: number, maxErrorRows?: number }} [meta]
 * @returns {string}
 */
export function buildReportCommentBody(summary, meta = {}) {
  const maxChangedRows = meta.maxChangedRows ?? 20;
  const maxErrorRows = meta.maxErrorRows ?? 10;
  const status = /** @type {string} */ (summary.status) || 'incomplete';
  const statusIcon = STATUS_ICONS[status] || '⚠️';
  const statusLabel = STATUS_LABELS[status] || status;
  const dimensionChanges = summary.dimensionChanges || [];
  const changed = summary.changed || [];
  const comparisonDimensionChanges = getComparisonDimensionChanges(changed);
  const dimensionShiftCount = dimensionChanges.length + comparisonDimensionChanges.length;
  const errors = summary.errors || [];
  const errorCount = (/** @type {unknown[]} */ (summary.errors) || []).length;

  const lines = [
    PR_COMMENT_MARKER,
    `## ${statusIcon} SnapDrift Report — ${statusLabel}`,
    '',
    '| Signal | Count |',
    '|:-------|------:|',
    `| Drift signals | ${summary.changedScreenshots || 0} |`,
    `| Missing in baseline | ${summary.missingInBaseline || 0} |`,
    `| Missing in current capture | ${summary.missingInCurrent || 0} |`,
    `| Dimension shifts | ${dimensionShiftCount} |`
  ];

  if (summary.message) {
    lines.push('');
    lines.push(`> **Note:** ${escapeMarkdown(summary.message)}`);
  }

  if (errors.length > 0) {
    lines.push('');
    lines.push('<details><summary>Error details</summary>');
    lines.push('');
    lines.push('| Route | Viewport | Error |');
    lines.push('|:------|:---------|:------|');
    for (const item of errors.slice(0, maxErrorRows)) {
      lines.push(`| ${escapeMarkdown(item.id)} | ${escapeMarkdown(item.viewport)} | ${escapeMarkdown(item.message)} |`);
    }
    if (errorCount > maxErrorRows) {
      lines.push('');
      const runLinkSuffix = meta.runUrl && /^https?:\/\//.test(meta.runUrl)
        ? ` — [View full report →](${meta.runUrl})`
        : '';
      lines.push(`*...and ${errorCount - maxErrorRows} more*${runLinkSuffix}`);
    }
    lines.push('');
    lines.push('</details>');
  }

  if (changed.length > 0) {
    lines.push('');
    lines.push('<details><summary>Drift signals</summary>');
    lines.push('');
    const comparisonDetails = changed.some(hasComparisonDetails);
    if (comparisonDetails) {
      lines.push('| Route | Viewport | Baseline | Current | Canvas | Mismatch | Pixels changed | Diff image |');
      lines.push('|:------|:---------|:---------|:--------|:-------|:---------|:---------------|:-----------|');
    } else {
      lines.push('| Route | Viewport | Mismatch |');
      lines.push('|:------|:---------|:---------|');
    }
    for (const item of changed.slice(0, maxChangedRows)) {
      const percentChanged = typeof item.mismatchRatio === 'number'
        ? `${(item.mismatchRatio * 100).toFixed(2)}%`
        : 'n/a';
      if (comparisonDetails) {
        lines.push(`| ${escapeMarkdown(item.id)} | ${escapeMarkdown(item.viewport)} | ${formatDimensions(item.comparison?.baseline)} | ${formatDimensions(item.comparison?.current)} | ${formatDimensions(item.comparison?.canvas)} | ${percentChanged} | ${item.differentPixels ?? '—'}/${item.totalPixels ?? '—'} | ${item.diffImagePath ? `![Diff image](${item.diffImagePath})` : '—'} |`);
      } else {
        lines.push(`| ${escapeMarkdown(item.id)} | ${escapeMarkdown(item.viewport)} | ${percentChanged} |`);
      }
    }
    if (changed.length > maxChangedRows) {
      lines.push('');
      const runLinkSuffix = meta.runUrl && /^https?:\/\//.test(meta.runUrl)
        ? ` — [View full report →](${meta.runUrl})`
        : '';
      lines.push(`*...and ${changed.length - maxChangedRows} more*${runLinkSuffix}`);
    }
    lines.push('');
    lines.push('</details>');
  }

  if (dimensionShiftCount > 0 && comparisonDimensionChanges.length === 0) {
    lines.push('');
    lines.push('<details open><summary>Dimension shifts — comparison skipped</summary>');
    lines.push('');
    lines.push('> SnapDrift detected a dimension shift between the baseline and current capture. Pixel comparison was skipped for these routes.');
    lines.push('>');
    lines.push('> **Next step:** refresh the baseline after this change lands so SnapDrift can compare like-for-like frames.');
    lines.push('');
    lines.push('| Route | Viewport | Baseline | Current |');
    lines.push('|:------|:---------|:---------|:--------|');
    for (const item of dimensionChanges) {
      lines.push(`| ${escapeMarkdown(item.id)} | ${escapeMarkdown(item.viewport)} | ${item.baselineWidth}×${item.baselineHeight} | ${item.currentWidth}×${item.currentHeight} |`);
    }
    lines.push('');
    lines.push('</details>');
  } else if (dimensionShiftCount > 0) {
    lines.push('');
    lines.push('<details open><summary>Dimension shifts — pixel comparison included</summary>');
    lines.push('');
    lines.push('> SnapDrift compared opted-in unequal dimensions on a top-left-aligned union canvas. One-sided pixels count as changes.');
    lines.push('');
    lines.push('| Route | Viewport | Baseline | Current | Canvas | Diff image |');
    lines.push('|:------|:---------|:---------|:--------|:-------|:-----------|');
    for (const item of dimensionChanges) {
      lines.push(`| ${escapeMarkdown(item.id)} | ${escapeMarkdown(item.viewport)} | ${item.baselineWidth}×${item.baselineHeight} | ${item.currentWidth}×${item.currentHeight} | — | — |`);
    }
    for (const item of comparisonDimensionChanges) {
      lines.push(`| ${escapeMarkdown(item.id)} | ${escapeMarkdown(item.viewport)} | ${formatDimensions(item.comparison?.baseline)} | ${formatDimensions(item.comparison?.current)} | ${formatDimensions(item.comparison?.canvas)} | ${item.diffImagePath ? `![Diff image](${item.diffImagePath})` : '—'} |`);
    }
    lines.push('');
    lines.push('</details>');
  }

  const metaItems = [];
  if (meta.artifactName) {
    metaItems.push(`artifact \`${meta.artifactName}\``);
  }
  if (summary.baselineArtifactName) {
    metaItems.push(`baseline \`${summary.baselineArtifactName}\``);
  }
  if (summary.baselineSourceSha) {
    const sha = /** @type {string} */ (summary.baselineSourceSha);
    metaItems.push(`sha \`${sha.slice(0, 7)}\``);
  }
  if (meta.runUrl && /^https?:\/\//.test(meta.runUrl)) {
    metaItems.push(`[View run](${meta.runUrl})`);
  }
  if (meta.dashboardUrl && /^https?:\/\//.test(meta.dashboardUrl)) {
    metaItems.push(`[View in dashboard →](${meta.dashboardUrl})`);
  }
  if (metaItems.length > 0) {
    lines.push('');
    lines.push(`<sub>SnapDrift · ${metaItems.join(' · ')}</sub>`);
  }

  lines.push('');
  lines.push(`<div align="right"><sub>Powered by <a href="${DEFAULT_SNAPDRIFT_REPO_URL}">SnapDrift</a></sub></div>`);

  return lines.join('\n');
}
