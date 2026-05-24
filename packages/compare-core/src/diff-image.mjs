// @ts-check

import pngjs from 'pngjs';

const { PNG } = pngjs;

const DEFAULT_HIGHLIGHT_COLOR = /** @type {const} */ ([255, 0, 0, 255]);

/**
 * Generate a visual diff PNG buffer from two image buffers.
 * Changed pixels are highlighted with the specified color;
 * unchanged pixels retain their original color.
 *
 * Note: ignore regions are not yet supported in the diff image.
 * Pixels inside ignore regions are still highlighted as changed,
 * so the diff image may visually disagree with
 * `compareWithIgnoreRegions` metrics. Adding `ignoreRegions`
 * support (neutral mask overlay) is deferred to Phase 1b.
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
    throw new Error(
      `Dimension mismatch: baseline ${baselinePng.width}x${baselinePng.height}, current ${currentPng.width}x${currentPng.height}.`
    );
  }

  const [r, g, b, a] = options.highlightColor || DEFAULT_HIGHLIGHT_COLOR;

  const diffPng = new PNG({ width: baselinePng.width, height: baselinePng.height });

  for (let i = 0; i < baselinePng.data.length; i += 4) {
    const changed =
      baselinePng.data[i] !== currentPng.data[i] ||
      baselinePng.data[i + 1] !== currentPng.data[i + 1] ||
      baselinePng.data[i + 2] !== currentPng.data[i + 2] ||
      baselinePng.data[i + 3] !== currentPng.data[i + 3];

    if (changed) {
      diffPng.data[i] = r;
      diffPng.data[i + 1] = g;
      diffPng.data[i + 2] = b;
      diffPng.data[i + 3] = a;
    } else {
      diffPng.data[i] = baselinePng.data[i];
      diffPng.data[i + 1] = baselinePng.data[i + 1];
      diffPng.data[i + 2] = baselinePng.data[i + 2];
      diffPng.data[i + 3] = baselinePng.data[i + 3];
    }
  }

  return PNG.sync.write(diffPng);
}