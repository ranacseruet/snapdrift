// @ts-check
/**
 * Diagnostic for issue #178. Prints the piecewise offset-run mapping and the
 * live policy v2 comparison for a PNG pair.
 *
 * The mapper lives in `src/offset-align.mjs`. This script does not seed the
 * search with a known shift.
 *
 * Usage (from the repository root):
 *   node packages/compare-core/scripts/measure-offset-runs.mjs \
 *     packages/compare-core/tests/fixtures/insertion-shift/baseline.png \
 *     packages/compare-core/tests/fixtures/insertion-shift/current.png
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import pngjs from 'pngjs';
import { compareImages } from '../src/index.mjs';
import { analyzeOffsetRuns } from '../src/offset-align.mjs';

const { PNG } = pngjs;

/**
 * @param {Buffer} buffer
 * @returns {string}
 */
function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

const baselinePath = process.argv[2];
const currentPath = process.argv[3];
if (!baselinePath || !currentPath) {
  console.error('usage: node measure-offset-runs.mjs <baseline.png> <current.png>');
  process.exit(1);
}

const baselineBuffer = await fs.readFile(baselinePath);
const currentBuffer = await fs.readFile(currentPath);
const regressionStarted = performance.now();
const regression = compareImages(baselineBuffer, currentBuffer, { alignment: 'vertical', renderDiffImage: false });
const regressionMs = performance.now() - regressionStarted;

const baselinePng = PNG.sync.read(baselineBuffer);
const currentPng = PNG.sync.read(currentBuffer);
const mapping = analyzeOffsetRuns(baselinePng, currentPng);

console.log(JSON.stringify({
  fixtures: {
    baseline: { path: baselinePath, sha256: sha256(baselineBuffer), width: baselinePng.width, height: baselinePng.height },
    current: { path: currentPath, sha256: sha256(currentBuffer), width: currentPng.width, height: currentPng.height }
  },
  comparison: {
    elapsedMs: regressionMs,
    mode: regression.comparison.mode,
    fallbackReason: regression.comparison.fallbackReason,
    mismatchRatio: regression.mismatchRatio,
    differentPixels: regression.differentPixels,
    totalPixels: regression.totalPixels
  },
  mapping: mapping.kind === 'mapped'
    ? {
        scoreMs: mapping.scoreMs,
        contentIntervalCount: mapping.contentIntervals.length,
        contentIntervals: mapping.contentIntervals
      }
    : mapping
}, null, 2));
