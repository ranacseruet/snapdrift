// @ts-check

/**
 * @typedef {{ kind: 'aligned', routeIds: string[] } | { kind: 'fallback', routes: { id: string, reason: string }[] }} AlignmentNote
 */

/**
 * Collect alignment facts once so Markdown, PR comments, and HTML reports use
 * the same route grouping and fallback wording.
 *
 * @param {import('@snapdrift/manifest').VisualDiffChangedItem[]} changed
 * @returns {AlignmentNote[]}
 */
export function getAlignmentNotes(changed) {
  const aligned = changed.filter((item) => item.comparison?.mode === 'vertical-aligned').map((item) => item.id);
  const fallback = changed
    .filter((item) => item.comparison?.mode === 'coordinate-fallback')
    .map((item) => ({ id: item.id, reason: item.comparison?.fallbackReason || 'unspecified reason' }));
  const notes = [];
  if (aligned.length > 0) notes.push({ kind: 'aligned', routeIds: aligned });
  if (fallback.length > 0) notes.push({ kind: 'fallback', routes: fallback });
  return notes;
}
