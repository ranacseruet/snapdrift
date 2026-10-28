// @ts-check

import pngjs from 'pngjs';

import { createDimensionMismatchError, validateIgnoreRegions } from './shared.mjs';
import { compareStrictPixels } from './strict-compare.mjs';

const { PNG } = pngjs;

/**
 * Compare two PNG image buffers, masking out ignore regions before counting differences.
 * Pixels within ignore regions are excluded from both `totalPixels` and `differentPixels`.
 *
 * @param {Buffer} baselineBuffer - Raw PNG buffer for the baseline image.
 * @param {Buffer} currentBuffer - Raw PNG buffer for the current image.
 * @param {import('../types/index.d.ts').IgnoreRegion[]} regions - Rectangular regions to ignore.
 * @returns {import('../types/index.d.ts').CompareBuffersResult}
 * @throws {Error} If image dimensions differ.
 */
export function compareWithIgnoreRegions(baselineBuffer, currentBuffer, regions) {
  validateIgnoreRegions(regions);

  const baselinePng = PNG.sync.read(baselineBuffer);
  const currentPng = PNG.sync.read(currentBuffer);

  if (baselinePng.width !== currentPng.width || baselinePng.height !== currentPng.height) {
    throw createDimensionMismatchError(baselinePng, currentPng);
  }

  const { differentPixels, totalPixels, mismatchRatio } = compareStrictPixels(baselinePng, currentPng, { ignoreRegions: regions });

  return {
    width: baselinePng.width,
    height: baselinePng.height,
    differentPixels,
    totalPixels,
    mismatchRatio,
    pct: mismatchRatio,
    pixelsChanged: differentPixels
  };
}
