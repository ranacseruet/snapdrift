// @ts-check

import path from 'node:path';

/**
 * @typedef {{
 *   runDir: string,
 *   resultsFile: string,
 *   manifestFile: string,
 *   screenshotsDir: string,
 * }} BaselinePaths
 */

/**
 * @typedef {{
 *   workspace: string,
 *   downloadPath?: string,
 * }} ResolveBaselinePathsParams
 */

const DEFAULT_DOWNLOAD_PATH = 'snapdrift-baseline-download';

/**
 * Resolve the baseline download paths for the resolve-baseline composite action.
 *
 * `downloadPath` may be absolute (used directly) or relative to the Actions
 * workspace (prefixed with `workspace`). Returns the run dir plus the results,
 * manifest, and screenshots paths derived from it.
 *
 * @param {ResolveBaselinePathsParams} params
 * @returns {BaselinePaths}
 */
export function resolveBaselinePaths({ workspace, downloadPath }) {
  const rel = downloadPath || DEFAULT_DOWNLOAD_PATH;
  const runDir = path.isAbsolute(rel) ? rel : path.join(workspace, rel);
  const resultsFile = path.join(runDir, 'results.json');
  const manifestFile = path.join(runDir, 'manifest.json');
  const screenshotsDir = path.join(path.dirname(manifestFile), 'screenshots');
  return { runDir, resultsFile, manifestFile, screenshotsDir };
}
