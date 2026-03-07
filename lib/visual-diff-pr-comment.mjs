// @ts-check

export const PR_COMMENT_MARKER = '<!-- pr-visual-diff-summary -->';

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
  'changes-detected': 'Changes detected',
  incomplete: 'Incomplete',
  skipped: 'Skipped'
};

/**
 * @param {Record<string, unknown>} summary
 * @param {{ artifactName?: string, runUrl?: string }} [meta]
 * @returns {string}
 */
export function buildPrCommentBody(summary, meta = {}) {
  const status = /** @type {string} */ (summary.status) || 'incomplete';
  const statusIcon = STATUS_ICONS[status] || '⚠️';
  const statusLabel = STATUS_LABELS[status] || status;
  const selectedRoutes = Array.isArray(summary.selectedRoutes)
    ? String(summary.selectedRoutes.length)
    : 'all';
  const dimensionChanges = /** @type {Array<Record<string, unknown>>} */ (summary.dimensionChanges) || [];
  const errorCount = (/** @type {unknown[]} */ (summary.errors) || []).length;

  const lines = [
    PR_COMMENT_MARKER,
    `## ${statusIcon} Visual Diff — ${statusLabel}`,
    '',
    '| Metric | Count |',
    '|:-------|------:|',
    `| Selected routes | ${selectedRoutes} |`,
    `| Matched | ${summary.matchedScreenshots || 0} |`,
    `| Changed | ${summary.changedScreenshots || 0} |`,
    `| Missing in baseline | ${summary.missingInBaseline || 0} |`,
    `| Missing in current | ${summary.missingInCurrent || 0} |`,
    `| Dimension changes | ${dimensionChanges.length} |`,
    `| Errors | ${errorCount} |`
  ];

  if (summary.message) {
    lines.push('');
    lines.push(`> **Note:** ${escapeMarkdown(summary.message)}`);
  }

  const changed = /** @type {Array<Record<string, unknown>>} */ (summary.changed) || [];
  if (changed.length > 0) {
    lines.push('');
    lines.push('<details><summary>Changed screenshots</summary>');
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
    lines.push('<details><summary>Viewport dimension changes — diff skipped</summary>');
    lines.push('');
    lines.push('> The page dimensions changed between the baseline and the current capture. Pixel diff was skipped for these routes.');
    lines.push('>');
    lines.push('> **Next step:** merge this PR and let the main CI re-capture the baseline with the new dimensions.');
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
    metaItems.push(`Artifact: \`${meta.artifactName}\``);
  }
  if (summary.baselineArtifactName) {
    metaItems.push(`Baseline: \`${summary.baselineArtifactName}\``);
  }
  if (summary.baselineSourceSha) {
    const sha = /** @type {string} */ (summary.baselineSourceSha);
    metaItems.push(`Baseline SHA: \`${sha.slice(0, 7)}\``);
  }
  if (meta.runUrl && /^https?:\/\//.test(meta.runUrl)) {
    metaItems.push(`[View run](${meta.runUrl})`);
  }
  if (metaItems.length > 0) {
    lines.push('');
    lines.push(`<sub>${metaItems.join(' · ')}</sub>`);
  }

  return lines.join('\n');
}
