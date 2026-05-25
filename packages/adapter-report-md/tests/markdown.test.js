/** @jest-environment node */

describe('makeMarkdown', () => {
  let makeMarkdown, formatViewport, formatDriftFailureMessage;

  beforeAll(async () => {
    ({ makeMarkdown, formatViewport, formatDriftFailureMessage } = await import('../src/markdown.mjs'));
  });

  const makeSummary = (overrides = {}) => ({
    startedAt: '2025-01-01T00:00:00.000Z',
    finishedAt: '2025-01-01T00:00:01.000Z',
    status: 'clean',
    selectedRoutes: ['home-desktop', 'home-mobile'],
    baselineResultsPath: '/tmp/baseline-results.json',
    currentResultsPath: '/tmp/current-results.json',
    baselineManifestPath: '/tmp/baseline-manifest.json',
    currentManifestPath: '/tmp/current-manifest.json',
    diffMode: 'report-only',
    threshold: 0.01,
    totalScreenshots: 2,
    matchedScreenshots: 2,
    changedScreenshots: 0,
    missingInBaseline: 0,
    missingInCurrent: 0,
    changed: [],
    missing: [],
    errors: [],
    dimensionChanges: [],
    ...overrides
  });

  describe('formatViewport', () => {
    it('returns empty string for undefined', () => {
      expect(formatViewport(undefined)).toBe('');
    });

    it('returns preset name for string viewport', () => {
      expect(formatViewport('desktop')).toBe('desktop');
    });

    it('returns WxH for custom viewport', () => {
      expect(formatViewport({ width: 1440, height: 900 })).toBe('1440x900');
    });
  });

  describe('makeMarkdown', () => {
    it('renders a clean report with icon and heading', () => {
      const md = makeMarkdown(makeSummary());
      expect(md).toContain('# ✅ SnapDrift Report — Clean');
      expect(md).toContain('<img src="https://raw.githubusercontent.com/ranacseruet/snapdrift/main/assets/snapdrift-logo-icon.png"');
    });

    it('renders the stats table with correct values', () => {
      const md = makeMarkdown(makeSummary());
      expect(md).toContain('| 2 | 2 | `report-only` | 0.01 |');
      expect(md).toContain('| Drift signals | 0 |');
      expect(md).toContain('| Errors | 0 |');
    });

    it('renders drift signals table when changed items exist', () => {
      const md = makeMarkdown(makeSummary({
        status: 'changes-detected',
        changedScreenshots: 1,
        changed: [{
          id: 'home-desktop',
          path: '/',
          viewport: 'desktop',
          baselineImagePath: 'baseline.png',
          currentImagePath: 'current.png',
          width: 1440,
          height: 900,
          differentPixels: 500,
          totalPixels: 1296000,
          mismatchRatio: 0.000386,
          status: 'changed'
        }]
      }));
      expect(md).toContain('🟡 SnapDrift Report — Drift detected');
      expect(md).toContain('| home-desktop | desktop | 0.04% | 500/1296000 |');
    });

    it('renders capture gaps when missing items exist', () => {
      const md = makeMarkdown(makeSummary({
        status: 'incomplete',
        missingInBaseline: 1,
        missing: [{ id: 'about-desktop', reason: 'missing baseline capture' }]
      }));
      expect(md).toContain('⚠️ SnapDrift Report — Incomplete');
      expect(md).toContain('| about-desktop | missing baseline capture |');
    });

    it('renders dimension shifts when present', () => {
      const md = makeMarkdown(makeSummary({
        status: 'incomplete',
        dimensionChanges: [{
          id: 'home-desktop',
          viewport: { width: 1440, height: 900 },
          baselineWidth: 1440,
          baselineHeight: 1266,
          currentWidth: 1440,
          currentHeight: 1092,
          status: 'dimension-changed'
        }]
      }));
      expect(md).toContain('Dimension shifts');
      expect(md).toContain('| home-desktop | 1440x900 | 1440×1266 | 1440×1092 |');
      expect(md).toContain('Next step');
    });

    it('renders errors when present', () => {
      const md = makeMarkdown(makeSummary({
        status: 'incomplete',
        errors: [{ id: 'home-desktop', message: 'Navigation timeout' }]
      }));
      expect(md).toContain('## Comparison errors');
      expect(md).toContain('| home-desktop | Navigation timeout |');
    });

    it('renders baseline metadata when available', () => {
      const md = makeMarkdown(makeSummary({
        baselineArtifactName: 'my-baseline',
        baselineSourceSha: 'abc1234def'
      }));
      expect(md).toContain('baseline `my-baseline`');
      expect(md).toContain('sha `abc1234def`');
    });

    it('includes footer with SnapDrift link', () => {
      const md = makeMarkdown(makeSummary());
      expect(md).toContain('Powered by <a href="https://github.com/ranacseruet/snapdrift">SnapDrift</a>');
    });

    it('shows None for empty sections', () => {
      const md = makeMarkdown(makeSummary());
      expect(md).toContain('None');
    });
  });

  describe('formatDriftFailureMessage', () => {
    it('returns fail-on-changes message', () => {
      expect(formatDriftFailureMessage('fail-on-changes', { changedScreenshots: 3 }))
        .toBe('SnapDrift detected drift in 3 capture(s), above the configured threshold.');
    });

    it('returns fail-on-incomplete message', () => {
      expect(formatDriftFailureMessage('fail-on-incomplete', {}))
        .toBe('SnapDrift stopped the run because the comparison finished incomplete.');
    });

    it('returns strict mode message for strict', () => {
      expect(formatDriftFailureMessage('strict', { changedScreenshots: 1 }))
        .toBe('SnapDrift strict mode detected drift or incomplete comparisons.');
    });

    it('returns strict mode message for report-only (fallback)', () => {
      expect(formatDriftFailureMessage('report-only', {}))
        .toBe('SnapDrift strict mode detected drift or incomplete comparisons.');
    });
  });
});
