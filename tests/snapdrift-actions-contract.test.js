/** @jest-environment node */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

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
    });
});
