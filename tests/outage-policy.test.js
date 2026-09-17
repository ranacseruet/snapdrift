/** @jest-environment node */

import { jest } from '@jest/globals';

const {
  captureWithPolicy,
  diffWithPolicy,
  hasLocalScreenshots,
  describeCaptureArtifacts,
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

describe('describeCaptureArtifacts', () => {
  it.each([
    ['local', 'https://example.com', true],
    ['snap', 'https://example.com', false],
    ['snap', 'http://localhost:3000', true],
    ['unknown', 'https://example.com', true],
    ['snap', undefined, false]
  ])('describes %s captures at %s', (providerName, baseUrl, localScreenshots) => {
    expect(describeCaptureArtifacts(providerName, CAPTURE_RESULT, { baseUrl })).toEqual({
      localScreenshots,
      artifactsRoot: localScreenshots ? CAPTURE_RESULT.screenshotsRoot : undefined
    });
    expect(hasLocalScreenshots(providerName, { baseUrl })).toBe(localScreenshots);
  });

  it('does not invent an artifacts root when capture paths are absent', () => {
    expect(describeCaptureArtifacts('local')).toEqual({ localScreenshots: true, artifactsRoot: undefined });
  });
});

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
  it('prefers provider-returned artifacts over contradictory provider and config inference', async () => {
    const artifacts = { localScreenshots: true, artifactsRoot: CAPTURE_RESULT.screenshotsRoot };
    const captureResult = { ...CAPTURE_RESULT, artifacts };
    const result = await captureWithPolicy({
      provider: makeProvider({ captureResult }), providerName: 'snap',
      config: { baseUrl: 'https://example.com' }, captureOptions: {}
    });
    expect(result.artifacts).toEqual(artifacts);
    expect(result.localScreenshots).toBe(true);
  });

  it.each([
    ['local', 'https://example.com', true],
    ['snap', 'https://example.com', false],
    ['snap', 'http://localhost:3000', true]
  ])('surfaces artifact capabilities for %s at %s', async (providerName, baseUrl, localScreenshots) => {
    const result = await captureWithPolicy({ provider: makeProvider(), providerName, config: { baseUrl }, captureOptions: {} });
    expect(result).toEqual({
      outcome: 'captured', providerName, result: CAPTURE_RESULT, localScreenshots,
      artifacts: { localScreenshots, artifactsRoot: localScreenshots ? CAPTURE_RESULT.screenshotsRoot : undefined }
    });
  });
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
    expect(result.artifacts).toEqual({ localScreenshots: false });
    expect(result.localScreenshots).toBe(false);
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

  it('rejects a local capture fallback when baseline lookup failed while preserving the outage callback', async () => {
    const snapProvider = makeProvider({ captureError: new SnapFallbackError('Snap unreachable') });
    const localProvider = makeProvider();
    const onFallback = jest.fn();

    const fallback = captureWithPolicy({
      provider: snapProvider,
      providerName: 'snap',
      config: { baseUrl: 'https://example.com' },
      captureOptions: { routeIds: ['home'] },
      createLocalProvider: () => localProvider,
      baselineResolutionStatus: 'error',
      baselineResolutionMessage: 'Unable to resolve the SnapDrift baseline artifact: Not Found',
      onFallback
    });
    await expect(fallback).rejects.toThrow(/GitHub baseline lookup failed.*Not Found.*Snap unreachable/);
    await expect(fallback).rejects.toMatchObject({ cause: expect.objectContaining({ message: 'Snap unreachable' }) });

    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(localProvider.capture).not.toHaveBeenCalled();
  });

  it('allows a local capture fallback when the baseline is intentionally missing', async () => {
    const snapProvider = makeProvider({ captureError: new SnapFallbackError('Snap unreachable') });
    const localProvider = makeProvider();

    const result = await captureWithPolicy({
      provider: snapProvider,
      providerName: 'snap',
      config: { baseUrl: 'https://example.com' },
      captureOptions: { routeIds: ['home'] },
      createLocalProvider: () => localProvider,
      baselineResolutionStatus: 'missing'
    });

    expect(result).toMatchObject({ outcome: 'captured', providerName: 'local' });
    expect(localProvider.capture).toHaveBeenCalledTimes(1);
  });
});

describe('diffWithPolicy', () => {
  const diffOptions = {
    baselineResultsPath: '/tmp/baseline/results.json',
    currentResultsPath: '/tmp/snap/results.json',
    currentManifestPath: '/tmp/snap/manifest.json'
  };

  it.each([
    ['diffed', undefined, DIFF_RESULT, 'snap'],
    ['skipped', new SnapSkipError('unavailable'), undefined, 'snap'],
    ['baseline-unavailable', new SnapFallbackError('unavailable'), undefined, 'local']
  ])('returns explicit capture artifacts for %s', async (outcome, diffError, expectedResult, providerName) => {
    const artifacts = { localScreenshots: false, artifactsRoot: undefined };
    const result = await diffWithPolicy({
      provider: makeProvider({ diffError }),
      providerName: 'snap',
      diffOptions,
      artifacts,
      baselineAvailable: false
    });
    expect(result).toEqual({
      outcome,
      providerName,
      ...(expectedResult ? { result: expectedResult } : {}),
      artifacts,
      localScreenshots: false
    });
  });

  it.each([
    ['explicit remote overrides hybrid inference', { localScreenshots: false }, undefined, 'http://localhost:3000', true],
    ['explicit hybrid overrides remote inference', { localScreenshots: true, artifactsRoot: '/tmp/hybrid' }, undefined, 'https://example.com', false],
    ['remote inference', undefined, undefined, 'https://example.com', true],
    ['hybrid inference', undefined, undefined, 'http://localhost:3000', false],
    ['legacy true overrides artifacts', { localScreenshots: false }, true, 'https://example.com', false],
    ['legacy false overrides artifacts', { localScreenshots: true }, false, 'http://localhost:3000', true]
  ])('preserves fallback recapture decisions: %s', async (_name, artifacts, localScreenshots, baseUrl, recaptures) => {
    const localProvider = makeProvider();
    const result = await diffWithPolicy({
      provider: makeProvider({ diffError: new SnapFallbackError('unavailable') }),
      providerName: 'snap', config: { baseUrl }, diffOptions, captureOptions: {},
      artifacts, localScreenshots, createLocalProvider: () => localProvider
    });
    expect(localProvider.capture).toHaveBeenCalledTimes(recaptures ? 1 : 0);
    expect(result.localScreenshots).toBe(true);
    expect(result.artifacts).toEqual({
      localScreenshots: true,
      artifactsRoot: recaptures ? CAPTURE_RESULT.screenshotsRoot : artifacts?.artifactsRoot
    });
    expect(result.recapture).toBe(recaptures ? CAPTURE_RESULT : undefined);
    expect(localProvider.diff).toHaveBeenCalledWith(recaptures ? {
      ...diffOptions,
      currentResultsPath: CAPTURE_RESULT.resultsPath,
      currentManifestPath: CAPTURE_RESULT.manifestPath,
      currentRunDir: CAPTURE_RESULT.screenshotsRoot
    } : diffOptions);
  });

  it.each([undefined, CAPTURE_RESULT])('defaults to local diff without recapture for legacy Snap callers with no capabilities or config (captureResult: %j)', async (captureResult) => {
    const localProvider = makeProvider();
    const onRecapture = jest.fn();
    const result = await diffWithPolicy({
      provider: makeProvider({ diffError: new SnapFallbackError('unavailable') }),
      providerName: 'snap', diffOptions, captureResult,
      baselineAvailable: true, createLocalProvider: () => localProvider, onRecapture
    });
    expect(result).toMatchObject({ outcome: 'diffed', providerName: 'local', localScreenshots: true });
    expect(result.recapture).toBeUndefined();
    expect(localProvider.capture).not.toHaveBeenCalled();
    expect(onRecapture).not.toHaveBeenCalled();
    expect(localProvider.diff).toHaveBeenCalledWith(diffOptions);
  });

  it.each([
    ['result local overrides remote config', true, 'https://example.com', undefined, undefined, false],
    ['result remote overrides hybrid config', false, 'http://localhost:3000', undefined, undefined, true],
    ['result remote overrides no-config default', false, undefined, undefined, undefined, true],
    ['artifacts override result local', true, undefined, { localScreenshots: false }, undefined, true],
    ['artifacts override result remote', false, undefined, { localScreenshots: true, artifactsRoot: '/tmp/override' }, undefined, false],
    ['legacy boolean overrides result local', true, undefined, undefined, false, true],
    ['legacy boolean overrides result remote', false, undefined, undefined, true, false]
  ])('prefers explicit capabilities before inference and legacy defaults: %s', async (_name, localScreenshots, baseUrl, artifacts, legacy, recaptures) => {
    const localProvider = makeProvider();
    const captureResult = {
      ...CAPTURE_RESULT,
      artifacts: { localScreenshots, artifactsRoot: localScreenshots ? CAPTURE_RESULT.screenshotsRoot : undefined }
    };
    const result = await diffWithPolicy({
      provider: makeProvider({ diffError: new SnapFallbackError('unavailable') }),
      providerName: 'snap', diffOptions, captureResult,
      config: baseUrl ? { baseUrl } : undefined,
      artifacts, localScreenshots: legacy, captureOptions: {}, createLocalProvider: () => localProvider
    });
    expect(localProvider.capture).toHaveBeenCalledTimes(recaptures ? 1 : 0);
    expect(result.localScreenshots).toBe(true);
    expect(result.recapture).toBe(recaptures ? CAPTURE_RESULT : undefined);
    expect(result.artifacts.artifactsRoot).toBe(recaptures
      ? CAPTURE_RESULT.screenshotsRoot
      : (artifacts || captureResult.artifacts).artifactsRoot);
    expect(localProvider.diff).toHaveBeenCalledWith(recaptures ? {
      ...diffOptions, currentResultsPath: CAPTURE_RESULT.resultsPath,
      currentManifestPath: CAPTURE_RESULT.manifestPath, currentRunDir: CAPTURE_RESULT.screenshotsRoot
    } : diffOptions);
  });

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

  it('rejects a local diff fallback when baseline lookup failed after notifying the callback', async () => {
    const snapProvider = makeProvider({ diffError: new SnapFallbackError('Snap unreachable') });
    const localProvider = makeProvider();
    const onBaselineUnavailable = jest.fn();

    const fallback = diffWithPolicy({
      provider: snapProvider,
      providerName: 'snap',
      diffOptions: { ...diffOptions, baselineResultsPath: undefined },
      captureOptions: { routeIds: ['home'] },
      localScreenshots: false,
      createLocalProvider: () => localProvider,
      baselineResolutionStatus: 'error',
      baselineResolutionMessage: 'Unable to resolve the SnapDrift baseline artifact: Not Found',
      onBaselineUnavailable
    });
    await expect(fallback).rejects.toThrow(/GitHub baseline lookup failed.*Not Found.*Snap unreachable/);
    await expect(fallback).rejects.toMatchObject({ cause: expect.objectContaining({ message: 'Snap unreachable' }) });

    expect(onBaselineUnavailable).toHaveBeenCalledTimes(1);
    expect(localProvider.capture).not.toHaveBeenCalled();
    expect(localProvider.diff).not.toHaveBeenCalled();
  });

  it('allows a missing-baseline diff fallback to keep the intentional skip outcome', async () => {
    const snapProvider = makeProvider({ diffError: new SnapFallbackError('Snap unreachable') });
    const localProvider = makeProvider();
    const onBaselineUnavailable = jest.fn();

    const result = await diffWithPolicy({
      provider: snapProvider,
      providerName: 'snap',
      diffOptions: { ...diffOptions, baselineResultsPath: undefined },
      captureOptions: { routeIds: ['home'] },
      localScreenshots: false,
      createLocalProvider: () => localProvider,
      baselineResolutionStatus: 'missing',
      onBaselineUnavailable
    });

    expect(result.outcome).toBe('baseline-unavailable');
    expect(onBaselineUnavailable).toHaveBeenCalledTimes(1);
    expect(localProvider.capture).not.toHaveBeenCalled();
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
