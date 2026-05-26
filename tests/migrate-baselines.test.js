/** @jest-environment node */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { parseArgs } = await import('../lib/cli.mjs');
const { runMigrateToSnap, runMigrateToLocal, readLocalBaselines } = await import('../lib/migrate-baselines.mjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResults(overrides = {}) {
  return {
    startedAt: new Date().toISOString(),
    baseUrl: 'http://localhost:3000',
    suite: 'default',
    headSha: 'abc1234567890def',
    routes: [{ id: 'home', path: '/', viewport: 'desktop', status: 'passed', durationMs: 100 }],
    ...overrides
  };
}

function makeManifest(overrides = {}) {
  return {
    generatedAt: new Date().toISOString(),
    baseUrl: 'http://localhost:3000',
    screenshots: [{ id: 'home', path: '/', viewport: 'desktop', imagePath: 'screenshots/home.png', width: 1440, height: 900 }],
    ...overrides
  };
}

/** @type {import('pngjs').PNG} */
let PNG;
try {
  const mod = await import('pngjs');
  PNG = mod.PNG;
} catch {
  PNG = null;
}

async function createPngBuffer(width = 10, height = 10) {
  if (!PNG) {
    return Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFklEQVQYV2P8z8BQz0BFwMgwasChAQBfHAqy0dH9jQAAAABJRU5ErkJggg==',
      'base64'
    );
  }
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2;
      png.data[idx] = 255;
      png.data[idx + 1] = 255;
      png.data[idx + 2] = 255;
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

async function setupBaselineDir(dir) {
  await fs.mkdir(path.join(dir, 'screenshots'), { recursive: true });
  await fs.writeFile(path.join(dir, 'results.json'), JSON.stringify(makeResults(), null, 2));
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(makeManifest(), null, 2));
  const pngBuffer = await createPngBuffer();
  await fs.writeFile(path.join(dir, 'screenshots', 'home.png'), pngBuffer);
}

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
// readLocalBaselines
// ---------------------------------------------------------------------------

describe('readLocalBaselines', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-migrate-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('reads results.json, manifest.json, and screenshots', async () => {
    const baselineDir = path.join(tempDir, 'baseline');
    await setupBaselineDir(baselineDir);

    const { results, manifest, screenshots, headSha } = await readLocalBaselines(baselineDir);

    expect(results.routes).toHaveLength(1);
    expect(results.headSha).toBe('abc1234567890def');
    expect(manifest.screenshots).toHaveLength(1);
    expect(screenshots).toHaveLength(1);
    expect(screenshots[0].filename).toBe('home.png');
    expect(typeof screenshots[0].data).toBe('string');
    expect(headSha).toBe('abc1234567890def');
  });

  it('throws if results.json is missing', async () => {
    const baselineDir = path.join(tempDir, 'empty');
    await fs.mkdir(baselineDir, { recursive: true });
    await expect(readLocalBaselines(baselineDir))
      .rejects.toThrow(/Cannot read baseline results/);
  });

  it('throws if manifest.json is missing', async () => {
    const baselineDir = path.join(tempDir, 'partial');
    await fs.mkdir(baselineDir, { recursive: true });
    await fs.writeFile(path.join(baselineDir, 'results.json'), '{}');
    await expect(readLocalBaselines(baselineDir))
      .rejects.toThrow(/Cannot read baseline manifest/);
  });

  it('returns empty screenshots if screenshots dir is missing', async () => {
    const baselineDir = path.join(tempDir, 'noscreenshots');
    await fs.mkdir(baselineDir, { recursive: true });
    await fs.writeFile(path.join(baselineDir, 'results.json'), JSON.stringify(makeResults()));
    await fs.writeFile(path.join(baselineDir, 'manifest.json'), JSON.stringify(makeManifest()));
    process.env.GITHUB_SHA = 'testsha123';

    try {
      const { screenshots } = await readLocalBaselines(baselineDir);
      expect(screenshots).toEqual([]);
    } finally {
      delete process.env.GITHUB_SHA;
    }
  });

  it('throws on non-ENOENT errors when reading screenshots', async () => {
    const baselineDir = path.join(tempDir, 'permfail');
    await setupBaselineDir(baselineDir);

    // Make screenshots directory unreadable (EACCES) by removing read permission
    const screenshotsDir = path.join(baselineDir, 'screenshots');
    await fs.chmod(screenshotsDir, 0o000);

    try {
      await expect(readLocalBaselines(baselineDir))
        .rejects.toThrow();
    } finally {
      // Restore permissions so cleanup can succeed
      await fs.chmod(screenshotsDir, 0o755).catch(() => {});
    }
  });

  it('resolves SHA from GITHUB_SHA when results lacks headSha', async () => {
    const baselineDir = path.join(tempDir, 'nosha');
    await fs.mkdir(baselineDir, { recursive: true });
    await fs.writeFile(path.join(baselineDir, 'results.json'), JSON.stringify(makeResults({ headSha: undefined })));
    await fs.writeFile(path.join(baselineDir, 'manifest.json'), JSON.stringify(makeManifest()));
    process.env.GITHUB_SHA = 'env-sha-1234';

    try {
      const { headSha } = await readLocalBaselines(baselineDir);
      expect(headSha).toBe('env-sha-1234');
    } finally {
      delete process.env.GITHUB_SHA;
    }
  });
});

// ---------------------------------------------------------------------------
// runMigrateToSnap
// ---------------------------------------------------------------------------

describe('runMigrateToSnap', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-migrate-test-'));
    process.env.SNAP_TEST_API_KEY = 'test-api-key-1234';
    process.env.GITHUB_SHA = 'abc1234567890def';
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    delete process.env.SNAP_TEST_API_KEY;
    delete process.env.GITHUB_SHA;
  });

  it('throws if snap config is missing', async () => {
    const baselineDir = path.join(tempDir, 'baseline');
    const config = {
      baselineArtifactName: 'test',
      workingDirectory: '.',
      baseUrl: 'http://localhost:3000',
      resultsFile: 'results.json',
      manifestFile: 'manifest.json',
      screenshotsRoot: 'screenshots',
      routes: [{ id: 'home', path: '/', viewport: 'desktop' }],
      diff: { threshold: 0.01, mode: 'report-only' }
    };
    const opts = { baselineDir, to: 'snap' };

    await expect(runMigrateToSnap(config, opts))
      .rejects.toThrow(/Migration requires snap config/);
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

  it('throws if snap config is missing', async () => {
    const baselineDir = path.join(tempDir, 'baseline');
    const config = {
      baselineArtifactName: 'test',
      workingDirectory: '.',
      baseUrl: 'http://localhost:3000',
      resultsFile: 'results.json',
      manifestFile: 'manifest.json',
      screenshotsRoot: 'screenshots',
      routes: [{ id: 'home', path: '/', viewport: 'desktop' }],
      diff: { threshold: 0.01, mode: 'report-only' }
    };
    const opts = { baselineDir, to: 'local', from: 'snap', acceptCrossEngine: false };

    await expect(runMigrateToLocal(config, opts))
      .rejects.toThrow(/Migration requires snap config/);
  });
});