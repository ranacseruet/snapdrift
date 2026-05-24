// @ts-check

/** @typedef {import('../types/index.d.ts').VisualScreenshotManifest} ScreenshotManifest */
/** @typedef {import('../types/index.d.ts').VisualScreenshotManifestEntry} ScreenshotManifestEntry */
/** @typedef {import('../types/index.d.ts').VisualBaselineResults} BaselineResults */

const CURRENT_SCHEMA_VERSION = 1;

/**
 * Validate a screenshot manifest object.
 * Accepts manifests without `schemaVersion` (defaults to 1).
 *
 * @param {unknown} value
 * @returns {ScreenshotManifest}
 */
export function validateManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Manifest must be a non-null object.');
  }

  const candidate = /** @type {Record<string, unknown>} */ (value);

  if (candidate.schemaVersion !== undefined && typeof candidate.schemaVersion !== 'number') {
    throw new Error('manifest.schemaVersion must be a number when present.');
  }

  if (typeof candidate.generatedAt !== 'string' || !candidate.generatedAt) {
    throw new Error('manifest.generatedAt must be a non-empty ISO date string.');
  }

  if (typeof candidate.baseUrl !== 'string') {
    throw new Error('manifest.baseUrl must be a string.');
  }

  if (!Array.isArray(candidate.screenshots)) {
    throw new Error('manifest.screenshots must be an array.');
  }

  const ids = new Set();
  for (const [index, entry] of candidate.screenshots.entries()) {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`manifest.screenshots[${index}] must be an object.`);
    }
    const e = /** @type {Record<string, unknown>} */ (entry);
    if (typeof e.id !== 'string' || !e.id) {
      throw new Error(`manifest.screenshots[${index}].id must be a non-empty string.`);
    }
    if (ids.has(e.id)) {
      throw new Error(`Duplicate screenshot id "${e.id}" in manifest.`);
    }
    ids.add(e.id);
    if (typeof e.path !== 'string') {
      throw new Error(`manifest.screenshots[${index}].path must be a string.`);
    }
    if (typeof e.width !== 'number' || !Number.isFinite(e.width) || e.width <= 0) {
      throw new Error(`manifest.screenshots[${index}].width must be a positive number.`);
    }
    if (typeof e.height !== 'number' || !Number.isFinite(e.height) || e.height <= 0) {
      throw new Error(`manifest.screenshots[${index}].height must be a positive number.`);
    }
  }

  return /** @type {ScreenshotManifest} */ (value);
}

/**
 * Index manifest entries by id, filtered to selected route ids.
 *
 * @param {ScreenshotManifest} manifest
 * @param {string[]} selectedRouteIds
 * @returns {Map<string, ScreenshotManifestEntry>}
 */
export function indexManifestEntries(manifest, selectedRouteIds) {
  const selected = new Set(selectedRouteIds);
  const entries = new Map();
  for (const screenshot of manifest.screenshots || []) {
    if (!selected.has(screenshot.id)) {
      continue;
    }
    if (entries.has(screenshot.id)) {
      throw new Error(`Duplicate screenshot id ${screenshot.id} detected in the SnapDrift screenshot manifest.`);
    }
    entries.set(screenshot.id, screenshot);
  }
  return entries;
}

/**
 * Index route results by id.
 *
 * @param {BaselineResults} results
 * @returns {Map<string, BaselineResults['routes'][number]>}
 */
export function indexRouteResults(results) {
  return new Map((results.routes || []).map((route) => [route.id, route]));
}

export { CURRENT_SCHEMA_VERSION };