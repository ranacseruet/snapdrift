// @ts-check

export { validateManifest, indexManifestEntries, indexRouteResults, CURRENT_SCHEMA_VERSION } from './schema.mjs';
export { viewportKey, viewportHash, VIEWPORT_PRESETS } from './viewport.mjs';
export { determineDriftStatus, shouldFailDriftCheck } from './drift-status.mjs';
export {
  validateSnapdriftConfig,
  selectConfiguredRoutes,
  selectRoutesForChangedFiles,
  resolveFromWorkingDirectory,
  splitCommaList,
  VALID_DIFF_MODES,
  SNAPDRIFT_NAVIGATION_TIMEOUT_MS,
  SNAPDRIFT_SETTLE_DELAY_MS
} from './config.mjs';