// @ts-check

export const DEFAULT_SNAPDRIFT_REPO_URL = 'https://github.com/ranacseruet/snapdrift';
export const DEFAULT_SNAPDRIFT_ICON_URL = 'https://raw.githubusercontent.com/ranacseruet/snapdrift/main/assets/snapdrift-logo-icon.png';
export const STATUS_ICONS = { clean: '✅', 'changes-detected': '🟡', incomplete: '⚠️', skipped: '⏭️' };
export const STATUS_LABELS = { clean: 'Clean', 'changes-detected': 'Drift detected', incomplete: 'Incomplete', skipped: 'Skipped' };

/**
 * Format an internal 0–1 ratio for human-facing reports.
 * @param {number} ratio
 * @returns {string}
 */
export function formatPercentage(ratio) {
  if (!Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}
