// @ts-check

import pngjs from 'pngjs';

import { createDimensionMismatchError, parseHighlightColor, validateIgnoreRegions } from './shared.mjs';
import { compareStrictPixels } from './strict-compare.mjs';

const { PNG } = pngjs;

const DEFAULT_HIGHLIGHT_COLOR = /** @type {const} */ ([255, 140, 0, 255]);

/**
 * Generate a visual diff PNG buffer from two image buffers.
 * Changed pixels are highlighted with the specified color;
 * unchanged pixels retain their original color.
 * Pixels inside ignore regions are painted with a neutral semi-transparent gray.
 *
 * Both images must have identical dimensions, so there are no one-sided
 * (added/removed) pixels — `addedColor`/`removedColor` do not apply here.
 *
 * @param {Buffer} baselineBuffer - Raw PNG buffer for the baseline image.
 * @param {Buffer} currentBuffer - Raw PNG buffer for the current image.
 * @param {import('../types/index.d.ts').DiffImageOptions} [options]
 * @returns {Buffer} PNG buffer of the diff image.
 * @throws {Error} If image dimensions differ.
 */
export function generateDiffImage(baselineBuffer, currentBuffer, options = {}) {
  const baselinePng = PNG.sync.read(baselineBuffer);
  const currentPng = PNG.sync.read(currentBuffer);

  if (baselinePng.width !== currentPng.width || baselinePng.height !== currentPng.height) {
    throw createDimensionMismatchError(baselinePng, currentPng);
  }

  const highlightColor = parseHighlightColor(options.highlightColor || DEFAULT_HIGHLIGHT_COLOR);
  const ignoreRegions = options.ignoreRegions || [];
  validateIgnoreRegions(ignoreRegions);

  const result = compareStrictPixels(baselinePng, currentPng, {
    ignoreRegions,
    highlightColor,
    renderDiffImage: true
  });

  // Always re-encode, even when the decoded pixels are byte-identical: this
  // export's contract is a PNG buffer, not a pass-through of the input.
  return PNG.sync.write(/** @type {import('pngjs').PNG} */ (result.diffPng));
}
