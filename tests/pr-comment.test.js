/** @jest-environment node */

describe('buildReportCommentBody', () => {
    let buildReportCommentBody;
    let PR_COMMENT_MARKER;
    let LEGACY_REPORT_COMMENT_MARKER;

    beforeAll(async () => {
        ({ buildReportCommentBody, PR_COMMENT_MARKER, LEGACY_REPORT_COMMENT_MARKER } = await import('../lib/pr-comment.mjs'));
    });

    const cleanSummary = {
        status: 'clean',
        selectedRoutes: ['home-desktop', 'home-mobile'],
        matchedScreenshots: 2,
        changedScreenshots: 0,
        missingInBaseline: 0,
        missingInCurrent: 0,
        diffMode: 'strict',
        threshold: 0.01,
        errors: [],
        dimensionChanges: [],
        changed: []
    };

    it('starts with the SnapDrift marker and keeps the legacy marker available', () => {
        const body = buildReportCommentBody(cleanSummary);
        expect(body.startsWith(PR_COMMENT_MARKER)).toBe(true);
        expect(LEGACY_REPORT_COMMENT_MARKER).toBe('<!-- pr-visual-diff-summary -->');
    });

    it('uses metadata and high-signal tables', () => {
        const body = buildReportCommentBody(cleanSummary);
        expect(body).toContain('| Selected routes | Stable captures | Diff mode | Threshold |');
        expect(body).toContain('| 2 | 2 | `strict` | 0.01 |');
        expect(body).toContain('| Signal | Count |');
        expect(body).toContain('| Drift signals | 0 |');
        expect(body).not.toContain('| Errors |');
    });

    it('shows status icon and label in heading', () => {
        const body = buildReportCommentBody(cleanSummary);
        expect(body).toContain('<img src="https://raw.githubusercontent.com/ranacseruet/snapdrift/main/assets/snapdrift-logo-icon.png" alt="SnapDrift" width="20" height="20" />');
        expect(body).toContain('## ✅ SnapDrift Report — Clean');
    });

    it('shows drift-detected status', () => {
        const body = buildReportCommentBody({ ...cleanSummary, status: 'changes-detected', changedScreenshots: 1 });
        expect(body).toContain('🟡 SnapDrift Report — Drift detected');
    });

    it('shows skipped status', () => {
        const body = buildReportCommentBody({
            status: 'skipped',
            selectedRoutes: [],
            message: 'No drift-relevant changes.',
            errors: []
        });
        expect(body).toContain('⏭️ SnapDrift Report — Skipped');
        expect(body).toContain('> **Note:** No drift-relevant changes.');
    });

    it('shows fallback metadata values when diff settings are unavailable', () => {
        const body = buildReportCommentBody({
            status: 'skipped',
            selectedRoutes: [],
            matchedScreenshots: 0,
            errors: []
        });
        expect(body).toContain('| 0 | 0 | n/a | n/a |');
    });

    it('includes drift signals in a details section with table', () => {
        const body = buildReportCommentBody({
            ...cleanSummary,
            status: 'changes-detected',
            changedScreenshots: 1,
            changed: [{ id: 'home-desktop', viewport: 'desktop', mismatchRatio: 0.0523 }]
        });
        expect(body).toContain('<details><summary>Drift signals</summary>');
        expect(body).toContain('| Route | Viewport | Mismatch |');
        expect(body).toContain('| home-desktop | desktop | 5.23% |');
    });

    it('truncates changed screenshots at 20 with overflow note', () => {
        const changed = Array.from({ length: 25 }, (_, i) => ({
            id: `route-${i}`,
            viewport: 'desktop',
            mismatchRatio: 0.01
        }));
        const body = buildReportCommentBody({
            ...cleanSummary,
            changedScreenshots: 25,
            changed
        });
        expect(body).toContain('route-19');
        expect(body).not.toContain('route-20');
        expect(body).toContain('...and 5 more');
    });

    it('includes dimension shifts in a details section', () => {
        const body = buildReportCommentBody({
            ...cleanSummary,
            status: 'incomplete',
            dimensionChanges: [{
                id: 'home-desktop',
                viewport: 'desktop',
                baselineWidth: 1440,
                baselineHeight: 1266,
                currentWidth: 1440,
                currentHeight: 1092
            }]
        });
        expect(body).toContain('Dimension shifts');
        expect(body).toContain('1440×1266');
        expect(body).toContain('1440×1092');
        expect(body).toContain('Next step');
    });

    it('includes actionable error details near the top of the report', () => {
        const body = buildReportCommentBody({
            ...cleanSummary,
            status: 'incomplete',
            message: 'Comparison finished with partial failures.',
            errors: [{
                id: 'home-desktop',
                viewport: 'desktop',
                message: 'Current capture failed: Navigation timeout'
            }]
        });
        expect(body).toContain('> **Note:** Comparison finished with partial failures.');
        expect(body).toContain('<details><summary>Error details</summary>');
        expect(body).toContain('| Route | Viewport | Error |');
        expect(body).toContain('| home-desktop | desktop | Current capture failed: Navigation timeout |');
    });

    it('includes a branded metadata footer with artifact name, baseline info, and run link', () => {
        const body = buildReportCommentBody(
            { ...cleanSummary, baselineArtifactName: 'my-baseline', baselineSourceSha: 'abc1234def' },
            {
                artifactName: 'snapdrift-pr-42',
                runUrl: 'https://github.com/example/runs/123'
            }
        );
        expect(body).toContain('artifact `snapdrift-pr-42`');
        expect(body).toContain('baseline `my-baseline`');
        expect(body).toContain('sha `abc1234`');
        expect(body).toContain('[View run](https://github.com/example/runs/123)');
        expect(body).toContain('<sub>SnapDrift ·');
        expect(body).toContain('<div align="right"><sub>Powered by <a href="https://github.com/ranacseruet/snapdrift">SnapDrift</a></sub></div>');
    });

    it('keeps the powered-by footer when no metadata is available', () => {
        const body = buildReportCommentBody(cleanSummary);
        expect(body).not.toContain('<sub>SnapDrift ·');
        expect(body).toContain('Powered by <a href="https://github.com/ranacseruet/snapdrift">SnapDrift</a>');
    });

    it('omits drift details when none changed', () => {
        const body = buildReportCommentBody(cleanSummary);
        expect(body).not.toContain('<details>');
    });

    it('shows selected route count from array length', () => {
        const body = buildReportCommentBody({ ...cleanSummary, selectedRoutes: ['a', 'b', 'c'] });
        expect(body).toContain('| 3 | 2 | `strict` | 0.01 |');
    });

    it('shows "all" when selectedRoutes is not an array', () => {
        const { selectedRoutes: _selectedRoutes, ...noRoutes } = cleanSummary;
        const body = buildReportCommentBody({ ...noRoutes, errors: [] });
        expect(body).toContain('| all | 2 | `strict` | 0.01 |');
    });
});
