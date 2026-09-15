// @ts-check

import pngjs from 'pngjs';

import { createDimensionMismatchError } from './shared.mjs';

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

  const totalPixels = baselinePng.width * baselinePng.height;

  if (baselinePng.data.equals(currentPng.data)) {
    return {
      width: baselinePng.width,
      height: baselinePng.height,
      differentPixels: 0,
      totalPixels,
      mismatchRatio: 0,
      pct: 0,
      pixelsChanged: 0
    };
  }

  let differentPixels = 0;
  for (let index = 0; index < baselinePng.data.length; index += 4) {
    if (
      baselinePng.data[index] !== currentPng.data[index] ||
      baselinePng.data[index + 1] !== currentPng.data[index + 1] ||
      baselinePng.data[index + 2] !== currentPng.data[index + 2] ||
      baselinePng.data[index + 3] !== currentPng.data[index + 3]
    ) {
      differentPixels += 1;
    }
  }

  const mismatchRatio = totalPixels === 0 ? 0 : differentPixels / totalPixels;

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