/** @jest-environment node */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';

const { createProvider, LocalProvider } = await import('../lib/provider.mjs');
const { validateSnapdriftConfig, VALID_PROVIDER_VALUES } = await import('@snapdrift/manifest');

// ---------------------------------------------------------------------------
// createProvider
// ---------------------------------------------------------------------------

describe('createProvider', () => {
  it('returns a LocalProvider for "local"', () => {
    const provider = createProvider('local');
    expect(provider).toBeInstanceOf(LocalProvider);
  });

  it('throws for unknown provider name', () => {
    expect(() => createProvider('snap')).toThrow(/Unknown SnapDrift provider.*"snap"/);
  });

  it('throws for arbitrary string', () => {
    expect(() => createProvider('nonexistent')).toThrow(/Unknown SnapDrift provider.*"nonexistent"/);
  });

  it('lists available providers in error message', () => {
    try {
      createProvider('invalid');
    } catch (err) {
      expect(err.message).toContain('local');
    }
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

  it('accepts provider: "local"', () => {
    const config = validateSnapdriftConfig({ ...validBase, provider: 'local' });
    expect(config.provider).toBe('local');
  });

  it('accepts config without provider field (defaults to local in consumer code)', () => {
    const config = validateSnapdriftConfig(validBase);
    expect(config.provider).toBeUndefined();
  });

  it('rejects provider: "snap"', () => {
    expect(() => validateSnapdriftConfig({ ...validBase, provider: 'snap' }))
      .toThrow(/provider must be one of: local/);
  });

  it('rejects provider: empty string', () => {
    expect(() => validateSnapdriftConfig({ ...validBase, provider: '' }))
      .toThrow(/provider must be one of: local/);
  });

  it('rejects provider: number', () => {
    expect(() => validateSnapdriftConfig({ ...validBase, provider: 42 }))
      .toThrow(/provider must be one of: local/);
  });

  it('VALID_PROVIDER_VALUES contains "local"', () => {
    expect(VALID_PROVIDER_VALUES).toContain('local');
  });
});
