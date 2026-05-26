// @ts-check

import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { createProvider } from './provider.mjs';

/**
 * Resolve the current commit HEAD SHA.
 * Tries GITHUB_SHA first, then git rev-parse HEAD.
 * @returns {string}
 */
function resolveHeadSha() {
  if (process.env.GITHUB_SHA) {
    return process.env.GITHUB_SHA;
  }
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    throw new Error(
      'Cannot resolve commit SHA. Set GITHUB_SHA or run inside a git repository.'
    );
  }
}

/**
 * Read local baseline files from a directory.
 *
 * @param {string} baselineDir
 * @returns {Promise<{ results: object, manifest: object, screenshots: Array<{ filename: string, data: string }>, headSha: string }>}
 */
async function readLocalBaselines(baselineDir) {
  const resultsPath = path.join(baselineDir, 'results.json');
  const manifestPath = path.join(baselineDir, 'manifest.json');
  const screenshotsDir = path.join(baselineDir, 'screenshots');

  let results;
  try {
    results = JSON.parse(await fs.readFile(resultsPath, 'utf-8'));
  } catch {
    throw new Error(`Cannot read baseline results: ${resultsPath}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
  } catch {
    throw new Error(`Cannot read baseline manifest: ${manifestPath}`);
  }

  const screenshots = [];
  try {
    const entries = await fs.readdir(screenshotsDir);
    for (const entry of entries) {
      if (!entry.endsWith('.png')) continue;
      const filePath = path.join(screenshotsDir, entry);
      const buffer = await fs.readFile(filePath);
      screenshots.push({
        filename: entry,
        data: buffer.toString('base64')
      });
    }
  } catch {
    // screenshots directory may not exist — that's acceptable
  }

  const headSha = results.headSha || resolveHeadSha();

  return { results, manifest, screenshots, headSha };
}

/**
 * Run the migrate-to-snap direction.
 * Reads local baselines and uploads them to Snap.
 *
 * @param {import('../types/visual-diff-types').VisualRegressionConfig} config
 * @param {import('../types/visual-diff-types').CliOptions} opts
 * @returns {Promise<void>}
 */
export async function runMigrateToSnap(config, opts) {
  process.stdout.write(`Migrating baselines to Snap ...\n`);

  const provider = createProvider('snap', config);
  const baselineDir = opts.baselineDir;

  const { results, manifest, screenshots, headSha } = await readLocalBaselines(baselineDir);

  process.stdout.write(`Found ${screenshots.length} screenshot(s) for commit ${headSha.substring(0, 8)}\n`);

  // Check idempotency — skip if baseline already exists
  const existing = await provider.checkBaselineExists(headSha);
  if (existing) {
    process.stdout.write(`Baseline already exists for commit ${headSha.substring(0, 8)}. Skipping upload.\n`);
    return;
  }

  const { uploaded, baselineId } = await provider.migrateBaselineFromLocal({
    results,
    manifest,
    screenshots,
    headSha
  });

  process.stdout.write(`Uploaded ${uploaded} screenshot(s) as baseline ${baselineId}\n`);
}

/**
 * Run the migrate-to-local direction.
 * Downloads baselines from Snap and writes them to the local directory.
 *
 * @param {import('../types/visual-diff-types').VisualRegressionConfig} config
 * @param {import('../types/visual-diff-types').CliOptions} opts
 * @returns {Promise<void>}
 */
export async function runMigrateToLocal(config, opts) {
  process.stdout.write(`Migrating baselines from Snap to local ...\n`);

  const provider = createProvider('snap', config);
  const baselineDir = opts.baselineDir;

  /** @type {{ results: object, manifest: object, screenshots: Array<{ filename: string, data: Buffer }>, engine: { name: string, version: string } }} */
  let exported;
  try {
    exported = await provider.exportBaselines();
  } catch (error) {
    // Provide a clearer message for the stub case
    if (error instanceof Error && error.message.includes('not yet available')) {
      process.stderr.write(`Error: ${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  // Engine compatibility check
  const engineName = exported.engine?.name || 'unknown';
  if (engineName !== 'snapdrift-local' && !opts.acceptCrossEngine) {
    process.stderr.write(
      `Error: Cannot import baselines captured by a different engine ("${engineName}").\n` +
      `Baselines from a different capture engine may produce different screenshots, making comparison results unreliable.\n\n` +
      `If you want to proceed anyway, re-run with --accept-cross-engine.\n` +
      `This will override the engine name to "snapdrift-local" in the imported manifest, but visual differences may occur.\n`
    );
    process.exitCode = 1;
    return;
  }

  if (engineName !== 'snapdrift-local' && opts.acceptCrossEngine) {
    process.stderr.write(
      `Warning: Overriding engine name from "${engineName}" to "snapdrift-local". Visual differences may occur.\n`
    );
    if (exported.manifest && typeof exported.manifest === 'object') {
      exported.manifest.captureProfile = exported.manifest.captureProfile || {};
      exported.manifest.captureProfile.engine = exported.manifest.captureProfile.engine || {};
      exported.manifest.captureProfile.engine.name = 'snapdrift-local';
    }
  }

  // Write files
  await fs.mkdir(baselineDir, { recursive: true });
  await fs.mkdir(path.join(baselineDir, 'screenshots'), { recursive: true });

  await fs.writeFile(path.join(baselineDir, 'results.json'), JSON.stringify(exported.results, null, 2));
  await fs.writeFile(path.join(baselineDir, 'manifest.json'), JSON.stringify(exported.manifest, null, 2));

  for (const screenshot of exported.screenshots) {
    await fs.writeFile(path.join(baselineDir, 'screenshots', screenshot.filename), screenshot.data);
  }

  // Write migration metadata for idempotency tracking
  await fs.writeFile(
    path.join(baselineDir, '.migration-metadata.json'),
    JSON.stringify({
      source: 'snap',
      migratedAt: new Date().toISOString(),
      engine: exported.engine
    }, null, 2)
  );

  process.stdout.write(`Downloaded ${exported.screenshots.length} screenshot(s) to ${baselineDir}\n`);
}