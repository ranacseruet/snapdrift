// @ts-check

export const DEFAULT_SNAPDRIFT_REPO_URL = 'https://github.com/ranacseruet/snapdrift';
export const DEFAULT_SNAPDRIFT_ICON_URL = 'https://raw.githubusercontent.com/ranacseruet/snapdrift/main/assets/snapdrift-logo-icon.png';
export const STATUS_ICONS = { clean: '✅', 'changes-detected': '🟡', incomplete: '⚠️', skipped: '⏭️' };
export const STATUS_LABELS = { clean: 'Clean', 'changes-detected': 'Drift detected', incomplete: 'Incomplete', skipped: 'Skipped' };

/**
 * Format a viewport for human-facing reports.
 *
 * A viewport is either a preset name or a `{ width, height }` object, so callers
 * must not stringify it directly — `String({ width, height })` renders the
 * useless `[object Object]` in every report.
 *
 * @param {import('../../manifest/types/index').VisualViewport | undefined} viewport
 * @returns {string}
 */
export function formatViewport(viewport) {
  if (!viewport) return '';
  return typeof viewport === 'string' ? viewport : `${viewport.width}x${viewport.height}`;
}

/**
 * Human-facing legend for the semantic diff-image palette rendered by
 * `@snapdrift/compare-core`: orange = changed pixels, green = pixels present
 * only in the current capture (added), red = pixels present only in the
 * baseline (removed).
 */
export const DIFF_IMAGE_LEGEND = 'Diff image colors: orange = changed · green = added or inserted · red = removed or deleted';

/**
 * Describe how the baseline source commit relates to the commit the baseline
 * was bound to, for the "sha" meta item of the reports. `label` is plain text
 * ("matches target", "2 commits behind target" or "target"); when
 * `matchesTarget` is false the caller appends the short target sha in its own
 * markup. Returns undefined when the baseline was not bound (no target) or
 * has no source commit to relate.
 *
 * @param {{ baselineSourceSha?: string, baselineTargetSha?: string, baselineDistance?: number }} summary
 * @returns {{ label: string, targetSha: string, matchesTarget: boolean } | undefined}
 */
export function describeBaselineBinding(summary) {
  const { baselineSourceSha: source, baselineTargetSha: target, baselineDistance: distance } = summary;
  if (!source || !target) return undefined;
  const targetSha = target.slice(0, 7);
  if (distance === 0 || (distance === undefined && source === target)) {
    return { label: 'matches target', targetSha, matchesTarget: true };
  }
  const label = distance === undefined ? 'target' : `${distance} commit${distance === 1 ? '' : 's'} behind target`;
  return { label, targetSha, matchesTarget: false };
}

/**
 * Format an internal 0–1 ratio for human-facing reports.
 * @param {number} ratio
 * @returns {string}
 */
export function formatPercentage(ratio) {
  if (!Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}
