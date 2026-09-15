// @ts-check

import pngjs from 'pngjs';

import { buildIgnoreMask, createDimensionMismatchError, validateIgnoreRegions } from './shared.mjs';

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

  const width = baselinePng.width;
  const height = baselinePng.height;
  const ignored = buildIgnoreMask(width, height, regions);

  let differentPixels = 0;
  let totalPixels = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (ignored && ignored[y * width + x]) {
        continue;
      }
      totalPixels += 1;
      const i = (y * width + x) * 4;
      if (
        baselinePng.data[i] !== currentPng.data[i] ||
        baselinePng.data[i + 1] !== currentPng.data[i + 1] ||
        baselinePng.data[i + 2] !== currentPng.data[i + 2] ||
        baselinePng.data[i + 3] !== currentPng.data[i + 3]
      ) {
        differentPixels += 1;
      }
    }
  }

  const mismatchRatio = totalPixels === 0 ? 0 : differentPixels / totalPixels;

  return {
    width,
    height,
    differentPixels,
    totalPixels,
    mismatchRatio,
    pct: mismatchRatio,
    pixelsChanged: differentPixels
  };
}
