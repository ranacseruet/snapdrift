/** @jest-environment node */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { createProvider, LocalProvider } = await import('../lib/provider.mjs');
const { SnapProvider } = await import('../lib/snap-provider.mjs');
const { validateSnapdriftConfig, VALID_PROVIDER_VALUES, VALID_ON_UNAVAILABLE_MODES } = await import('@snapdrift/manifest');

const validBase = {
  baselineArtifactName: 'test-baseline',
  workingDirectory: '.',
  baseUrl: 'http://localhost:3000',
  resultsFile: 'results.json',
  manifestFile: 'manifest.json',
  screenshotsRoot: 'screenshots',
  routes: [{ id: 'home', path: '/', viewport: 'desktop' }],
  diff: { threshold: 0.01, mode: 'report-only' }
};

// ---------------------------------------------------------------------------
// createProvider
// ---------------------------------------------------------------------------

describe('createProvider', () => {
  it('returns a LocalProvider for "local"', () => {
    const provider = createProvider('local');
    expect(provider).toBeInstanceOf(LocalProvider);
  });

  it('throws for unknown provider name', () => {
    expect(() => createProvider('nonexistent')).toThrow(/Unknown SnapDrift provider.*"nonexistent"/);
  });

  it('throws for arbitrary string', () => {
    expect(() => createProvider('nonexistent')).toThrow(/Unknown SnapDrift provider.*"nonexistent"/);
  });

  it('lists available providers in error message', () => {
    expect(() => createProvider('invalid')).toThrow(/local/);
  });

  it('returns a SnapProvider for "snap" with valid config', () => {
    const config = { ...validBase, provider: 'snap', snap: { apiKeyEnv: 'SNAP_API_KEY', projectId: 'explicit-123' } };
    process.env.SNAP_API_KEY = 'test-key';
    try {
      const provider = createProvider('snap', config);
      expect(provider).toBeInstanceOf(SnapProvider);
    } finally {
      delete process.env.SNAP_API_KEY;
    }
  });

  it('throws for "snap" without config', () => {
    expect(() => createProvider('snap')).toThrow(/snap configuration/i);
  });
});

// ---------------------------------------------------------------------------
// LocalProvider interface
// ---------------------------------------------------------------------------

describe('LocalProvider', () => {
  it('exposes capture, diff, publishBaseline, fetchLatestBaseline methods', () => {
    const provider = new LocalProvider();
    expect(typeof provider.capture).toBe('function');
    expect(typeof provider.diff).toBe('function');
    expect(typeof provider.publishBaseline).toBe('function');
    expect(typeof provider.fetchLatestBaseline).toBe('function');
  });

  it('fetchLatestBaseline throws not-implemented error', async () => {
    const provider = new LocalProvider();
    await expect(provider.fetchLatestBaseline({ githubToken: 'fake' }))
      .rejects.toThrow(/not yet implemented/);
  });

  it('publishBaseline delegates to stageArtifacts', async () => {
    const provider = new LocalProvider();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-provider-'));
    try {
      const result = await provider.publishBaseline({ bundleDir: tmpDir });
      expect(result.bundleDir).toBe(path.resolve(tmpDir));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('publishBaseline passes resultsPath and manifestPath through', async () => {
    const provider = new LocalProvider();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-provider-'));
    const resultsPath = path.join(tmpDir, 'results.json');
    const manifestPath = path.join(tmpDir, 'manifest.json');
    await fs.writeFile(resultsPath, '{}');
    await fs.writeFile(manifestPath, '{}');

    try {
      const result = await provider.publishBaseline({
        bundleDir: path.join(tmpDir, 'bundle'),
        resultsPath,
        manifestPath
      });
      expect(result.bundleDir).toBe(path.resolve(path.join(tmpDir, 'bundle')));
      // Verify the files were staged
      const stagedResults = path.join(result.bundleDir, 'results.json');
      const stagedManifest = path.join(result.bundleDir, 'manifest.json');
      const resultsExists = await fs.access(stagedResults).then(() => true, () => false);
      const manifestExists = await fs.access(stagedManifest).then(() => true, () => false);
      expect(resultsExists).toBe(true);
      expect(manifestExists).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Config validation for provider field
// ---------------------------------------------------------------------------

describe('config validation — provider field', () => {
  it('accepts provider: "local"', () => {
    const config = validateSnapdriftConfig({ ...validBase, provider: 'local' });
    expect(config.provider).toBe('local');
  });

  it('accepts config without provider field (defaults to local in consumer code)', () => {
    const config = validateSnapdriftConfig(validBase);
    expect(config.provider).toBeUndefined();
  });

  it('accepts provider: "snap" with valid snap config', () => {
    const config = validateSnapdriftConfig({
      ...validBase,
      provider: 'snap',
      snap: { apiKeyEnv: 'SNAP_API_KEY' }
    });
    expect(config.provider).toBe('snap');
  });

  it('rejects provider: "snap" without snap config', () => {
    expect(() => validateSnapdriftConfig({ ...validBase, provider: 'snap' }))
      .toThrow(/snap config is required/i);
  });

  it('rejects provider: "snap" with both apiKeyEnv and apiKey', () => {
    expect(() => validateSnapdriftConfig({
      ...validBase,
      provider: 'snap',
      snap: { apiKeyEnv: 'SNAP_API_KEY', apiKey: '${SNAP_API_KEY}' }
    })).toThrow(/mutually exclusive/i);
  });

  it('rejects provider: "snap" with neither apiKeyEnv nor apiKey', () => {
    expect(() => validateSnapdriftConfig({
      ...validBase,
      provider: 'snap',
      snap: { projectId: 'auto' }
    })).toThrow(/exactly one of snap.apiKeyEnv or snap.apiKey/i);
  });

  it('rejects invalid onUnavailable mode', () => {
    expect(() => validateSnapdriftConfig({
      ...validBase,
      provider: 'snap',
      snap: { apiKeyEnv: 'SNAP_API_KEY', onUnavailable: 'skip' }
    })).toThrow(/snap.onUnavailable must be one of/i);
  });

  it('accepts valid onUnavailable modes', () => {
    for (const mode of ['fail', 'warn-and-skip', 'fallback-local']) {
      const config = validateSnapdriftConfig({
        ...validBase,
        provider: 'snap',
        snap: { apiKeyEnv: 'SNAP_API_KEY', onUnavailable: mode }
      });
      expect(config.snap.onUnavailable).toBe(mode);
    }
  });

  it('rejects provider: empty string', () => {
    expect(() => validateSnapdriftConfig({ ...validBase, provider: '' }))
      .toThrow(/provider must be one of/);
  });

  it('rejects provider: number', () => {
    expect(() => validateSnapdriftConfig({ ...validBase, provider: 42 }))
      .toThrow(/provider must be one of/);
  });

  it('VALID_PROVIDER_VALUES contains "local"', () => {
    expect(VALID_PROVIDER_VALUES).toContain('local');
  });

  it('VALID_PROVIDER_VALUES contains "snap"', () => {
    expect(VALID_PROVIDER_VALUES).toContain('snap');
  });

  it('VALID_ON_UNAVAILABLE_MODES contains expected modes', () => {
    expect(VALID_ON_UNAVAILABLE_MODES).toContain('fail');
    expect(VALID_ON_UNAVAILABLE_MODES).toContain('warn-and-skip');
    expect(VALID_ON_UNAVAILABLE_MODES).toContain('fallback-local');
  });
});
