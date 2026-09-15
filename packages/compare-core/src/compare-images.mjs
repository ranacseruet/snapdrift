// @ts-check

import pngjs from 'pngjs';

import { buildIgnoreMask, parseHighlightColor, readPngDimensions, validateIgnoreRegions } from './shared.mjs';

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
 * Compare two PNG buffers on a top-left-aligned union canvas and generate the
 * corresponding visual diff in the same pass over the decoded pixels.
 *
 * No threshold is applied here. Callers decide whether `mismatchRatio` is
 * actionable after aggregating the returned comparison metrics.
 *
 * When ignore regions cover the whole canvas, `totalPixels` is 0 and
 * `mismatchRatio` is reported as 0, so the comparison is treated as matched.
 *
 * @param {Buffer} baselineBuffer - Raw PNG buffer for the baseline image.
 * @param {Buffer} currentBuffer - Raw PNG buffer for the current image.
 * @param {import('../types/index.d.ts').CompareImagesOptions} [options]
 * @returns {import('../types/index.d.ts').CompareImagesResult}
 * @throws {ComparisonTooLargeError} If the union canvas exceeds the limit.
 */
export function compareImages(baselineBuffer, currentBuffer, options = {}) {
  const ignoreRegions = options.ignoreRegions || [];
  validateIgnoreRegions(ignoreRegions);
  const [r, g, b, a] = parseHighlightColor(options.highlightColor || DEFAULT_HIGHLIGHT_COLOR);
  const renderDiffImage = options.renderDiffImage !== false;

  // Best-effort pre-decode guard: reject oversized unions before allocating the
  // decoded RGBA buffers, which are the largest allocations in this path.
  const baselineHeader = readPngDimensions(baselineBuffer);
  const currentHeader = readPngDimensions(currentBuffer);
  if (baselineHeader && currentHeader) {
    const headerCanvasWidth = Math.max(baselineHeader.width, currentHeader.width);
    const headerCanvasHeight = Math.max(baselineHeader.height, currentHeader.height);
    if (headerCanvasWidth * headerCanvasHeight > MAX_COMPARISON_PIXELS) {
      throw new ComparisonTooLargeError(
        baselineHeader.width,
        baselineHeader.height,
        currentHeader.width,
        currentHeader.height,
        headerCanvasWidth,
        headerCanvasHeight
      );
    }
  }

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

  const dimensionsChanged = baselinePng.width !== currentPng.width || baselinePng.height !== currentPng.height;
  const comparison = {
    baseline: { width: baselinePng.width, height: baselinePng.height },
    current: { width: currentPng.width, height: currentPng.height },
    canvas: { width: canvasWidth, height: canvasHeight },
    dimensionsChanged,
    totalPixels: 0
  };

  // Fast path: identical dimensions and decoded pixels. The visual diff of an
  // unchanged image is the image itself, so the baseline buffer can be reused.
  if (!dimensionsChanged && ignoreRegions.length === 0 && baselinePng.data.equals(currentPng.data)) {
    const totalPixels = canvasWidth * canvasHeight;
    comparison.totalPixels = totalPixels;
    return {
      width: canvasWidth,
      height: canvasHeight,
      differentPixels: 0,
      totalPixels,
      mismatchRatio: 0,
      pct: 0,
      pixelsChanged: 0,
      ...(renderDiffImage ? { diffImageBuffer: baselineBuffer } : {}),
      comparison
    };
  }

  const ignored = buildIgnoreMask(canvasWidth, canvasHeight, ignoreRegions);
  const diffPng = renderDiffImage ? new PNG({ width: canvasWidth, height: canvasHeight }) : undefined;
  let differentPixels = 0;
  let totalPixels = 0;

  for (let y = 0; y < canvasHeight; y++) {
    for (let x = 0; x < canvasWidth; x++) {
      const pixelIndex = y * canvasWidth + x;
      const diffIndex = pixelIndex * 4;
      const inBaseline = x < baselinePng.width && y < baselinePng.height;
      const inCurrent = x < currentPng.width && y < currentPng.height;
      if (!inBaseline && !inCurrent) {
        continue;
      }

      if (ignored && ignored[pixelIndex]) {
        if (diffPng) {
          diffPng.data[diffIndex] = IGNORE_REGION_COLOR[0];
          diffPng.data[diffIndex + 1] = IGNORE_REGION_COLOR[1];
          diffPng.data[diffIndex + 2] = IGNORE_REGION_COLOR[2];
          diffPng.data[diffIndex + 3] = IGNORE_REGION_COLOR[3];
        }
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

        if (!changed && diffPng) {
          diffPng.data[diffIndex] = baselinePng.data[baselineIndex];
          diffPng.data[diffIndex + 1] = baselinePng.data[baselineIndex + 1];
          diffPng.data[diffIndex + 2] = baselinePng.data[baselineIndex + 2];
          diffPng.data[diffIndex + 3] = baselinePng.data[baselineIndex + 3];
        }
      }

      if (changed) {
        differentPixels += 1;
        if (diffPng) {
          diffPng.data[diffIndex] = r;
          diffPng.data[diffIndex + 1] = g;
          diffPng.data[diffIndex + 2] = b;
          diffPng.data[diffIndex + 3] = a;
        }
      }
    }
  }

  const mismatchRatio = totalPixels === 0 ? 0 : differentPixels / totalPixels;
  comparison.totalPixels = totalPixels;

  return {
    width: canvasWidth,
    height: canvasHeight,
    differentPixels,
    totalPixels,
    mismatchRatio,
    pct: mismatchRatio,
    pixelsChanged: differentPixels,
    ...(diffPng ? { diffImageBuffer: PNG.sync.write(diffPng) } : {}),
    comparison
  };
}
