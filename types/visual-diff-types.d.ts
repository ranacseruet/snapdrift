import type { SnapConfig } from '@snapdrift/manifest';

/** Object-shaped data decoded from an external JSON or YAML boundary. */
export type JsonObject = Record<string, any>;

export type VisualViewportPreset = 'desktop' | 'mobile';
export interface VisualCustomViewport { width: number; height: number; }
export type VisualViewport = VisualViewportPreset | VisualCustomViewport;

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
  provider?: 'local' | 'snap';
  snap?: SnapConfig;
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

/** Exact route/viewport capture identity persisted for hosted baseline validation. */
export interface SnapExpectedCaptureIdentity {
  routeId: string;
  routePath: string;
  viewportDescriptorJson: string;
}

/** Metadata written by SnapProvider.capture() and consumed by publishBaseline(). */
export interface SnapRunMetadata {
  runId: string;
  projectId: string;
  purpose: 'baseline' | 'capture' | 'diff';
  /** CI source branch for hosted baseline runs; omitted for ordinary diff runs. */
  refBranch?: string;
  /** Resolved 40-character CI commit for hosted baseline runs. */
  refSha?: string;
  /** Stable CI workflow identity that owns the publication sequence. */
  publicationWorkflowRef?: string;
  /** Monotonic CI publication sequence for stale-publisher rejection. */
  publicationSequence?: number;
  startedAt: string;
  configuredRouteIds: string[];
  selectedRouteIds: string[];
  expectedCaptures: SnapExpectedCaptureIdentity[];
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
  /** Link to the provider's run detail page. Set by SnapProvider during diff(); undefined for LocalProvider. */
  dashboardUrl?: string;
}

// --- Provider abstraction (canonical definitions in @snapdrift/manifest) ---

export type {
  ProviderCaptureOptions,
  ProviderCaptureResult,
  ProviderDiffOptions,
  ProviderDiffResult,
  ProviderPublishBaselineOptions,
  ProviderPublishBaselineResult,
  ProviderFetchBaselineOptions,
  ProviderBaselineData,
  ProviderCommentMeta,
  VisualProvider,
  SnapConfig
} from '@snapdrift/manifest';

// --- Migration types ---

export interface MigrateToSnapResult {
  uploaded: number;
  skipped: number;
  baselineId: string;
}

export interface ExportedBaseline {
  results: JsonObject;
  manifest: JsonObject;
  screenshots: Array<{ filename: string; data: Buffer }>;
  engine: { name: string; version: string };
}

// --- Init codemod types ---

export interface InitWarning {
  field: string;
  originalValue: string;
  message: string;
  severity: 'warning' | 'note';
}

export interface InitFromActionResult {
  configPath: string;
  warningsCount: number;
}

// --- CLI options (extended) ---

export interface CliOptions {
  command: string;
  open: boolean;
  configPath?: string;
  routes: string[];
  baselineDir: string;
  currentDir: string;
  diffDir: string;
  to?: 'snap' | 'local';
  from?: 'snap';
  acceptCrossEngine?: boolean;
  fromSnapAction?: string;
}
