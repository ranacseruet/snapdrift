// @ts-check

import pngjs from 'pngjs';

import { createDimensionMismatchError } from './shared.mjs';
import { compareStrictPixels } from './strict-compare.mjs';

const { PNG } = pngjs;

/**
 * Compare two PNG image buffers pixel-by-pixel.
 * Pure function — no filesystem I/O.
 *
 * @param {Buffer} baselineBuffer - Raw PNG buffer for the baseline image.
 * @param {Buffer} currentBuffer - Raw PNG buffer for the current image.
 * @returns {import('../types/index.d.ts').CompareBuffersResult}
 * @throws {Error} If image dimensions differ.
 */
export function compareBuffers(baselineBuffer, currentBuffer) {
  const baselinePng = PNG.sync.read(baselineBuffer);
  const currentPng = PNG.sync.read(currentBuffer);

  if (baselinePng.width !== currentPng.width || baselinePng.height !== currentPng.height) {
    throw createDimensionMismatchError(baselinePng, currentPng);
  }

  const { differentPixels, totalPixels, mismatchRatio } = compareStrictPixels(baselinePng, currentPng);

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