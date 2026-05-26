/** @jest-environment node */

describe('buildDriftSummary', () => {
  let buildDriftSummary, describeReason;

  beforeAll(async () => {
    ({ buildDriftSummary, describeReason } = await import('../src/drift-summary.mjs'));
  });

  describe('describeReason', () => {
    it('maps missing_main_baseline_artifact to human-readable text', () => {
      const result = describeReason('missing_main_baseline_artifact');
      expect(result.message).toBe('The latest successful `main` SnapDrift baseline was not available.');
      expect(result.markdownReason).toBe('latest successful `main` SnapDrift baseline was not available');
    });

    it('maps no_snapdrift_relevant_changes to human-readable text', () => {
      const result = describeReason('no_snapdrift_relevant_changes');
      expect(result.message).toBe('No drift-relevant changes were detected in this pull request.');
      expect(result.markdownReason).toBe('no drift-relevant changes were detected in this pull request');
    });

    it('replaces underscores with spaces for unknown reasons', () => {
      const result = describeReason('snapdrift_scope_check_failed');
      expect(result.message).toBe('snapdrift scope check failed');
      expect(result.markdownReason).toBe('snapdrift scope check failed');
    });
  });

  describe('buildDriftSummary', () => {
    it('builds a skipped summary with no_snapdrift_relevant_changes reason', () => {
      const { summary, markdown } = buildDriftSummary({
        reason: 'no_snapdrift_relevant_changes'
      });
      expect(summary.status).toBe('skipped');
      expect(summary.reason).toBe('no_snapdrift_relevant_changes');
      expect(summary.message).toBe('No drift-relevant changes were detected in this pull request.');
      expect(summary.selectedRoutes).toEqual([]);
      expect(markdown).toContain('# ⏭️ SnapDrift Report — Skipped');
      expect(markdown).toContain('> **Reason:** no drift-relevant changes were detected in this pull request');
    });

    it('builds a skipped summary with missing_main_baseline_artifact reason and next action', () => {
      const { summary, markdown } = buildDriftSummary({
        reason: 'missing_main_baseline_artifact',
        baselineAvailable: false,
        currentResultsPath: '/tmp/current-results.json',
        selectedRouteIds: 'route-a,route-b'
      });
      expect(summary.status).toBe('skipped');
      expect(summary.baselineAvailable).toBe(false);
      expect(summary.currentResultsPath).toBe('/tmp/current-results.json');
      expect(summary.selectedRoutes).toEqual(['route-a', 'route-b']);
      expect(markdown).toContain('## Next action');
      expect(markdown).toContain('| 2 | false | `/tmp/current-results.json` |');
    });

    it('builds an incomplete summary with custom message', () => {
      const { summary, markdown } = buildDriftSummary({
        status: 'incomplete',
        reason: 'snapdrift_scope_check_failed',
        message: 'Custom error detail'
      });
      expect(summary.status).toBe('incomplete');
      expect(summary.message).toBe('Custom error detail');
      expect(markdown).toContain('# ⚠️ SnapDrift Report — Incomplete');
      expect(markdown).toContain('> **Details:** Custom error detail');
    });

    it('accepts selectedRouteIds as an array', () => {
      const { summary } = buildDriftSummary({
        reason: 'no_snapdrift_relevant_changes',
        selectedRouteIds: ['a', 'b', 'c']
      });
      expect(summary.selectedRoutes).toEqual(['a', 'b', 'c']);
    });

    it('renders the icon and powered-by footer', () => {
      const { markdown } = buildDriftSummary({ reason: 'no_snapdrift_relevant_changes' });
      expect(markdown).toContain('<img src="https://raw.githubusercontent.com/ranacseruet/snapdrift/main/assets/snapdrift-logo-icon.png"');
      expect(markdown).toContain('Powered by <a href="https://github.com/ranacseruet/snapdrift">SnapDrift</a>');
    });

    it('shows n/a when baselineAvailable is not provided', () => {
      const { markdown } = buildDriftSummary({ reason: 'no_snapdrift_relevant_changes' });
      expect(markdown).toContain('| n/a | n/a |');
    });
  });
});
