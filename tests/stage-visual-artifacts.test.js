/** @jest-environment node */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function writeFile(filePath, content = '') {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
}

describe('stage artifact bundles helper', () => {
    let tempDir;
    let originalCwd;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stage-snapdrift-artifacts-'));
        originalCwd = process.cwd();
        process.chdir(tempDir);
    });

    afterEach(async () => {
        process.chdir(originalCwd);
        if (tempDir) {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });

    it('stages a baseline bundle and recursively copies only png screenshots', async () => {
        const { stageArtifacts } = await import('../lib/stage-visual-artifacts.mjs');

        const resultsPath = path.join(tempDir, 'inputs', 'results.json');
        const manifestPath = path.join(tempDir, 'inputs', 'manifest.json');
        const screenshotsDir = path.join(tempDir, 'inputs', 'screenshots');

        await writeFile(resultsPath, '{"passed":true}\n');
        await writeFile(manifestPath, '{"screenshots":[]}\n');
        await writeFile(path.join(screenshotsDir, 'root-index-desktop.png'), 'desktop-png');
        await writeFile(path.join(screenshotsDir, 'nested', 'root-index-mobile.png'), 'mobile-png');
        await writeFile(path.join(screenshotsDir, 'nested', 'readme.txt'), 'ignore-me');

        const result = await stageArtifacts({
            artifactType: 'baseline',
            resultsPath,
            manifestPath,
            screenshotsDir
        });

        expect(await fs.readFile(path.join(result.bundleDir, 'results.json'), 'utf8')).toBe('{"passed":true}\n');
        expect(await fs.readFile(path.join(result.bundleDir, 'manifest.json'), 'utf8')).toBe('{"screenshots":[]}\n');
        expect(await fs.readFile(path.join(result.bundleDir, 'screenshots', 'root-index-desktop.png'), 'utf8')).toBe('desktop-png');
        expect(await fs.readFile(path.join(result.bundleDir, 'screenshots', 'root-index-mobile.png'), 'utf8')).toBe('mobile-png');
        await expect(fs.access(path.join(result.bundleDir, 'screenshots', 'readme.txt'))).rejects.toThrow();
    });

    it('stages a drift bundle, supports custom bundle dirs, and tolerates missing optional inputs', async () => {
        const { stageArtifacts } = await import('../lib/stage-visual-artifacts.mjs');

        const bundleDir = path.join(tempDir, 'custom-bundle');
        const summaryJsonPath = path.join(tempDir, 'inputs', 'summary.json');
        const currentResultsPath = path.join(tempDir, 'inputs', 'current-results.json');
        const baselineManifestPath = path.join(tempDir, 'inputs', 'baseline-manifest.json');
        const currentScreenshotsDir = path.join(tempDir, 'inputs', 'current-screenshots');

        await writeFile(summaryJsonPath, '{"status":"clean"}\n');
        await writeFile(currentResultsPath, '{"routes":[]}\n');
        await writeFile(baselineManifestPath, '{"screenshots":[]}\n');
        await writeFile(path.join(currentScreenshotsDir, 'tool-desktop.png'), 'tool-png');

        const result = await stageArtifacts({
            artifactType: 'diff',
            bundleDir,
            summaryJsonPath,
            currentResultsPath,
            baselineManifestPath,
            currentScreenshotsDir,
            summaryMarkdownPath: path.join(tempDir, 'inputs', 'missing-summary.md'),
            baselineResultsPath: undefined,
            currentManifestPath: path.join(tempDir, 'inputs', 'missing-current-manifest.json'),
            baselineScreenshotsDir: path.join(tempDir, 'inputs', 'missing-baseline-screenshots')
        });

        expect(result.bundleDir).toBe(bundleDir);
        expect(await fs.readFile(path.join(bundleDir, 'summary.json'), 'utf8')).toBe('{"status":"clean"}\n');
        expect(await fs.readFile(path.join(bundleDir, 'current', 'results.json'), 'utf8')).toBe('{"routes":[]}\n');
        expect(await fs.readFile(path.join(bundleDir, 'baseline', 'manifest.json'), 'utf8')).toBe('{"screenshots":[]}\n');
        expect(await fs.readFile(path.join(bundleDir, 'current', 'screenshots', 'tool-desktop.png'), 'utf8')).toBe('tool-png');
        await expect(fs.access(path.join(bundleDir, 'summary.md'))).rejects.toThrow();
        await expect(fs.access(path.join(bundleDir, 'baseline', 'results.json'))).rejects.toThrow();
        await expect(fs.access(path.join(bundleDir, 'current', 'manifest.json'))).rejects.toThrow();
    });
});
