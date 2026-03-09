/** @jest-environment node */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';

import {
    loadSnapdriftConfig,
    readFirstDefinedEnv,
    resolveFromWorkingDirectory,
    selectConfiguredRoutes,
    selectRoutesForChangedFiles,
    validateSnapdriftConfig
} from '../lib/snapdrift-config.mjs';

const validConfig = {
    baselineArtifactName: 'test-baseline',
    workingDirectory: '.',
    baseUrl: 'http://localhost:3000',
    resultsFile: 'results.json',
    manifestFile: 'manifest.json',
    screenshotsRoot: 'screenshots',
    routes: [
        { id: 'home-desktop', path: '/', viewport: 'desktop', changePaths: ['src/pages/home'] },
        { id: 'home-mobile', path: '/', viewport: 'mobile', changePaths: ['src/pages/mobile'] }
    ],
    diff: { threshold: 0.01, mode: 'report-only' },
    selection: {
        sharedPrefixes: ['src/components'],
        sharedExact: ['package-lock.json']
    }
};

async function writeConfig(filePath, config = validConfig) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(config, null, 2));
}

describe('snapdrift config helpers', () => {
    const envNames = [
        'SNAPDRIFT_CONFIG_PATH',
        'SNAPDRIFT_ROUTE_IDS'
    ];
    let tempDir;
    let originalEnv;
    let originalCwd;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-config-'));
        originalCwd = process.cwd();
        originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
        for (const envName of envNames) {
            delete process.env[envName];
        }
    });

    afterEach(async () => {
        process.chdir(originalCwd);
        for (const envName of envNames) {
            if (originalEnv[envName] === undefined) {
                delete process.env[envName];
            } else {
                process.env[envName] = originalEnv[envName];
            }
        }
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('readFirstDefinedEnv returns the first non-empty env var and ignores empty strings', () => {
        process.env.SNAPDRIFT_CONFIG_PATH = '';
        process.env.SNAPDRIFT_ROUTE_IDS = 'home-desktop';

        expect(readFirstDefinedEnv(['SNAPDRIFT_CONFIG_PATH', 'SNAPDRIFT_ROUTE_IDS'])).toBe('home-desktop');
    });

    it('validateSnapdriftConfig rejects a non-object root value', () => {
        expect(() => validateSnapdriftConfig(null, 'inline')).toThrow(/expected a JSON object/i);
    });

    it('validateSnapdriftConfig rejects non-object route entries', () => {
        expect(() => validateSnapdriftConfig({
            ...validConfig,
            routes: ['not-an-object']
        }, 'inline')).toThrow(/routes\[0\] must be an object/i);
    });

    it('validateSnapdriftConfig rejects routes with missing ids or paths', () => {
        expect(() => validateSnapdriftConfig({
            ...validConfig,
            routes: [{ id: ' ', path: '/', viewport: 'desktop' }]
        }, 'inline')).toThrow(/routes\[0\]\.id must be a non-empty string/i);

        expect(() => validateSnapdriftConfig({
            ...validConfig,
            routes: [{ id: 'home', path: ' ', viewport: 'desktop' }]
        }, 'inline')).toThrow(/routes\[0\]\.path must be a non-empty string/i);
    });

    it('validateSnapdriftConfig rejects a non-finite threshold', () => {
        expect(() => validateSnapdriftConfig({
            ...validConfig,
            diff: { threshold: Number.NaN, mode: 'report-only' }
        }, 'inline')).toThrow(/diff\.threshold must be a finite number/i);
    });

    it('validateSnapdriftConfig rejects malformed selection metadata', () => {
        expect(() => validateSnapdriftConfig({
            ...validConfig,
            selection: 'invalid'
        }, 'inline')).toThrow(/selection must be an object/i);

        expect(() => validateSnapdriftConfig({
            ...validConfig,
            selection: {
                sharedPrefixes: ['src/components'],
                sharedExact: ['README.md', '']
            }
        }, 'inline')).toThrow(/sharedExact/i);
    });

    it('loadSnapdriftConfig prefers an explicit configPath over env overrides', async () => {
        const explicitPath = path.join(tempDir, 'explicit.json');
        const envPath = path.join(tempDir, 'env.json');
        await writeConfig(explicitPath, { ...validConfig, baselineArtifactName: 'explicit' });
        await writeConfig(envPath, { ...validConfig, baselineArtifactName: 'env' });
        process.env.SNAPDRIFT_CONFIG_PATH = envPath;

        const { config, configPath } = await loadSnapdriftConfig(explicitPath);

        expect(config.baselineArtifactName).toBe('explicit');
        expect(configPath).toBe(explicitPath);
    });

    it('loadSnapdriftConfig uses env overrides when no explicit configPath is provided', async () => {
        const envPath = path.join(tempDir, 'env.json');
        await writeConfig(envPath, { ...validConfig, baselineArtifactName: 'env' });
        process.env.SNAPDRIFT_CONFIG_PATH = envPath;

        const { config, configPath } = await loadSnapdriftConfig();

        expect(config.baselineArtifactName).toBe('env');
        expect(configPath).toBe(envPath);
    });

    it('loadSnapdriftConfig loads .github/snapdrift.json from the current working directory by default', async () => {
        process.chdir(tempDir);
        await writeConfig(path.join(tempDir, '.github', 'snapdrift.json'), { ...validConfig, baselineArtifactName: 'default' });
        jest.resetModules();
        const { loadSnapdriftConfig: loadSnapdriftConfigFromCwd } = await import('../lib/snapdrift-config.mjs');
        const expectedConfigPath = await fs.realpath(path.join(tempDir, '.github', 'snapdrift.json'));

        const { config, configPath } = await loadSnapdriftConfigFromCwd();

        expect(config.baselineArtifactName).toBe('default');
        expect(configPath).toBe(expectedConfigPath);
    });

    it('loadSnapdriftConfig does not fall back to legacy config filenames', async () => {
        process.chdir(tempDir);
        jest.resetModules();
        const { loadSnapdriftConfig: loadSnapdriftConfigFromCwd } = await import('../lib/snapdrift-config.mjs');

        await expect(loadSnapdriftConfigFromCwd()).rejects.toThrow(/snapdrift\.json/);
    });

    it('resolveFromWorkingDirectory resolves relative paths from workingDirectory', () => {
        expect(resolveFromWorkingDirectory({
            ...validConfig,
            workingDirectory: '/tmp/snapdrift-app'
        }, 'qa-artifacts/results.json')).toBe('/tmp/snapdrift-app/qa-artifacts/results.json');
    });

    it('selectConfiguredRoutes returns all routes when no route ids are requested', () => {
        const selected = selectConfiguredRoutes(validConfig, []);

        expect(selected.selectedRouteIds).toEqual(['home-desktop', 'home-mobile']);
        expect(selected.routes).toHaveLength(2);
    });

    it('selectConfiguredRoutes throws when unknown route ids are requested', () => {
        expect(() => selectConfiguredRoutes(validConfig, ['missing-route'])).toThrow(/Unknown SnapDrift route ids/i);
    });

    it('selectRoutesForChangedFiles selects all routes for shared exact or shared prefix changes', () => {
        expect(selectRoutesForChangedFiles(validConfig, ['package-lock.json'])).toEqual({
            shouldRun: true,
            reason: 'shared_snapdrift_change',
            selectedRouteIds: ['home-desktop', 'home-mobile']
        });

        expect(selectRoutesForChangedFiles(validConfig, ['src/components/button.js'])).toEqual({
            shouldRun: true,
            reason: 'shared_snapdrift_change',
            selectedRouteIds: ['home-desktop', 'home-mobile']
        });
    });

    it('selectRoutesForChangedFiles scopes to route-specific change paths when applicable', () => {
        expect(selectRoutesForChangedFiles(validConfig, ['src/pages/mobile/header.tsx'])).toEqual({
            shouldRun: true,
            reason: 'scoped_snapdrift_change',
            selectedRouteIds: ['home-mobile']
        });
    });

    it('selectRoutesForChangedFiles returns no_snapdrift_relevant_changes for unrelated files', () => {
        expect(selectRoutesForChangedFiles(validConfig, ['README.md'])).toEqual({
            shouldRun: false,
            reason: 'no_snapdrift_relevant_changes',
            selectedRouteIds: []
        });
    });

    it('selectRoutesForChangedFiles returns no_changed_files when the change list is empty', () => {
        expect(selectRoutesForChangedFiles(validConfig, [])).toEqual({
            shouldRun: false,
            reason: 'no_changed_files',
            selectedRouteIds: []
        });
    });
});
