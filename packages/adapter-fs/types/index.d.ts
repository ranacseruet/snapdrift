/**
 * Filesystem I/O adapter types for @snapdrift/adapter-fs.
 */

import type {
  VisualRegressionConfig,
  VisualRegressionRouteConfig,
  VisualDiffSummary
} from '@snapdrift/manifest';

// --- config.mjs ---

export const DEFAULT_CONFIG_PATH: string;
export const SNAPDRIFT_CAPTURE_CONCURRENCY: number;

export function readFirstDefinedEnv(names: string[]): string | undefined;

export function loadSnapdriftConfig(configPath?: string): Promise<{
  config: VisualRegressionConfig;
  configPath: string;
}>;

// --- compare-files.mjs ---

export function comparePngs(
  baselinePath: string,
  currentPath: string
): Promise<{
  width: number;
  height: number;
  differentPixels: number;
  totalPixels: number;
  mismatchRatio: number;
}>;

export function resolveImagePath(runDir: string, relativeImagePath: string): Promise<string>;

export function loadJson<T = unknown>(filePath: string, label: string): Promise<T>;

export function clearFileIndexCache(): void;

// --- drift-report.mjs ---

export interface GenerateDriftReportOptions {
  configPath?: string;
  baselineResultsPath?: string;
  baselineManifestPath?: string;
  currentResultsPath?: string;
  currentManifestPath?: string;
  baselineRunDir?: string;
  currentRunDir?: string;
  routeIds?: Iterable<string>;
  baselineArtifactName?: string;
  baselineSourceSha?: string;
}

export function generateDriftReport(
  options?: GenerateDriftReportOptions
): Promise<{ summary: VisualDiffSummary; markdown: string }>;

export interface RunDriftCheckCliOptions extends GenerateDriftReportOptions {
  outDir?: string;
  summaryPath?: string;
  markdownPath?: string;
  enforceOutcome?: boolean;
}

export function runDriftCheckCli(options?: RunDriftCheckCliOptions): Promise<void>;

// --- stage.mjs ---

export function getDefaultArtifactBundleDir(artifactType: 'baseline' | 'diff'): string;

export interface StageArtifactsOptions {
  artifactType: 'baseline' | 'diff';
  bundleDir?: string;
  resultsPath?: string;
  manifestPath?: string;
  screenshotsDir?: string;
  summaryJsonPath?: string;
  summaryMarkdownPath?: string;
  reportHtmlPath?: string;
  baselineResultsPath?: string;
  currentResultsPath?: string;
  baselineManifestPath?: string;
  currentManifestPath?: string;
  baselineScreenshotsDir?: string;
  currentScreenshotsDir?: string;
}

export function stageArtifacts(options: StageArtifactsOptions): Promise<{
  bundleDir: string;
}>;

// --- drift-summary-io.mjs ---

export interface WriteDriftSummaryOptions {
  status?: 'skipped' | 'clean' | 'changes-detected' | 'incomplete';
  reason: string;
  message?: string;
  selectedRouteIds?: string[] | string;
  currentResultsPath?: string;
  baselineAvailable?: boolean;
  outDir?: string;
  summaryPath?: string;
  markdownPath?: string;
}

export function writeDriftSummary(
  options: WriteDriftSummaryOptions
): Promise<{
  summaryPath: string;
  markdownPath: string;
  summary: Record<string, unknown>;
  markdown: string;
}>;

// --- capture.mjs ---

export interface RunBaselineCaptureOptions {
  configPath?: string;
  routeIds?: Iterable<string>;
  outDir?: string;
}

export function runBaselineCapture(
  options?: RunBaselineCaptureOptions
): Promise<{
  resultsPath: string;
  manifestPath: string;
  screenshotsRoot: string;
  selectedRouteIds: string[];
}>;

/**
 * Throws if a Playwright navigation resolved to an HTTP error status (>= 400),
 * so an error page is never captured as a valid screenshot. A `null` response
 * (non-navigation scheme, e.g. about:blank) is treated as fine.
 */
export function assertNavigationOk(
  response: { status: () => number } | null,
  route: VisualRegressionRouteConfig,
  targetUrl: string
): void;