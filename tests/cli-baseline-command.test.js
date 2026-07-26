/** @jest-environment node */

import { jest } from '@jest/globals';

const loadSnapdriftConfigMock = jest.fn();
const createProviderMock = jest.fn();

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

const { runBaselineCommand } = await import('../lib/cli.mjs');
const { SnapFallbackError, SnapSkipError } = await import('../lib/snap-provider.mjs');

const BASELINE_DIR = '/tmp/snapdrift-baseline';

function opts(overrides = {}) {
  return { baselineDir: BASELINE_DIR, routes: [], configPath: undefined, ...overrides };
}

/** Minimal provider double recording which methods the command called. */
function makeProvider({ captureImpl, publishImpl } = {}) {
  const calls = [];
  return {
    calls,
    capture: jest.fn(async (options) => {
      calls.push('capture');
      if (captureImpl) return captureImpl(options);
      return {
        resultsPath: '/tmp/run/results.json',
        manifestPath: '/tmp/run/manifest.json',
        screenshotsRoot: '/tmp/run',
        selectedRouteIds: ['home', 'about']
      };
    }),
    publishBaseline: jest.fn(async (options) => {
      calls.push('publishBaseline');
      if (publishImpl) return publishImpl(options);
      return {};
    })
  };
}

let stdout;
let stderr;

beforeEach(() => {
  loadSnapdriftConfigMock.mockReset();
  createProviderMock.mockReset();
  stdout = [];
  stderr = [];
  jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('runBaselineCommand — provider: "snap"', () => {
  it('captures and then publishes, in that order', async () => {
    const provider = makeProvider();
    loadSnapdriftConfigMock.mockResolvedValue({ config: { provider: 'snap' } });
    createProviderMock.mockReturnValue(provider);

    await runBaselineCommand(opts());

    // The whole point of ranacseruet/snapdrift#106: capture alone submits a run
    // but never creates a baseline. Both calls must happen, publish second.
    expect(provider.calls).toEqual(['capture', 'publishBaseline']);
    expect(provider.publishBaseline).toHaveBeenCalledWith({
      resultsPath: '/tmp/run/results.json'
    });
    expect(stdout.join('')).toMatch(/Snap baseline published successfully/);
  });

  it('passes purpose "baseline" and selected routes through to capture', async () => {
    const provider = makeProvider();
    loadSnapdriftConfigMock.mockResolvedValue({ config: { provider: 'snap' } });
    createProviderMock.mockReturnValue(provider);

    await runBaselineCommand(opts({ routes: ['home'], configPath: 'custom.json' }));

    expect(provider.capture).toHaveBeenCalledWith({
      configPath: 'custom.json',
      routeIds: ['home'],
      outDir: BASELINE_DIR,
      purpose: 'baseline'
    });
  });

  it('propagates a publish failure instead of reporting success', async () => {
    const provider = makeProvider({
      publishImpl: () => {
        throw new Error('Snap API 409: baseline_publish_conflict');
      }
    });
    loadSnapdriftConfigMock.mockResolvedValue({ config: { provider: 'snap' } });
    createProviderMock.mockReturnValue(provider);

    await expect(runBaselineCommand(opts())).rejects.toThrow(/baseline_publish_conflict/);
    expect(stdout.join('')).not.toMatch(/published successfully/);
  });
});

describe('runBaselineCommand — provider: "local"', () => {
  it('captures without publishing, since the captured files are the baseline', async () => {
    const provider = makeProvider();
    loadSnapdriftConfigMock.mockResolvedValue({ config: {} });
    createProviderMock.mockReturnValue(provider);

    await runBaselineCommand(opts());

    expect(provider.calls).toEqual(['capture']);
    expect(provider.publishBaseline).not.toHaveBeenCalled();
    expect(createProviderMock).toHaveBeenCalledWith('local', {});
    expect(stdout.join('')).toMatch(/Captured 2 route\(s\)/);
  });
});

describe('runBaselineCommand — onUnavailable: warn-and-skip', () => {
  it('exits cleanly without publishing when Snap is unavailable', async () => {
    const provider = makeProvider({
      captureImpl: () => {
        throw new SnapSkipError('Snap API 500: internal server error');
      }
    });
    loadSnapdriftConfigMock.mockResolvedValue({ config: { provider: 'snap' } });
    createProviderMock.mockReturnValue(provider);

    // warn-and-skip means "do not fail my build for this" — the command must
    // resolve, not reject, matching runDiffCommand's handling of the same error.
    await expect(runBaselineCommand(opts())).resolves.toBeUndefined();
    expect(provider.publishBaseline).not.toHaveBeenCalled();
    expect(stdout.join('')).toMatch(/Baseline skipped \(Snap unavailable, warn-and-skip mode\)/);
  });
});

describe('runBaselineCommand — onUnavailable: fallback-local', () => {
  it('does not publish to Snap after falling back to a local capture', async () => {
    const snapProvider = makeProvider({
      captureImpl: () => {
        throw new SnapFallbackError('Snap unreachable');
      }
    });
    const localProvider = makeProvider();
    loadSnapdriftConfigMock.mockResolvedValue({ config: { provider: 'snap' } });
    createProviderMock
      .mockReturnValueOnce(snapProvider)
      .mockReturnValueOnce(localProvider);

    await runBaselineCommand(opts());

    // The baseline is local now — publishing it to Snap would create a baseline
    // whose manifest references object keys Snap never stored.
    expect(snapProvider.publishBaseline).not.toHaveBeenCalled();
    expect(localProvider.publishBaseline).not.toHaveBeenCalled();
    expect(localProvider.capture).toHaveBeenCalled();
    expect(stdout.join('')).toMatch(/local fallback — nothing published to Snap/);
  });
});
