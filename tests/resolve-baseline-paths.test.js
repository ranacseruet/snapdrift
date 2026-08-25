/** @jest-environment node */

import path from 'node:path';

const { resolveBaselinePaths } = await import('../lib/resolve-baseline-paths.mjs');

// ---------------------------------------------------------------------------
// resolveBaselinePaths — relative and absolute download paths (finding 5)
// ---------------------------------------------------------------------------

describe('resolveBaselinePaths', () => {
  const workspace = '/home/runner/work/repo';

  it('prefixes a relative download-path with the workspace', () => {
    const paths = resolveBaselinePaths({ workspace, downloadPath: 'snapdrift-baseline-download' });
    expect(paths.runDir).toBe(path.join(workspace, 'snapdrift-baseline-download'));
  });

  it('uses an absolute download-path directly (no workspace prefix)', () => {
    const abs = '/mnt/external/baseline';
    const paths = resolveBaselinePaths({ workspace, downloadPath: abs });
    expect(paths.runDir).toBe(abs);
  });

  it('derives results/manifest/screenshots paths from the run dir', () => {
    const rel = resolveBaselinePaths({ workspace, downloadPath: 'dl' });
    const abs = resolveBaselinePaths({ workspace, downloadPath: '/abs/dl' });

    expect(rel.resultsFile).toBe(path.join(rel.runDir, 'results.json'));
    expect(rel.manifestFile).toBe(path.join(rel.runDir, 'manifest.json'));
    expect(rel.screenshotsDir).toBe(path.join(rel.runDir, 'screenshots'));

    expect(abs.resultsFile).toBe(path.join(abs.runDir, 'results.json'));
    expect(abs.screenshotsDir).toBe(path.join(abs.runDir, 'screenshots'));
  });

  it('falls back to the default download-path name when none is supplied', () => {
    const paths = resolveBaselinePaths({ workspace });
    expect(paths.runDir).toBe(path.join(workspace, 'snapdrift-baseline-download'));
  });

  it('handles a relative download-path with nested subdirectories', () => {
    const paths = resolveBaselinePaths({ workspace, downloadPath: 'a/b/c' });
    expect(paths.runDir).toBe(path.join(workspace, 'a', 'b', 'c'));
  });
});
