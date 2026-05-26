// @ts-check
// Re-exports from packages — this module is a thin shim.

export {
  determineDriftStatus,
  shouldFailDriftCheck,
  indexManifestEntries,
  indexRouteResults
} from '@snapdrift/manifest';

export {
  comparePngs,
  resolveImagePath,
  generateDriftReport,
  runDriftCheckCli
} from '@snapdrift/adapter-fs';

export {
  makeMarkdown,
  formatDriftFailureMessage,
  formatViewport
} from '@snapdrift/adapter-report-md';