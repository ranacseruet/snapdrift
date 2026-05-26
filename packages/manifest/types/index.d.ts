/**
 * SnapDrift manifest and configuration types.
 *
 * These types define the contract between capture, comparison, and report
 * components. They are shared across providers (filesystem, S3, etc.).
 */

export type VisualViewportPreset = 'desktop' | 'mobile';

export interface VisualCustomViewport {
  width: number;
  height: number;
}

export type VisualViewport = VisualViewportPreset | VisualCustomViewport;

/**
 * Normalised viewport descriptor used for cross-provider hashing and comparison.
 * Both preset names and custom dimensions resolve to this shape.
 */
export interface ViewportDescriptor {
  width: number;
  height: number;
  deviceScaleFactor?: number;
  isMobile?: boolean;
  hasTouch?: boolean;
}

export interface VisualRegressionSelectionConfig {
  sharedPrefixes?: string[];
  sharedExact?: string[];
}

export interface VisualRegressionRouteConfig {
  id: string;
  path: string;
  viewport: VisualViewport;
  changePaths?: string[];
  navigationTimeout?: number;
}

export interface VisualRegressionConfig {
  baselineArtifactName: string;
  workingDirectory: string;
  baseUrl: string;
  resultsFile: string;
  manifestFile: string;
  screenshotsRoot: string;
  routes: VisualRegressionRouteConfig[];
  diff: {
    threshold: number;
    mode: 'report-only' | 'fail-on-changes' | 'fail-on-incomplete' | 'strict';
  };
  selection?: VisualRegressionSelectionConfig;
  provider?: 'local';
}

export interface VisualBaselineRouteResult {
  id: string;
  path: string;
  viewport: VisualViewport;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  imagePath?: string;
  width?: number;
  height?: number;
  error?: string;
}

export interface VisualScreenshotManifestEntry {
  id: string;
  path: string;
  viewport: VisualViewport;
  imagePath: string;
  width: number;
  height: number;
}

export interface VisualScreenshotManifest {
  /** Schema version. Omitted in v0 manifests; defaults to 1 when absent. */
  schemaVersion?: number;
  generatedAt: string;
  baseUrl: string;
  screenshots: VisualScreenshotManifestEntry[];
}

export interface VisualBaselineResults {
  startedAt: string;
  finishedAt?: string;
  baseUrl: string;
  suite: string;
  configPath?: string;
  manifestPath?: string;
  screenshotsRoot?: string;
  routes: VisualBaselineRouteResult[];
  passed?: boolean;
}

/**
 * Capture profile metadata for engine-version validation across providers.
 * Snap stores this on baselines and runs; snapdrift writes it into manifests.
 */
export interface CaptureProfile {
  engineVersion: string;
  browser?: string;
  browserRevision?: string;
  fontsHash?: string;
  timezone?: string;
  locale?: string;
}

export interface VisualDiffMissingItem {
  id: string;
  reason: string;
  path?: string;
  viewport?: VisualViewport;
  location: 'baseline' | 'current';
}

export interface VisualDiffErrorItem {
  id: string;
  path?: string;
  viewport?: VisualViewport;
  status: 'error';
  message: string;
}

export interface VisualDiffDimensionItem {
  id: string;
  path?: string;
  viewport?: VisualViewport;
  baselineWidth: number;
  baselineHeight: number;
  currentWidth: number;
  currentHeight: number;
  status: 'dimension-changed';
}

export interface VisualDiffChangedItem {
  id: string;
  path: string;
  viewport: VisualViewport;
  baselineImagePath: string;
  currentImagePath: string;
  width: number;
  height: number;
  differentPixels: number;
  totalPixels: number;
  mismatchRatio: number;
  status: 'changed';
}

export interface VisualDiffSummary {
  startedAt: string;
  finishedAt?: string;
  completed?: boolean;
  status?: 'clean' | 'changes-detected' | 'incomplete' | 'skipped';
  selectedRoutes?: string[];
  baselineArtifactName?: string;
  baselineSourceSha?: string;
  baselineAvailable?: boolean;
  baselineManifestPath: string;
  currentManifestPath: string;
  diffMode: 'report-only' | 'fail-on-changes' | 'fail-on-incomplete' | 'strict';
  threshold: number;
  baselineResultsPath: string;
  currentResultsPath: string;
  totalScreenshots: number;
  matchedScreenshots: number;
  changedScreenshots: number;
  missingInBaseline: number;
  missingInCurrent: number;
  changed: VisualDiffChangedItem[];
  missing: VisualDiffMissingItem[];
  errors: VisualDiffErrorItem[];
  dimensionChanges: VisualDiffDimensionItem[];
  message?: string;
}

// --- Drift status classification ---

export function determineDriftStatus(summaryData: VisualDiffSummary): 'clean' | 'changes-detected' | 'incomplete';
export function shouldFailDriftCheck(summaryData: VisualDiffSummary): boolean;

// --- Provider abstraction ---

export interface ProviderCaptureOptions {
  configPath?: string;
  routeIds?: string[];
  outDir?: string;
}

export interface ProviderCaptureResult {
  resultsPath: string;
  manifestPath: string;
  screenshotsRoot: string;
  selectedRouteIds: string[];
}

export interface ProviderDiffOptions {
  configPath?: string;
  routeIds?: string[];
  baselineResultsPath?: string;
  baselineManifestPath?: string;
  currentResultsPath?: string;
  currentManifestPath?: string;
  baselineRunDir?: string;
  currentRunDir?: string;
  baselineArtifactName?: string;
  baselineSourceSha?: string;
}

export interface ProviderDiffResult {
  summary: VisualDiffSummary;
  markdown: string;
}

export interface ProviderPublishBaselineOptions {
  configPath?: string;
  resultsPath?: string;
  manifestPath?: string;
  screenshotsDir?: string;
  bundleDir?: string;
}

export interface ProviderPublishBaselineResult {
  bundleDir: string;
}

export interface ProviderFetchBaselineOptions {
  githubToken: string;
  repository?: string;
  workflowId?: string;
  branch?: string;
}

export interface ProviderBaselineData {
  resultsPath: string;
  manifestPath: string;
  runDir: string;
  screenshotsDir: string;
  artifactName: string;
  headSha: string;
}

export interface VisualProvider {
  capture(options: ProviderCaptureOptions): Promise<ProviderCaptureResult>;
  diff(options: ProviderDiffOptions): Promise<ProviderDiffResult>;
  publishBaseline(options: ProviderPublishBaselineOptions): Promise<ProviderPublishBaselineResult>;
  fetchLatestBaseline(options: ProviderFetchBaselineOptions): Promise<ProviderBaselineData | null>;
}

// --- Config validation and route selection ---

export const VALID_DIFF_MODES: string[];
export const VALID_PROVIDER_VALUES: readonly ['local'];
export const SNAPDRIFT_NAVIGATION_TIMEOUT_MS: number;
export const SNAPDRIFT_SETTLE_DELAY_MS: number;

export function splitCommaList(value: string | undefined): string[];
export function validateSnapdriftConfig(value: unknown, sourceLabel?: string): VisualRegressionConfig;
export function resolveFromWorkingDirectory(config: VisualRegressionConfig, relativePath: string): string;
export function selectConfiguredRoutes(config: VisualRegressionConfig, requestedRouteIds: Iterable<string>): { routes: VisualRegressionRouteConfig[]; selectedRouteIds: string[] };
export function selectRoutesForChangedFiles(config: VisualRegressionConfig, changedFiles: string[]): { shouldRun: boolean; reason: string; selectedRouteIds: string[] };