// @ts-check

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const packageName = process.argv[2];
const expectedExports = JSON.parse(process.argv[3] || '[]');
assert(typeof packageName === 'string' && packageName, 'A package name is required.');

const api = await import(packageName);
for (const name of expectedExports) {
  assert(Object.prototype.hasOwnProperty.call(api, name), `${packageName}: missing runtime export ${name}`);
}

const functionExports = {
  '@snapdrift/manifest': [
    'validateManifest', 'indexManifestEntries', 'indexRouteResults', 'viewportKey', 'viewportHash',
    'validateSnapdriftConfig', 'selectConfiguredRoutes', 'selectRoutesForChangedFiles', 'resolveFromWorkingDirectory',
    'splitCommaList', 'sanitizeRouteId', 'assertUniqueRouteIdFilenames', 'determineDriftStatus', 'shouldFailDriftCheck'
  ],
  '@snapdrift/compare-core': ['compareBuffers', 'generateDiffImage', 'compareWithIgnoreRegions'],
  '@snapdrift/adapter-report-md': [
    'makeMarkdown', 'formatViewport', 'formatDriftFailureMessage', 'buildDriftSummary', 'describeReason',
    'buildReportCommentBody', 'escapeMarkdown', 'generateHtmlReport'
  ],
  '@snapdrift/adapter-fs': [
    'loadSnapdriftConfig', 'readFirstDefinedEnv', 'comparePngs', 'resolveImagePath', 'loadJson',
    'clearFileIndexCache', 'generateDriftReport', 'runDriftCheckCli', 'stageArtifacts',
    'getDefaultArtifactBundleDir', 'writeDriftSummary', 'runBaselineCapture', 'assertNavigationOk'
  ]
};
for (const name of functionExports[packageName] || []) {
  assert.equal(typeof api[name], 'function', `${packageName}: ${name} is not callable`);
}

const validConfig = {
  baselineArtifactName: 'snapdrift-baseline',
  workingDirectory: '.',
  baseUrl: 'http://localhost:3000',
  resultsFile: 'results.json',
  manifestFile: 'manifest.json',
  screenshotsRoot: 'screenshots',
  routes: [{ id: 'home', path: '/', viewport: 'desktop' }],
  diff: { threshold: 0.01, mode: 'report-only' }
};

function makeSummary() {
  return {
    status: 'clean',
    selectedRoutes: [],
    matchedScreenshots: 0,
    changedScreenshots: 0,
    missingInBaseline: 0,
    missingInCurrent: 0,
    threshold: 0.01,
    diffMode: 'report-only',
    changed: [],
    missing: [],
    dimensionChanges: [],
    errors: [],
    baselineResultsPath: 'baseline/results.json',
    currentResultsPath: 'current/results.json'
  };
}

function solidPng(PNG, color) {
  const png = new PNG({ width: 2, height: 2 });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = color[0];
    png.data[index + 1] = color[1];
    png.data[index + 2] = color[2];
    png.data[index + 3] = color[3];
  }
  return PNG.sync.write(png);
}

if (packageName === '@snapdrift/manifest') {
  const config = api.validateSnapdriftConfig(validConfig);
  assert.deepEqual(api.selectConfiguredRoutes(config, ['home']).selectedRouteIds, ['home']);
  const manifest = api.validateManifest({
    generatedAt: '2024-01-01T00:00:00.000Z',
    baseUrl: config.baseUrl,
    screenshots: [{ id: 'home', path: '/', viewport: 'desktop', imagePath: 'screenshots/home.png', width: 1440, height: 900 }]
  });
  assert.equal(manifest.screenshots.length, 1);
} else if (packageName === '@snapdrift/compare-core') {
  const pngjs = await import('pngjs');
  const { PNG } = pngjs.default || pngjs;
  const baseline = solidPng(PNG, [0, 0, 0, 255]);
  const current = solidPng(PNG, [0, 0, 0, 255]);
  assert.equal(api.compareBuffers(baseline, current).mismatchRatio, 0);
  assert(Buffer.isBuffer(api.generateDiffImage(baseline, current)));
} else if (packageName === '@snapdrift/adapter-report-md') {
  const { summary, markdown } = api.buildDriftSummary({ reason: 'no_snapdrift_relevant_changes' });
  assert.equal(summary.status, 'skipped');
  assert.match(markdown, /SnapDrift Report/);
  assert.match(api.makeMarkdown(makeSummary()), /SnapDrift Report/);
} else if (packageName === '@snapdrift/adapter-fs') {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-runtime-smoke-'));
  try {
    const configPath = path.join(tempDir, 'snapdrift.json');
    await fs.writeFile(configPath, JSON.stringify(validConfig));
    const loaded = await api.loadSnapdriftConfig(configPath);
    assert.equal(loaded.config.routes[0].id, 'home');
    const written = await api.writeDriftSummary({ reason: 'no_snapdrift_relevant_changes', outDir: tempDir });
    assert.match(await fs.readFile(written.summaryPath, 'utf8'), /"status": "skipped"/);
    assert.match(await fs.readFile(written.markdownPath, 'utf8'), /SnapDrift Report/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
