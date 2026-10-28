// @ts-check

import pngjs from 'pngjs';

import { buildIgnoreMask } from './shared.mjs';

const { PNG } = pngjs;

const DEFAULT_HIGHLIGHT_COLOR = /** @type {const} */ ([255, 140, 0, 255]);
const IGNORE_REGION_COLOR = /** @type {const} */ ([128, 128, 128, 128]);

/**
 * The one strict pixel loop shared by `compareBuffers`,
 * `compareWithIgnoreRegions`, and `generateDiffImage`.
 *
 * Callers decode both PNGs and reject dimension mismatches in their own
 * contract order before calling this helper, so it assumes equal dimensions.
 * Pixels inside ignore regions are excluded from `totalPixels` and
 * `differentPixels`. Equality compares all four RGBA channels, including hidden
 * RGB on fully transparent pixels (issue #201 deliberately leaves that
 * semantics unchanged). Diff painting uses only `highlightColor` for changed
 * pixels, the neutral gray for ignored pixels, and the baseline color for
 * unchanged pixels; there are no added/removed colors for equal dimensions.
 *
 * @param {{ data: Buffer, width: number, height: number }} baselinePng
 * @param {{ data: Buffer, width: number, height: number }} currentPng
 * @param {{
 *   ignoreRegions?: import('../types/index.d.ts').IgnoreRegion[],
 *   highlightColor?: [number, number, number, number],
 *   renderDiffImage?: boolean
 * }} [options]
 * @returns {{
 *   differentPixels: number,
 *   totalPixels: number,
 *   mismatchRatio: number,
 *   diffPng?: import('pngjs').PNG
 * }}
 */
export function compareStrictPixels(baselinePng, currentPng, options = {}) {
  const width = baselinePng.width;
  const height = baselinePng.height;
  const ignoreRegions = options.ignoreRegions || [];
  const ignored = buildIgnoreMask(width, height, ignoreRegions);
  const renderDiffImage = options.renderDiffImage === true;
  const [r, g, b, a] = options.highlightColor || DEFAULT_HIGHLIGHT_COLOR;
  const diffPng = renderDiffImage ? new PNG({ width, height }) : undefined;

  if (baselinePng.data.equals(currentPng.data) && !ignored && !diffPng) {
    const totalPixels = width * height;
    return {
      differentPixels: 0,
      totalPixels,
      mismatchRatio: 0
    };
  }

  let differentPixels = 0;
  let totalPixels = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixelIndex = y * width + x;
      const i = pixelIndex * 4;

      if (ignored && ignored[pixelIndex]) {
        if (diffPng) {
          diffPng.data[i] = IGNORE_REGION_COLOR[0];
          diffPng.data[i + 1] = IGNORE_REGION_COLOR[1];
          diffPng.data[i + 2] = IGNORE_REGION_COLOR[2];
          diffPng.data[i + 3] = IGNORE_REGION_COLOR[3];
        }
        continue;
      }

      totalPixels += 1;
      const changed =
        baselinePng.data[i] !== currentPng.data[i] ||
        baselinePng.data[i + 1] !== currentPng.data[i + 1] ||
        baselinePng.data[i + 2] !== currentPng.data[i + 2] ||
        baselinePng.data[i + 3] !== currentPng.data[i + 3];

      if (changed) {
        differentPixels += 1;
        if (diffPng) {
          diffPng.data[i] = r;
          diffPng.data[i + 1] = g;
          diffPng.data[i + 2] = b;
          diffPng.data[i + 3] = a;
        }
      } else if (diffPng) {
        diffPng.data[i] = baselinePng.data[i];
        diffPng.data[i + 1] = baselinePng.data[i + 1];
        diffPng.data[i + 2] = baselinePng.data[i + 2];
        diffPng.data[i + 3] = baselinePng.data[i + 3];
      }
    }
  }

  const mismatchRatio = totalPixels === 0 ? 0 : differentPixels / totalPixels;
  return {
    differentPixels,
    totalPixels,
    mismatchRatio,
    ...(diffPng ? { diffPng } : {})
  };
}
