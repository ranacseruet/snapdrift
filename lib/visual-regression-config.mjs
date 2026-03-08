// @ts-check

import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_CONFIG_PATH = path.resolve('.github', 'visual-regression.json');

export const VIEWPORT_PRESETS = {
  desktop: {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false
  },
  mobile: {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true
  }
};

export const VISUAL_NAVIGATION_TIMEOUT_MS = 30000;
export const VISUAL_SETTLE_DELAY_MS = 300;

/**
 * @typedef {import('../types/visual-diff-types').VisualRegressionConfig} VisualRegressionConfig
 * @typedef {import('../types/visual-diff-types').VisualRegressionRouteConfig} VisualRegressionRouteConfig
 */

/**
 * @param {string | undefined} value
 * @returns {string[]}
 */
export function splitCommaList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * @param {unknown} value
 * @returns {value is VisualRegressionConfig}
 */
function isVisualRegressionConfig(value) {
  const candidate = /** @type {Partial<VisualRegressionConfig> | null} */ (value);
  return Boolean(
    candidate &&
      typeof candidate === 'object' &&
      typeof candidate.baselineArtifactName === 'string' &&
      typeof candidate.workingDirectory === 'string' &&
      typeof candidate.baseUrl === 'string' &&
      typeof candidate.readyUrl === 'string' &&
      typeof candidate.readyTimeoutSeconds === 'number' &&
      typeof candidate.resultsFile === 'string' &&
      typeof candidate.manifestFile === 'string' &&
      typeof candidate.screenshotsRoot === 'string' &&
      Array.isArray(candidate.routes) &&
      typeof candidate.diff?.threshold === 'number' &&
      typeof candidate.diff?.mode === 'string'
  );
}

/**
 * @param {string | undefined} [configPath]
 * @returns {Promise<{ config: VisualRegressionConfig, configPath: string }>}
 */
export async function loadVisualRegressionConfig(configPath = process.env.QA_VISUAL_CONFIG_PATH) {
  const resolvedConfigPath = path.resolve(configPath || DEFAULT_CONFIG_PATH);
  const raw = await fs.readFile(resolvedConfigPath, 'utf8');
  const parsed = JSON.parse(raw);

  if (!isVisualRegressionConfig(parsed)) {
    throw new Error(`Invalid visual regression config at ${resolvedConfigPath}.`);
  }

  return {
    config: parsed,
    configPath: resolvedConfigPath
  };
}

/**
 * @param {VisualRegressionConfig} config
 * @param {string} relativePath
 * @returns {string}
 */
export function resolveFromWorkingDirectory(config, relativePath) {
  return path.resolve(config.workingDirectory || '.', relativePath);
}

/**
 * @param {VisualRegressionConfig} config
 * @param {Iterable<string>} requestedRouteIds
 * @returns {{ routes: VisualRegressionRouteConfig[], selectedRouteIds: string[] }}
 */
export function selectConfiguredRoutes(config, requestedRouteIds) {
  const requestedIds = new Set([...requestedRouteIds].filter(Boolean));
  if (requestedIds.size === 0) {
    return {
      routes: [...config.routes],
      selectedRouteIds: config.routes.map((route) => route.id)
    };
  }

  const routes = config.routes.filter((route) => requestedIds.has(route.id));
  const missingRouteIds = [...requestedIds].filter((routeId) => !routes.some((route) => route.id === routeId));
  if (missingRouteIds.length > 0) {
    throw new Error(`Unknown visual regression route ids: ${missingRouteIds.join(', ')}`);
  }

  return {
    routes,
    selectedRouteIds: routes.map((route) => route.id)
  };
}

/**
 * @param {VisualRegressionConfig} config
 * @param {string[]} changedFiles
 * @returns {{ shouldRun: boolean, reason: string, selectedRouteIds: string[] }}
 */
export function selectRoutesForChangedFiles(config, changedFiles) {
  const sharedPrefixes = config.selection?.sharedPrefixes || [];
  const sharedExact = new Set(config.selection?.sharedExact || []);

  if (changedFiles.some((file) => sharedExact.has(file) || sharedPrefixes.some((prefix) => file.startsWith(prefix)))) {
    return {
      shouldRun: true,
      reason: 'shared_visual_change',
      selectedRouteIds: config.routes.map((route) => route.id)
    };
  }

  const selectedRouteIds = config.routes
    .filter((route) => (route.changePaths || []).some((prefix) => changedFiles.some((file) => file.startsWith(prefix))))
    .map((route) => route.id);

  if (selectedRouteIds.length > 0) {
    return {
      shouldRun: true,
      reason: 'scoped_visual_change',
      selectedRouteIds
    };
  }

  return {
    shouldRun: false,
    reason: changedFiles.length > 0 ? 'no_visual_relevant_changes' : 'no_changed_files',
    selectedRouteIds: []
  };
}
