/** @jest-environment node */

describe('makeMarkdown', () => {
  let makeMarkdown, formatViewport, formatPercentage, formatDriftFailureMessage;

  beforeAll(async () => {
    ({ makeMarkdown, formatViewport, formatDriftFailureMessage } = await import('../src/markdown.mjs'));
    ({ formatPercentage } = await import('../src/constants.mjs'));
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

  describe('formatPercentage', () => {
    it('renders ratios as percentages without unnecessary trailing zeros', () => {
      expect(formatPercentage(0.05)).toBe('5%');
      expect(formatPercentage(0.005)).toBe('0.5%');
    });
  });

  describe('makeMarkdown', () => {
    it('renders a clean report with icon and heading', () => {
      const md = makeMarkdown(makeSummary());
      expect(md).toContain('# ✅ SnapDrift Report — Clean');
      expect(md).toContain('<img src="https://raw.githubusercontent.com/ranacseruet/snapdrift/main/assets/snapdrift-logo-icon.png"');
    });

    it('renders the unverified capture diagnostic once with Markdown escaping', () => {
      const message = 'Capture compatibility is unverified: <legacy> & [profile] | `v1`.';
      const md = makeMarkdown(makeSummary({
        captureCompatibility: { status: 'unverified', reason: message },
        message
      }));
      const escaped = 'Capture compatibility is unverified: &lt;legacy&gt; &amp; \\[profile\\] \\| \\`v1\\`.';
      expect(md.split(escaped)).toHaveLength(2);
      expect(md).not.toContain(message);
    });

    it('does not render unrelated summary messages or empty diagnostics', () => {
      for (const status of [undefined, 'verified', 'incompatible', 'unverified']) {
        const md = makeMarkdown(makeSummary({
          captureCompatibility: status ? { status } : undefined,
          message: status === 'unverified' ? undefined : 'Unrelated note'
        }));
        expect(md).not.toContain('Unrelated note');
        expect(md).not.toContain('**Note:**');
      }
    });

    it('renders the stats table with correct values', () => {
      const md = makeMarkdown(makeSummary());
      expect(md).toContain('| 2 | 2 | `report-only` | 1% |');
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

    it('renders v1 comparison dimensions and the staged diff image', () => {
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
          differentPixels: 10,
          totalPixels: 100,
          mismatchRatio: 0.1,
          status: 'changed',
          comparison: {
            baseline: { width: 1440, height: 900 },
            current: { width: 1440, height: 920 },
            canvas: { width: 1440, height: 920 },
            dimensionsChanged: true,
            totalPixels: 1324800
          },
          diffImagePath: 'diffs/home-desktop.png'
        }]
      }));

      expect(md).toContain('| Dimension shifts | 1 |');
      expect(md).toContain('| home-desktop | desktop | 1440×900 | 1440×920 | 1440×920 |');
      expect(md).toContain('![Diff image](<diffs/home-desktop.png>)');
      expect(md).toContain('Pixel comparison included');
      expect(md).not.toContain('Pixel comparison was skipped');
    });

    it('percent-encodes diff image destinations that would break the link', () => {
      const md = makeMarkdown(makeSummary({
        status: 'changes-detected',
        changed: [{
          id: 'about-us-desktop',
          viewport: 'desktop',
          mismatchRatio: 0.5,
          differentPixels: 5,
          totalPixels: 10,
          comparison: {
            dimensionsChanged: false,
            totalPixels: 100,
            baseline: { width: 1440, height: 900 },
            current: { width: 1440, height: 900 },
            canvas: { width: 1440, height: 900 }
          },
          diffImagePath: 'diffs/about us & v2.png'
        }]
      }));

      expect(md).toContain('![Diff image](<diffs/about us %26 v2.png>)');
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

    it('escapes markdown-special characters in route ids, reasons, and error messages', () => {
      const md = makeMarkdown(makeSummary({
        status: 'incomplete',
        changed: [{
          id: 'route|with|pipes](https://evil.example) [x',
          viewport: 'desktop',
          mismatchRatio: 0.5,
          differentPixels: 5,
          totalPixels: 10
        }],
        missing: [{ id: 'missing|route', reason: 'missing [baseline](https://evil.example)' }],
        errors: [{ id: 'error|route', message: 'Navigation failed: <script> | [link](https://evil.example)' }],
        dimensionChanges: [{
          id: 'dimension|route',
          viewport: { width: 1440, height: 900 },
          baselineWidth: 1440,
          baselineHeight: 1266,
          currentWidth: 1440,
          currentHeight: 1092,
          status: 'dimension-changed'
        }]
      }));

      expect(md).not.toContain('(https://evil.example)');
      expect(md).toContain('\\|');
      expect(md).toContain('&lt;script&gt;');
    });

    it('escapes backslashes before other characters so pipes stay escaped', () => {
      const md = makeMarkdown(makeSummary({
        status: 'incomplete',
        errors: [{ id: 'tricky\\', message: 'ends with backslash | pipe' }]
      }));

      expect(md).toContain('tricky\\\\ |');
      expect(md).toContain('ends with backslash \\| pipe');
    });

    it('collapses newlines in error messages so table rows survive multi-line Playwright errors', () => {
      const md = makeMarkdown(makeSummary({
        status: 'incomplete',
        errors: [{ id: 'home-desktop', message: 'page.goto: Timeout 30000ms exceeded.\nCall log:\n - navigating to "http://localhost:3000/", waiting until "load"' }]
      }));

      const errorRow = md.split('\n').find((line) => line.includes('home-desktop'));
      expect(errorRow).toContain('| home-desktop | page.goto: Timeout 30000ms exceeded. Call log:  - navigating to');
      expect(errorRow?.endsWith('|')).toBe(true);
    });

    it('neutralizes bare URLs and mentions in table cells', () => {
      const md = makeMarkdown(makeSummary({
        status: 'incomplete',
        errors: [{ id: 'home-desktop', message: 'see https://evil.example and ping @org/team' }]
      }));

      expect(md).not.toContain('https://evil.example');
      expect(md).toContain('https\\://evil.example');
      expect(md).toContain('\\@org/team');
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
