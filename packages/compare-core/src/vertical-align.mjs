// @ts-check

import { createHash } from 'node:crypto';
import { diffArrays } from 'diff';

/**
 * The alignment algorithm is deliberately bounded. A very large edit
 * distance is more likely to be a wholesale page replacement than a useful
 * insertion/deletion, and spending quadratic work on it would put the diff
 * worker at risk.
 */
export const MAX_ALIGNMENT_ROWS = 100_000;
export const MAX_ALIGNMENT_EDIT_LENGTH = 16_384;

/**
 * @typedef {'matched' | 'changed' | 'inserted' | 'deleted'} AlignmentRowKind
 * @typedef {{
 *   outputStart: number,
 *   length: number,
 *   kind: AlignmentRowKind,
 *   baselineStart?: number,
 *   currentStart?: number
 * }} AlignmentSegment
 */

/**
 * @typedef {{
 *   kind: 'aligned',
 *   segments: AlignmentSegment[],
 *   height: number
 * } | {
 *   kind: 'fallback',
 *   reason: 'width-mismatch' | 'alignment-limit' | 'ambiguous' | 'verification-failed'
 * }} RowAlignment
 */

/**
 * Hash one decoded row. Hashes make the sequence diff cheap while the exact
 * byte comparison below prevents a hash collision from becoming a match.
 *
 * @param {{ data: Uint8Array, width: number }} png
 * @param {number} y
 * @returns {string}
 */
function rowFingerprint(png, y) {
  const stride = png.width * 4;
  const start = y * stride;
  return createHash('sha1').update(png.data.subarray(start, start + stride)).digest('hex');
}

/**
 * @param {{ data: Uint8Array, width: number }} baseline
 * @param {{ data: Uint8Array, width: number }} current
 * @param {number} baselineY
 * @param {number} currentY
 * @returns {boolean}
 */
function rowsEqual(baseline, current, baselineY, currentY) {
  const stride = baseline.width * 4;
  const baselineStart = baselineY * stride;
  const currentStart = currentY * stride;
  for (let offset = 0; offset < stride; offset++) {
    if (baseline.data[baselineStart + offset] !== current.data[currentStart + offset]) {
      return false;
    }
  }
  return true;
}

/**
 * Add a segment and coalesce adjacent segments with the same meaning.
 *
 * @param {AlignmentSegment[]} segments
 * @param {AlignmentSegment} segment
 * @returns {void}
 */
function appendSegment(segments, segment) {
  const previous = segments.at(-1);
  const baselineContiguous =
    previous?.baselineStart === undefined ||
    segment.baselineStart === undefined ||
    previous.baselineStart + previous.length === segment.baselineStart;
  const currentContiguous =
    previous?.currentStart === undefined ||
    segment.currentStart === undefined ||
    previous.currentStart + previous.length === segment.currentStart;

  if (previous && previous.kind === segment.kind && baselineContiguous && currentContiguous && previous.outputStart + previous.length === segment.outputStart) {
    previous.length += segment.length;
    return;
  }
  segments.push(segment);
}

/**
 * Align rows using a Myers sequence diff over row fingerprints.
 *
 * @param {{ data: Uint8Array, width: number, height: number }} baseline
 * @param {{ data: Uint8Array, width: number, height: number }} current
 * @returns {RowAlignment}
 */
export function alignRows(baseline, current) {
  if (baseline.width !== current.width) {
    return { kind: 'fallback', reason: 'width-mismatch' };
  }

  const rowCount = baseline.height + current.height;
  if (rowCount > MAX_ALIGNMENT_ROWS) {
    return { kind: 'fallback', reason: 'alignment-limit' };
  }

  const baselineFingerprints = Array.from({ length: baseline.height }, (_, y) => rowFingerprint(baseline, y));
  const currentFingerprints = Array.from({ length: current.height }, (_, y) => rowFingerprint(current, y));

  let changes;
  try {
    changes = diffArrays(baselineFingerprints, currentFingerprints, {
      maxEditLength: Math.min(MAX_ALIGNMENT_EDIT_LENGTH, rowCount)
    });
  } catch {
    return { kind: 'fallback', reason: 'alignment-limit' };
  }
  if (!changes) {
    return { kind: 'fallback', reason: 'alignment-limit' };
  }

  const baselineFingerprintSet = new Set(baselineFingerprints);
  const currentFingerprintSet = new Set(currentFingerprints);
  /** @type {AlignmentSegment[]} */
  const segments = [];
  let baselineIndex = 0;
  let currentIndex = 0;
  let outputIndex = 0;

  for (let changeIndex = 0; changeIndex < changes.length;) {
    const change = changes[changeIndex];
    if (!change.added && !change.removed) {
      if (!change.value.every((_, offset) => rowsEqual(baseline, current, baselineIndex + offset, currentIndex + offset))) {
        return { kind: 'fallback', reason: 'verification-failed' };
      }
      appendSegment(segments, {
        outputStart: outputIndex,
        length: change.count,
        kind: 'matched',
        baselineStart: baselineIndex,
        currentStart: currentIndex
      });
      baselineIndex += change.count;
      currentIndex += change.count;
      outputIndex += change.count;
      changeIndex += 1;
      continue;
    }

    // A contiguous remove/add group represents edits at one page position.
    // Pair rows in order so a changed row is orange, while an excess row on
    // either side retains its insertion/deletion color.
    const removedStart = baselineIndex;
    const addedStart = currentIndex;
    let removedCount = 0;
    let addedCount = 0;
    /** @type {string[]} */
    const unmatchedRemoved = [];
    /** @type {string[]} */
    const unmatchedAdded = [];

    while (changeIndex < changes.length && (changes[changeIndex].added || changes[changeIndex].removed)) {
      const groupChange = changes[changeIndex];
      if (groupChange.removed) {
        removedCount += groupChange.count;
        unmatchedRemoved.push(...groupChange.value);
        baselineIndex += groupChange.count;
      } else if (groupChange.added) {
        addedCount += groupChange.count;
        unmatchedAdded.push(...groupChange.value);
        currentIndex += groupChange.count;
      }
      changeIndex += 1;
    }

    // If an unmatched row is also present elsewhere in the opposite image,
    // there is no reliable way to tell movement from insertion. Fall back to
    // coordinate comparison instead of painting an arbitrary occurrence green.
    if (
      (unmatchedAdded.length > removedCount && unmatchedAdded.some((fingerprint) => baselineFingerprintSet.has(fingerprint))) ||
      (unmatchedRemoved.length > addedCount && unmatchedRemoved.some((fingerprint) => currentFingerprintSet.has(fingerprint)))
    ) {
      return { kind: 'fallback', reason: 'ambiguous' };
    }

    const pairedCount = Math.min(removedCount, addedCount);
    if (pairedCount > 0) {
      appendSegment(segments, {
        outputStart: outputIndex,
        length: pairedCount,
        kind: 'changed',
        baselineStart: removedStart,
        currentStart: addedStart
      });
      outputIndex += pairedCount;
    }
    if (removedCount > pairedCount) {
      appendSegment(segments, {
        outputStart: outputIndex,
        length: removedCount - pairedCount,
        kind: 'deleted',
        baselineStart: removedStart + pairedCount
      });
      outputIndex += removedCount - pairedCount;
    }
    if (addedCount > pairedCount) {
      appendSegment(segments, {
        outputStart: outputIndex,
        length: addedCount - pairedCount,
        kind: 'inserted',
        currentStart: addedStart + pairedCount
      });
      outputIndex += addedCount - pairedCount;
    }
  }

  if (baselineIndex !== baseline.height || currentIndex !== current.height) {
    return { kind: 'fallback', reason: 'verification-failed' };
  }

  return { kind: 'aligned', segments, height: outputIndex };
}
