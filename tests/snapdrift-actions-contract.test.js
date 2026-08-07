/** @jest-environment node */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as yaml from 'js-yaml';

async function readAction(actionPath) {
    return yaml.load(await fs.readFile(actionPath, 'utf8'));
}

describe('SnapDrift action contracts', () => {
    it('keeps the low-level defaulted inputs ergonomic', async () => {
        const determineScope = await readAction('actions/scope/action.yml');
        const publishComment = await readAction('actions/comment/action.yml');
        const compare = await readAction('actions/compare/action.yml');
        const stage = await readAction('actions/stage/action.yml');
        const evaluate = await readAction('actions/enforce/action.yml');

        expect(determineScope.inputs['pr-number'].required).toBe(false);
        expect(publishComment.inputs['pr-number'].required).toBe(false);
        expect(compare.inputs['current-results-path'].default).toBe('');
        expect(compare.inputs['current-manifest-path'].default).toBe('');
        expect(compare.inputs['current-run-dir'].default).toBe('');
        expect(stage.inputs['bundle-dir'].default).toBe('');
        expect(evaluate.inputs['summary-path'].default).toBe('qa-artifacts/snapdrift/drift/current/summary.json');
    });

    it('uses artifact-type-specific default bundle directories at runtime', async () => {
        const { stageArtifacts } = await import('../lib/stage-artifacts.mjs');
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-stage-defaults-'));
        const originalCwd = process.cwd();

        try {
            process.chdir(tempDir);

            const baseline = await stageArtifacts({ artifactType: 'baseline' });
            const diff = await stageArtifacts({ artifactType: 'diff' });
            const expectedBaselineDir = await fs.realpath(path.join(tempDir, 'qa-artifacts', 'snapdrift', 'bundles', 'baseline'));
            const expectedDiffDir = await fs.realpath(path.join(tempDir, 'qa-artifacts', 'snapdrift', 'bundles', 'drift'));

            expect(baseline.bundleDir).toBe(expectedBaselineDir);
            expect(diff.bundleDir).toBe(expectedDiffDir);
        } finally {
            process.chdir(originalCwd);
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });

    it('defines the wrapper actions as the primary public entrypoints', async () => {
        const baseline = await readAction('actions/baseline/action.yml');
        const prDiff = await readAction('actions/pr-diff/action.yml');

        expect(baseline.inputs['repo-config-path'].default).toBe('.github/snapdrift.json');
        expect(baseline.inputs['route-ids'].default).toBe('');
        expect(baseline.inputs['artifact-retention-days'].default).toBe('30');
        expect(baseline.inputs['upload-artifact'].default).toBe('true');
        expect(baseline.outputs['artifact-name']).toBeTruthy();
        expect(baseline.outputs['bundle-dir']).toBeTruthy();

        expect(prDiff.inputs['github-token'].required).toBe(true);
        expect(prDiff.inputs['comment-on-pr'].default).toBe('true');
        expect(prDiff.inputs['baseline-workflow-id'].default).toBe('ci.yml');
        expect(prDiff.inputs['baseline-branch'].default).toBe('main');
        expect(prDiff.outputs['status']).toBeTruthy();
        expect(prDiff.outputs['summary-path']).toBeTruthy();
        expect(prDiff.outputs['bundle-dir']).toBeTruthy();
    });

    it('actions that shell out to node or npm self-provision Node 22', async () => {
        const baseline = await readAction('actions/baseline/action.yml');
        const capture = await readAction('actions/capture/action.yml');
        const compare = await readAction('actions/compare/action.yml');
        const prDiff = await readAction('actions/pr-diff/action.yml');
        const stage = await readAction('actions/stage/action.yml');
        const enforce = await readAction('actions/enforce/action.yml');

        function hasSetupNode22Step(action) {
            return (action.runs?.steps || []).some(
                (step) => typeof step.uses === 'string'
                    && step.uses.startsWith('actions/setup-node@')
                    && step.with?.['node-version'] === '22'
            );
        }

        expect(hasSetupNode22Step(baseline)).toBe(true);
        expect(hasSetupNode22Step(capture)).toBe(true);
        expect(hasSetupNode22Step(compare)).toBe(true);
        expect(hasSetupNode22Step(prDiff)).toBe(true);
        expect(hasSetupNode22Step(stage)).toBe(true);
        expect(hasSetupNode22Step(enforce)).toBe(true);
    });

    it('pr-diff keeps its baseline lookup and fallback comment paths wired correctly', async () => {
        const prDiff = await readAction('actions/pr-diff/action.yml');
        const steps = prDiff.runs?.steps || [];
        const baselineStep = steps.find((step) => step.id === 'baseline');
        const commentStep = steps.find(
            (step) => step.with?.script && String(step.with.script).includes('SnapDrift did not produce a summary.')
        );

        expect(baselineStep.env.INPUT_ARTIFACT_NAME).toBeUndefined();
        expect(baselineStep.with.script).toContain('const artifactName = config.baselineArtifactName;');
        expect(commentStep.with.script).toContain("const repoUrl = 'https://github.com/ranacseruet/snapdrift';");
        expect(commentStep.with.script).toContain('Powered by <a href="${repoUrl}">SnapDrift</a>');
        expect(commentStep.with.script).toContain('createProvider');
        expect(commentStep.with.script).toContain('buildCommentBody');
    });

    it('installs Playwright for Snap local-capture hybrid runs', async () => {
        const baseline = await readAction('actions/baseline/action.yml');
        const prDiff = await readAction('actions/pr-diff/action.yml');

        const baselineConfig = baseline.runs.steps.find((step) => step.id === 'config');
        const baselineInstall = baseline.runs.steps.find((step) => step.name === 'Install Playwright Chromium');
        const prDiffConfig = prDiff.runs.steps.find((step) => step.id === 'config');
        const prDiffInstall = prDiff.runs.steps.find((step) => step.name === 'Install Playwright Chromium');

        expect(baselineConfig.run).toContain('isLocalBaseUrl(config.baseUrl)');
        expect(baselineConfig.run).toContain('snap_local_capture=');
        expect(baselineInstall.if).toContain("steps.config.outputs.snap_local_capture == 'true'");

        expect(prDiffConfig.run).toContain('isLocalBaseUrl(config.baseUrl)');
        expect(prDiffConfig.run).toContain('snap_local_capture=');
        expect(prDiffInstall.if).toContain("steps.config.outputs.snap_local_capture == 'true'");
    });

    // Every outage path is implemented once, in lib/outage-policy.mjs, and
    // exercised by tests/outage-policy.test.js. These assertions only guard the
    // wiring: that the wrappers route through it and thread its results on to
    // the steps that consume them. See ranacseruet/snapdrift#125.
    describe('Snap outage handling', () => {
        it('routes every wrapper phase through the shared outage policy', async () => {
            const baseline = await readAction('actions/baseline/action.yml');
            const prDiff = await readAction('actions/pr-diff/action.yml');

            const baselineCapture = baseline.runs.steps.find((step) => step.id === 'capture');
            const baselinePublish = baseline.runs.steps.find((step) => step.id === 'publish');
            const prDiffCapture = prDiff.runs.steps.find((step) => step.id === 'capture');
            const prDiffCompare = prDiff.runs.steps.find((step) => step.id === 'compare');

            expect(baselineCapture.run).toContain('captureWithPolicy');
            expect(baselinePublish.run).toContain('publishBaselineWithPolicy');
            expect(prDiffCapture.run).toContain('captureWithPolicy');
            expect(prDiffCompare.run).toContain('diffWithPolicy');
        });

        it('reports the effective provider so a local fallback is not diffed by Snap', async () => {
            const baseline = await readAction('actions/baseline/action.yml');
            const prDiff = await readAction('actions/pr-diff/action.yml');

            const baselineCapture = baseline.runs.steps.find((step) => step.id === 'capture');
            const prDiffCapture = prDiff.runs.steps.find((step) => step.id === 'capture');
            const prDiffCompare = prDiff.runs.steps.find((step) => step.id === 'compare');

            expect(baselineCapture.run).toContain('provider=${captured.providerName}');
            expect(prDiffCapture.run).toContain('provider=${captured.providerName}');
            expect(prDiffCompare.env.CAPTURE_PROVIDER).toBe('${{ steps.capture.outputs.provider }}');
            expect(prDiffCompare.run).toContain('process.env.CAPTURE_PROVIDER');
        });

        it('writes a skipped summary for warn-and-skip rather than leaving the report empty', async () => {
            const prDiff = await readAction('actions/pr-diff/action.yml');
            const steps = prDiff.runs.steps;
            const capture = steps.find((step) => step.id === 'capture');
            const compare = steps.find((step) => step.id === 'compare');
            const stage = steps.find((step) => step.id === 'stage');
            const commentStep = steps.find(
                (step) => step.with?.script && String(step.with.script).includes('SnapDrift did not produce a summary.')
            );

            expect(capture.run).toContain('writeDriftSummary');
            expect(compare.run).toContain('writeDriftSummary');

            // The skipped summary is only useful if the staging and reporting
            // steps can actually find it.
            expect(stage.env.SUMMARY_JSON_PATH).toContain('steps.capture.outputs.summary_path');
            expect(commentStep.env.SUMMARY_PATH).toContain('steps.capture.outputs.summary_path');
        });

        it('threads a diff-time local recapture into the staged bundle', async () => {
            const prDiff = await readAction('actions/pr-diff/action.yml');
            const compare = prDiff.runs.steps.find((step) => step.id === 'compare');
            const stage = prDiff.runs.steps.find((step) => step.id === 'stage');

            expect(compare.env.LOCAL_SCREENSHOTS).toBe('${{ steps.capture.outputs.local_screenshots }}');
            expect(compare.run).toContain('current_results_file=');
            expect(stage.env.CURRENT_RESULTS_PATH).toContain('steps.compare.outputs.current_results_file');
            expect(stage.env.CURRENT_MANIFEST_PATH).toContain('steps.compare.outputs.current_manifest_file');
            expect(stage.env.CURRENT_SCREENSHOTS_ROOT).toContain('steps.compare.outputs.current_screenshots_root');
        });

        it('does not enforce diff.mode against a skipped summary', async () => {
            const prDiff = await readAction('actions/pr-diff/action.yml');
            const enforce = prDiff.runs.steps.find(
                (step) => typeof step.run === 'string' && step.run.includes('shouldFailDriftCheck')
            );
            const skippedBaseline = prDiff.runs.steps.find((step) => step.id === 'skipped_baseline');

            expect(enforce.if).toContain("steps.capture.outputs.provider != 'skipped'");
            expect(enforce.if).toContain("steps.compare.outputs.skipped != 'true'");
            // A skipped capture already wrote the summary; skipped_baseline must
            // not overwrite it with a different reason.
            expect(skippedBaseline.if).toContain("steps.capture.outputs.provider != 'skipped'");
        });

        it('stages and uploads a baseline captured by a publish-time local fallback', async () => {
            const baseline = await readAction('actions/baseline/action.yml');
            const stage = baseline.runs.steps.find((step) => step.id === 'stage');
            const upload = baseline.runs.steps.find(
                (step) => typeof step.uses === 'string' && step.uses.startsWith('actions/upload-artifact@')
            );

            expect(stage.if).toContain("steps.publish.outputs.provider == 'local'");
            expect(upload.if).toContain("steps.publish.outputs.provider == 'local'");
            expect(stage.env.RESULTS_PATH).toContain('steps.publish.outputs.results_file');
            expect(baseline.outputs['results-file'].value).toContain('steps.publish.outputs.results_file');
        });
    });
});
