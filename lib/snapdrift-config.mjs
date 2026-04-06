// @ts-check

import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_CONFIG_PATH = path.resolve('.github', 'snapdrift.json');
export const VALID_DIFF_MODES = ['report-only', 'fail-on-changes', 'fail-on-incomplete', 'strict'];

export const SNAPDRIFT_VIEWPORT_PRESETS = {
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

export const SNAPDRIFT_NAVIGATION_TIMEOUT_MS = 30000;
export const SNAPDRIFT_SETTLE_DELAY_MS = 300;

/**
 * @param {string[]} names
 * @returns {string | undefined}
 */
export function readFirstDefinedEnv(names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * @typedef {import('../types/visual-diff-types').VisualRegressionConfig} SnapdriftConfig
 * @typedef {import('../types/visual-diff-types').VisualRegressionRouteConfig} SnapdriftRouteConfig
 */

const VALID_VIEWPORT_PRESETS = new Set(Object.keys(SNAPDRIFT_VIEWPORT_PRESETS));

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidCustomViewport(value) {
  if (!isRecord(value)) return false;
  const rec = /** @type {Record<string,unknown>} */ (value);
  return Number.isInteger(rec.width) && /** @type {number} */ (rec.width) > 0 &&
    Number.isInteger(rec.height) && /** @type {number} */ (rec.height) > 0;
}
const VALID_DIFF_MODE_SET = new Set(VALID_DIFF_MODES);

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * @param {unknown} value
 * @returns {value is string[]}
 */
function isNonEmptyStringArray(value) {
  return Array.isArray(value) && value.every((item) => isNonEmptyString(item));
}

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
 * @param {string} sourceLabel
 * @returns {SnapdriftConfig}
 */
export function validateSnapdriftConfig(value, sourceLabel = 'inline config') {
  /** @type {string[]} */
  const errors = [];

  if (!isRecord(value)) {
    throw new Error(`Invalid SnapDrift config at ${sourceLabel}: expected a JSON object.`);
  }

  const candidate = /** @type {Record<string, unknown>} */ (value);
  const requiredStringFields = [
    'baselineArtifactName',
    'workingDirectory',
    'baseUrl',
    'resultsFile',
    'manifestFile',
    'screenshotsRoot'
  ];

  for (const fieldName of requiredStringFields) {
    if (!isNonEmptyString(candidate[fieldName])) {
      errors.push(`${fieldName} must be a non-empty string.`);
    }
  }

  if (!Array.isArray(candidate.routes) || candidate.routes.length === 0) {
    errors.push('routes must contain at least one route definition.');
  } else {
    const routeIds = new Set();

    for (const [index, route] of candidate.routes.entries()) {
      const routeLabel = `routes[${index}]`;
      if (!isRecord(route)) {
        errors.push(`${routeLabel} must be an object.`);
        continue;
      }

      if (!isNonEmptyString(route.id)) {
        errors.push(`${routeLabel}.id must be a non-empty string.`);
      } else if (routeIds.has(route.id)) {
        errors.push(`${routeLabel}.id duplicates the route id "${route.id}".`);
      } else {
        routeIds.add(route.id);
      }

      if (!isNonEmptyString(route.path)) {
        errors.push(`${routeLabel}.path must be a non-empty string.`);
      }

      const viewportValid = (isNonEmptyString(route.viewport) && VALID_VIEWPORT_PRESETS.has(route.viewport)) ||
        isValidCustomViewport(route.viewport);
      if (!viewportValid) {
        errors.push(`${routeLabel}.viewport must be one of: ${[...VALID_VIEWPORT_PRESETS].join(', ')} or an object with positive integer width and height.`);
      }

      if (route.changePaths !== undefined && !isNonEmptyStringArray(route.changePaths)) {
        errors.push(`${routeLabel}.changePaths must be an array of non-empty strings when provided.`);
      }
    }
  }

  if (!isRecord(candidate.diff)) {
    errors.push('diff must be an object.');
  } else {
    if (typeof candidate.diff.threshold !== 'number' || !Number.isFinite(candidate.diff.threshold)) {
      errors.push('diff.threshold must be a finite number.');
    } else if (candidate.diff.threshold < 0 || candidate.diff.threshold > 1) {
      errors.push('diff.threshold must be between 0 and 1.');
    }

    if (!isNonEmptyString(candidate.diff.mode) || !VALID_DIFF_MODE_SET.has(candidate.diff.mode)) {
      errors.push(`diff.mode must be one of: ${VALID_DIFF_MODES.join(', ')}.`);
    }
  }

  if (candidate.selection !== undefined) {
    if (!isRecord(candidate.selection)) {
      errors.push('selection must be an object when provided.');
    } else {
      if (candidate.selection.sharedPrefixes !== undefined && !isNonEmptyStringArray(candidate.selection.sharedPrefixes)) {
        errors.push('selection.sharedPrefixes must be an array of non-empty strings when provided.');
      }
      if (candidate.selection.sharedExact !== undefined && !isNonEmptyStringArray(candidate.selection.sharedExact)) {
        errors.push('selection.sharedExact must be an array of non-empty strings when provided.');
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid SnapDrift config at ${sourceLabel}:\n- ${errors.join('\n- ')}`);
  }

  return /** @type {SnapdriftConfig} */ (/** @type {unknown} */ (value));
}

/**
 * @param {string | undefined} [configPath]
 * @returns {Promise<{ config: SnapdriftConfig, configPath: string }>}
 */
export async function loadSnapdriftConfig(configPath = readFirstDefinedEnv(['SNAPDRIFT_CONFIG_PATH'])) {
  const resolvedConfigPath = configPath ? path.resolve(configPath) : DEFAULT_CONFIG_PATH;
  const raw = await fs.readFile(resolvedConfigPath, 'utf8');
  const parsed = JSON.parse(raw);

  return {
    config: validateSnapdriftConfig(parsed, resolvedConfigPath),
    configPath: resolvedConfigPath
  };
}

/**
 * @param {SnapdriftConfig} config
 * @param {string} relativePath
 * @returns {string}
 */
export function resolveFromWorkingDirectory(config, relativePath) {
  return path.resolve(config.workingDirectory || '.', relativePath);
}

/**
 * @param {SnapdriftConfig} config
 * @param {Iterable<string>} requestedRouteIds
 * @returns {{ routes: SnapdriftRouteConfig[], selectedRouteIds: string[] }}
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
    throw new Error(`Unknown SnapDrift route ids: ${missingRouteIds.join(', ')}`);
  }

  return {
    routes,
    selectedRouteIds: routes.map((route) => route.id)
  };
}

/**
 * @param {SnapdriftConfig} config
 * @param {string[]} changedFiles
 * @returns {{ shouldRun: boolean, reason: string, selectedRouteIds: string[] }}
 */
export function selectRoutesForChangedFiles(config, changedFiles) {
  const sharedPrefixes = config.selection?.sharedPrefixes || [];
  const sharedExact = new Set(config.selection?.sharedExact || []);

  if (changedFiles.some((file) => sharedExact.has(file) || sharedPrefixes.some((prefix) => file.startsWith(prefix)))) {
    return {
      shouldRun: true,
      reason: 'shared_snapdrift_change',
      selectedRouteIds: config.routes.map((route) => route.id)
    };
  }

  const selectedRouteIds = config.routes
    .filter((route) => (route.changePaths || []).some((prefix) => changedFiles.some((file) => file.startsWith(prefix))))
    .map((route) => route.id);

  if (selectedRouteIds.length > 0) {
    return {
      shouldRun: true,
      reason: 'scoped_snapdrift_change',
      selectedRouteIds
    };
  }

  return {
    shouldRun: false,
    reason: changedFiles.length > 0 ? 'no_snapdrift_relevant_changes' : 'no_changed_files',
    selectedRouteIds: []
  };
}
