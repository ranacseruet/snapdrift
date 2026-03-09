/** @jest-environment node */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACTION_ROOT = path.resolve(__dirname, '..');
const ACTIONS_DIR = path.join(ACTION_ROOT, 'actions');

async function readAction(actionDir) {
    const raw = await fs.readFile(path.join(ACTIONS_DIR, actionDir, 'action.yml'), 'utf8');
    return yaml.load(raw);
}

async function listActionDirs() {
    const entries = await fs.readdir(ACTIONS_DIR, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

// ---------------------------------------------------------------------------
// Action YML structural smoke tests
// ---------------------------------------------------------------------------

describe('action YML structural integrity', () => {
    let actionDirs;
    let actions;

    beforeAll(async () => {
        actionDirs = await listActionDirs();
        actions = {};
        for (const dir of actionDirs) {
            actions[dir] = await readAction(dir);
        }
    });

    it('every action directory has a valid action.yml', () => {
        for (const dir of actionDirs) {
            expect(actions[dir]).toBeDefined();
            expect(actions[dir].name).toBeTruthy();
            expect(actions[dir].description).toBeTruthy();
            expect(actions[dir].runs).toBeDefined();
            expect(actions[dir].runs.using).toBe('composite');
        }
    });

    it('every action has at least one step', () => {
        for (const dir of actionDirs) {
            expect(actions[dir].runs.steps.length).toBeGreaterThan(0);
        }
    });

    it('all actions that reference ACTION_ROOT set it in the first step', () => {
        for (const dir of actionDirs) {
            const steps = actions[dir].runs.steps;
            const usesActionRoot = steps.some((step) =>
                typeof step.run === 'string' && step.run.includes('ACTION_ROOT')
            );
            if (usesActionRoot) {
                const firstStep = steps[0];
                expect(firstStep.run).toContain('ACTION_ROOT');
            }
        }
    });

    it('all required inputs are marked required', () => {
        for (const dir of actionDirs) {
            const inputs = actions[dir].inputs || {};
            for (const inputDef of Object.values(inputs)) {
                if (inputDef.required === true) {
                    expect(inputDef.default).toBeUndefined();
                }
            }
        }
    });

    it('covers the expected set of action directories', () => {
        const expected = [
            'baseline',
            'capture',
            'comment',
            'compare',
            'enforce',
            'pr-diff',
            'resolve-baseline',
            'scope',
            'stage'
        ];
        expect(actionDirs.sort()).toEqual(expected.sort());
    });
});

// ---------------------------------------------------------------------------
// Wrapper action input/output completeness
// ---------------------------------------------------------------------------

describe('wrapper action completeness', () => {
    let baseline;
    let prDiff;

    beforeAll(async () => {
        baseline = await readAction('baseline');
        prDiff = await readAction('pr-diff');
    });

    it('baseline exposes all required outputs', () => {
        const outputNames = Object.keys(baseline.outputs || {});
        expect(outputNames).toContain('artifact-name');
        expect(outputNames).toContain('bundle-dir');
        expect(outputNames).toContain('results-file');
        expect(outputNames).toContain('manifest-file');
        expect(outputNames).toContain('screenshots-root');
        expect(outputNames).toContain('selected-route-ids');
    });

    it('pr-diff exposes all required outputs', () => {
        const outputNames = Object.keys(prDiff.outputs || {});
        expect(outputNames).toContain('should-run');
        expect(outputNames).toContain('scope-reason');
        expect(outputNames).toContain('selected-route-ids');
        expect(outputNames).toContain('baseline-found');
        expect(outputNames).toContain('status');
        expect(outputNames).toContain('summary-path');
        expect(outputNames).toContain('markdown-path');
        expect(outputNames).toContain('artifact-name');
        expect(outputNames).toContain('bundle-dir');
    });

    it('pr-diff requires github-token', () => {
        expect(prDiff.inputs['github-token'].required).toBe(true);
    });

    it('baseline defaults repo-config-path to .github/snapdrift.json', () => {
        expect(baseline.inputs['repo-config-path'].default).toBe('.github/snapdrift.json');
    });

    it('pr-diff defaults repo-config-path to .github/snapdrift.json', () => {
        expect(prDiff.inputs['repo-config-path'].default).toBe('.github/snapdrift.json');
    });
});

// ---------------------------------------------------------------------------
// Viewport presets match documented contract
// ---------------------------------------------------------------------------

describe('viewport presets match contract', () => {
    let SNAPDRIFT_VIEWPORT_PRESETS;

    beforeAll(async () => {
        ({ SNAPDRIFT_VIEWPORT_PRESETS } = await import('../lib/snapdrift-config.mjs'));
    });

    it('desktop preset matches the documented contract', () => {
        expect(SNAPDRIFT_VIEWPORT_PRESETS.desktop).toEqual({
            width: 1440,
            height: 900,
            deviceScaleFactor: 1,
            isMobile: false,
            hasTouch: false
        });
    });

    it('mobile preset matches the documented contract', () => {
        expect(SNAPDRIFT_VIEWPORT_PRESETS.mobile).toEqual({
            width: 390,
            height: 844,
            deviceScaleFactor: 3,
            isMobile: true,
            hasTouch: true
        });
    });

    it('only desktop and mobile presets exist', () => {
        expect(Object.keys(SNAPDRIFT_VIEWPORT_PRESETS).sort()).toEqual(['desktop', 'mobile']);
    });
});

// ---------------------------------------------------------------------------
// Capture defaults match documented contract
// ---------------------------------------------------------------------------

describe('capture defaults match contract', () => {
    let SNAPDRIFT_NAVIGATION_TIMEOUT_MS;
    let SNAPDRIFT_SETTLE_DELAY_MS;

    beforeAll(async () => {
        ({ SNAPDRIFT_NAVIGATION_TIMEOUT_MS, SNAPDRIFT_SETTLE_DELAY_MS } = await import('../lib/snapdrift-config.mjs'));
    });

    it('navigation timeout is 30000ms', () => {
        expect(SNAPDRIFT_NAVIGATION_TIMEOUT_MS).toBe(30000);
    });

    it('settle delay is 300ms', () => {
        expect(SNAPDRIFT_SETTLE_DELAY_MS).toBe(300);
    });
});

// ---------------------------------------------------------------------------
// Config schema validation
// ---------------------------------------------------------------------------

describe('config schema validation', () => {
    let loadSnapdriftConfig;
    let tempDir;

    beforeAll(async () => {
        ({ loadSnapdriftConfig } = await import('../lib/snapdrift-config.mjs'));
    });

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-smoke-'));
    });

    afterEach(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    const validConfig = {
        baselineArtifactName: 'test-baseline',
        workingDirectory: '.',
        baseUrl: 'http://localhost:3000',
        resultsFile: 'results.json',
        manifestFile: 'manifest.json',
        screenshotsRoot: 'screenshots',
        routes: [{ id: 'home', path: '/', viewport: 'desktop' }],
        diff: { threshold: 0.01, mode: 'report-only' }
    };

    it('accepts a valid config with all required fields', async () => {
        const configPath = path.join(tempDir, 'valid.json');
        await fs.writeFile(configPath, JSON.stringify(validConfig));

        const { config } = await loadSnapdriftConfig(configPath);
        expect(config.baselineArtifactName).toBe('test-baseline');
    });

    it('accepts optional route selection metadata when it is well formed', async () => {
        const configPath = path.join(tempDir, 'valid-with-selection.json');
        await fs.writeFile(configPath, JSON.stringify({
            ...validConfig,
            routes: [{ id: 'home', path: '/', viewport: 'desktop', changePaths: ['src/pages/home'] }],
            selection: {
                sharedPrefixes: ['src/components'],
                sharedExact: ['package-lock.json']
            }
        }));

        const { config } = await loadSnapdriftConfig(configPath);
        expect(config.selection.sharedPrefixes).toEqual(['src/components']);
        expect(config.routes[0].changePaths).toEqual(['src/pages/home']);
    });

    it('rejects config missing baselineArtifactName', async () => {
        const { baselineArtifactName, ...invalid } = validConfig;
        const configPath = path.join(tempDir, 'invalid.json');
        await fs.writeFile(configPath, JSON.stringify(invalid));

        await expect(loadSnapdriftConfig(configPath)).rejects.toThrow(/Invalid/);
    });

    it('rejects config missing workingDirectory', async () => {
        const { workingDirectory, ...invalid } = validConfig;
        const configPath = path.join(tempDir, 'invalid.json');
        await fs.writeFile(configPath, JSON.stringify(invalid));

        await expect(loadSnapdriftConfig(configPath)).rejects.toThrow(/Invalid/);
    });

    it('rejects config missing routes', async () => {
        const { routes, ...invalid } = validConfig;
        const configPath = path.join(tempDir, 'invalid.json');
        await fs.writeFile(configPath, JSON.stringify(invalid));

        await expect(loadSnapdriftConfig(configPath)).rejects.toThrow(/Invalid/);
    });

    it('rejects config missing diff', async () => {
        const { diff, ...invalid } = validConfig;
        const configPath = path.join(tempDir, 'invalid.json');
        await fs.writeFile(configPath, JSON.stringify(invalid));

        await expect(loadSnapdriftConfig(configPath)).rejects.toThrow(/Invalid/);
    });

    it('rejects config with duplicate route ids', async () => {
        const configPath = path.join(tempDir, 'duplicate-route-ids.json');
        await fs.writeFile(configPath, JSON.stringify({
            ...validConfig,
            routes: [
                { id: 'home', path: '/', viewport: 'desktop' },
                { id: 'home', path: '/mobile', viewport: 'mobile' }
            ]
        }));

        await expect(loadSnapdriftConfig(configPath)).rejects.toThrow(/duplicate/i);
    });

    it('rejects config with an unsupported viewport preset', async () => {
        const configPath = path.join(tempDir, 'invalid-viewport.json');
        await fs.writeFile(configPath, JSON.stringify({
            ...validConfig,
            routes: [{ id: 'home', path: '/', viewport: 'tablet' }]
        }));

        await expect(loadSnapdriftConfig(configPath)).rejects.toThrow(/viewport/i);
    });

    it('rejects config with an unsupported diff mode', async () => {
        const configPath = path.join(tempDir, 'invalid-diff-mode.json');
        await fs.writeFile(configPath, JSON.stringify({
            ...validConfig,
            diff: { threshold: 0.01, mode: 'warn-only' }
        }));

        await expect(loadSnapdriftConfig(configPath)).rejects.toThrow(/diff\.mode/i);
    });

    it('rejects config with an out-of-range diff threshold', async () => {
        const configPath = path.join(tempDir, 'invalid-threshold.json');
        await fs.writeFile(configPath, JSON.stringify({
            ...validConfig,
            diff: { threshold: 1.5, mode: 'report-only' }
        }));

        await expect(loadSnapdriftConfig(configPath)).rejects.toThrow(/between 0 and 1/i);
    });

    it('rejects config with malformed change path selectors', async () => {
        const configPath = path.join(tempDir, 'invalid-change-paths.json');
        await fs.writeFile(configPath, JSON.stringify({
            ...validConfig,
            routes: [{ id: 'home', path: '/', viewport: 'desktop', changePaths: ['src/pages', ''] }]
        }));

        await expect(loadSnapdriftConfig(configPath)).rejects.toThrow(/changePaths/i);
    });

    it('rejects config with malformed shared selection rules', async () => {
        const configPath = path.join(tempDir, 'invalid-selection.json');
        await fs.writeFile(configPath, JSON.stringify({
            ...validConfig,
            selection: {
                sharedPrefixes: ['src/components', ''],
                sharedExact: ['README.md']
            }
        }));

        await expect(loadSnapdriftConfig(configPath)).rejects.toThrow(/sharedPrefixes/i);
    });

    it('rejects config missing manifestFile', async () => {
        const { manifestFile, ...invalid } = validConfig;
        const configPath = path.join(tempDir, 'invalid.json');
        await fs.writeFile(configPath, JSON.stringify(invalid));

        await expect(loadSnapdriftConfig(configPath)).rejects.toThrow(/Invalid/);
    });

    it('rejects config missing screenshotsRoot', async () => {
        const { screenshotsRoot, ...invalid } = validConfig;
        const configPath = path.join(tempDir, 'invalid.json');
        await fs.writeFile(configPath, JSON.stringify(invalid));

        await expect(loadSnapdriftConfig(configPath)).rejects.toThrow(/Invalid/);
    });

    it('rejects a nonexistent config path', async () => {
        await expect(
            loadSnapdriftConfig(path.join(tempDir, 'nonexistent.json'))
        ).rejects.toThrow();
    });
});

// ---------------------------------------------------------------------------
// Enforcement modes cover the full contract
// ---------------------------------------------------------------------------

describe('enforcement modes cover the full contract', () => {
    let shouldFailDriftCheck;

    beforeAll(async () => {
        ({ shouldFailDriftCheck } = await import('../lib/compare-results.mjs'));
    });

    const clean = {
        errors: [],
        dimensionChanges: [],
        missingInBaseline: 0,
        missingInCurrent: 0,
        changedScreenshots: 0
    };

    for (const mode of ['report-only', 'fail-on-changes', 'fail-on-incomplete', 'strict']) {
        it(`handles ${mode} mode without throwing`, () => {
            expect(() => shouldFailDriftCheck({ ...clean, diffMode: mode })).not.toThrow();
        });
    }
});

// ---------------------------------------------------------------------------
// Lib module exports are stable
// ---------------------------------------------------------------------------

describe('lib module exports are stable', () => {
    it('config module exports all expected symbols', async () => {
        const mod = await import('../lib/snapdrift-config.mjs');
        expect(typeof mod.loadSnapdriftConfig).toBe('function');
        expect(typeof mod.validateSnapdriftConfig).toBe('function');
        expect(typeof mod.readFirstDefinedEnv).toBe('function');
        expect(typeof mod.resolveFromWorkingDirectory).toBe('function');
        expect(typeof mod.selectConfiguredRoutes).toBe('function');
        expect(typeof mod.selectRoutesForChangedFiles).toBe('function');
        expect(typeof mod.splitCommaList).toBe('function');
        expect(typeof mod.DEFAULT_CONFIG_PATH).toBe('string');
        expect(Array.isArray(mod.VALID_DIFF_MODES)).toBe(true);
        expect(mod.SNAPDRIFT_VIEWPORT_PRESETS).toBeDefined();
        expect(typeof mod.SNAPDRIFT_NAVIGATION_TIMEOUT_MS).toBe('number');
        expect(typeof mod.SNAPDRIFT_SETTLE_DELAY_MS).toBe('number');
    });

    it('drift comparison module exports all expected symbols', async () => {
        const mod = await import('../lib/compare-results.mjs');
        expect(typeof mod.determineDriftStatus).toBe('function');
        expect(typeof mod.shouldFailDriftCheck).toBe('function');
        expect(typeof mod.formatDriftFailureMessage).toBe('function');
        expect(typeof mod.generateDriftReport).toBe('function');
        expect(typeof mod.runDriftCheckCli).toBe('function');
    });

    it('artifact staging module exports all expected symbols', async () => {
        const mod = await import('../lib/stage-artifacts.mjs');
        expect(typeof mod.stageArtifacts).toBe('function');
        expect(typeof mod.getDefaultArtifactBundleDir).toBe('function');
    });

    it('summary module exports all expected symbols', async () => {
        const mod = await import('../lib/drift-summary.mjs');
        expect(typeof mod.buildDriftSummary).toBe('function');
        expect(typeof mod.writeDriftSummary).toBe('function');
    });

    it('capture module exports runBaselineCapture', async () => {
        const mod = await import('../lib/capture-routes.mjs');
        expect(typeof mod.runBaselineCapture).toBe('function');
    });

    it('comment module exports all expected symbols', async () => {
        const mod = await import('../lib/pr-comment.mjs');
        expect(typeof mod.buildReportCommentBody).toBe('function');
        expect(typeof mod.PR_COMMENT_MARKER).toBe('string');
        expect(Array.isArray(mod.PR_COMMENT_MARKERS)).toBe(true);
        expect(mod.PR_COMMENT_MARKERS).toEqual([mod.PR_COMMENT_MARKER]);
    });
});

// ---------------------------------------------------------------------------
// Artifact bundle contracts
// ---------------------------------------------------------------------------

describe('artifact bundle directory structure', () => {
    let stageArtifacts;
    let tempDir;

    beforeAll(async () => {
        ({ stageArtifacts } = await import('../lib/stage-artifacts.mjs'));
    });

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-smoke-bundle-'));
    });

    afterEach(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('baseline bundle creates the contract directory structure', async () => {
        const bundleDir = path.join(tempDir, 'baseline-bundle');
        await stageArtifacts({ artifactType: 'baseline', bundleDir });

        const entries = await fs.readdir(bundleDir);
        expect(entries).toContain('screenshots');
    });

    it('diff bundle creates the contract directory structure', async () => {
        const bundleDir = path.join(tempDir, 'diff-bundle');
        await stageArtifacts({ artifactType: 'diff', bundleDir });

        const entries = await fs.readdir(bundleDir);
        expect(entries).toContain('baseline');
        expect(entries).toContain('current');
    });
});
