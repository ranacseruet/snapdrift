/** @jest-environment node */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { parseArgs } = await import('../lib/cli.mjs');
const { runMigrateToLocal } = await import('../lib/migrate-baselines.mjs');

// ---------------------------------------------------------------------------
// parseArgs — migrate-baselines flags
// ---------------------------------------------------------------------------

describe('parseArgs — migrate-baselines', () => {
  it('parses migrate-baselines --to snap', () => {
    const opts = parseArgs(['node', 'snapdrift', 'migrate-baselines', '--to', 'snap']);
    expect(opts.command).toBe('migrate-baselines');
    expect(opts.to).toBe('snap');
  });

  it('parses migrate-baselines --to local --from snap', () => {
    const opts = parseArgs(['node', 'snapdrift', 'migrate-baselines', '--to', 'local', '--from', 'snap']);
    expect(opts.to).toBe('local');
    expect(opts.from).toBe('snap');
  });

  it('parses --accept-cross-engine', () => {
    const opts = parseArgs(['node', 'snapdrift', 'migrate-baselines', '--to', 'local', '--from', 'snap', '--accept-cross-engine']);
    expect(opts.acceptCrossEngine).toBe(true);
  });

  it('--accept-cross-engine defaults to false', () => {
    const opts = parseArgs(['node', 'snapdrift', 'migrate-baselines', '--to', 'snap']);
    expect(opts.acceptCrossEngine).toBe(false);
  });

  it('parses --baseline-dir with migrate-baselines', () => {
    const opts = parseArgs(['node', 'snapdrift', 'migrate-baselines', '--to', 'snap', '--baseline-dir', 'my/baselines']);
    expect(opts.baselineDir).toBe(path.resolve('my/baselines'));
  });

  it('ignores invalid --to value', () => {
    const opts = parseArgs(['node', 'snapdrift', 'migrate-baselines', '--to', 'invalid']);
    expect(opts.to).toBeUndefined();
  });

  it('ignores invalid --from value', () => {
    const opts = parseArgs(['node', 'snapdrift', 'migrate-baselines', '--to', 'local', '--from', 'invalid']);
    expect(opts.from).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseArgs — init flags
// ---------------------------------------------------------------------------

describe('parseArgs — init', () => {
  it('parses init --from-snap-action', () => {
    const opts = parseArgs(['node', 'snapdrift', 'init', '--from-snap-action', '.github/workflows/screenshots.yml']);
    expect(opts.command).toBe('init');
    expect(opts.fromSnapAction).toBe('.github/workflows/screenshots.yml');
  });
});

// ---------------------------------------------------------------------------
// runMigrateToLocal
// ---------------------------------------------------------------------------

describe('runMigrateToLocal', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-migrate-test-'));
    process.env.SNAP_TEST_API_KEY = 'test-api-key-1234';
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    delete process.env.SNAP_TEST_API_KEY;
  });

  it('errors when export endpoint is not available (stub)', async () => {
    const baselineDir = path.join(tempDir, 'baseline');
    const config = {
      provider: 'snap',
      snap: { apiKeyEnv: 'SNAP_TEST_API_KEY', projectId: 'test-project' },
      baselineArtifactName: 'test',
      workingDirectory: '.',
      baseUrl: 'http://localhost:3000',
      resultsFile: 'results.json',
      manifestFile: 'manifest.json',
      screenshotsRoot: 'screenshots',
      routes: [{ id: 'home', path: '/', viewport: 'desktop' }],
      diff: { threshold: 0.01, mode: 'report-only' }
    };

    const opts = {
      command: 'migrate-baselines',
      open: false,
      routes: [],
      baselineDir,
      currentDir: path.join(tempDir, 'current'),
      diffDir: path.join(tempDir, 'diff'),
      to: 'local',
      from: 'snap',
      acceptCrossEngine: false
    };

    const originalExitCode = process.exitCode;
    await runMigrateToLocal(config, opts);
    expect(process.exitCode).toBe(1);
    process.exitCode = originalExitCode;
  });
});