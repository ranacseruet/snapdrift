/** @jest-environment node */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** @returns {import('../types/visual-diff-types').VisualDiffSummary} */
function makeSummary(overrides = {}) {
  return {
    startedAt: '2024-01-01T00:00:00.000Z',
    finishedAt: '2024-01-01T00:00:05.000Z',
    status: 'clean',
    diffMode: 'fail-on-changes',
    threshold: 0.01,
    baselineResultsPath: '/baseline/results.json',
    currentResultsPath: '/current/results.json',
    baselineManifestPath: '/baseline/manifest.json',
    currentManifestPath: '/current/manifest.json',
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
  };
}

describe('generateHtmlReport', () => {
  it('generates valid HTML with summary header data', async () => {
    const { generateHtmlReport } = await import('../lib/report.mjs');
    const summary = makeSummary();
    const html = await generateHtmlReport(summary);

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('SnapDrift');
    expect(html).toContain('fail-on-changes');
    expect(html).toContain('0.01');
    expect(html).toContain('2024-01-01T00:00:05.000Z');
  });

  it('shows clean status for clean summary', async () => {
    const { generateHtmlReport } = await import('../lib/report.mjs');
    const html = await generateHtmlReport(makeSummary({ status: 'clean' }));
    expect(html).toContain('status-clean');
    expect(html).toContain('Clean');
  });

  it('shows changes-detected status', async () => {
    const { generateHtmlReport } = await import('../lib/report.mjs');
    const html = await generateHtmlReport(makeSummary({ status: 'changes-detected' }));
    expect(html).toContain('status-changes');
    expect(html).toContain('Drift detected');
  });

  it('shows incomplete status', async () => {
    const { generateHtmlReport } = await import('../lib/report.mjs');
    const html = await generateHtmlReport(makeSummary({ status: 'incomplete' }));
    expect(html).toContain('status-incomplete');
    expect(html).toContain('Incomplete');
  });

  it('shows skipped status', async () => {
    const { generateHtmlReport } = await import('../lib/report.mjs');
    const html = await generateHtmlReport(makeSummary({ status: 'skipped' }));
    expect(html).toContain('status-skipped');
    expect(html).toContain('Skipped');
  });

  it('renders changed route rows without images when no run dirs provided', async () => {
    const { generateHtmlReport } = await import('../lib/report.mjs');
    const summary = makeSummary({
      status: 'changes-detected',
      changedScreenshots: 1,
      changed: [{
        id: 'home-desktop',
        path: '/',
        viewport: 'desktop',
        baselineImagePath: 'screenshots/home-desktop.png',
        currentImagePath: 'screenshots/home-desktop.png',
        width: 1440,
        height: 900,
        differentPixels: 500,
        totalPixels: 1296000,
        mismatchRatio: 0.000386,
        status: 'changed'
      }]
    });

    const html = await generateHtmlReport(summary);
    expect(html).toContain('home-desktop');
    expect(html).toContain('/');
    expect(html).toContain('desktop');
    expect(html).toContain('500/1296000');
    expect(html).not.toContain('data:image/png;base64,');
  });

  it('renders custom viewport in changed routes', async () => {
    const { generateHtmlReport } = await import('../lib/report.mjs');
    const summary = makeSummary({
      status: 'changes-detected',
      changedScreenshots: 1,
      changed: [{
        id: 'about-tablet',
        path: '/about',
        viewport: { width: 768, height: 1024 },
        baselineImagePath: 'screenshots/about-tablet.png',
        currentImagePath: 'screenshots/about-tablet.png',
        width: 768,
        height: 1024,
        differentPixels: 100,
        totalPixels: 786432,
        mismatchRatio: 0.000127,
        status: 'changed'
      }]
    });

    const html = await generateHtmlReport(summary);
    expect(html).toContain('768x1024');
  });

  it('renders missing captures in capture gaps section', async () => {
    const { generateHtmlReport } = await import('../lib/report.mjs');
    const summary = makeSummary({
      missingInBaseline: 1,
      missing: [{
        id: 'contact-desktop',
        path: '/contact',
        viewport: 'desktop',
        location: 'baseline',
        reason: 'missing baseline capture'
      }]
    });

    const html = await generateHtmlReport(summary);
    expect(html).toContain('contact-desktop');
    expect(html).toContain('baseline');
    expect(html).toContain('missing baseline capture');
  });

  it('renders dimension shifts in dimension section', async () => {
    const { generateHtmlReport } = await import('../lib/report.mjs');
    const summary = makeSummary({
      dimensionChanges: [{
        id: 'nav-desktop',
        path: '/nav',
        viewport: 'desktop',
        baselineWidth: 1440,
        baselineHeight: 900,
        currentWidth: 1440,
        currentHeight: 950,
        status: 'dimension-changed'
      }]
    });

    const html = await generateHtmlReport(summary);
    expect(html).toContain('nav-desktop');
    expect(html).toContain('1440');
    expect(html).toContain('900');
    expect(html).toContain('950');
  });

  it('renders errors in comparison errors section', async () => {
    const { generateHtmlReport } = await import('../lib/report.mjs');
    const summary = makeSummary({
      errors: [{
        id: 'broken-route',
        path: '/broken',
        viewport: 'desktop',
        status: 'error',
        message: 'Unable to locate screenshot broken-route.png'
      }]
    });

    const html = await generateHtmlReport(summary);
    expect(html).toContain('broken-route');
    expect(html).toContain('Unable to locate screenshot broken-route.png');
  });

  it('shows None for each empty section', async () => {
    const { generateHtmlReport } = await import('../lib/report.mjs');
    const html = await generateHtmlReport(makeSummary());

    const noneCount = (html.match(/<p class="none">None<\/p>/g) || []).length;
    expect(noneCount).toBe(4);
  });

  it('includes baseline artifact name and source sha when present', async () => {
    const { generateHtmlReport } = await import('../lib/report.mjs');
    const html = await generateHtmlReport(makeSummary({
      baselineArtifactName: 'snapdrift-baseline-main',
      baselineSourceSha: 'abc1234'
    }));

    expect(html).toContain('snapdrift-baseline-main');
    expect(html).toContain('abc1234');
  });

  it('escapes HTML special characters in route id', async () => {
    const { generateHtmlReport } = await import('../lib/report.mjs');
    const summary = makeSummary({
      errors: [{
        id: '<script>alert(1)</script>',
        status: 'error',
        message: 'test error'
      }]
    });

    const html = await generateHtmlReport(summary);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('embeds base64 images when run dirs and files are provided', async () => {
    const { generateHtmlReport } = await import('../lib/report.mjs');
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-report-test-'));

    try {
      // Minimal 1x1 PNG (67 bytes, valid PNG header + IDAT)
      const minimalPng = Buffer.from(
        '89504e470d0a1a0a0000000d49484452000000010000000108020000009001' +
        '2e000000174944415478016360f8cfc00000000200016d66236c00000000' +
        '49454e44ae426082', 'hex'
      );

      const baselineDir = path.join(tempDir, 'baseline');
      const currentDir = path.join(tempDir, 'current');
      await fs.mkdir(path.join(baselineDir, 'screenshots'), { recursive: true });
      await fs.mkdir(path.join(currentDir, 'screenshots'), { recursive: true });
      await fs.writeFile(path.join(baselineDir, 'screenshots', 'home-desktop.png'), minimalPng);
      await fs.writeFile(path.join(currentDir, 'screenshots', 'home-desktop.png'), minimalPng);

      const summary = makeSummary({
        status: 'changes-detected',
        changedScreenshots: 1,
        changed: [{
          id: 'home-desktop',
          path: '/',
          viewport: 'desktop',
          baselineImagePath: 'screenshots/home-desktop.png',
          currentImagePath: 'screenshots/home-desktop.png',
          width: 1,
          height: 1,
          differentPixels: 1,
          totalPixels: 1,
          mismatchRatio: 1,
          status: 'changed'
        }]
      });

      const html = await generateHtmlReport(summary, {
        baselineRunDir: baselineDir,
        currentRunDir: currentDir
      });

      expect(html).toContain('data:image/png;base64,');
      expect(html).toContain('Baseline');
      expect(html).toContain('Current');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('shows Image unavailable when image file is missing', async () => {
    const { generateHtmlReport } = await import('../lib/report.mjs');
    const summary = makeSummary({
      status: 'changes-detected',
      changedScreenshots: 1,
      changed: [{
        id: 'missing-img',
        path: '/missing',
        viewport: 'desktop',
        baselineImagePath: 'screenshots/missing-img.png',
        currentImagePath: 'screenshots/missing-img.png',
        width: 100,
        height: 100,
        differentPixels: 50,
        totalPixels: 10000,
        mismatchRatio: 0.005,
        status: 'changed'
      }]
    });

    const html = await generateHtmlReport(summary, {
      baselineRunDir: '/nonexistent/path',
      currentRunDir: '/nonexistent/path'
    });

    expect(html).toContain('Image unavailable');
    expect(html).not.toContain('data:image/png;base64,');
  });
});
