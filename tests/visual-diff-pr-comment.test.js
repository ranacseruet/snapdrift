/** @jest-environment node */

describe('buildPrCommentBody', () => {
    let buildPrCommentBody;
    let PR_COMMENT_MARKER;

    beforeAll(async () => {
        ({ buildPrCommentBody, PR_COMMENT_MARKER } = await import('../lib/visual-diff-pr-comment.mjs'));
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

    it('starts with the PR comment marker', () => {
        const body = buildPrCommentBody(cleanSummary);
        expect(body.startsWith(PR_COMMENT_MARKER)).toBe(true);
    });

    it('uses tabular format for metrics', () => {
        const body = buildPrCommentBody(cleanSummary);
        expect(body).toContain('| Metric | Count |');
        expect(body).toContain('| Matched | 2 |');
        expect(body).toContain('| Changed | 0 |');
    });

    it('shows status icon and label in heading', () => {
        const body = buildPrCommentBody(cleanSummary);
        expect(body).toContain('## ✅ Visual Diff — Clean');
    });

    it('shows changes-detected status', () => {
        const body = buildPrCommentBody({ ...cleanSummary, status: 'changes-detected', changedScreenshots: 1 });
        expect(body).toContain('🟡 Visual Diff — Changes detected');
    });

    it('shows skipped status', () => {
        const body = buildPrCommentBody({
            status: 'skipped',
            selectedRoutes: [],
            message: 'No visual-relevant changes.',
            errors: []
        });
        expect(body).toContain('⏭️ Visual Diff — Skipped');
        expect(body).toContain('> **Note:** No visual-relevant changes.');
    });

    it('includes changed screenshots in a details section with table', () => {
        const body = buildPrCommentBody({
            ...cleanSummary,
            status: 'changes-detected',
            changedScreenshots: 1,
            changed: [{ id: 'home-desktop', viewport: 'desktop', mismatchRatio: 0.0523 }]
        });
        expect(body).toContain('<details><summary>Changed screenshots</summary>');
        expect(body).toContain('| Route | Viewport | Mismatch |');
        expect(body).toContain('| home-desktop | desktop | 5.23% |');
    });

    it('truncates changed screenshots at 20 with overflow note', () => {
        const changed = Array.from({ length: 25 }, (_, i) => ({
            id: `route-${i}`,
            viewport: 'desktop',
            mismatchRatio: 0.01
        }));
        const body = buildPrCommentBody({
            ...cleanSummary,
            changedScreenshots: 25,
            changed
        });
        expect(body).toContain('route-19');
        expect(body).not.toContain('route-20');
        expect(body).toContain('...and 5 more');
    });

    it('includes dimension changes in a details section', () => {
        const body = buildPrCommentBody({
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
        expect(body).toContain('Viewport dimension changes');
        expect(body).toContain('1440×1266');
        expect(body).toContain('1440×1092');
        expect(body).toContain('Next step');
    });

    it('includes metadata footer with artifact name, baseline info, and run link', () => {
        const body = buildPrCommentBody(
            { ...cleanSummary, baselineArtifactName: 'my-baseline', baselineSourceSha: 'abc1234def' },
            { artifactName: 'pr-visual-diff-42', runUrl: 'https://github.com/example/runs/123' }
        );
        expect(body).toContain('Artifact: `pr-visual-diff-42`');
        expect(body).toContain('Baseline: `my-baseline`');
        expect(body).toContain('Baseline SHA: `abc1234`');
        expect(body).toContain('[View run](https://github.com/example/runs/123)');
        expect(body).toContain('<sub>');
    });

    it('omits metadata footer when no metadata is available', () => {
        const body = buildPrCommentBody(cleanSummary);
        expect(body).not.toContain('<sub>');
    });

    it('omits changed screenshots section when none changed', () => {
        const body = buildPrCommentBody(cleanSummary);
        expect(body).not.toContain('<details>');
    });

    it('omits dimension changes section when none present', () => {
        const body = buildPrCommentBody(cleanSummary);
        expect(body).not.toContain('Viewport dimension changes');
    });

    it('shows selected route count from array length', () => {
        const body = buildPrCommentBody({ ...cleanSummary, selectedRoutes: ['a', 'b', 'c'] });
        expect(body).toContain('| Selected routes | 3 |');
    });

    it('shows "all" when selectedRoutes is not an array', () => {
        const { selectedRoutes, ...noRoutes } = cleanSummary;
        const body = buildPrCommentBody({ ...noRoutes, errors: [] });
        expect(body).toContain('| Selected routes | all |');
    });
});
