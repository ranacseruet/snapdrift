// @ts-check

import pngjs from 'pngjs';

import {
  buildOffsetRenderPlan,
  pixelIsHighlighted,
  CONTENT_INK_MIN,
  rowHasContentInk,
  rowInkCost,
  STRUCTURED_DELTA,
  STRUCTURAL_DUPLICATE_COST,
  STRUCTURAL_DUPLICATE_WINDOW
} from './offset-align.mjs';
import { buildIgnoreMask, parseHighlightColor, readPngDimensions, validateIgnoreRegions } from './shared.mjs';
import { alignRows, appendSegment } from './vertical-align.mjs';

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
 * Max absolute difference across RGBA. Highlighting includes alpha so a mapped
 * row whose opacity changed is not reported as matched. Scoring ignores fully
 * transparent pixels and treats only a large opacity change as a mismatch.
 *
 * @param {Uint8Array} baseline
 * @param {Uint8Array} current
 * @param {number} baselineIndex
 * @param {number} currentIndex
 * @returns {number}
 */
function channelDelta(baseline, current, baselineIndex, currentIndex) {
  return Math.max(
    Math.abs(baseline[baselineIndex] - current[currentIndex]),
    Math.abs(baseline[baselineIndex + 1] - current[currentIndex + 1]),
    Math.abs(baseline[baselineIndex + 2] - current[currentIndex + 2]),
    Math.abs(baseline[baselineIndex + 3] - current[currentIndex + 3])
  );
}

/**
 * Whether a one-sided content row duplicates a row the plan already claims in
 * the other image. Search offsets around the neighboring stable runs: a
 * compensating band of repeated fill rows is a rendering duplicate, while a
 * text line inserted by reflow matches nowhere and stays content.
 *
 * @param {{ data: Uint8Array, width: number, height: number }} baselinePng
 * @param {{ data: Uint8Array, width: number, height: number }} currentPng
 * @param {'inserted' | 'deleted'} role
 * @param {number} sourceY
 * @param {Set<number>} claimedBaseline
 * @param {Set<number>} claimedCurrent
 * @param {number | null} beforeOffset
 * @param {number | null} afterOffset
 * @returns {boolean}
 */
function isStructuralDuplicate(baselinePng, currentPng, role, sourceY, claimedBaseline, claimedCurrent, beforeOffset, afterOffset) {
  const neighbors = [beforeOffset, afterOffset].filter((offset) => offset !== null);
  if (neighbors.length === 0) {
    return false;
  }
  const minOffset = Math.min(...neighbors) - STRUCTURAL_DUPLICATE_WINDOW;
  const maxOffset = Math.max(...neighbors) + STRUCTURAL_DUPLICATE_WINDOW;
  if (role === 'inserted') {
    for (let offset = minOffset; offset <= maxOffset; offset += 1) {
      const baselineY = sourceY - offset;
      if (baselineY < 0 || baselineY >= baselinePng.height) continue;
      if (!claimedBaseline.has(baselineY) || !rowHasContentInk(baselinePng, baselineY)) continue;
      if (rowInkCost(baselinePng, currentPng, baselineY, offset) <= STRUCTURAL_DUPLICATE_COST) {
        return true;
      }
    }
    return false;
  }
  for (let offset = minOffset; offset <= maxOffset; offset += 1) {
    const currentY = sourceY + offset;
    if (currentY < 0 || currentY >= currentPng.height) continue;
    if (!claimedCurrent.has(currentY) || !rowHasContentInk(currentPng, currentY)) continue;
    if (rowInkCost(baselinePng, currentPng, sourceY, offset) <= STRUCTURAL_DUPLICATE_COST) {
      return true;
    }
  }
  return false;
}

/**
 * Whether two pixels are byte-identical.
 *
 * @param {{ data: Uint8Array }} pngA
 * @param {number} indexA
 * @param {{ data: Uint8Array }} pngB
 * @param {number} indexB
 * @returns {boolean}
 */
function pixelsEqual(pngA, indexA, pngB, indexB) {
  return pngA.data[indexA] === pngB.data[indexB] &&
    pngA.data[indexA + 1] === pngB.data[indexB + 1] &&
    pngA.data[indexA + 2] === pngB.data[indexB + 2] &&
    pngA.data[indexA + 3] === pngB.data[indexB + 3];
}

/**
 * Bitmasks of relative offsets within {@link STRUCTURAL_DUPLICATE_WINDOW} where
 * one mismatched pixel of a paired row duplicates a row the plan already claims
 * in the other image. Zero is excluded: the mismatched pair cannot be equal at
 * its own plan offset. `backgroundMask` records a current-side copy: the
 * baseline pixel exists in a claimed current row, which proves the old
 * background moved. `foregroundMask` records a baseline-side copy: the current
 * pixel exists in a claimed baseline row, which proves the new foreground came
 * from somewhere in the baseline. A newly added mark on uniform background has
 * only a background copy, so it must not be suppressed as displacement. Bits
 * are relative to the compared rows, and a row intersects both masks across
 * every mismatched pixel.
 *
 * @param {{ data: Uint8Array, width: number, height: number }} baselinePng
 * @param {{ data: Uint8Array, width: number, height: number }} currentPng
 * @param {number} baselineY
 * @param {number} pixelY
 * @param {number} x
 * @param {Set<number>} claimedBaseline
 * @param {Set<number>} claimedCurrent
 * @returns {{ backgroundMask: number, foregroundMask: number }}
 */
function displacementEvidenceMasks(baselinePng, currentPng, baselineY, pixelY, x, claimedBaseline, claimedCurrent) {
  const window = STRUCTURAL_DUPLICATE_WINDOW;
  let backgroundMask = 0;
  let foregroundMask = 0;
  for (let delta = -window; delta <= window; delta += 1) {
    if (delta === 0) continue;
    const currentY = pixelY + delta;
    if (currentY >= 0 && currentY < currentPng.height && claimedCurrent.has(currentY)) {
      const baselineIndex = (baselineY * baselinePng.width + x) * 4;
      const currentIndex = (currentY * currentPng.width + x) * 4;
      if (pixelsEqual(baselinePng, baselineIndex, currentPng, currentIndex)) {
        backgroundMask |= 1 << (delta + window);
      }
    }
    const baselineCandidateY = baselineY + delta;
    if (baselineCandidateY >= 0 && baselineCandidateY < baselinePng.height && claimedBaseline.has(baselineCandidateY)) {
      const baselineIndex = (baselineCandidateY * baselinePng.width + x) * 4;
      const currentIndex = (pixelY * currentPng.width + x) * 4;
      if (pixelsEqual(currentPng, currentIndex, baselinePng, baselineIndex)) {
        foregroundMask |= 1 << (-delta + window);
      }
    }
  }
  return { backgroundMask, foregroundMask };
}

/**
 * Render a page from piecewise vertical-offset runs.
 * Used when exact row alignment exhausts its edit budget. Callers that still
 * have an exact Myers script should keep that script: short byte-identical
 * edits are cheaper and already precise. An offset canvas past `maxPixels`
 * falls back so the caller can still use coordinate comparison. The coordinate
 * union itself still throws when it exceeds the limit.
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
export function compareOffsetAligned(baselinePng, currentPng, options) {
  const plan = buildOffsetRenderPlan(baselinePng, currentPng);
  if (plan.kind !== 'aligned') {
    return plan;
  }

  const canvasWidth = baselinePng.width;
  const canvasHeight = plan.steps.length;
  if (canvasWidth * canvasHeight > options.maxPixels) {
    return { kind: 'fallback', reason: 'alignment-limit' };
  }

  /** @type {import('./vertical-align.mjs').AlignmentSegment[]} */
  const segments = [];
  const diffPng = options.renderDiffImage ? new PNG({ width: canvasWidth, height: canvasHeight }) : undefined;
  let differentPixels = 0;
  let outputY = 0;

  /** @type {Set<number>} */
  const claimedBaseline = new Set();
  /** @type {Set<number>} */
  const claimedCurrent = new Set();
  for (const step of plan.steps) {
    if (step.role === 'paired') {
      claimedBaseline.add(step.baselineY);
      claimedCurrent.add(step.currentY);
    } else if (step.role === 'inserted') {
      // An inserted row is still a row of the current image that the plan
      // outputs. A glyph shifted onto it is old content claimed by the plan,
      // not a new mark, so displacement evidence may use it as a current-side
      // duplicate.
      claimedCurrent.add(step.currentY);
    } else {
      // A deleted row is still a row of the baseline image. Foreground evidence
      // may find the new current pixel in it only when the pixel is a duplicate
      // of old content.
      claimedBaseline.add(step.baselineY);
    }
  }
  /** @type {(number | null)[]} */
  const nearestBefore = new Array(plan.steps.length).fill(null);
  let previousOffset = null;
  for (let index = 0; index < plan.steps.length; index += 1) {
    nearestBefore[index] = previousOffset;
    const step = plan.steps[index];
    if (step.role === 'paired') {
      previousOffset = step.currentY - step.baselineY;
    }
  }
  /** @type {(number | null)[]} */
  const nearestAfter = new Array(plan.steps.length).fill(null);
  let nextOffset = null;
  for (let index = plan.steps.length - 1; index >= 0; index -= 1) {
    nearestAfter[index] = nextOffset;
    const step = plan.steps[index];
    if (step.role === 'paired') {
      nextOffset = step.currentY - step.baselineY;
    }
  }

  // A mismatched pixel inside a paired row can duplicate a pixel of a row the
  // plan already claims three offsets away: the glyph or badge edge was drawn a
  // few rows higher or lower relative to the text than row-level alignment can
  // represent. Suppression needs both halves of that story: the old baseline
  // pixel must exist in a claimed current row (background evidence) and the
  // new current pixel must exist in a claimed baseline row (foreground
  // evidence). A new small mark on a uniform background has only a background
  // copy and is content, not displacement. A row with at least
  // {@link CONTENT_INK_MIN} mismatched pixels is a structured edit (a changed
  // glyph or region), not an edge displacement, so it stays painted. Suppress
  // displacement only when the contiguous run of displaced rows borders matched
  // rows, so a run that borders unexplained content remains part of that
  // content edit.
  /** @type {number[][]} */
  const pairedMismatches = new Array(plan.steps.length);
  /** @type {boolean[]} */
  const displacement = new Array(plan.steps.length).fill(false);
  /** @type {boolean[]} */
  const suppressRow = new Array(plan.steps.length).fill(false);
  const allCandidateBits = (1 << (STRUCTURAL_DUPLICATE_WINDOW * 2 + 1)) - 1;
  for (let index = 0; index < plan.steps.length; index += 1) {
    const step = plan.steps[index];
    if (step.role !== 'paired') continue;
    const baselineRow = step.baselineY * canvasWidth * 4;
    const pixelRow = step.pixelY * canvasWidth * 4;
    /** @type {number[]} */
    const mismatches = [];
    let commonBackground = allCandidateBits & ~(1 << STRUCTURAL_DUPLICATE_WINDOW);
    let commonForeground = allCandidateBits & ~(1 << STRUCTURAL_DUPLICATE_WINDOW);
    for (let x = 0; x < canvasWidth; x += 1) {
      const delta = channelDelta(baselinePng.data, currentPng.data, baselineRow + x * 4, pixelRow + x * 4);
      if (!pixelIsHighlighted(delta, step.paint)) continue;
      mismatches.push(x);
      if (commonBackground !== 0 || commonForeground !== 0) {
        const evidence = displacementEvidenceMasks(baselinePng, currentPng, step.baselineY, step.pixelY, x, claimedBaseline, claimedCurrent);
        commonBackground &= evidence.backgroundMask;
        commonForeground &= evidence.foregroundMask;
      }
    }
    pairedMismatches[index] = mismatches;
    displacement[index] =
      mismatches.length > 0 &&
      mismatches.length < CONTENT_INK_MIN &&
      commonBackground !== 0 &&
      commonForeground !== 0;
  }
  for (let start = 0; start < plan.steps.length; start += 1) {
    if (!displacement[start]) continue;
    let end = start;
    while (end + 1 < plan.steps.length && displacement[end + 1]) end += 1;
    let contentBoundary = false;
    for (const neighbor of [start - 1, end + 1]) {
      if (neighbor < 0 || neighbor >= plan.steps.length) continue;
      const neighborStep = plan.steps[neighbor];
      if (neighborStep.role === 'paired') {
        if (pairedMismatches[neighbor].length > 0) {
          contentBoundary = true;
          break;
        }
      } else {
        const sourcePng = neighborStep.role === 'inserted' ? currentPng : baselinePng;
        const sourceY = neighborStep.role === 'inserted' ? neighborStep.currentY : neighborStep.baselineY;
        const structural =
          !rowHasContentInk(sourcePng, sourceY) ||
          isStructuralDuplicate(
            baselinePng, currentPng, neighborStep.role, sourceY,
            claimedBaseline, claimedCurrent, nearestBefore[neighbor], nearestAfter[neighbor]
          );
        if (!structural) {
          contentBoundary = true;
          break;
        }
      }
    }
    if (!contentBoundary) {
      for (let index = start; index <= end; index += 1) suppressRow[index] = true;
    }
    start = end;
  }

  for (let index = 0; index < plan.steps.length; index += 1) {
    const step = plan.steps[index];
    let highlighted = 0;
    if (step.role === 'paired') {
      const pixelRow = step.pixelY * canvasWidth * 4;
      const mismatches = pairedMismatches[index];
      let nextMismatch = 0;
      for (let x = 0; x < canvasWidth; x += 1) {
        const currentIndex = pixelRow + x * 4;
        const outputIndex = (outputY * canvasWidth + x) * 4;
        const mismatched = nextMismatch < mismatches.length && mismatches[nextMismatch] === x;
        if (mismatched) nextMismatch += 1;
        if (mismatched && !suppressRow[index]) {
          highlighted += 1;
          if (diffPng) {
            diffPng.data[outputIndex] = options.changedColor[0];
            diffPng.data[outputIndex + 1] = options.changedColor[1];
            diffPng.data[outputIndex + 2] = options.changedColor[2];
            diffPng.data[outputIndex + 3] = options.changedColor[3];
          }
        } else if (diffPng) {
          diffPng.data[outputIndex] = currentPng.data[currentIndex];
          diffPng.data[outputIndex + 1] = currentPng.data[currentIndex + 1];
          diffPng.data[outputIndex + 2] = currentPng.data[currentIndex + 2];
          diffPng.data[outputIndex + 3] = currentPng.data[currentIndex + 3];
        }
      }
      const comparedDelta = step.pixelY - step.currentY;
      const comparedOffset = comparedDelta === -1 || comparedDelta === 1 ? comparedDelta : undefined;
      appendSegment(segments, {
        outputStart: outputY,
        length: 1,
        kind: highlighted > 0 ? 'changed' : 'matched',
        baselineStart: step.baselineY,
        currentStart: step.currentY,
        ...(comparedOffset === undefined ? {} : { comparedOffset })
      });
    } else {
      const sourcePng = step.role === 'inserted' ? currentPng : baselinePng;
      const sourceY = step.role === 'inserted' ? step.currentY : step.baselineY;
      // Structural padding carries no content ink. Colouring a spacer or an
      // antialias tail green or red would report a page-height difference as a
      // content change, and a full-row colour over seven pixels inflates it.
      // A content row that duplicates a claimed row nearby is the same kind of
      // rendering artifact: a compensating band of repeated fill rows, not a
      // new line.
      const blank =
        !rowHasContentInk(sourcePng, sourceY) ||
        isStructuralDuplicate(baselinePng, currentPng, step.role, sourceY, claimedBaseline, claimedCurrent, nearestBefore[index], nearestAfter[index]);
      highlighted = blank ? 0 : canvasWidth;
      if (diffPng) {
        const color = step.role === 'inserted' ? options.addedColor : options.removedColor;
        for (let x = 0; x < canvasWidth; x += 1) {
          const outputIndex = (outputY * canvasWidth + x) * 4;
          const sourceIndex = (sourceY * canvasWidth + x) * 4;
          diffPng.data[outputIndex] = blank ? sourcePng.data[sourceIndex] : color[0];
          diffPng.data[outputIndex + 1] = blank ? sourcePng.data[sourceIndex + 1] : color[1];
          diffPng.data[outputIndex + 2] = blank ? sourcePng.data[sourceIndex + 2] : color[2];
          diffPng.data[outputIndex + 3] = blank ? sourcePng.data[sourceIndex + 3] : color[3];
        }
      }
      appendSegment(segments, step.role === 'inserted'
        ? { outputStart: outputY, length: 1, kind: 'inserted', currentStart: step.currentY }
        : { outputStart: outputY, length: 1, kind: 'deleted', baselineStart: step.baselineY });
    }
    differentPixels += highlighted;
    outputY += 1;
  }

  const totalPixels = canvasWidth * canvasHeight;
  const mismatchRatio = totalPixels === 0 ? 0 : differentPixels / totalPixels;
  const comparison = /** @type {import('../types/index.d.ts').ComparisonMetadata} */ ({
    baseline: { width: baselinePng.width, height: baselinePng.height },
    current: { width: currentPng.width, height: currentPng.height },
    canvas: { width: canvasWidth, height: canvasHeight },
    dimensionsChanged: baselinePng.height !== currentPng.height,
    totalPixels,
    policyVersion: 2,
    mode: /** @type {const} */ ('vertical-aligned'),
    alignmentStrategy: /** @type {const} */ ('offset'),
    // Stable offset-run rows use the 32-per-channel highlight rule. Local
    // residual bands between stable runs use the stricter NOISE_DELTA floor,
    // so this field describes stable runs only.
    tolerance: STRUCTURED_DELTA,
    rowMapping: segments
  });
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
 * Compare two equal-width images after aligning their rows. Exact fingerprint
 * alignment is tried first. When that search hits its edit cap, piecewise
 * vertical-offset runs supply the row plan. The result uses one output row
 * for every matched, changed, inserted, or deleted source row.
 *
 * An aligned canvas past `maxPixels` falls back as `alignment-limit` so the
 * caller can still use coordinate comparison. The coordinate union itself
 * still throws when it exceeds the limit.
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
    if (alignment.reason === 'alignment-limit' || alignment.reason === 'ambiguous') {
      const offsetAligned = compareOffsetAligned(baselinePng, currentPng, options);
      if (offsetAligned.kind === 'aligned') {
        return offsetAligned;
      }
    }
    return alignment;
  }

  const canvasWidth = baselinePng.width;
  const canvasHeight = alignment.height;
  if (canvasWidth * canvasHeight > options.maxPixels) {
    return { kind: 'fallback', reason: 'alignment-limit' };
  }

  const comparison = /** @type {import('../types/index.d.ts').ComparisonMetadata} */ ({
    baseline: { width: baselinePng.width, height: baselinePng.height },
    current: { width: currentPng.width, height: currentPng.height },
    canvas: { width: canvasWidth, height: canvasHeight },
    dimensionsChanged: baselinePng.width !== currentPng.width || baselinePng.height !== currentPng.height,
    totalPixels: 0,
    policyVersion: 2,
    mode: /** @type {const} */ ('vertical-aligned'),
    alignmentStrategy: /** @type {const} */ ('exact'),
    rowMapping: alignment.segments
  });
  const diffPng = options.renderDiffImage ? new PNG({ width: canvasWidth, height: canvasHeight }) : undefined;
  let differentPixels = 0;
  let totalPixels = 0;

  for (const segment of alignment.segments) {
    // Matched rows are byte-identical and contribute nothing but the
    // denominator when no image is rendered.
    if (!diffPng && segment.kind === 'matched') {
      totalPixels += canvasWidth * segment.length;
      continue;
    }
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
          // Uncolored rows are matched or changed, so both sides are present;
          // the current pixel is shown.
          diffPng.data[outputIndex] = currentPng.data[currentIndex];
          diffPng.data[outputIndex + 1] = currentPng.data[currentIndex + 1];
          diffPng.data[outputIndex + 2] = currentPng.data[currentIndex + 2];
          diffPng.data[outputIndex + 3] = currentPng.data[currentIndex + 3];
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
 * same pass over the decoded pixels. The default is the deprecated v1
 * top-left-aligned union canvas for compatibility; callers can opt into
 * `alignment: 'vertical'` for policy v2.
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
      alignmentStrategy: /** @type {const} */ ('exact'),
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
