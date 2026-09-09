// @ts-check

import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { createProvider } from './provider.mjs';

/** @typedef {import('../types/visual-diff-types').JsonObject} JsonObject */

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
 * @returns {Promise<{ results: JsonObject, manifest: JsonObject, screenshots: Array<{ filename: string, data: string }>, headSha: string }>}
 */
export async function readLocalBaselines(baselineDir) {
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
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const headSha = results.headSha || resolveHeadSha();

  return { results, manifest, screenshots, headSha };
}

/**
 * Validate that config has snap provider configuration.
 *
 * @param {import('../types/visual-diff-types').VisualRegressionConfig} config
 * @throws {Error}
 */
function requireSnapConfig(config) {
  if (!config.snap) {
    throw new Error(
      'Migration requires snap config in snapdrift.json. ' +
      'Add a "snap" section with apiKeyEnv or apiKey.'
    );
  }
}

/**
 * Run the migrate-to-snap direction — retired.
 *
 * This uploaded a pre-built local baseline bundle to
 * `POST /v1/visual/projects/:id/baselines`, but the server has never read the
 * `manifest`/`results`/`screenshots` fields that body carries: the PNGs were
 * never stored, and the manifest referenced local filenames rather than Snap
 * object keys. The request used to fail with an opaque 500 and, since
 * i2Dev-com/snap#653, is rejected outright with `400 unsupported_baseline_body`.
 *
 * `snapdrift baseline` is the supported replacement — it captures each route
 * through Snap so the pixels actually land in storage, then publishes a manifest
 * that references them (and that `--to local --from snap` can export back out).
 *
 * @param {import('../types/visual-diff-types').VisualRegressionConfig} _config
 * @param {import('../types/visual-diff-types').CliOptions} _opts
 * @returns {Promise<never>}
 * @throws {Error} Always — the direction is not supported by the Snap API.
 */
export async function runMigrateToSnap(_config, _opts) {
  throw new Error(
    'migrate-baselines --to snap is no longer supported: Snap cannot accept a pre-built local ' +
    'baseline bundle, because its screenshots are never uploaded to Snap storage and its manifest ' +
    'references local filenames rather than Snap object keys.\n' +
    'Run `snapdrift baseline` instead — it captures each route through Snap and publishes a ' +
    'baseline from the stored objects.\n' +
    'Migration in the other direction (`migrate-baselines --to local --from snap`) is unaffected.'
  );
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

  requireSnapConfig(config);
  const provider = createProvider('snap', config);
  const baselineDir = opts.baselineDir;

  /** @type {{ results: JsonObject, manifest: JsonObject, screenshots: Array<{ filename: string, data: Buffer }>, engine: { name: string, version: string } }} */
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
