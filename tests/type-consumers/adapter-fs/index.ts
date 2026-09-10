import * as api from '@snapdrift/adapter-fs';
import type { GenerateDriftReportOptions, RunDriftCheckCliOptions, RunBaselineCaptureOptions, StageArtifactsOptions, WriteDriftSummaryOptions } from '@snapdrift/adapter-fs';
import type { ComparisonPolicy } from '@snapdrift/manifest';

api.DEFAULT_CONFIG_PATH.toUpperCase();
api.SNAPDRIFT_CAPTURE_CONCURRENCY.toFixed();
api.readFirstDefinedEnv(['SNAP_KEY'])?.toUpperCase();
api.loadSnapdriftConfig().then(({ config, configPath }) => {
  config.routes[0].viewport;
  configPath.toUpperCase();
});
api.comparePngs('before.png', 'after.png').then(result => {
  result.mismatchRatio.toFixed();
  result.pct.toFixed();
  result.pixelsChanged.toFixed();
});
const comparisonPolicy: ComparisonPolicy = { version: 1, threshold: 0.1 };
api.comparePngs('before.png', 'after.png', { comparisonPolicy }).then(result => {
  result.comparison.dimensionsChanged.valueOf();
  result.diffImageBuffer.toString('base64');
});
api.resolveImagePath('.', 'image.png').then(path => path.toUpperCase());
api.loadJson<{ name: string }>('input.json', 'fixture').then(data => data.name.toUpperCase());
api.clearFileIndexCache();
const report: GenerateDriftReportOptions = { routeIds: new Set(['home']), currentRunDir: '.', diffImagesDir: './diffs' };
api.generateDriftReport(report).then(result => result.summary.threshold.toFixed());
const cli: RunDriftCheckCliOptions = { ...report, enforceOutcome: false };
api.runDriftCheckCli(cli);
api.getDefaultArtifactBundleDir('baseline').toUpperCase();
const stage: StageArtifactsOptions = { artifactType: 'diff', bundleDir: 'bundle', diffImagesDir: './diffs' };
api.stageArtifacts(stage).then(result => result.bundleDir.toUpperCase());
const skipped: WriteDriftSummaryOptions = { status: 'skipped', reason: 'scope', selectedRouteIds: 'home' };
api.writeDriftSummary(skipped).then(result => result.markdown.toUpperCase());
const capture: RunBaselineCaptureOptions = { routeIds: new Set(['home']), outDir: 'capture' };
api.runBaselineCapture(capture).then(result => result.selectedRouteIds[0].toUpperCase());
api.assertNavigationOk({ status: () => 200 }, { id: 'home', path: '/', viewport: 'desktop' }, 'https://example.com');
api.assertNavigationOk(null, { id: 'home', path: '/', viewport: 'mobile' }, 'about:blank');
// @ts-expect-error config path is a string
api.loadSnapdriftConfig(42);
// @ts-expect-error invalid stage type
api.stageArtifacts({ artifactType: 'unknown' });
// @ts-expect-error route selection contains strings
api.runBaselineCapture({ routeIds: [42] });
// @ts-expect-error navigation status must be a function
api.assertNavigationOk({ status: 200 }, { id: 'home', path: '/', viewport: 'desktop' }, '/');
// @ts-expect-error alias is a number, not a string
api.comparePngs('a', 'b').then(result => result.pct.toUpperCase());
