// @ts-check
// Shim: delegates to adapter-report-md with default filesystem imageReader.

import fs from 'node:fs/promises';
import { resolveImagePath } from '@snapdrift/adapter-fs';
import { generateHtmlReport as _generateHtmlReport } from '@snapdrift/adapter-report-md';

/**
 * Default filesystem image reader — resolves image path and reads as base64.
 * @param {string} runDir
 * @param {string} imagePath
 * @returns {Promise<string | null>}
 */
async function defaultImageReader(runDir, imagePath) {
  try {
    const resolved = await resolveImagePath(runDir, imagePath);
    const buffer = await fs.readFile(resolved);
    return buffer.toString('base64');
  } catch {
    return null;
  }
}

/**
 * @param {import('../types/visual-diff-types').VisualDiffSummary} summary
 * @param {{
 *   baselineRunDir?: string,
 *   currentRunDir?: string,
 *   imageReader?: (runDir: string, imagePath: string) => Promise<string | null>
 * }} [options]
 * @returns {Promise<string>}
 */
export async function generateHtmlReport(summary, options = {}) {
  const enrichedOptions = { ...options };
  if (!enrichedOptions.imageReader && (options.baselineRunDir || options.currentRunDir)) {
    enrichedOptions.imageReader = defaultImageReader;
  }
  return _generateHtmlReport(summary, enrichedOptions);
}