/** @jest-environment node */

describe('buildReportCommentBody', () => {
    let buildReportCommentBody;
    let PR_COMMENT_MARKER;
    let PR_COMMENT_MARKERS;

    beforeAll(async () => {
        ({ buildReportCommentBody, PR_COMMENT_MARKER, PR_COMMENT_MARKERS } = await import('../lib/pr-comment.mjs'));
    });

    const cleanSummary = {
        status: 'clean',
        selectedRoutes: ['home-desktop', 'home-mobile'],
        matchedScreenshots: 2,
        changedScreenshots: 0,
        missingInBaseline: 0,
        missingInCurrent: 0,
        errors: [],
        dimensionChanges: [],
        changed: []
    };

    it('starts with the SnapDrift marker and only matches the SnapDrift marker', () => {
        const body = buildReportCommentBody(cleanSummary);
        expect(body.startsWith(PR_COMMENT_MARKER)).toBe(true);
        expect(PR_COMMENT_MARKERS).toEqual([PR_COMMENT_MARKER]);
    });

    it('uses a concise high-signal metrics table', () => {
        const body = buildReportCommentBody(cleanSummary);
        expect(body).toContain('| Signal | Count |');
        expect(body).toContain('| Drift signals | 0 |');
        expect(body).not.toContain('| Errors |');
        expect(body).not.toContain('| Selected routes | Stable captures | Diff mode | Threshold |');
    });

    it('shows status icon and label in heading', () => {
        const body = buildReportCommentBody(cleanSummary);
        expect(body).toContain('## ✅ SnapDrift Report — Clean');
        expect(body).not.toContain('<img');
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

    it('appends a "View full report" link after the overflow note when runUrl is provided', () => {
        const changed = Array.from({ length: 25 }, (_, i) => ({
            id: `route-${i}`,
            viewport: 'desktop',
            mismatchRatio: 0.01
        }));
        const body = buildReportCommentBody(
            { ...cleanSummary, changedScreenshots: 25, changed },
            { runUrl: 'https://github.com/example/runs/999' }
        );
        expect(body).toContain('*...and 5 more* — [View full report →](https://github.com/example/runs/999)');
    });

    it('includes dimension shifts in an auto-expanded details section showing affected routes', () => {
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
        expect(body).toContain('<details open>');
        expect(body).toContain('Dimension shifts');
        expect(body).toContain('home-desktop');
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

    it('truncates error details at 10 rows with an overflow note', () => {
        const errors = Array.from({ length: 12 }, (_, i) => ({
            id: `route-${i}`,
            viewport: 'desktop',
            message: `Failure ${i}`
        }));
        const body = buildReportCommentBody({
            ...cleanSummary,
            status: 'incomplete',
            errors
        });

        expect(body).toContain('| route-9 | desktop | Failure 9 |');
        expect(body).not.toContain('| route-10 | desktop | Failure 10 |');
        expect(body).toContain('...and 2 more');
    });

    it('appends a "View full report" link after the error overflow note when runUrl is provided', () => {
        const errors = Array.from({ length: 12 }, (_, i) => ({
            id: `route-${i}`,
            viewport: 'desktop',
            message: `Failure ${i}`
        }));
        const body = buildReportCommentBody(
            { ...cleanSummary, status: 'incomplete', errors },
            { runUrl: 'https://github.com/example/runs/999' }
        );
        expect(body).toContain('*...and 2 more* — [View full report →](https://github.com/example/runs/999)');
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

    it('keeps the concise metric table when selected routes are provided', () => {
        const body = buildReportCommentBody({ ...cleanSummary, selectedRoutes: ['a', 'b', 'c'] });
        expect(body).toContain('| Drift signals | 0 |');
        expect(body).not.toContain('| Selected routes | Stable captures | Diff mode | Threshold |');
    });

    it('keeps the concise metric table when selectedRoutes is omitted', () => {
        const { selectedRoutes: _selectedRoutes, ...noRoutes } = cleanSummary;
        const body = buildReportCommentBody({ ...noRoutes, errors: [] });
        expect(body).toContain('| Drift signals | 0 |');
        expect(body).not.toContain('| Selected routes | Stable captures | Diff mode | Threshold |');
    });
});
