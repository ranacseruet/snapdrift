/** @jest-environment node */

import { jest } from '@jest/globals';

const loadSnapdriftConfigMock = jest.fn();
const createProviderMock = jest.fn();

// Spread the real package so every other export stays intact — other modules in
// the cli.mjs import graph depend on them.
const actualAdapterFs = await import('@snapdrift/adapter-fs');

jest.unstable_mockModule('@snapdrift/adapter-fs', () => ({
  ...actualAdapterFs,
  loadSnapdriftConfig: loadSnapdriftConfigMock
}));

jest.unstable_mockModule('../lib/provider.mjs', () => ({
  createProvider: createProviderMock
}));

const { runCaptureCommand } = await import('../lib/cli.mjs');
const { SnapFallbackError, SnapSkipError } = await import('../lib/snap-provider.mjs');

const BASELINE_DIR = '/tmp/snapdrift-capture';

function opts(overrides = {}) {
  return { baselineDir: BASELINE_DIR, routes: [], configPath: undefined, ...overrides };
}

function makeProvider({ captureImpl } = {}) {
  return {
    capture: jest.fn(async (options) => {
      if (captureImpl) return captureImpl(options);
      return { resultsPath: '/tmp/run/results.json', selectedRouteIds: ['home'] };
    })
  };
}

let stdout;

beforeEach(() => {
  loadSnapdriftConfigMock.mockReset();
  createProviderMock.mockReset();
  stdout = [];
  jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('runCaptureCommand — onUnavailable', () => {
  it('warn-and-skip exits cleanly instead of failing the build', async () => {
    const provider = makeProvider({
      captureImpl: () => {
        throw new SnapSkipError('Snap API 500: internal server error');
      }
    });
    loadSnapdriftConfigMock.mockResolvedValue({ config: { provider: 'snap' } });
    createProviderMock.mockReturnValue(provider);

    // Must resolve, not reject: rejecting sets exit code 1 in bin/snapdrift.mjs,
    // which is precisely what warn-and-skip is configured to avoid.
    await expect(runCaptureCommand(opts())).resolves.toBeUndefined();
    expect(stdout.join('')).toMatch(/Capture skipped \(Snap unavailable, warn-and-skip mode\)/);
  });

  it('fallback-local still captures locally', async () => {
    const snapProvider = makeProvider({
      captureImpl: () => {
        throw new SnapFallbackError('Snap unreachable');
      }
    });
    const localProvider = makeProvider();
    loadSnapdriftConfigMock.mockResolvedValue({ config: { provider: 'snap' } });
    createProviderMock.mockReturnValueOnce(snapProvider).mockReturnValueOnce(localProvider);

    await expect(runCaptureCommand(opts())).resolves.toBeUndefined();
    expect(localProvider.capture).toHaveBeenCalled();
  });

  it('still propagates errors that are not unavailability', async () => {
    const provider = makeProvider({
      captureImpl: () => {
        throw new Error('Snap API 403: unauthorized_visual_scope');
      }
    });
    loadSnapdriftConfigMock.mockResolvedValue({ config: { provider: 'snap' } });
    createProviderMock.mockReturnValue(provider);

    await expect(runCaptureCommand(opts())).rejects.toThrow(/unauthorized_visual_scope/);
  });
});
