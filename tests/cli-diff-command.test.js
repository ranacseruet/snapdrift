/** @jest-environment node */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { jest } from '@jest/globals';

const loadSnapdriftConfigMock = jest.fn();
const createProviderMock = jest.fn();
const generateHtmlReportMock = jest.fn(async () => '<html></html>');

// Spread the real package so every other export it provides stays intact —
// other modules in the cli.mjs import graph depend on them.
const actualAdapterFs = await import('@snapdrift/adapter-fs');

jest.unstable_mockModule('@snapdrift/adapter-fs', () => ({
  ...actualAdapterFs,
  loadSnapdriftConfig: loadSnapdriftConfigMock
}));

jest.unstable_mockModule('../lib/provider.mjs', () => ({
  createProvider: createProviderMock
}));

jest.unstable_mockModule('../lib/report.mjs', () => ({
  generateHtmlReport: generateHtmlReportMock
}));

const { runDiffCommand } = await import('../lib/cli.mjs');
const { SnapFallbackError, SnapSkipError } = await import('../lib/snap-provider.mjs');

const CONFIG = {
  provider: 'snap',
  baseUrl: 'https://example.com',
  resultsFile: 'results.json',
  manifestFile: 'manifest.json'
};

/** Set per test so the command's real summary/report writes land in a sandbox. */
let workDir;

function opts(overrides = {}) {
  return {
    baselineDir: path.join(workDir, 'baseline'),
    currentDir: path.join(workDir, 'current'),
    diffDir: path.join(workDir, 'diff'),
    routes: [],
    configPath: undefined,
    open: false,
    ...overrides
  };
}

function makeProvider({ captureImpl, diffImpl } = {}) {
  return {
    capture: jest.fn(async (options) => {
      if (captureImpl) return captureImpl(options);
      return {
        resultsPath: '/tmp/run/results.json',
        manifestPath: '/tmp/run/manifest.json',
        screenshotsRoot: '/tmp/run',
        selectedRouteIds: ['home']
      };
    }),
    diff: jest.fn(async (options) => {
      if (diffImpl) return diffImpl(options);
      return {
        summary: { status: 'clean', diffMode: 'fail-on-changes', changedScreenshots: 0, errors: [] },
        markdown: '# clean'
      };
    })
  };
}

let stdout;

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-cli-diff-'));
  loadSnapdriftConfigMock.mockReset();
  createProviderMock.mockReset();
  generateHtmlReportMock.mockClear();
  stdout = [];
  jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
});

afterEach(async () => {
  jest.restoreAllMocks();
  process.exitCode = undefined;
  await fs.rm(workDir, { recursive: true, force: true });
});

describe('runDiffCommand — onUnavailable: warn-and-skip', () => {
  // Capture-time SnapSkipError used to reach bin/snapdrift.mjs and exit 1,
  // contradicting the documented contract that warn-and-skip exits 0. See #125.
  it('exits cleanly when Snap is unavailable during capture', async () => {
    const provider = makeProvider({
      captureImpl: () => {
        throw new SnapSkipError('Snap API 500: internal server error');
      }
    });
    loadSnapdriftConfigMock.mockResolvedValue({ config: CONFIG });
    createProviderMock.mockReturnValue(provider);

    await expect(runDiffCommand(opts())).resolves.toBeUndefined();
    expect(provider.diff).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    expect(stdout.join('')).toMatch(/Visual regression skipped \(Snap unavailable, warn-and-skip mode\)/);
  });

  it('exits cleanly when Snap is unavailable during diff', async () => {
    const provider = makeProvider({
      diffImpl: () => {
        throw new SnapSkipError('Snap API 500: internal server error');
      }
    });
    loadSnapdriftConfigMock.mockResolvedValue({ config: CONFIG });
    createProviderMock.mockReturnValue(provider);

    await expect(runDiffCommand(opts())).resolves.toBeUndefined();
    expect(generateHtmlReportMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
});

describe('runDiffCommand — onUnavailable: fallback-local', () => {
  it('runs the local engine for the diff after a local fallback capture', async () => {
    const snapProvider = makeProvider({
      captureImpl: () => {
        throw new SnapFallbackError('Snap unreachable');
      }
    });
    const localProvider = makeProvider();
    loadSnapdriftConfigMock.mockResolvedValue({ config: CONFIG });
    createProviderMock.mockReturnValue(localProvider).mockReturnValueOnce(snapProvider);

    await expect(runDiffCommand(opts())).resolves.toBeUndefined();

    expect(localProvider.capture).toHaveBeenCalled();
    expect(localProvider.diff).toHaveBeenCalled();
    expect(snapProvider.diff).not.toHaveBeenCalled();
  });

  // A remote Snap capture leaves no PNGs on disk, so the local pixel engine has
  // nothing to compare until the routes are recaptured locally.
  it('recaptures locally before diffing when Snap goes down after a remote capture', async () => {
    let diffCalls = 0;
    const snapProvider = makeProvider({
      diffImpl: () => {
        diffCalls += 1;
        throw new SnapFallbackError('Snap unreachable');
      }
    });
    const localProvider = makeProvider();
    loadSnapdriftConfigMock.mockResolvedValue({ config: CONFIG });
    createProviderMock.mockReturnValue(localProvider).mockReturnValueOnce(snapProvider);

    await expect(runDiffCommand(opts())).resolves.toBeUndefined();

    expect(diffCalls).toBe(1);
    expect(snapProvider.capture).toHaveBeenCalled();
    expect(localProvider.capture).toHaveBeenCalled();
    expect(localProvider.diff).toHaveBeenCalledWith(
      expect.objectContaining({ currentResultsPath: '/tmp/run/results.json' })
    );
  });
});
