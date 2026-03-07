// @ts-check

import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * @param {'baseline' | 'diff'} artifactType
 * @returns {string}
 */
export function getDefaultVisualArtifactBundleDir(artifactType) {
  return artifactType === 'baseline'
    ? path.join('qa-artifacts', 'visual-baseline-artifact')
    : path.join('qa-artifacts', 'visual-diff-artifact');
}

/**
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string | undefined} sourcePath
 * @param {string} targetPath
 * @returns {Promise<void>}
 */
async function copyFileIfPresent(sourcePath, targetPath) {
  if (!sourcePath) {
    return;
  }

  if (!(await exists(sourcePath))) {
    return;
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.copyFile(sourcePath, targetPath);
}

/**
 * @param {string} sourceDir
 * @param {string} targetDir
 * @returns {Promise<void>}
 */
async function copyPngFiles(sourceDir, targetDir) {
  if (!(await exists(sourceDir))) {
    return;
  }

  await fs.mkdir(targetDir, { recursive: true });
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    if (entry.isDirectory()) {
      await copyPngFiles(sourcePath, targetDir);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.png')) {
      continue;
    }
    await fs.copyFile(sourcePath, path.join(targetDir, entry.name));
  }
}

/**
 * @param {{
 *   artifactType: 'baseline' | 'diff',
 *   bundleDir?: string,
 *   resultsPath?: string,
 *   manifestPath?: string,
 *   screenshotsDir?: string,
 *   summaryJsonPath?: string,
 *   summaryMarkdownPath?: string,
 *   baselineResultsPath?: string,
 *   currentResultsPath?: string,
 *   baselineManifestPath?: string,
 *   currentManifestPath?: string,
 *   baselineScreenshotsDir?: string,
 *   currentScreenshotsDir?: string
 * }} options
 * @returns {Promise<{ bundleDir: string }>}
 */
export async function stageVisualArtifacts(options) {
  const resolvedBundleDir = path.resolve(options.bundleDir || getDefaultVisualArtifactBundleDir(options.artifactType));

  await fs.rm(resolvedBundleDir, { recursive: true, force: true });

  if (options.artifactType === 'baseline') {
    await fs.mkdir(path.join(resolvedBundleDir, 'screenshots'), { recursive: true });
    await copyFileIfPresent(options.resultsPath, path.join(resolvedBundleDir, 'visual-baseline-results.json'));
    await copyFileIfPresent(options.manifestPath, path.join(resolvedBundleDir, 'visual-screenshot-manifest.json'));
    if (options.screenshotsDir) {
      await copyPngFiles(options.screenshotsDir, path.join(resolvedBundleDir, 'screenshots'));
    }
  } else {
    await fs.mkdir(path.join(resolvedBundleDir, 'baseline-screenshots'), { recursive: true });
    await fs.mkdir(path.join(resolvedBundleDir, 'current-screenshots'), { recursive: true });
    await copyFileIfPresent(options.summaryJsonPath, path.join(resolvedBundleDir, 'visual-diff-summary.json'));
    await copyFileIfPresent(options.summaryMarkdownPath, path.join(resolvedBundleDir, 'visual-diff-summary.md'));
    await copyFileIfPresent(options.baselineResultsPath, path.join(resolvedBundleDir, 'baseline-results.json'));
    await copyFileIfPresent(options.currentResultsPath, path.join(resolvedBundleDir, 'current-results.json'));
    await copyFileIfPresent(options.baselineManifestPath, path.join(resolvedBundleDir, 'baseline-screenshot-manifest.json'));
    await copyFileIfPresent(options.currentManifestPath, path.join(resolvedBundleDir, 'current-screenshot-manifest.json'));

    if (options.baselineScreenshotsDir) {
      await copyPngFiles(options.baselineScreenshotsDir, path.join(resolvedBundleDir, 'baseline-screenshots'));
    }
    if (options.currentScreenshotsDir) {
      await copyPngFiles(options.currentScreenshotsDir, path.join(resolvedBundleDir, 'current-screenshots'));
    }
  }

  return {
    bundleDir: resolvedBundleDir
  };
}
