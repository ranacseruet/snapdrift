/** @jest-environment node */

import { jest } from '@jest/globals';

const {
  captureWithPolicy,
  diffWithPolicy,
  hasLocalScreenshots,
  publishBaselineWithPolicy,
  MISSING_BASELINE_REASON,
  SNAP_UNAVAILABLE_REASON
} = await import('../lib/outage-policy.mjs');
const { SnapFallbackError, SnapSkipError } = await import('../lib/snap-provider.mjs');

const CAPTURE_RESULT = {
  resultsPath: '/tmp/local/results.json',
  manifestPath: '/tmp/local/manifest.json',
  screenshotsRoot: '/tmp/local',
  selectedRouteIds: ['home', 'about']
};

const DIFF_RESULT = { summary: { status: 'clean' }, markdown: '# clean' };

/**
 * Provider double. Each method either throws the supplied error or returns the
 * canned result, and records the options it was called with.
 */
function makeProvider({ captureError, diffError, publishError, captureResult = CAPTURE_RESULT } = {}) {
  return {
    capture: jest.fn(async () => {
      if (captureError) throw captureError;
      return captureResult;
    }),
    diff: jest.fn(async () => {
      if (diffError) throw diffError;
      return DIFF_RESULT;
    }),
    publishBaseline: jest.fn(async () => {
      if (publishError) throw publishError;
      return {};
    })
  };
}

describe('hasLocalScreenshots', () => {
  it('is true for the local provider', () => {
    expect(hasLocalScreenshots('local', { baseUrl: 'https://example.com' })).toBe(true);
  });

  it('is false for a remote Snap capture, which renders server-side', () => {
    expect(hasLocalScreenshots('snap', { baseUrl: 'https://example.com' })).toBe(false);
  });

  it('is true for the Snap local-capture hybrid, which renders on the runner', () => {
    expect(hasLocalScreenshots('snap', { baseUrl: 'http://localhost:3000' })).toBe(true);
  });
});

describe('captureWithPolicy', () => {
  it('returns the capture and the configured provider when Snap is healthy', async () => {
    const provider = makeProvider();

    const result = await captureWithPolicy({
      provider,
      providerName: 'snap',
      config: { baseUrl: 'https://example.com' },
      captureOptions: { routeIds: ['home'] }
    });

    expect(result).toMatchObject({ outcome: 'captured', providerName: 'snap', localScreenshots: false });
    expect(result.result).toBe(CAPTURE_RESULT);
  });

  it('reports "skipped" on SnapSkipError instead of throwing', async () => {
    const provider = makeProvider({ captureError: new SnapSkipError('Snap API 500') });
    const onSkip = jest.fn();

    const result = await captureWithPolicy({
      provider,
      providerName: 'snap',
      captureOptions: {},
      onSkip
    });

    expect(result.outcome).toBe('skipped');
    expect(result.result).toBeUndefined();
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  // The bug in #125: the wrapper captured locally but kept emitting
  // provider=snap, so the compare step rebuilt SnapProvider around local
  // results that carry no run id.
  it('reports the effective provider as "local" after a fallback capture', async () => {
    const snapProvider = makeProvider({ captureError: new SnapFallbackError('Snap unreachable') });
    const localProvider = makeProvider();
    const onFallback = jest.fn();

    const result = await captureWithPolicy({
      provider: snapProvider,
      providerName: 'snap',
      config: { baseUrl: 'https://example.com' },
      captureOptions: { routeIds: ['home'] },
      createLocalProvider: () => localProvider,
      onFallback
    });

    expect(result).toMatchObject({ outcome: 'captured', providerName: 'local', localScreenshots: true });
    expect(localProvider.capture).toHaveBeenCalledWith({ routeIds: ['home'] });
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it('propagates errors that are not unavailability', async () => {
    const provider = makeProvider({ captureError: new Error('Snap API 403: unauthorized_visual_scope') });

    await expect(
      captureWithPolicy({ provider, providerName: 'snap', captureOptions: {} })
    ).rejects.toThrow(/unauthorized_visual_scope/);
  });
});

describe('diffWithPolicy', () => {
  const diffOptions = {
    baselineResultsPath: '/tmp/baseline/results.json',
    currentResultsPath: '/tmp/snap/results.json',
    currentManifestPath: '/tmp/snap/manifest.json'
  };

  it('returns the diff when Snap is healthy', async () => {
    const provider = makeProvider();

    const result = await diffWithPolicy({ provider, providerName: 'snap', diffOptions });

    expect(result).toMatchObject({ outcome: 'diffed', providerName: 'snap' });
    expect(result.result).toBe(DIFF_RESULT);
  });

  it('reports "skipped" on SnapSkipError instead of throwing', async () => {
    const provider = makeProvider({ diffError: new SnapSkipError('Snap API 500') });
    const onSkip = jest.fn();

    const result = await diffWithPolicy({ provider, providerName: 'snap', diffOptions, onSkip });

    expect(result.outcome).toBe('skipped');
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('diffs locally without recapturing when the current capture is already local', async () => {
    const snapProvider = makeProvider({ diffError: new SnapFallbackError('Snap unreachable') });
    const localProvider = makeProvider();

    const result = await diffWithPolicy({
      provider: snapProvider,
      providerName: 'snap',
      diffOptions,
      captureOptions: {},
      localScreenshots: true,
      createLocalProvider: () => localProvider
    });

    expect(result).toMatchObject({ outcome: 'diffed', providerName: 'local' });
    expect(localProvider.capture).not.toHaveBeenCalled();
    expect(localProvider.diff).toHaveBeenCalledWith(diffOptions);
  });

  // The second bug in #125: a remote Snap capture writes run metadata and a
  // zero-dimension manifest, so handing it to the local pixel engine produced a
  // dimension-only result rather than a real comparison.
  it('recaptures locally first when the current capture was rendered by Snap', async () => {
    const snapProvider = makeProvider({ diffError: new SnapFallbackError('Snap unreachable') });
    const localProvider = makeProvider();
    const onRecapture = jest.fn();

    const result = await diffWithPolicy({
      provider: snapProvider,
      providerName: 'snap',
      diffOptions,
      captureOptions: { routeIds: ['home'] },
      localScreenshots: false,
      createLocalProvider: () => localProvider,
      onRecapture
    });

    expect(onRecapture).toHaveBeenCalledTimes(1);
    expect(localProvider.capture).toHaveBeenCalledWith({ routeIds: ['home'] });
    expect(localProvider.diff).toHaveBeenCalledWith({
      ...diffOptions,
      currentResultsPath: CAPTURE_RESULT.resultsPath,
      currentManifestPath: CAPTURE_RESULT.manifestPath,
      currentRunDir: CAPTURE_RESULT.screenshotsRoot
    });
    expect(result.recapture).toBe(CAPTURE_RESULT);
  });

  it('reports "baseline-unavailable" rather than crashing the local diff on a missing baseline', async () => {
    const snapProvider = makeProvider({ diffError: new SnapFallbackError('Snap unreachable') });
    const localProvider = makeProvider();
    const onBaselineUnavailable = jest.fn();

    const result = await diffWithPolicy({
      provider: snapProvider,
      providerName: 'snap',
      diffOptions: { ...diffOptions, baselineResultsPath: undefined },
      captureOptions: {},
      localScreenshots: false,
      createLocalProvider: () => localProvider,
      onBaselineUnavailable
    });

    expect(result.outcome).toBe('baseline-unavailable');
    expect(localProvider.capture).not.toHaveBeenCalled();
    expect(localProvider.diff).not.toHaveBeenCalled();
    expect(onBaselineUnavailable).toHaveBeenCalledTimes(1);
  });

  it('fails loudly when a recapture is required but no captureOptions were supplied', async () => {
    const snapProvider = makeProvider({ diffError: new SnapFallbackError('Snap unreachable') });

    await expect(
      diffWithPolicy({
        provider: snapProvider,
        providerName: 'snap',
        diffOptions,
        localScreenshots: false,
        createLocalProvider: () => makeProvider()
      })
    ).rejects.toThrow(/no captureOptions were supplied/);
  });

  it('propagates errors that are not unavailability', async () => {
    const provider = makeProvider({ diffError: new Error('Snap API 403: unauthorized_visual_scope') });

    await expect(
      diffWithPolicy({ provider, providerName: 'snap', diffOptions })
    ).rejects.toThrow(/unauthorized_visual_scope/);
  });
});

describe('publishBaselineWithPolicy', () => {
  it('reports "published" on success', async () => {
    const provider = makeProvider();

    const result = await publishBaselineWithPolicy({
      provider,
      publishOptions: { resultsPath: '/tmp/snap/results.json' }
    });

    expect(result.outcome).toBe('published');
    expect(provider.publishBaseline).toHaveBeenCalledWith({ resultsPath: '/tmp/snap/results.json' });
  });

  it('reports "skipped" on SnapSkipError instead of failing the build', async () => {
    const provider = makeProvider({ publishError: new SnapSkipError('Snap API 500') });
    const onSkip = jest.fn();

    const result = await publishBaselineWithPolicy({ provider, publishOptions: {}, onSkip });

    expect(result.outcome).toBe('skipped');
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('recaptures locally on SnapFallbackError so the run still yields a baseline', async () => {
    const snapProvider = makeProvider({ publishError: new SnapFallbackError('Snap unreachable') });
    const localProvider = makeProvider();

    const result = await publishBaselineWithPolicy({
      provider: snapProvider,
      publishOptions: {},
      captureOptions: { purpose: 'baseline' },
      createLocalProvider: () => localProvider
    });

    expect(result.outcome).toBe('fell-back');
    expect(result.recapture).toBe(CAPTURE_RESULT);
    expect(localProvider.capture).toHaveBeenCalledWith({ purpose: 'baseline' });
  });

  it('propagates errors that are not unavailability', async () => {
    const provider = makeProvider({ publishError: new Error('Snap API 409: baseline_publish_conflict') });

    await expect(
      publishBaselineWithPolicy({ provider, publishOptions: {} })
    ).rejects.toThrow(/baseline_publish_conflict/);
  });
});

describe('skipped-summary reasons', () => {
  it('exposes reasons the drift summary knows how to describe', async () => {
    const { buildDriftSummary } = await import('@snapdrift/adapter-report-md');

    const unavailable = buildDriftSummary({ reason: SNAP_UNAVAILABLE_REASON });
    expect(unavailable.summary.status).toBe('skipped');
    expect(unavailable.summary.message).toMatch(/Snap could not be reached/);
    expect(unavailable.markdown).toMatch(/warn-and-skip/);

    const missingBaseline = buildDriftSummary({ reason: MISSING_BASELINE_REASON });
    expect(missingBaseline.summary.message).toMatch(/baseline was not available/);
  });
});
