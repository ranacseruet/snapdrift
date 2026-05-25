import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { writeDriftSummary } from '../src/drift-summary-io.mjs';

describe('@snapdrift/adapter-fs — drift-summary-io', () => {
  describe('writeDriftSummary', () => {
    test('writes summary JSON and markdown files to disk', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-summary-'));

      const { summaryPath, markdownPath, summary, markdown } = await writeDriftSummary({
        reason: 'no_snapdrift_relevant_changes',
        outDir: tmpDir
      });

      expect(summaryPath).toContain('summary.json');
      expect(markdownPath).toContain('summary.md');
      expect(summary.status).toBe('skipped');
      expect(typeof markdown).toBe('string');
      expect(markdown).toContain('SnapDrift Report');

      // Verify files exist on disk
      const summaryContent = JSON.parse(await fs.readFile(summaryPath, 'utf8'));
      expect(summaryContent.status).toBe('skipped');
      const markdownContent = await fs.readFile(markdownPath, 'utf8');
      expect(markdownContent).toContain('SnapDrift');

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    test('uses custom output paths when provided', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-summary-'));
      const customSummaryPath = path.join(tmpDir, 'custom-summary.json');
      const customMarkdownPath = path.join(tmpDir, 'custom-summary.md');

      const { summaryPath, markdownPath } = await writeDriftSummary({
        reason: 'missing_main_baseline_artifact',
        summaryPath: customSummaryPath,
        markdownPath: customMarkdownPath
      });

      expect(summaryPath).toBe(path.resolve(customSummaryPath));
      expect(markdownPath).toBe(path.resolve(customMarkdownPath));

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    test('includes selectedRouteIds in output', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-summary-'));

      const { summary } = await writeDriftSummary({
        reason: 'scoped_snapdrift_change',
        selectedRouteIds: ['home', 'about'],
        outDir: tmpDir
      });

      expect(summary.selectedRoutes).toEqual(['home', 'about']);

      await fs.rm(tmpDir, { recursive: true, force: true });
    });
  });
});