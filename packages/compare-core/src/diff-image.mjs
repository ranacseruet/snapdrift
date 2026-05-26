// @ts-check

import pngjs from 'pngjs';

const { PNG } = pngjs;

const DEFAULT_HIGHLIGHT_COLOR = /** @type {const} */ ([255, 0, 0, 255]);
const IGNORE_REGION_COLOR = /** @type {const} */ ([128, 128, 128, 128]);

/**
 * Generate a visual diff PNG buffer from two image buffers.
 * Changed pixels are highlighted with the specified color;
 * unchanged pixels retain their original color.
 * Pixels inside ignore regions are overlaid with a neutral semi-transparent gray.
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
  const width = baselinePng.width;
  const height = baselinePng.height;
  const ignoreRegions = options.ignoreRegions || [];

  let ignored;
  if (ignoreRegions.length > 0) {
    ignored = new Uint8Array(width * height);
    for (const region of ignoreRegions) {
      const xStart = Math.max(0, region.x);
      const yStart = Math.max(0, region.y);
      const xEnd = Math.min(width, region.x + region.width);
      const yEnd = Math.min(height, region.y + region.height);
      for (let y = yStart; y < yEnd; y++) {
        for (let x = xStart; x < xEnd; x++) {
          ignored[y * width + x] = 1;
        }
      }
    }
  }

  const diffPng = new PNG({ width, height });

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;

      if (ignored && ignored[y * width + x]) {
        diffPng.data[i] = IGNORE_REGION_COLOR[0];
        diffPng.data[i + 1] = IGNORE_REGION_COLOR[1];
        diffPng.data[i + 2] = IGNORE_REGION_COLOR[2];
        diffPng.data[i + 3] = IGNORE_REGION_COLOR[3];
        continue;
      }

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
  }

  return PNG.sync.write(diffPng);
}