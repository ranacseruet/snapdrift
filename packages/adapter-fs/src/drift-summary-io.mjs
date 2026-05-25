// @ts-check

import fs from 'node:fs/promises';
import path from 'node:path';

import { buildDriftSummary } from '@snapdrift/adapter-report-md';

const DEFAULT_OUT_DIR = path.join('qa-artifacts', 'snapdrift', 'drift', 'current');

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