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
        const determineScope = await readAction('actions/determine-visual-diff-scope/action.yml');
        const publishComment = await readAction('actions/publish-visual-pr-comment/action.yml');
        const compare = await readAction('actions/compare-visual-results/action.yml');
        const stage = await readAction('actions/stage-visual-artifacts/action.yml');
        const evaluate = await readAction('actions/evaluate-visual-diff-outcome/action.yml');

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
        const publishBaseline = await readAction('actions/publish-visual-baseline/action.yml');
        const runPrDiff = await readAction('actions/run-visual-pr-diff/action.yml');

        expect(publishBaseline.inputs['repo-config-path'].default).toBe('.github/visual-regression.json');
        expect(publishBaseline.inputs['route-ids'].default).toBe('');
        expect(publishBaseline.inputs['artifact-retention-days'].default).toBe('30');
        expect(publishBaseline.inputs['upload-artifact'].default).toBe('true');
        expect(publishBaseline.outputs['artifact-name']).toBeTruthy();
        expect(publishBaseline.outputs['bundle-dir']).toBeTruthy();

        expect(runPrDiff.inputs['github-token'].required).toBe(true);
        expect(runPrDiff.inputs['comment-on-pr'].default).toBe('true');
        expect(runPrDiff.inputs['baseline-workflow-id'].default).toBe('ci.yml');
        expect(runPrDiff.inputs['baseline-branch'].default).toBe('main');
        expect(runPrDiff.outputs['status']).toBeTruthy();
        expect(runPrDiff.outputs['summary-path']).toBeTruthy();
        expect(runPrDiff.outputs['bundle-dir']).toBeTruthy();
    });

    it('wrapper actions self-provision Node so non-Node consumers do not need to', async () => {
        const publishBaseline = await readAction('actions/publish-visual-baseline/action.yml');
        const runPrDiff = await readAction('actions/run-visual-pr-diff/action.yml');

        function hasSetupNodeStep(action) {
            return (action.runs?.steps || []).some(
                (step) => typeof step.uses === 'string' && step.uses.startsWith('actions/setup-node@')
            );
        }

        expect(hasSetupNodeStep(publishBaseline)).toBe(true);
        expect(hasSetupNodeStep(runPrDiff)).toBe(true);
    });
});
