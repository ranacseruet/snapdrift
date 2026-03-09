// @ts-check

import fs from 'node:fs/promises';
import path from 'node:path';

import { splitCommaList } from './snapdrift-config.mjs';

const DEFAULT_OUT_DIR = path.join('qa-artifacts', 'snapdrift', 'drift', 'current');
const DEFAULT_SNAPDRIFT_REPO_URL = 'https://github.com/ranacseruet/snapdrift';
const DEFAULT_SNAPDRIFT_ICON_URL = 'https://raw.githubusercontent.com/ranacseruet/snapdrift/main/assets/snapdrift-logo-icon.png';

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
 * @param {string} reason
 * @returns {{ message: string, markdownReason: string }}
 */
function describeReason(reason) {
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

/**
 * @param {{
 *   status?: 'skipped' | 'clean' | 'changes-detected' | 'incomplete',
 *   reason: string,
 *   message?: string,
 *   selectedRouteIds?: string[] | string,
 *   currentResultsPath?: string,
 *   baselineAvailable?: boolean,
 *   outDir?: string,
 *   summaryPath?: string,
 *   markdownPath?: string
 * }} options
 * @returns {Promise<{ summaryPath: string, markdownPath: string, summary: Record<string, unknown>, markdown: string }>}
 */
export async function writeDriftSummary(options) {
  const resolvedOutDir = path.resolve(options.outDir || DEFAULT_OUT_DIR);
  const resolvedSummaryPath = path.resolve(options.summaryPath || path.join(resolvedOutDir, 'summary.json'));
  const resolvedMarkdownPath = path.resolve(options.markdownPath || path.join(resolvedOutDir, 'summary.md'));
  const { summary, markdown } = buildDriftSummary(options);

  await fs.mkdir(resolvedOutDir, { recursive: true });
  await Promise.all([
    fs.writeFile(resolvedSummaryPath, `${JSON.stringify(summary, null, 2)}\n`),
    fs.writeFile(resolvedMarkdownPath, markdown)
  ]);

  return {
    summaryPath: resolvedSummaryPath,
    markdownPath: resolvedMarkdownPath,
    summary,
    markdown
  };
}
