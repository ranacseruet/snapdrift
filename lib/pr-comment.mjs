// @ts-check

export const PR_COMMENT_MARKER = '<!-- snapdrift-report -->';
export const LEGACY_REPORT_COMMENT_MARKER = '<!-- pr-visual-diff-summary -->';
export const PR_COMMENT_MARKERS = [PR_COMMENT_MARKER, LEGACY_REPORT_COMMENT_MARKER];
export const DEFAULT_SNAPDRIFT_REPO_URL = 'https://github.com/ranacseruet/snapdrift';
export const DEFAULT_SNAPDRIFT_ICON_URL = 'https://raw.githubusercontent.com/ranacseruet/snapdrift/main/assets/snapdrift-logo-icon.png';

/**
 * Escape characters that could break markdown table cells or inject links.
 * @param {unknown} value
 * @returns {string}
 */
function escapeMarkdown(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

const STATUS_ICONS = {
  clean: '✅',
  'changes-detected': '🟡',
  incomplete: '⚠️',
  skipped: '⏭️'
};

const STATUS_LABELS = {
  clean: 'Clean',
  'changes-detected': 'Drift detected',
  incomplete: 'Incomplete',
  skipped: 'Skipped'
};

/**
 * @param {string | undefined} value
 * @param {string} fallback
 * @returns {string}
 */
function resolveUrl(value, fallback) {
  return value && /^https?:\/\//.test(value) ? value : fallback;
}

/**
 * @param {Record<string, unknown>} summary
 * @param {{ artifactName?: string, runUrl?: string, iconUrl?: string }} [meta]
 * @returns {string}
 */
export function buildReportCommentBody(summary, meta = {}) {
  const status = /** @type {string} */ (summary.status) || 'incomplete';
  const statusIcon = STATUS_ICONS[status] || '⚠️';
  const statusLabel = STATUS_LABELS[status] || status;
  const iconUrl = resolveUrl(meta.iconUrl, DEFAULT_SNAPDRIFT_ICON_URL);
  const selectedRoutes = Array.isArray(summary.selectedRoutes)
    ? String(summary.selectedRoutes.length)
    : 'all';
  const stableCaptures = String(summary.matchedScreenshots || 0);
  const diffMode = typeof summary.diffMode === 'string' && summary.diffMode
    ? `\`${escapeMarkdown(summary.diffMode)}\``
    : 'n/a';
  const threshold = Number.isFinite(summary.threshold)
    ? String(summary.threshold)
    : 'n/a';
  const dimensionChanges = /** @type {Array<Record<string, unknown>>} */ (summary.dimensionChanges) || [];
  const errors = /** @type {Array<Record<string, unknown>>} */ (summary.errors) || [];
  const errorCount = (/** @type {unknown[]} */ (summary.errors) || []).length;

  const lines = [
    PR_COMMENT_MARKER,
    `<img src="${iconUrl}" alt="SnapDrift" width="20" height="20" />`,
    '',
    `## ${statusIcon} SnapDrift Report — ${statusLabel}`,
    '',
    '| Selected routes | Stable captures | Diff mode | Threshold |',
    '|---------------:|----------------:|:----------|----------:|',
    `| ${selectedRoutes} | ${stableCaptures} | ${diffMode} | ${threshold} |`,
    '',
    '| Signal | Count |',
    '|:-------|------:|',
    `| Drift signals | ${summary.changedScreenshots || 0} |`,
    `| Missing in baseline | ${summary.missingInBaseline || 0} |`,
    `| Missing in current capture | ${summary.missingInCurrent || 0} |`,
    `| Dimension shifts | ${dimensionChanges.length} |`
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
    for (const item of errors.slice(0, 10)) {
      lines.push(`| ${escapeMarkdown(item.id)} | ${escapeMarkdown(item.viewport)} | ${escapeMarkdown(item.message)} |`);
    }
    if (errorCount > 10) {
      lines.push('');
      lines.push(`*...and ${errorCount - 10} more*`);
    }
    lines.push('');
    lines.push('</details>');
  }

  const changed = /** @type {Array<Record<string, unknown>>} */ (summary.changed) || [];
  if (changed.length > 0) {
    lines.push('');
    lines.push('<details><summary>Drift signals</summary>');
    lines.push('');
    lines.push('| Route | Viewport | Mismatch |');
    lines.push('|:------|:---------|:---------|');
    for (const item of changed.slice(0, 20)) {
      const percentChanged = typeof item.mismatchRatio === 'number'
        ? `${(item.mismatchRatio * 100).toFixed(2)}%`
        : 'n/a';
      lines.push(`| ${escapeMarkdown(item.id)} | ${escapeMarkdown(item.viewport)} | ${percentChanged} |`);
    }
    if (changed.length > 20) {
      lines.push('');
      lines.push(`*...and ${changed.length - 20} more*`);
    }
    lines.push('');
    lines.push('</details>');
  }

  if (dimensionChanges.length > 0) {
    lines.push('');
    lines.push('<details><summary>Dimension shifts — comparison skipped</summary>');
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
  if (metaItems.length > 0) {
    lines.push('');
    lines.push(`<sub>SnapDrift · ${metaItems.join(' · ')}</sub>`);
  }

  lines.push('');
  lines.push(`<div align="right"><sub>Powered by <a href="${DEFAULT_SNAPDRIFT_REPO_URL}">SnapDrift</a></sub></div>`);

  return lines.join('\n');
}
