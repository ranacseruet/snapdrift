/** @jest-environment node */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

describe('visual diff skipped summary helpers', () => {
    let tempDir;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-diff-summary-'));
    });

    afterEach(async () => {
        if (tempDir) {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });

    it('writes the no-visual-relevant-changes skipped summary with default messaging', async () => {
        const { writeVisualDiffSummary } = await import('../lib/visual-diff-summary.mjs');

        const result = await writeVisualDiffSummary({
            reason: 'no_visual_relevant_changes',
            outDir: tempDir
        });

        const summary = JSON.parse(await fs.readFile(result.summaryPath, 'utf8'));
        const markdown = await fs.readFile(result.markdownPath, 'utf8');

        expect(summary).toEqual({
            status: 'skipped',
            reason: 'no_visual_relevant_changes',
            message: 'No visual-relevant changes were detected in this pull request.',
            selectedRoutes: []
        });
        expect(markdown).toContain('- Status: skipped');
        expect(markdown).toContain('- Reason: no visual-relevant changes were detected in this pull request');
    });

    it('writes the missing-baseline skipped summary with current run metadata', async () => {
        const { writeVisualDiffSummary } = await import('../lib/visual-diff-summary.mjs');

        const result = await writeVisualDiffSummary({
            reason: 'missing_main_baseline_artifact',
            message: 'No non-expired visual baseline artifact named ui-foundation-visual-baseline was found.',
            baselineAvailable: false,
            currentResultsPath: '/tmp/current-results.json',
            selectedRouteIds: 'root-index-desktop,root-index-mobile',
            outDir: tempDir
        });

        const summary = JSON.parse(await fs.readFile(result.summaryPath, 'utf8'));
        const markdown = await fs.readFile(result.markdownPath, 'utf8');

        expect(summary).toEqual({
            status: 'skipped',
            reason: 'missing_main_baseline_artifact',
            message: 'No non-expired visual baseline artifact named ui-foundation-visual-baseline was found.',
            selectedRoutes: ['root-index-desktop', 'root-index-mobile'],
            baselineAvailable: false,
            currentResultsPath: '/tmp/current-results.json'
        });
        expect(markdown).toContain('- Current run: `/tmp/current-results.json`');
        expect(markdown).toContain('## Next action');
    });

    it('falls back to an underscore-decoded reason string for unknown skip reasons', async () => {
        const { buildVisualDiffSummary } = await import('../lib/visual-diff-summary.mjs');

        const { summary, markdown } = buildVisualDiffSummary({
            status: 'incomplete',
            reason: 'visual_scope_check_failed'
        });

        expect(summary).toEqual({
            status: 'incomplete',
            reason: 'visual_scope_check_failed',
            message: 'visual scope check failed',
            selectedRoutes: []
        });
        expect(markdown).toContain('- Status: incomplete');
        expect(markdown).toContain('- Reason: visual scope check failed');
    });
});
