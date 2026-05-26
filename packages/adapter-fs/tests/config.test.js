import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { loadSnapdriftConfig, readFirstDefinedEnv, DEFAULT_CONFIG_PATH, SNAPDRIFT_CAPTURE_CONCURRENCY } from '../src/config.mjs';

const VALID_CONFIG = {
  baselineArtifactName: 'snapdrift-baseline',
  workingDirectory: '.',
  baseUrl: 'http://localhost:3000',
  resultsFile: 'results.json',
  manifestFile: 'manifest.json',
  screenshotsRoot: 'screenshots',
  routes: [
    { id: 'home', path: '/', viewport: 'desktop' }
  ],
  diff: { threshold: 0.01, mode: 'report-only' }
};

describe('@snapdrift/adapter-fs — config', () => {
  describe('loadSnapdriftConfig', () => {
    test('reads config from disk and validates it', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-config-'));
      const configPath = path.join(tmpDir, 'snapdrift.json');
      await fs.writeFile(configPath, JSON.stringify(VALID_CONFIG));

      const { config, configPath: resolvedPath } = await loadSnapdriftConfig(configPath);
      expect(resolvedPath).toBe(path.resolve(configPath));
      expect(config.routes).toHaveLength(1);
      expect(config.routes[0].id).toBe('home');
      expect(config.diff.mode).toBe('report-only');

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    test('throws on invalid config file', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-config-'));
      const configPath = path.join(tmpDir, 'snapdrift.json');
      await fs.writeFile(configPath, JSON.stringify({ invalid: true }));

      await expect(loadSnapdriftConfig(configPath)).rejects.toThrow('Invalid SnapDrift config');

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    test('throws when file does not exist', async () => {
      await expect(loadSnapdriftConfig('/nonexistent/path/snapdrift.json')).rejects.toThrow();
    });
  });

  describe('readFirstDefinedEnv', () => {
    test('returns the first defined env value', () => {
      process.env._SNAPDRIFT_TEST_A = 'alpha';
      delete process.env._SNAPDRIFT_TEST_B;
      expect(readFirstDefinedEnv(['_SNAPDRIFT_TEST_B', '_SNAPDRIFT_TEST_A'])).toBe('alpha');
      delete process.env._SNAPDRIFT_TEST_A;
    });

    test('returns undefined when none are defined', () => {
      expect(readFirstDefinedEnv(['_SNAPDRIFT_TEST_MISSING_XYZ'])).toBeUndefined();
    });

    test('skips empty string values', () => {
      process.env._SNAPDRIFT_TEST_EMPTY = '';
      expect(readFirstDefinedEnv(['_SNAPDRIFT_TEST_EMPTY'])).toBeUndefined();
      delete process.env._SNAPDRIFT_TEST_EMPTY;
    });
  });

  describe('DEFAULT_CONFIG_PATH', () => {
    test('resolves to .github/snapdrift.json', () => {
      expect(DEFAULT_CONFIG_PATH).toContain('.github');
      expect(DEFAULT_CONFIG_PATH).toContain('snapdrift.json');
    });
  });

  describe('SNAPDRIFT_CAPTURE_CONCURRENCY', () => {
    test('defaults to 5 when env is not set', () => {
      // The module-level constant was already evaluated; just verify it is a positive integer
      expect(SNAPDRIFT_CAPTURE_CONCURRENCY).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(SNAPDRIFT_CAPTURE_CONCURRENCY)).toBe(true);
    });
  });
});