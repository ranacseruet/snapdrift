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
