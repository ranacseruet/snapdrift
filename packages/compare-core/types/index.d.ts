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
  /** Not yet implemented (Phase 1b). Pixels in ignore regions will be overlaid with a neutral mask. */
  ignoreRegions?: IgnoreRegion[];
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