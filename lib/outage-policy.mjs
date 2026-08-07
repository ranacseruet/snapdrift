// @ts-check

/**
 * Shared `snap.onUnavailable` policy for every SnapDrift entry point.
 *
 * `warn-and-skip` and `fallback-local` used to be re-implemented independently
 * in `lib/cli.mjs`, `actions/pr-diff` and `actions/baseline`, and the copies
 * drifted apart — see ranacseruet/snapdrift#125:
 *
 * - a wrapper capture that fell back to local still reported `provider=snap`,
 *   so the compare step rebuilt `SnapProvider` and handed it local results with
 *   no run id;
 * - a diff-time fallback swapped only the diff provider, so `LocalProvider` was
 *   asked to pixel-compare a remote Snap capture that has a manifest but no
 *   PNGs on disk;
 * - `warn-and-skip` exited the wrapper without writing the documented skipped
 *   summary, so the PR comment claimed "Capture Failed";
 * - `actions/baseline` did not apply the policy to `publishBaseline()` at all.
 *
 * Every caller now routes through these three helpers, so the error-mode matrix
 * is defined once.
 */

import { createProvider } from './provider.mjs';
import { SnapFallbackError, SnapSkipError, isLocalBaseUrl } from './snap-provider.mjs';

/** @typedef {import('../types/visual-diff-types').VisualProvider} VisualProvider */
/** @typedef {import('../types/visual-diff-types').ProviderCaptureOptions} CaptureOptions */
/** @typedef {import('../types/visual-diff-types').ProviderCaptureResult} CaptureResult */
/** @typedef {import('../types/visual-diff-types').ProviderDiffOptions} DiffOptions */
/** @typedef {import('../types/visual-diff-types').ProviderDiffResult} DiffResult */
/** @typedef {import('../types/visual-diff-types').ProviderPublishBaselineOptions} PublishBaselineOptions */
/** @typedef {import('../types/visual-diff-types').VisualRegressionConfig} VisualRegressionConfig */

/** Reason recorded on the skipped summary written under `warn-and-skip`. */
export const SNAP_UNAVAILABLE_REASON = 'snap_unavailable';

/** Reason recorded when `fallback-local` has no baseline to compare against. */
export const MISSING_BASELINE_REASON = 'missing_main_baseline_artifact';

/** @returns {void} */
function noop() {}

/**
 * Whether the current capture leaves real PNGs on the runner's filesystem.
 *
 * `LocalProvider.diff` reads screenshots off disk, so this is the precondition
 * for handing it a capture. A remote Snap capture writes only run metadata and
 * a zero-dimension manifest, which would otherwise diff as a dimension change
 * for every route.
 *
 * @param {string} providerName - Effective provider that produced the capture
 * @param {VisualRegressionConfig} [config]
 * @returns {boolean}
 */
export function hasLocalScreenshots(providerName, config) {
  if (providerName !== 'snap') {
    return true;
  }
  return isLocalBaseUrl(config?.baseUrl);
}

/**
 * Capture under the configured outage policy.
 *
 * @param {{
 *   provider: VisualProvider,
 *   providerName?: string,
 *   captureOptions: CaptureOptions,
 *   config?: VisualRegressionConfig,
 *   createLocalProvider?: () => VisualProvider,
 *   onSkip?: (error: SnapSkipError) => void,
 *   onFallback?: (error: SnapFallbackError) => void
 * }} options
 * @returns {Promise<{
 *   outcome: 'captured' | 'skipped',
 *   providerName: string,
 *   result?: CaptureResult,
 *   localScreenshots: boolean
 * }>}
 */
export async function captureWithPolicy(options) {
  const providerName = options.providerName || 'local';
  const createLocalProvider = options.createLocalProvider || (() => createProvider('local'));
  const onSkip = options.onSkip || noop;
  const onFallback = options.onFallback || noop;

  try {
    const result = await options.provider.capture(options.captureOptions);
    return {
      outcome: 'captured',
      providerName,
      result,
      localScreenshots: hasLocalScreenshots(providerName, options.config)
    };
  } catch (error) {
    if (error instanceof SnapSkipError) {
      onSkip(error);
      return { outcome: 'skipped', providerName, localScreenshots: false };
    }
    if (error instanceof SnapFallbackError) {
      onFallback(error);
      const result = await createLocalProvider().capture(options.captureOptions);
      // The rest of the pipeline must be told the *effective* provider, not the
      // configured one — otherwise it rebuilds SnapProvider around local output.
      return { outcome: 'captured', providerName: 'local', result, localScreenshots: true };
    }
    throw error;
  }
}

/**
 * Diff under the configured outage policy.
 *
 * `fallback-local` is only a real fallback when the local engine has something
 * to compare. Two preconditions have to hold, and neither is guaranteed at the
 * point Snap goes down mid-run:
 *
 * 1. A baseline must exist on disk. Without one the local diff throws on a
 *    missing results file, so we report `baseline-unavailable` and let the
 *    caller write the documented missing-baseline summary instead.
 * 2. The current capture must have local screenshots. A remote Snap capture
 *    does not, so we recapture locally first rather than diffing a manifest of
 *    zero-dimension placeholders.
 *
 * @param {{
 *   provider: VisualProvider,
 *   providerName?: string,
 *   diffOptions: DiffOptions,
 *   captureOptions?: CaptureOptions,
 *   localScreenshots?: boolean,
 *   baselineAvailable?: boolean,
 *   createLocalProvider?: () => VisualProvider,
 *   onSkip?: (error: SnapSkipError) => void,
 *   onFallback?: (error: SnapFallbackError) => void,
 *   onRecapture?: () => void,
 *   onBaselineUnavailable?: () => void
 * }} options
 * @returns {Promise<{
 *   outcome: 'diffed' | 'skipped' | 'baseline-unavailable',
 *   providerName: string,
 *   result?: DiffResult,
 *   recapture?: CaptureResult
 * }>}
 */
export async function diffWithPolicy(options) {
  const providerName = options.providerName || 'local';
  const createLocalProvider = options.createLocalProvider || (() => createProvider('local'));
  const onSkip = options.onSkip || noop;
  const onFallback = options.onFallback || noop;
  const onRecapture = options.onRecapture || noop;
  const onBaselineUnavailable = options.onBaselineUnavailable || noop;

  try {
    const result = await options.provider.diff(options.diffOptions);
    return { outcome: 'diffed', providerName, result };
  } catch (error) {
    if (error instanceof SnapSkipError) {
      onSkip(error);
      return { outcome: 'skipped', providerName };
    }
    if (!(error instanceof SnapFallbackError)) {
      throw error;
    }

    onFallback(error);

    const baselineAvailable = options.baselineAvailable !== undefined
      ? options.baselineAvailable
      : Boolean(options.diffOptions.baselineResultsPath);
    if (!baselineAvailable) {
      onBaselineUnavailable();
      return { outcome: 'baseline-unavailable', providerName: 'local' };
    }

    const localProvider = createLocalProvider();
    let diffOptions = options.diffOptions;
    /** @type {CaptureResult | undefined} */
    let recapture;

    if (options.localScreenshots === false) {
      if (!options.captureOptions) {
        throw new Error(
          'Cannot fall back to a local diff: the current capture has no screenshots on disk ' +
          'and no captureOptions were supplied to recapture with.',
          { cause: error }
        );
      }
      onRecapture();
      recapture = await localProvider.capture(options.captureOptions);
      diffOptions = {
        ...options.diffOptions,
        currentResultsPath: recapture.resultsPath,
        currentManifestPath: recapture.manifestPath,
        currentRunDir: recapture.screenshotsRoot
      };
    }

    const result = await localProvider.diff(diffOptions);
    return { outcome: 'diffed', providerName: 'local', result, recapture };
  }
}

/**
 * Publish a baseline under the configured outage policy.
 *
 * Snap can go down *after* the capture submission succeeds — while polling the
 * render or posting the baseline — and the user's `onUnavailable` choice has to
 * hold for that window too. `fallback-local` recaptures locally so the caller
 * still ends up with a baseline bundle it can stage and upload.
 *
 * @param {{
 *   provider: VisualProvider,
 *   publishOptions: PublishBaselineOptions,
 *   captureOptions?: CaptureOptions,
 *   createLocalProvider?: () => VisualProvider,
 *   onSkip?: (error: SnapSkipError) => void,
 *   onFallback?: (error: SnapFallbackError) => void
 * }} options
 * @returns {Promise<{ outcome: 'published' | 'skipped' | 'fell-back', recapture?: CaptureResult }>}
 */
export async function publishBaselineWithPolicy(options) {
  const createLocalProvider = options.createLocalProvider || (() => createProvider('local'));
  const onSkip = options.onSkip || noop;
  const onFallback = options.onFallback || noop;

  try {
    await options.provider.publishBaseline(options.publishOptions);
    return { outcome: 'published' };
  } catch (error) {
    if (error instanceof SnapSkipError) {
      onSkip(error);
      return { outcome: 'skipped' };
    }
    if (error instanceof SnapFallbackError) {
      onFallback(error);
      if (!options.captureOptions) {
        return { outcome: 'fell-back' };
      }
      const recapture = await createLocalProvider().capture(options.captureOptions);
      return { outcome: 'fell-back', recapture };
    }
    throw error;
  }
}
