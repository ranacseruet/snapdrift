import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { stageArtifacts, getDefaultArtifactBundleDir } from '../src/stage.mjs';

describe('@snapdrift/adapter-fs — stage', () => {
  describe('getDefaultArtifactBundleDir', () => {
    test('returns baseline path', () => {
      expect(getDefaultArtifactBundleDir('baseline')).toContain('baseline');
    });

    test('returns diff path', () => {
      expect(getDefaultArtifactBundleDir('diff')).toContain('drift');
    });
  });

  describe('stageArtifacts', () => {
    test('creates a baseline bundle with results and manifest', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-stage-'));
      const resultsPath = path.join(tmpDir, 'results.json');
      const manifestPath = path.join(tmpDir, 'manifest.json');
      await fs.writeFile(resultsPath, JSON.stringify({ passed: true }));
      await fs.writeFile(manifestPath, JSON.stringify({ screenshots: [] }));

      const bundleDir = path.join(tmpDir, 'bundle');
      const { bundleDir: resolved } = await stageArtifacts({
        artifactType: 'baseline',
        bundleDir,
        resultsPath,
        manifestPath
      });

      expect(resolved).toBe(path.resolve(bundleDir));
      const results = JSON.parse(await fs.readFile(path.join(resolved, 'results.json'), 'utf8'));
      expect(results.passed).toBe(true);
      const manifest = JSON.parse(await fs.readFile(path.join(resolved, 'manifest.json'), 'utf8'));
      expect(manifest.screenshots).toEqual([]);

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    test('creates a diff bundle with summary and baseline/current data', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-stage-'));
      const summaryJsonPath = path.join(tmpDir, 'summary.json');
      const summaryMarkdownPath = path.join(tmpDir, 'summary.md');
      const baselineResultsPath = path.join(tmpDir, 'baseline-results.json');
      const currentResultsPath = path.join(tmpDir, 'current-results.json');
      const baselineManifestPath = path.join(tmpDir, 'baseline-manifest.json');
      const currentManifestPath = path.join(tmpDir, 'current-manifest.json');

      await fs.writeFile(summaryJsonPath, JSON.stringify({ status: 'clean' }));
      await fs.writeFile(summaryMarkdownPath, '# Report');
      await fs.writeFile(baselineResultsPath, JSON.stringify({ baseline: true }));
      await fs.writeFile(currentResultsPath, JSON.stringify({ current: true }));
      await fs.writeFile(baselineManifestPath, JSON.stringify({ baseline: true }));
      await fs.writeFile(currentManifestPath, JSON.stringify({ current: true }));

      const bundleDir = path.join(tmpDir, 'bundle');
      const { bundleDir: resolved } = await stageArtifacts({
        artifactType: 'diff',
        bundleDir,
        summaryJsonPath,
        summaryMarkdownPath,
        baselineResultsPath,
        currentResultsPath,
        baselineManifestPath,
        currentManifestPath
      });

      const summary = JSON.parse(await fs.readFile(path.join(resolved, 'summary.json'), 'utf8'));
      expect(summary.status).toBe('clean');
      const baseline = JSON.parse(await fs.readFile(path.join(resolved, 'baseline', 'results.json'), 'utf8'));
      expect(baseline.baseline).toBe(true);
      const current = JSON.parse(await fs.readFile(path.join(resolved, 'current', 'results.json'), 'utf8'));
      expect(current.current).toBe(true);

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    test('removes previous bundle directory before staging', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-stage-'));
      const bundleDir = path.join(tmpDir, 'bundle');
      const staleFile = path.join(bundleDir, 'stale.txt');
      await fs.mkdir(bundleDir, { recursive: true });
      await fs.writeFile(staleFile, 'old data');

      await stageArtifacts({
        artifactType: 'baseline',
        bundleDir
      });

      await expect(fs.access(staleFile)).rejects.toThrow();

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    test('skips missing source files gracefully', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-stage-'));
      const bundleDir = path.join(tmpDir, 'bundle');

      const { bundleDir: resolved } = await stageArtifacts({
        artifactType: 'baseline',
        bundleDir,
        resultsPath: '/nonexistent/results.json'
      });

      // results.json should not exist in bundle since source was missing
      await expect(fs.access(path.join(resolved, 'results.json'))).rejects.toThrow();

      await fs.rm(tmpDir, { recursive: true, force: true });
    });
  });
});