/** @jest-environment node */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

describe('SnapDrift skipped summary helpers', () => {
    let tempDir;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-summary-'));
    });

    afterEach(async () => {
        if (tempDir) {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });

    it('writes the no-drift-relevant-changes skipped summary with default messaging', async () => {
        const { writeDriftSummary } = await import('../lib/drift-summary.mjs');

        const result = await writeDriftSummary({
            reason: 'no_snapdrift_relevant_changes',
            outDir: tempDir
        });

        const summary = JSON.parse(await fs.readFile(result.summaryPath, 'utf8'));
        const markdown = await fs.readFile(result.markdownPath, 'utf8');

        expect(summary).toEqual({
            status: 'skipped',
            reason: 'no_snapdrift_relevant_changes',
            message: 'No drift-relevant changes were detected in this pull request.',
            selectedRoutes: []
        });
        expect(path.basename(result.summaryPath)).toBe('summary.json');
        expect(path.basename(result.markdownPath)).toBe('summary.md');
        expect(markdown).toContain('<img src="https://raw.githubusercontent.com/ranacseruet/snapdrift/main/assets/snapdrift-logo-icon.png" alt="SnapDrift" width="24" height="24" />');
        expect(markdown).toContain('# ⏭️ SnapDrift Report — Skipped');
        expect(markdown).toContain('| Selected routes | Baseline available | Current capture |');
        expect(markdown).toContain('| 0 | n/a | n/a |');
        expect(markdown).toContain('> **Reason:** no drift-relevant changes were detected in this pull request');
        expect(markdown).toContain('> **Details:** No drift-relevant changes were detected in this pull request.');
        expect(markdown).toContain('Powered by <a href="https://github.com/ranacseruet/snapdrift">SnapDrift</a>');
    });

    it('writes the missing-baseline skipped summary with current run metadata', async () => {
        const { writeDriftSummary } = await import('../lib/drift-summary.mjs');

        const result = await writeDriftSummary({
            reason: 'missing_main_baseline_artifact',
            message: 'No non-expired SnapDrift baseline artifact named ui-foundation-snapdrift-baseline was found.',
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
            message: 'No non-expired SnapDrift baseline artifact named ui-foundation-snapdrift-baseline was found.',
            selectedRoutes: ['root-index-desktop', 'root-index-mobile'],
            baselineAvailable: false,
            currentResultsPath: '/tmp/current-results.json'
        });
        expect(markdown).toContain('| 2 | false | `/tmp/current-results.json` |');
        expect(markdown).toContain('## Next action');
    });

    it('falls back to an underscore-decoded reason string for unknown skip reasons', async () => {
        const { buildDriftSummary } = await import('../lib/drift-summary.mjs');

        const { summary, markdown } = buildDriftSummary({
            status: 'incomplete',
            reason: 'snapdrift_scope_check_failed'
        });

        expect(summary).toEqual({
            status: 'incomplete',
            reason: 'snapdrift_scope_check_failed',
            message: 'snapdrift scope check failed',
            selectedRoutes: []
        });
        expect(markdown).toContain('# ⚠️ SnapDrift Report — Incomplete');
        expect(markdown).toContain('> **Reason:** snapdrift scope check failed');
    });
});
