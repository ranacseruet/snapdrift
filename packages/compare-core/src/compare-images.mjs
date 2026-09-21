// @ts-check

import pngjs from 'pngjs';

import { buildIgnoreMask, parseHighlightColor, readPngDimensions, validateIgnoreRegions } from './shared.mjs';
import { alignRows } from './vertical-align.mjs';

const { PNG } = pngjs;

/**
 * Default maximum union-canvas size accepted by the unequal-dimension
 * comparator.
 *
 * This is a *process memory* bound, not a property of the algorithm. The
 * comparison holds both decoded RGBA inputs (4 bytes per pixel each) plus, when
 * `renderDiffImage` is enabled (the default), a union-sized diff canvas —
 * at least ~12 bytes per union pixel when both inputs approach the union
 * dimensions, before PNG decode/encode overhead. End-to-end RSS measured on
 * real full-page captures runs ~32-35 bytes per union pixel: ~1.16 GB at 33.8 M
 * pixels and ~3.37 GB at 103.9 M. Callers running in a larger memory envelope
 * (e.g. a dedicated diff Lambda) may pass a higher `maxPixels`; callers sharing a
 * small host must keep this default and should size against their own
 * measurement, not this arithmetic. See `CompareImagesOptions.maxPixels`.
 */
export const MAX_COMPARISON_PIXELS = 32 * 1024 * 1024;
const DEFAULT_HIGHLIGHT_COLOR = /** @type {const} */ ([255, 140, 0, 255]);
const DEFAULT_ADDED_COLOR = /** @type {const} */ ([0, 170, 0, 255]);
const DEFAULT_REMOVED_COLOR = /** @type {const} */ ([255, 0, 0, 255]);
const IGNORE_REGION_COLOR = /** @type {const} */ ([128, 128, 128, 128]);

/**
 * Resolve the effective union-canvas ceiling for a comparison.
 *
 * A missing, non-finite, or sub-1 override falls back to the default so a
 * misconfigured caller cannot accidentally remove the guard (which would let a
 * single tall image OOM the process) or set a ceiling that rejects every
 * comparison. The value is floored *before* the check: a positive fraction such
 * as `0.5` floors to `0`, which would otherwise pass a `<= 0` guard.
 *
 * @param {number | undefined} maxPixels
 * @returns {number}
 */
function resolveMaxPixels(maxPixels) {
  if (typeof maxPixels !== 'number' || !Number.isFinite(maxPixels)) {
    return MAX_COMPARISON_PIXELS;
  }
  const floored = Math.floor(maxPixels);
  return floored >= 1 ? floored : MAX_COMPARISON_PIXELS;
}

/**
 * Compare decoded pixel buffers without requiring callers or test doubles to
 * provide Node's Buffer#equals method.
 *
 * @param {Uint8Array} left
 * @param {Uint8Array} right
 * @returns {boolean}
 */
function pixelDataEqual(left, right) {
  const leftWithEquals = /** @type {Uint8Array & { equals?: (value: Uint8Array) => boolean }} */ (left);
  if (typeof leftWithEquals.equals === 'function') return leftWithEquals.equals(right);
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

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
   * @param {number} [maxPixels] - The ceiling that was exceeded.
   */
  constructor(baselineWidth, baselineHeight, currentWidth, currentHeight, canvasWidth, canvasHeight, maxPixels = MAX_COMPARISON_PIXELS) {
    super(
      `comparison_too_large: union canvas ${canvasWidth}x${canvasHeight} ` +
      `(${canvasWidth * canvasHeight} pixels) exceeds the maximum of ${maxPixels} pixels ` +
      `(baseline ${baselineWidth}x${baselineHeight}, current ${currentWidth}x${currentHeight}).`
    );
    this.name = 'ComparisonTooLargeError';
  }
}

/**
 * Compare two equal-width images after aligning their rows. The result uses
 * one output row for every matched, changed, inserted, or deleted source row.
 *
 * @param {{ data: Uint8Array, width: number, height: number }} baselinePng
 * @param {{ data: Uint8Array, width: number, height: number }} currentPng
 * @param {{
 *   renderDiffImage: boolean,
 *   changedColor: [number, number, number, number],
 *   addedColor: [number, number, number, number],
 *   removedColor: [number, number, number, number],
 *   maxPixels: number
 * }} options
 * @returns {{ kind: 'aligned', result: CompareImagesImplementationResult } | { kind: 'fallback', reason: string }}
 */
function compareAlignedImages(baselinePng, currentPng, options) {
  const alignment = alignRows(baselinePng, currentPng);
  if (alignment.kind === 'fallback') {
    return alignment;
  }

  const canvasWidth = baselinePng.width;
  const canvasHeight = alignment.height;
  if (canvasWidth * canvasHeight > options.maxPixels) {
    throw new ComparisonTooLargeError(
      baselinePng.width,
      baselinePng.height,
      currentPng.width,
      currentPng.height,
      canvasWidth,
      canvasHeight,
      options.maxPixels
    );
  }

  const comparison = /** @type {import('../types/index.d.ts').ComparisonMetadata} */ ({
    baseline: { width: baselinePng.width, height: baselinePng.height },
    current: { width: currentPng.width, height: currentPng.height },
    canvas: { width: canvasWidth, height: canvasHeight },
    dimensionsChanged: baselinePng.width !== currentPng.width || baselinePng.height !== currentPng.height,
    totalPixels: 0,
    policyVersion: 2,
    mode: /** @type {const} */ ('vertical-aligned'),
    rowMapping: alignment.segments
  });
  const diffPng = options.renderDiffImage ? new PNG({ width: canvasWidth, height: canvasHeight }) : undefined;
  let differentPixels = 0;
  let totalPixels = 0;

  for (const segment of alignment.segments) {
    for (let offset = 0; offset < segment.length; offset++) {
      const outputY = segment.outputStart + offset;
      const baselineY = segment.baselineStart === undefined ? undefined : segment.baselineStart + offset;
      const currentY = segment.currentStart === undefined ? undefined : segment.currentStart + offset;
      totalPixels += canvasWidth;

      for (let x = 0; x < canvasWidth; x++) {
        const outputIndex = (outputY * canvasWidth + x) * 4;
        const baselineIndex = baselineY === undefined ? -1 : (baselineY * canvasWidth + x) * 4;
        const currentIndex = currentY === undefined ? -1 : (currentY * canvasWidth + x) * 4;
        const changed = segment.kind !== 'matched' && (
          segment.kind === 'inserted' ||
          segment.kind === 'deleted' ||
          baselinePng.data[baselineIndex] !== currentPng.data[currentIndex] ||
          baselinePng.data[baselineIndex + 1] !== currentPng.data[currentIndex + 1] ||
          baselinePng.data[baselineIndex + 2] !== currentPng.data[currentIndex + 2] ||
          baselinePng.data[baselineIndex + 3] !== currentPng.data[currentIndex + 3]
        );

        if (changed) {
          differentPixels += 1;
        }
        if (!diffPng) continue;

        const color = segment.kind === 'inserted'
          ? options.addedColor
          : segment.kind === 'deleted'
            ? options.removedColor
            : changed
              ? options.changedColor
              : undefined;
        if (color) {
          diffPng.data[outputIndex] = color[0];
          diffPng.data[outputIndex + 1] = color[1];
          diffPng.data[outputIndex + 2] = color[2];
          diffPng.data[outputIndex + 3] = color[3];
        } else {
          const sourceIndex = currentIndex >= 0 ? currentIndex : baselineIndex;
          diffPng.data[outputIndex] = sourceIndex >= 0 ? (currentIndex >= 0 ? currentPng.data[sourceIndex] : baselinePng.data[sourceIndex]) : 0;
          diffPng.data[outputIndex + 1] = sourceIndex >= 0 ? (currentIndex >= 0 ? currentPng.data[sourceIndex + 1] : baselinePng.data[sourceIndex + 1]) : 0;
          diffPng.data[outputIndex + 2] = sourceIndex >= 0 ? (currentIndex >= 0 ? currentPng.data[sourceIndex + 2] : baselinePng.data[sourceIndex + 2]) : 0;
          diffPng.data[outputIndex + 3] = sourceIndex >= 0 ? (currentIndex >= 0 ? currentPng.data[sourceIndex + 3] : baselinePng.data[sourceIndex + 3]) : 0;
        }
      }
    }
  }

  const mismatchRatio = totalPixels === 0 ? 0 : differentPixels / totalPixels;
  comparison.totalPixels = totalPixels;
  return {
    kind: 'aligned',
    result: {
      width: canvasWidth,
      height: canvasHeight,
      differentPixels,
      totalPixels,
      mismatchRatio,
      pct: mismatchRatio,
      pixelsChanged: differentPixels,
      ...(diffPng ? { diffImageBuffer: PNG.sync.write(diffPng) } : {}),
      comparison
    }
  };
}

/**
 * @typedef {import('../types/index.d.ts').CompareResult & {
 *   comparison: import('../types/index.d.ts').ComparisonMetadata,
 *   diffImageBuffer?: Buffer
 * }} CompareImagesImplementationResult
 */

/**
 * Compare two PNG buffers and generate the corresponding visual diff in the
 * same pass over the decoded pixels. The default is the v1 top-left-aligned
 * union canvas; callers can opt into `alignment: 'vertical'` for policy v2.
 *
 * No threshold is applied here. Callers decide whether `mismatchRatio` is
 * actionable after aggregating the returned comparison metrics.
 *
 * Diff rendering is semantic: pixels present only in the current image are
 * additions (green by default), pixels present only in the baseline image are
 * removals (red by default), and overlapping pixels that differ use
 * `highlightColor` (orange by default). One-sided pixels still count as
 * changed in the metrics, matching comparison policy v1.
 *
 * When ignore regions cover the whole canvas, `totalPixels` is 0 and
 * `mismatchRatio` is reported as 0, so the comparison is treated as matched.
 *
 * @overload
 * @param {Buffer} baselineBuffer - Raw PNG buffer for the baseline image.
 * @param {Buffer} currentBuffer - Raw PNG buffer for the current image.
 * @param {import('../types/index.d.ts').CompareImagesOptions & { renderDiffImage: false }} options
 * @returns {import('../types/index.d.ts').CompareImagesMetricsResult}
 */
/**
 * Renders and returns the visual diff (default).
 * @overload
 * @param {Buffer} baselineBuffer - Raw PNG buffer for the baseline image.
 * @param {Buffer} currentBuffer - Raw PNG buffer for the current image.
 * @param {(import('../types/index.d.ts').CompareImagesOptions & { renderDiffImage?: true })} [options]
 * @returns {import('../types/index.d.ts').CompareImagesResult}
 */
/**
 * Fallback for a non-literal `renderDiffImage` boolean.
 * @overload
 * @param {Buffer} baselineBuffer - Raw PNG buffer for the baseline image.
 * @param {Buffer} currentBuffer - Raw PNG buffer for the current image.
 * @param {import('../types/index.d.ts').CompareImagesOptions} options
 * @returns {CompareImagesImplementationResult}
 */
/**
 * @param {Buffer} baselineBuffer - Raw PNG buffer for the baseline image.
 * @param {Buffer} currentBuffer - Raw PNG buffer for the current image.
 * @param {import('../types/index.d.ts').CompareImagesOptions} [options]
 * @returns {CompareImagesImplementationResult}
 * @throws {ComparisonTooLargeError} If the union canvas exceeds the limit.
 */
export function compareImages(baselineBuffer, currentBuffer, options = {}) {
  const ignoreRegions = options.ignoreRegions || [];
  validateIgnoreRegions(ignoreRegions);
  const changedColor = parseHighlightColor(options.highlightColor || DEFAULT_HIGHLIGHT_COLOR, 'highlightColor');
  const addedColor = parseHighlightColor(options.addedColor || DEFAULT_ADDED_COLOR, 'addedColor');
  const removedColor = parseHighlightColor(options.removedColor || DEFAULT_REMOVED_COLOR, 'removedColor');
  const renderDiffImage = options.renderDiffImage !== false;
  const maxPixels = resolveMaxPixels(options.maxPixels);
  const alignmentRequested = options.alignment === 'vertical';

  // Best-effort pre-decode guard: reject oversized unions before allocating the
  // decoded RGBA buffers, which are the largest allocations in this path.
  const baselineHeader = readPngDimensions(baselineBuffer);
  const currentHeader = readPngDimensions(currentBuffer);
  if (baselineHeader && currentHeader) {
    const headerCanvasWidth = Math.max(baselineHeader.width, currentHeader.width);
    const headerCanvasHeight = Math.max(baselineHeader.height, currentHeader.height);
    if (headerCanvasWidth * headerCanvasHeight > maxPixels) {
      throw new ComparisonTooLargeError(
        baselineHeader.width,
        baselineHeader.height,
        currentHeader.width,
        currentHeader.height,
        headerCanvasWidth,
        headerCanvasHeight,
        maxPixels
      );
    }
  }

  const baselinePng = PNG.sync.read(baselineBuffer);
  const currentPng = PNG.sync.read(currentBuffer);

  const canvasWidth = Math.max(baselinePng.width, currentPng.width);
  const canvasHeight = Math.max(baselinePng.height, currentPng.height);
  const unionPixels = canvasWidth * canvasHeight;
  if (unionPixels > maxPixels) {
    throw new ComparisonTooLargeError(
      baselinePng.width,
      baselinePng.height,
      currentPng.width,
      currentPng.height,
      canvasWidth,
      canvasHeight,
      maxPixels
    );
  }

  const dimensionsChanged = baselinePng.width !== currentPng.width || baselinePng.height !== currentPng.height;
  let alignmentFallbackReason;

  // Keep unchanged v2 captures on the same cheap path as v1 while returning
  // the complete aligned metadata contract.
  if (alignmentRequested && !dimensionsChanged && ignoreRegions.length === 0 && pixelDataEqual(baselinePng.data, currentPng.data)) {
    const totalPixels = canvasWidth * canvasHeight;
    const comparison = /** @type {import('../types/index.d.ts').ComparisonMetadata} */ ({
      baseline: { width: baselinePng.width, height: baselinePng.height },
      current: { width: currentPng.width, height: currentPng.height },
      canvas: { width: canvasWidth, height: canvasHeight },
      dimensionsChanged: false,
      totalPixels,
      policyVersion: 2,
      mode: /** @type {const} */ ('vertical-aligned'),
      rowMapping: canvasHeight > 0
        ? [{ outputStart: 0, length: canvasHeight, kind: /** @type {const} */ ('matched'), baselineStart: 0, currentStart: 0 }]
        : []
    });
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

  if (alignmentRequested && ignoreRegions.length === 0) {
    const alignedResult = compareAlignedImages(baselinePng, currentPng, {
      renderDiffImage,
      changedColor,
      addedColor,
      removedColor,
      maxPixels
    });
    if (alignedResult.kind === 'aligned') {
      return alignedResult.result;
    }
    alignmentFallbackReason = alignedResult.reason;
  } else if (alignmentRequested) {
    alignmentFallbackReason = 'ignore-regions';
  }

  const comparison = /** @type {import('../types/index.d.ts').ComparisonMetadata} */ ({
    baseline: { width: baselinePng.width, height: baselinePng.height },
    current: { width: currentPng.width, height: currentPng.height },
    canvas: { width: canvasWidth, height: canvasHeight },
    dimensionsChanged,
    totalPixels: 0,
    ...(alignmentRequested
      ? {
          policyVersion: 2,
          mode: 'coordinate-fallback',
          fallbackReason: alignmentFallbackReason || 'alignment-limit'
        }
      : {})
  });

  // Fast path: identical dimensions and decoded pixels. The visual diff of an
  // unchanged image is the image itself, so the baseline buffer can be reused.
  if (!alignmentRequested && !dimensionsChanged && ignoreRegions.length === 0 && pixelDataEqual(baselinePng.data, currentPng.data)) {
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
      // regardless of its RGBA values. Rendered semantically: current-only
      // pixels are additions, baseline-only pixels are removals.
      const currentOnly = !inBaseline && inCurrent;
      const baselineOnly = inBaseline && !inCurrent;
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
          const color = currentOnly ? addedColor : baselineOnly ? removedColor : changedColor;
          diffPng.data[diffIndex] = color[0];
          diffPng.data[diffIndex + 1] = color[1];
          diffPng.data[diffIndex + 2] = color[2];
          diffPng.data[diffIndex + 3] = color[3];
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
