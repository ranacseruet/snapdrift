import type { Buffer } from 'node:buffer';

/**
 * Comparison result types for @snapdrift/compare-core.
 */

export interface IgnoreRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DiffImageOptions {
  /**
   * RGBA color for pixels that differ between baseline and current.
   * Default: [255, 140, 0, 255] (orange).
   */
  highlightColor?: [number, number, number, number];
  /**
   * RGBA color for pixels present only in the current image (added).
   * Union-canvas and insertion-aware comparisons; strict same-dimension diffs cannot add pixels.
   * Default: [0, 170, 0, 255] (green).
   */
  addedColor?: [number, number, number, number];
  /**
   * RGBA color for pixels present only in the baseline image (removed).
   * Union-canvas comparisons only; strict same-dimension diffs cannot remove pixels.
   * Default: [255, 0, 0, 255] (red).
   */
  removedColor?: [number, number, number, number];
  /** Pixels in ignore regions are overlaid with a neutral semi-transparent gray instead of being highlighted. */
  ignoreRegions?: IgnoreRegion[];
}

export interface ComparisonDimensions {
  width: number;
  height: number;
}

export type ComparisonRowKind = 'matched' | 'changed' | 'inserted' | 'deleted';

export const COMPARISON_ROW_KINDS: readonly ['matched', 'changed', 'inserted', 'deleted'];
export const COMPARISON_FALLBACK_REASONS: readonly ['width-mismatch', 'alignment-limit', 'ambiguous', 'verification-failed', 'ignore-regions'];

export type ComparisonFallbackReason = (typeof COMPARISON_FALLBACK_REASONS)[number];

export interface ComparisonRowMapping {
  outputStart: number;
  length: number;
  kind: ComparisonRowKind;
  baselineStart?: number;
  currentStart?: number;
  /**
   * Present when an offset-run row was compared one pixel above or below the
   * recorded current row. Output row i was compared to current row
   * `currentStart + i + comparedOffset`. `currentStart` still consumes each
   * current row once.
   */
  comparedOffset?: -1 | 0 | 1;
}

export interface ComparisonMetadata {
  baseline: ComparisonDimensions;
  current: ComparisonDimensions;
  canvas: ComparisonDimensions;
  dimensionsChanged: boolean;
  totalPixels: number;
  /** Present for the opt-in policy v2 result. */
  policyVersion?: 2;
  /** Whether v2 aligned rows or fell back to coordinate comparison. */
  mode?: 'vertical-aligned' | 'coordinate-fallback';
  /**
   * Row mapping used to render and score an aligned result.
   * On an offset-run match, `matched` means mapped and below the highlight rule.
   * `comparedOffset` names a one-pixel neighbor when that row was the one compared.
   */
  rowMapping?: ComparisonRowMapping[];
  /** Why v2 used coordinate fallback, when it did. */
  fallbackReason?: ComparisonFallbackReason;
}

export interface CompareResult {
  width: number;
  height: number;
  differentPixels: number;
  totalPixels: number;
  /** Ratio of different to total pixels (0–1). Alias: `pct`. */
  mismatchRatio: number;
  /** Alias for `mismatchRatio`. ADR-convention name. */
  pct: number;
  /** Alias for `differentPixels`. ADR-convention name. */
  pixelsChanged: number;
  /** Visual diff image buffer, only present when generated via diff-image mode. */
  diffImageBuffer?: Buffer;
}

export type CompareBuffersResult = CompareResult;

export interface CompareImagesOptions extends DiffImageOptions {
  /**
   * Row alignment strategy. Omitting this uses the deprecated v1 top-left
   * union comparison for compatibility; `vertical` selects policy v2.
   */
  alignment?: 'vertical';
  /**
   * Whether to render and return `diffImageBuffer`. Default: `true`.
   * Set to `false` to skip the PNG encode for callers that only need metrics.
   */
  renderDiffImage?: boolean;
  /**
   * Maximum union-canvas pixels this comparison may allocate. Defaults to
   * `MAX_COMPARISON_PIXELS` (32 Mi). Raise it only when the calling process has a
   * memory envelope large enough for both decoded inputs plus the optional diff
   * canvas — at least ~12 bytes per union pixel when both inputs approach the
   * union dimensions, and measured end-to-end at ~32-35 bytes per union pixel on
   * real full-page captures. Size against your own measurement, not the
   * arithmetic: this is a process-memory bound, not an algorithm property. A
   * missing, non-finite, or sub-1 value falls back to the default so the guard
   * cannot be removed accidentally or reduced to a ceiling that rejects every
   * comparison. Fractions are floored (`16.9` becomes `16`).
   */
  maxPixels?: number;
}

export interface CompareImagesResult extends CompareResult {
  /** Visual diff generated from the same decoded images as the metrics. */
  diffImageBuffer: Buffer;
  /** Dimensions and effective denominator used by the union-canvas comparison. */
  comparison: ComparisonMetadata;
}

export interface CompareImagesMetricsResult extends CompareResult {
  /** Absent because `renderDiffImage: false` was passed. */
  diffImageBuffer?: never;
  /** Dimensions and effective denominator used by the union-canvas comparison. */
  comparison: ComparisonMetadata;
}

export class ComparisonTooLargeError extends Error {
  readonly code: 'comparison_too_large';
}

export const MAX_COMPARISON_PIXELS: number;
export const MAX_ALIGNMENT_ROWS: number;
export const MAX_ALIGNMENT_EDIT_LENGTH: number;

export function compareBuffers(baselineBuffer: Buffer, currentBuffer: Buffer): CompareBuffersResult;
/** Metrics-only overload: `diffImageBuffer` is not rendered. */
export function compareImages(
  baselineBuffer: Buffer,
  currentBuffer: Buffer,
  options: CompareImagesOptions & { renderDiffImage: false }
): CompareImagesMetricsResult;
/**
 * Union-canvas comparison. Diff rendering is semantic: added pixels (current-only)
 * use `addedColor` (green), removed pixels (baseline-only) use `removedColor` (red),
 * and overlapping changed pixels use `highlightColor` (orange).
 */
export function compareImages(baselineBuffer: Buffer, currentBuffer: Buffer, options?: CompareImagesOptions): CompareImagesResult;
export function compareWithIgnoreRegions(baselineBuffer: Buffer, currentBuffer: Buffer, regions: IgnoreRegion[]): CompareBuffersResult;
/**
 * Strict same-dimension diff. Changed pixels use `highlightColor` (orange by default);
 * `addedColor`/`removedColor` do not apply because equal dimensions preclude one-sided pixels.
 */
export function generateDiffImage(baselineBuffer: Buffer, currentBuffer: Buffer, options?: DiffImageOptions): Buffer;
