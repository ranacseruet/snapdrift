/** @jest-environment node */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

async function readAction(actionPath) {
    return yaml.load(await fs.readFile(actionPath, 'utf8'));
}

describe('visual diff action contracts', () => {
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
        expect(evaluate.inputs['summary-path'].default).toBe('qa-artifacts/visual-diffs/current/visual-diff-summary.json');
    });

    it('uses artifact-type-specific default bundle directories at runtime', async () => {
        const { stageVisualArtifacts } = await import('../lib/stage-visual-artifacts.mjs');
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-stage-defaults-'));
        const originalCwd = process.cwd();

        try {
            process.chdir(tempDir);

            const baseline = await stageVisualArtifacts({ artifactType: 'baseline' });
            const diff = await stageVisualArtifacts({ artifactType: 'diff' });
            const expectedBaselineDir = await fs.realpath(path.join(tempDir, 'qa-artifacts', 'visual-baseline-artifact'));
            const expectedDiffDir = await fs.realpath(path.join(tempDir, 'qa-artifacts', 'visual-diff-artifact'));

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

        expect(baseline.inputs['repo-config-path'].default).toBe('.github/visual-regression.json');
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

    it('wrapper actions self-provision Node so non-Node consumers do not need to', async () => {
        const baseline = await readAction('actions/baseline/action.yml');
        const prDiff = await readAction('actions/pr-diff/action.yml');

        function hasSetupNodeStep(action) {
            return (action.runs?.steps || []).some(
                (step) => typeof step.uses === 'string' && step.uses.startsWith('actions/setup-node@')
            );
        }

        expect(hasSetupNodeStep(baseline)).toBe(true);
        expect(hasSetupNodeStep(prDiff)).toBe(true);
    });
});
