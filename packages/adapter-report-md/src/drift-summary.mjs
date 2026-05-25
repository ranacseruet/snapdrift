// @ts-check

import { splitCommaList } from '@snapdrift/manifest';
import { DEFAULT_SNAPDRIFT_ICON_URL, DEFAULT_SNAPDRIFT_REPO_URL, STATUS_ICONS, STATUS_LABELS } from './constants.mjs';

/**
 * @param {string} reason
 * @returns {{ message: string, markdownReason: string }}
 */
export function describeReason(reason) {
  if (reason === 'missing_main_baseline_artifact') {
    return {
      message: 'The latest successful `main` SnapDrift baseline was not available.',
      markdownReason: 'latest successful `main` SnapDrift baseline was not available'
    };
  }

  if (reason === 'no_snapdrift_relevant_changes') {
    return {
      message: 'No drift-relevant changes were detected in this pull request.',
      markdownReason: 'no drift-relevant changes were detected in this pull request'
    };
  }

  const text = reason.replace(/_/g, ' ');
  return {
    message: text,
    markdownReason: text
  };
}

/**
 * @param {{
 *   status?: 'skipped' | 'clean' | 'changes-detected' | 'incomplete',
 *   reason: string,
 *   message?: string,
 *   selectedRouteIds?: string[] | string,
 *   currentResultsPath?: string,
 *   baselineAvailable?: boolean
 * }} options
 * @returns {{ summary: Record<string, unknown>, markdown: string }}
 */
export function buildDriftSummary(options) {
  const description = describeReason(options.reason);
  const status = options.status || 'skipped';
  const selectedRoutes = Array.isArray(options.selectedRouteIds)
    ? options.selectedRouteIds
    : splitCommaList(options.selectedRouteIds);
  const message = options.message || description.message;
  const statusIcon = STATUS_ICONS[status] || '⚠️';
  const statusLabel = STATUS_LABELS[status] || status;
  const baselineAvailable = typeof options.baselineAvailable === 'boolean'
    ? String(options.baselineAvailable)
    : 'n/a';
  const currentCapture = options.currentResultsPath
    ? `\`${options.currentResultsPath}\``
    : 'n/a';

  /** @type {Record<string, unknown>} */
  const summary = {
    status,
    reason: options.reason,
    message,
    selectedRoutes
  };

  if (typeof options.baselineAvailable === 'boolean') {
    summary.baselineAvailable = options.baselineAvailable;
  }
  if (options.currentResultsPath) {
    summary.currentResultsPath = options.currentResultsPath;
  }

  const lines = [
    `<img src="${DEFAULT_SNAPDRIFT_ICON_URL}" alt="SnapDrift" width="24" height="24" />`,
    '',
    `# ${statusIcon} SnapDrift Report — ${statusLabel}`,
    '',
    '| Selected routes | Baseline available | Current capture |',
    '|---------------:|:-------------------|:----------------|',
    `| ${selectedRoutes.length} | ${baselineAvailable} | ${currentCapture} |`
  ];

  lines.push('');
  lines.push(`> **Reason:** ${description.markdownReason}`);
  lines.push(`> **Details:** ${message}`);

  if (options.reason === 'missing_main_baseline_artifact') {
    lines.push('');
    lines.push('## Next action');
    lines.push('');
    lines.push('- Publish or refresh a SnapDrift baseline on `main`, then rerun the pull request check.');
  }

  lines.push('');
  lines.push(`<div align="right"><sub>Powered by <a href="${DEFAULT_SNAPDRIFT_REPO_URL}">SnapDrift</a></sub></div>`);

  return {
    summary,
    markdown: `${lines.join('\n')}\n`
  };
}
