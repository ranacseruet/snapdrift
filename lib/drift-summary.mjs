// @ts-check

import fs from 'node:fs/promises';
import path from 'node:path';

import { splitCommaList } from './snapdrift-config.mjs';

const DEFAULT_OUT_DIR = path.join('qa-artifacts', 'snapdrift', 'drift', 'current');

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
    '# SnapDrift Report',
    '',
    `- Status: ${status}`,
    `- Reason: ${description.markdownReason}`
  ];

  if (message) {
    lines.push(`- Details: ${message}`);
  }
  if (options.currentResultsPath) {
    lines.push(`- Current capture: \`${options.currentResultsPath}\``);
  }

  if (options.reason === 'missing_main_baseline_artifact') {
    lines.push('');
    lines.push('## Next action');
    lines.push('');
    lines.push('- Publish or refresh a SnapDrift baseline on `main`, then rerun the pull request check.');
  }

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
