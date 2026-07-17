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

  // Build the same plain ustar tar layout Snap's export endpoint emits.
  function buildExportTar(entries) {
    const octal = (value, length) => value.toString(8).padStart(length - 1, '0') + '\0';
    const chunks = [];
    for (const entry of entries) {
      const body = typeof entry.body === 'string' ? Buffer.from(entry.body, 'utf8') : Buffer.from(entry.body);
      const header = Buffer.alloc(512, 0);
      header.write(entry.name.slice(0, 100), 0, 'utf8');
      header.write(octal(0o644, 8), 100, 'ascii');
      header.write(octal(0, 8), 108, 'ascii');
      header.write(octal(0, 8), 116, 'ascii');
      header.write(octal(body.length, 12), 124, 'ascii');
      header.write(octal(Math.floor(Date.now() / 1000), 12), 136, 'ascii');
      header.fill(' ', 148, 156);
      header.write('0', 156, 'ascii');
      header.write('ustar\0', 257, 'ascii');
      header.write('00', 263, 'ascii');
      let checksum = 0;
      for (const byte of header) checksum += byte;
      header.write(octal(checksum, 8), 148, 'ascii');
      chunks.push(header, body);
      const pad = (512 - (body.length % 512)) % 512;
      if (pad) chunks.push(Buffer.alloc(pad, 0));
    }
    chunks.push(Buffer.alloc(1024, 0));
    return Buffer.concat(chunks);
  }

  function makeConfig() {
    return {
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
  }

  function makeOpts(baselineDir, overrides = {}) {
    return {
      command: 'migrate-baselines',
      open: false,
      routes: [],
      baselineDir,
      currentDir: path.join(tempDir, 'current'),
      diffDir: path.join(tempDir, 'diff'),
      to: 'local',
      from: 'snap',
      acceptCrossEngine: false,
      ...overrides
    };
  }

  async function withMockedFetch(response, run) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => response;
    try {
      return await run();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  it('imports the exported baseline and writes results, manifest, screenshots, and metadata', async () => {
    const baselineDir = path.join(tempDir, 'baseline');
    const pngBuffer = await createPngBuffer();
    const tar = buildExportTar([
      {
        name: 'manifest.json',
        body: JSON.stringify({
          project: { id: 'test-project', slug: 'test' },
          baselines: [{
            id: 'bsl_1',
            projectId: 'test-project',
            refBranch: 'main',
            refSha: 'abc1234567890def',
            status: 'accepted',
            createdAt: '2026-07-01T00:00:00.000Z',
            sourceManifest: {
              schemaVersion: 1,
              sourceRunId: 'run_1',
              routes: [{
                routeId: 'home',
                routePath: '/',
                viewportDescriptorJson: JSON.stringify({ width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false }),
                objectKey: 'visual/test-project/home.png'
              }]
            },
            objects: [{ sourceKey: 'visual/test-project/home.png', archivePath: 'bsl_1/images/abcd1234abcd1234.png' }]
          }]
        })
      },
      { name: 'bsl_1/images/abcd1234abcd1234.png', body: pngBuffer },
      { name: 'bsl_1/capture_profile.json', body: JSON.stringify({ schemaVersion: 1, engine: { name: 'snapdrift-local', version: 'v0' } }) },
      { name: 'MIGRATION_NOTES.md', body: '# notes\n' }
    ]);

    const response = {
      ok: true,
      status: 200,
      arrayBuffer: async () => tar.buffer.slice(tar.byteOffset, tar.byteOffset + tar.byteLength),
      text: async () => ''
    };

    await withMockedFetch(response, () => runMigrateToLocal(makeConfig(), makeOpts(baselineDir)));

    const results = JSON.parse(await fs.readFile(path.join(baselineDir, 'results.json'), 'utf-8'));
    expect(results.headSha).toBe('abc1234567890def');
    expect(results.baselineId).toBe('bsl_1');

    const manifest = JSON.parse(await fs.readFile(path.join(baselineDir, 'manifest.json'), 'utf-8'));
    expect(manifest.screenshots).toHaveLength(1);
    expect(manifest.screenshots[0].imagePath).toBe('screenshots/home.png');
    expect(manifest.screenshots[0].viewport).toBe('desktop');

    const written = await fs.readFile(path.join(baselineDir, 'screenshots', 'home.png'));
    expect(Buffer.compare(written, pngBuffer)).toBe(0);

    const metadata = JSON.parse(await fs.readFile(path.join(baselineDir, '.migration-metadata.json'), 'utf-8'));
    expect(metadata.source).toBe('snap');
    expect(metadata.engine).toEqual({ name: 'snapdrift-local', version: 'v0' });
  });

  it('propagates a clear error when the project has no accepted baselines', async () => {
    const baselineDir = path.join(tempDir, 'baseline');
    const tar = buildExportTar([
      { name: 'manifest.json', body: JSON.stringify({ project: { id: 'test-project' }, baselines: [] }) }
    ]);
    const response = {
      ok: true,
      status: 200,
      arrayBuffer: async () => tar.buffer.slice(tar.byteOffset, tar.byteOffset + tar.byteLength),
      text: async () => ''
    };

    await withMockedFetch(response, async () => {
      await expect(runMigrateToLocal(makeConfig(), makeOpts(baselineDir)))
        .rejects.toThrow(/no accepted baselines to export/);
    });
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