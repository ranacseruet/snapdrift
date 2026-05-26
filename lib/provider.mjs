// @ts-check

import { runBaselineCapture, generateDriftReport, stageArtifacts } from '@snapdrift/adapter-fs';
import { SnapProvider, SnapApiError, SnapUnavailableError, SnapFallbackError } from './snap-provider.mjs';

/** @typedef {import('../types/visual-diff-types').VisualProvider} VisualProvider */
/** @typedef {import('../types/visual-diff-types').ProviderCaptureOptions} CaptureOptions */
/** @typedef {import('../types/visual-diff-types').ProviderCaptureResult} CaptureResult */
/** @typedef {import('../types/visual-diff-types').ProviderDiffOptions} DiffOptions */
/** @typedef {import('../types/visual-diff-types').ProviderDiffResult} DiffResult */
/** @typedef {import('../types/visual-diff-types').ProviderPublishBaselineOptions} PublishBaselineOptions */
/** @typedef {import('../types/visual-diff-types').ProviderPublishBaselineResult} PublishBaselineResult */
/** @typedef {import('../types/visual-diff-types').ProviderFetchBaselineOptions} FetchBaselineOptions */
/** @typedef {import('../types/visual-diff-types').ProviderBaselineData} BaselineData */
/** @typedef {import('../types/visual-diff-types').SnapConfig} SnapConfig */
/** @typedef {import('../types/visual-diff-types').VisualRegressionConfig} VisualRegressionConfig */

/**
 * Local filesystem provider — wraps the current snapdrift behavior
 * (Playwright capture, pixel diff, GH artifact baselines).
 * @implements {VisualProvider}
 */
export class LocalProvider {
  /**
   * @param {CaptureOptions} options
   * @returns {Promise<CaptureResult>}
   */
  async capture(options) {
    return runBaselineCapture(options);
  }

  /**
   * @param {DiffOptions} options
   * @returns {Promise<DiffResult>}
   */
  async diff(options) {
    return generateDriftReport(options);
  }

  /**
   * @param {PublishBaselineOptions} options
   * @returns {Promise<PublishBaselineResult>}
   */
  async publishBaseline(options) {
    const { configPath: _unused, ...stageOpts } = options;
    return stageArtifacts({ artifactType: 'baseline', ...stageOpts });
  }

  /**
   * @param {FetchBaselineOptions} _options
   * @returns {Promise<never>}
   * @throws {Error} Not yet implemented for LocalProvider.
   *   Use the pr-diff action for baseline resolution, or wait for a future release.
   */
  async fetchLatestBaseline(_options) {
    throw new Error(
      'LocalProvider.fetchLatestBaseline is not yet implemented. ' +
      'Use the pr-diff action for baseline resolution, or wait for a future release.'
    );
  }
}

/** @type {Record<string, (config?: VisualRegressionConfig) => VisualProvider>} */
const PROVIDER_FACTORIES = {
  local: () => new LocalProvider(),
  snap: (config) => {
    if (!config?.snap) {
      throw new Error('Snap provider requires snap configuration.');
    }
    return new SnapProvider(config.snap);
  }
};

/**
 * Create a VisualProvider instance by name.
 *
 * @param {string} providerName - Provider identifier ("local" or "snap")
 * @param {VisualRegressionConfig} [config] - Full config (required for "snap" provider)
 * @returns {VisualProvider}
 * @throws {Error} If the provider name is not recognized
 */
export function createProvider(providerName, config) {
  const factory = PROVIDER_FACTORIES[providerName];
  if (!factory) {
    throw new Error(
      `Unknown SnapDrift provider: "${providerName}". ` +
      `Available providers: ${Object.keys(PROVIDER_FACTORIES).join(', ')}.`
    );
  }
  return factory(config);
}

export { SnapProvider, SnapApiError, SnapUnavailableError, SnapFallbackError };
