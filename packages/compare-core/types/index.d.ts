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
  /** RGBA color for changed pixels. Default: [255, 0, 0, 255] (red). */
  highlightColor?: [number, number, number, number];
  /** Pixels in ignore regions are overlaid with a neutral semi-transparent gray instead of being highlighted. */
  ignoreRegions?: IgnoreRegion[];
}

export interface ComparisonDimensions {
  width: number;
  height: number;
}

export interface ComparisonMetadata {
  baseline: ComparisonDimensions;
  current: ComparisonDimensions;
  canvas: ComparisonDimensions;
  dimensionsChanged: boolean;
  totalPixels: number;
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

export interface CompareImagesOptions extends DiffImageOptions {}

export interface CompareImagesResult extends CompareResult {
  /** Visual diff generated from the same decoded images as the metrics. */
  diffImageBuffer: Buffer;
  /** Dimensions and effective denominator used by the union-canvas comparison. */
  comparison: ComparisonMetadata;
}

export class ComparisonTooLargeError extends Error {
  readonly code: 'comparison_too_large';
}

export const MAX_COMPARISON_PIXELS: number;

export function compareBuffers(baselineBuffer: Buffer, currentBuffer: Buffer): CompareBuffersResult;
export function compareImages(baselineBuffer: Buffer, currentBuffer: Buffer, options?: CompareImagesOptions): CompareImagesResult;
export function compareWithIgnoreRegions(baselineBuffer: Buffer, currentBuffer: Buffer, regions: IgnoreRegion[]): CompareBuffersResult;
export function generateDiffImage(baselineBuffer: Buffer, currentBuffer: Buffer, options?: DiffImageOptions): Buffer;
