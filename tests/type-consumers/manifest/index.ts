import * as api from '@snapdrift/manifest';
import type {
  VisualRegressionConfig, VisualBaselineResults, VisualScreenshotManifest,
  VisualDiffSummary, VisualDriftSkippedSummary, VisualProvider, SnapConfig,
  ProviderCaptureOptions, ProviderDiffOptions, ProviderPublishBaselineOptions,
  ProviderFetchBaselineOptions, ProviderBaselineData, ProviderCommentMeta,
  ComparisonPolicy, ComparisonMetadata
} from '@snapdrift/manifest';

const snap: SnapConfig = { projectId: 'test', onUnavailable: 'fail', apiKeyEnv: 'SNAP_KEY' };
const config: VisualRegressionConfig = {
  baselineArtifactName: 'baseline', workingDirectory: '.', baseUrl: 'https://example.com',
  resultsFile: 'results.json', manifestFile: 'manifest.json', screenshotsRoot: 'screenshots',
  routes: [{ id: 'home', path: '/', viewport: 'desktop' }],
  diff: { threshold: 0.01, mode: 'strict', comparisonPolicy: { version: 1, threshold: 0.01 } }, provider: 'snap', snap
};
const policy: ComparisonPolicy = config.diff.comparisonPolicy!;
const comparison: ComparisonMetadata = {
  baseline: { width: 1, height: 1 },
  current: { width: 2, height: 1 },
  canvas: { width: 2, height: 1 },
  dimensionsChanged: true,
  totalPixels: 2
};
policy.threshold.toFixed();
comparison.canvas.width.toFixed();
const validated: VisualRegressionConfig = api.validateSnapdriftConfig(config, 'fixture');
api.splitCommaList('home');
api.resolveFromWorkingDirectory(validated, 'results.json').toUpperCase();
api.selectConfiguredRoutes(config, new Set(['home'])).routes[0].id.toUpperCase();
api.selectRoutesForChangedFiles(config, ['src/home.ts']).shouldRun.valueOf();
api.sanitizeRouteId('home/page').toUpperCase();
api.assertUniqueRouteIdFilenames(['home', 'about']);
const manifest: VisualScreenshotManifest = api.validateManifest({
  generatedAt: new Date().toISOString(), baseUrl: 'https://example.com',
  screenshots: [{ id: 'home', path: '/', viewport: 'desktop', imagePath: 'home.png', width: 1, height: 1 }]
});
api.indexManifestEntries(manifest, ['home']).get('home')?.width.toFixed();
const results: VisualBaselineResults = { startedAt: '', baseUrl: '', suite: '', routes: [] };
api.indexRouteResults(results).get('home')?.status.toUpperCase();
api.CURRENT_SCHEMA_VERSION.toFixed();
api.viewportKey('mobile').toUpperCase();
api.viewportHash(api.VIEWPORT_PRESETS.desktop).toUpperCase();
api.VIEWPORT_PRESETS.mobile.hasTouch.valueOf();
api.VALID_DIFF_MODES.includes('strict');
api.VALID_PROVIDER_VALUES.includes('snap');
api.VALID_ON_UNAVAILABLE_MODES.includes('fail');
api.SNAPDRIFT_NAVIGATION_TIMEOUT_MS.toFixed();
api.SNAPDRIFT_SETTLE_DELAY_MS.toFixed();
api.determineDriftStatus({ changedScreenshots: 0 }).toUpperCase();
api.shouldFailDriftCheck({ diffMode: 'strict', changedScreenshots: 1 });
const skipped: VisualDriftSkippedSummary = { status: 'skipped', reason: 'snap_unavailable' };
api.shouldFailDriftCheck(skipped);
declare const provider: VisualProvider;
declare const summary: VisualDiffSummary;
const captureOptions: ProviderCaptureOptions = { purpose: 'diff', routeIds: ['home'] };
const diffOptions: ProviderDiffOptions = { routeIds: ['home'] };
const publishOptions: ProviderPublishBaselineOptions = { resultsPath: 'results.json' };
const fetchOptions: ProviderFetchBaselineOptions = { githubToken: 'fixture' };
const meta: ProviderCommentMeta = { maxChangedRows: 5 };
provider.capture(captureOptions).then(result => result.selectedRouteIds[0].toUpperCase());
provider.diff(diffOptions).then(result => result.summary.threshold.toFixed());
provider.publishBaseline(publishOptions).then(result => result.bundleDir.toUpperCase());
provider.fetchLatestBaseline(fetchOptions).then((baseline: ProviderBaselineData | null) => baseline?.headSha.toUpperCase());
provider.buildCommentBody(summary, meta).toUpperCase();
provider.buildCommentBody(skipped).toUpperCase();
// @ts-expect-error invalid viewport preset
api.viewportKey('tablet');
const customPreset: string = 'tablet';
api.VIEWPORT_PRESETS[customPreset]?.width.toFixed();
// @ts-expect-error unknown preset lookups can be undefined
api.VIEWPORT_PRESETS[customPreset].width.toFixed();
config.diff.mode = api.VALID_DIFF_MODES[0];
// @ts-expect-error descriptor dimensions must be numeric
api.viewportHash({ width: '1440', height: 900 });
// @ts-expect-error route IDs must be strings
api.selectConfiguredRoutes(config, [1]);
// @ts-expect-error filename sanitizer returns a string
const wrongFilename: number = api.sanitizeRouteId('home');
// @ts-expect-error capture purposes are a finite union
provider.capture({ purpose: 'publish' });
// @ts-expect-error diff threshold is numeric
config.diff.threshold = '0.1';

// @ts-expect-error typo is not a report summary
provider.buildCommentBody({ totalScrenshots: 5 });
// @ts-expect-error unrelated configs are not summaries
provider.buildCommentBody(config);
