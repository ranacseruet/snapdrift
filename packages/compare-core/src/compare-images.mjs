// @ts-check

import pngjs from 'pngjs';

const { PNG } = pngjs;

/** Maximum union-canvas size accepted by the unequal-dimension comparator. */
export const MAX_COMPARISON_PIXELS = 32 * 1024 * 1024;
const DEFAULT_HIGHLIGHT_COLOR = /** @type {const} */ ([255, 0, 0, 255]);
const IGNORE_REGION_COLOR = /** @type {const} */ ([128, 128, 128, 128]);

/**
 * Error raised when an unequal-dimension comparison would exceed the bounded
 * union canvas. The code is stable for callers that need to classify it.
 */
export class ComparisonTooLargeError extends Error {
  /** @type {'comparison_too_large'} */
  code = 'comparison_too_large';

  /**
   * @param {number} baselineWidth
   * @param {number} baselineHeight
   * @param {number} currentWidth
   * @param {number} currentHeight
   * @param {number} canvasWidth
   * @param {number} canvasHeight
   */
  constructor(baselineWidth, baselineHeight, currentWidth, currentHeight, canvasWidth, canvasHeight) {
    super(
      `comparison_too_large: union canvas ${canvasWidth}x${canvasHeight} ` +
      `(${canvasWidth * canvasHeight} pixels) exceeds the maximum of ${MAX_COMPARISON_PIXELS} pixels ` +
      `(baseline ${baselineWidth}x${baselineHeight}, current ${currentWidth}x${currentHeight}).`
    );
    this.name = 'ComparisonTooLargeError';
  }
}

/**
 * @param {number} width
 * @param {number} height
 * @param {import('../types/index.d.ts').IgnoreRegion[]} regions
 * @returns {Uint8Array | undefined}
 */
function buildIgnoreMask(width, height, regions) {
  if (regions.length === 0) return undefined;

  const ignored = new Uint8Array(width * height);
  for (const region of regions) {
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
  return ignored;
}

/**
 * Compare two PNG buffers on a top-left-aligned union canvas and generate the
 * corresponding visual diff in the same pass over the decoded pixels.
 *
 * No threshold is applied here. Callers decide whether `mismatchRatio` is
 * actionable after aggregating the returned comparison metrics.
 *
 * @param {Buffer} baselineBuffer - Raw PNG buffer for the baseline image.
 * @param {Buffer} currentBuffer - Raw PNG buffer for the current image.
 * @param {import('../types/index.d.ts').CompareImagesOptions} [options]
 * @returns {import('../types/index.d.ts').CompareImagesResult}
 * @throws {ComparisonTooLargeError} If the union canvas exceeds the limit.
 */
export function compareImages(baselineBuffer, currentBuffer, options = {}) {
  const baselinePng = PNG.sync.read(baselineBuffer);
  const currentPng = PNG.sync.read(currentBuffer);

  const canvasWidth = Math.max(baselinePng.width, currentPng.width);
  const canvasHeight = Math.max(baselinePng.height, currentPng.height);
  const unionPixels = canvasWidth * canvasHeight;
  if (unionPixels > MAX_COMPARISON_PIXELS) {
    throw new ComparisonTooLargeError(
      baselinePng.width,
      baselinePng.height,
      currentPng.width,
      currentPng.height,
      canvasWidth,
      canvasHeight
    );
  }

  const [r, g, b, a] = options.highlightColor || DEFAULT_HIGHLIGHT_COLOR;
  const ignored = buildIgnoreMask(canvasWidth, canvasHeight, options.ignoreRegions || []);
  const diffPng = new PNG({ width: canvasWidth, height: canvasHeight });
  let differentPixels = 0;
  let totalPixels = 0;

  for (let y = 0; y < canvasHeight; y++) {
    for (let x = 0; x < canvasWidth; x++) {
      const diffIndex = (y * canvasWidth + x) * 4;
      const inBaseline = x < baselinePng.width && y < baselinePng.height;
      const inCurrent = x < currentPng.width && y < currentPng.height;
      if (!inBaseline && !inCurrent) {
        continue;
      }

      if (ignored && ignored[y * canvasWidth + x]) {
        diffPng.data[diffIndex] = IGNORE_REGION_COLOR[0];
        diffPng.data[diffIndex + 1] = IGNORE_REGION_COLOR[1];
        diffPng.data[diffIndex + 2] = IGNORE_REGION_COLOR[2];
        diffPng.data[diffIndex + 3] = IGNORE_REGION_COLOR[3];
        continue;
      }

      totalPixels += 1;
      // A coordinate present on exactly one side is a changed one-sided pixel,
      // regardless of its RGBA values.
      let changed = inBaseline !== inCurrent;

      if (inBaseline && inCurrent) {
        const baselineIndex = (y * baselinePng.width + x) * 4;
        const currentIndex = (y * currentPng.width + x) * 4;
        changed =
          baselinePng.data[baselineIndex] !== currentPng.data[currentIndex] ||
          baselinePng.data[baselineIndex + 1] !== currentPng.data[currentIndex + 1] ||
          baselinePng.data[baselineIndex + 2] !== currentPng.data[currentIndex + 2] ||
          baselinePng.data[baselineIndex + 3] !== currentPng.data[currentIndex + 3];

        if (!changed) {
          diffPng.data[diffIndex] = baselinePng.data[baselineIndex];
          diffPng.data[diffIndex + 1] = baselinePng.data[baselineIndex + 1];
          diffPng.data[diffIndex + 2] = baselinePng.data[baselineIndex + 2];
          diffPng.data[diffIndex + 3] = baselinePng.data[baselineIndex + 3];
        }
      }

      if (changed) {
        differentPixels += 1;
        diffPng.data[diffIndex] = r;
        diffPng.data[diffIndex + 1] = g;
        diffPng.data[diffIndex + 2] = b;
        diffPng.data[diffIndex + 3] = a;
      }
    }
  }

  const mismatchRatio = totalPixels === 0 ? 0 : differentPixels / totalPixels;
  const dimensionsChanged = baselinePng.width !== currentPng.width || baselinePng.height !== currentPng.height;

  return {
    width: canvasWidth,
    height: canvasHeight,
    differentPixels,
    totalPixels,
    mismatchRatio,
    pct: mismatchRatio,
    pixelsChanged: differentPixels,
    diffImageBuffer: PNG.sync.write(diffPng),
    comparison: {
      baseline: { width: baselinePng.width, height: baselinePng.height },
      current: { width: currentPng.width, height: currentPng.height },
      canvas: { width: canvasWidth, height: canvasHeight },
      dimensionsChanged,
      totalPixels
    }
  };
}
