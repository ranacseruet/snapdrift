// @ts-check

import { diffArrays } from 'diff';

/**
 * The alignment algorithm is deliberately bounded. A very large edit
 * distance is more likely to be a wholesale page replacement than a useful
 * insertion/deletion, and spending quadratic work on it would put the diff
 * worker at risk.
 */
export const MAX_ALIGNMENT_ROWS = 100_000;
// Keep the synchronous Myers search below a bounded sub-second budget for
// dissimilar tall captures. Larger edit groups conservatively use v1.
export const MAX_ALIGNMENT_EDIT_LENGTH = 2_048;
// A row repeated this often on either side (page background, card padding,
// borders) carries no movement evidence: where it lands inside a run of
// identical rows makes no visible difference. Rarer rows still trigger the
// ambiguity fallback.
export const MIN_STRUCTURAL_ROW_REPEATS = 16;
export const COMPARISON_ROW_KINDS = /** @type {const} */ (['matched', 'changed', 'inserted', 'deleted']);
export const COMPARISON_FALLBACK_REASONS = /** @type {const} */ (['width-mismatch', 'alignment-limit', 'ambiguous', 'verification-failed', 'ignore-regions']);

/**
 * @typedef {'matched' | 'changed' | 'inserted' | 'deleted'} AlignmentRowKind
 * @typedef {{
 *   outputStart: number,
 *   length: number,
 *   kind: AlignmentRowKind,
 *   baselineStart?: number,
 *   currentStart?: number,
 *   comparedOffset?: -1 | 0 | 1
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

// Row fingerprints are two independent 32-bit FNV-style accumulators packed
// into one JS number instead of a Node crypto digest. SHA-1 hex strings over
// every row are an avoidable cost in a metrics-only full-page comparison; this
// word loop is cheaper (measured ~20% faster fingerprinting at 1440x8000).
// A single 32-bit value over ~16k rows has a few-percent birthday collision
// chance (~1.6% at 16,384 rows over 2^32), which would make the Myers diff pair
// distinct rows and then force a whole-comparison `verification-failed`
// fallback. Packing the halves into a 53-bit safe integer (`high * 2^32 + low`)
// shrinks that to roughly 7.5e-9.
//
// A 64-bit integer is not exactly representable: `high * 2^32` alone is exact,
// but adding a 32-bit `low` would round once `high` exceeds 21 bits. So only
// the low 21 bits of the first accumulator become the high half; the second
// accumulator contributes all 32 bits. The resulting value is <= 2^53 - 1 and
// exactly representable. `rowsEqual` still byte-verifies every Myers match, so
// even a rare collision cannot turn two different rows into a matched segment.
const HIGH_MASK = 0x1fffff; // 21 bits: the safe-integer headroom over 2^32
const HIGH_SCALE = 4294967296; // 2^32
const FIRST_BASIS = 0x811c9dc5; // FNV-1a 32-bit offset basis
const FIRST_PRIME = 0x01000193; // FNV-1a 32-bit prime
const SECOND_BASIS = 0x84222325; // FNV-1 offset basis, low 32 bits
const SECOND_PRIME = 0x9e3779b1; // independent odd multiplier
// A Uint32Array word view reads host-endian words. Only little-endian hosts can
// compare those words to the byte fallback's little-endian assembly below; a
// big-endian host always takes the byte path so the two images stay comparable.
const LITTLE_ENDIAN = new Uint32Array(new Uint8Array([1, 0, 0, 0]).buffer)[0] === 1;

/**
 * Build one word view over the whole decoded image when its RGBA bytes start
 * on a 4-byte boundary. A view lets the fingerprint loop read one 32-bit word
 * per pixel instead of four byte loads, and building it once per image avoids
 * a view allocation per row. When the backing buffer's byte offset is
 * misaligned or its declared rows exceed the buffer, every row falls back to
 * byte hashing.
 *
 * @param {{ data: Uint8Array, width: number, height: number }} png
 * @returns {Uint32Array | undefined}
 */
function imageWordView(png) {
  if (!LITTLE_ENDIAN) return undefined;
  if (png.data.byteOffset % 4 !== 0) return undefined;
  if (png.width * png.height * 4 > png.data.byteLength) return undefined;
  return new Uint32Array(png.data.buffer, png.data.byteOffset, png.width * png.height);
}

/**
 * Hash one decoded row into a combined 53-bit fingerprint (a JS safe integer).
 * Hashes make the Myers sequence diff cheap while `rowsEqual` byte-verifies
 * every match, so a collision cannot become a matched segment.
 *
 * @param {{ data: Uint8Array, width: number }} png
 * @param {number} y
 * @param {Uint32Array} [words] whole-image word view, absent for byte hashing
 * @returns {number}
 */
function rowFingerprint(png, y, words) {
  const stride = png.width * 4;
  const start = y * stride;
  let first = FIRST_BASIS;
  let second = SECOND_BASIS;
  if (words) {
    const wordStart = y * png.width;
    for (let x = 0; x < png.width; x++) {
      const word = words[wordStart + x];
      // Math.imul wraps mod 2^32 regardless of the signed return; the unsigned
      // conversion is only needed on the second accumulator's final value.
      first = Math.imul(first ^ word, FIRST_PRIME);
      second = Math.imul(second ^ word, SECOND_PRIME);
    }
  } else {
    // Assemble each pixel as the same little-endian word the view would expose,
    // so a row hashed through this fallback equals the same row hashed via a view.
    for (let x = 0; x < png.width; x++) {
      const byteIndex = start + x * 4;
      const word =
        png.data[byteIndex] |
        (png.data[byteIndex + 1] << 8) |
        (png.data[byteIndex + 2] << 16) |
        (png.data[byteIndex + 3] << 24);
      first = Math.imul(first ^ word, FIRST_PRIME);
      second = Math.imul(second ^ word, SECOND_PRIME);
    }
  }
  return (first & HIGH_MASK) * HIGH_SCALE + (second >>> 0);
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
 * @param {number[]} fingerprints
 * @returns {Map<number, number>}
 */
function countFingerprints(fingerprints) {
  /** @type {Map<number, number>} */
  const counts = new Map();
  for (const fingerprint of fingerprints) {
    counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1);
  }
  return counts;
}

/**
 * An unmatched row is ambiguous when it also occurs on the opposite side, unless
 * it repeats often enough, on either side, to be a structural row.
 *
 * @param {Map<number, number>} ownCounts rows of the image the unmatched row came from
 * @param {Map<number, number>} oppositeCounts rows of the other image
 * @param {number} fingerprint
 * @returns {boolean}
 */
function isAmbiguousRow(ownCounts, oppositeCounts, fingerprint) {
  const oppositeRepeats = oppositeCounts.get(fingerprint) ?? 0;
  const ownRepeats = ownCounts.get(fingerprint) ?? 0;
  return oppositeRepeats > 0 && Math.max(oppositeRepeats, ownRepeats) < MIN_STRUCTURAL_ROW_REPEATS;
}

/**
 * Add a segment and coalesce adjacent segments with the same meaning,
 * including the same `comparedOffset`.
 *
 * @param {AlignmentSegment[]} segments
 * @param {AlignmentSegment} segment
 * @returns {void}
 */
export function appendSegment(segments, segment) {
  const previous = segments.at(-1);
  const baselineContiguous =
    previous?.baselineStart === undefined ||
    segment.baselineStart === undefined ||
    previous.baselineStart + previous.length === segment.baselineStart;
  const currentContiguous =
    previous?.currentStart === undefined ||
    segment.currentStart === undefined ||
    previous.currentStart + previous.length === segment.currentStart;

  const sameComparedRow = (previous?.comparedOffset ?? 0) === (segment.comparedOffset ?? 0);
  if (
    previous &&
    previous.kind === segment.kind &&
    baselineContiguous &&
    currentContiguous &&
    sameComparedRow &&
    previous.outputStart + previous.length === segment.outputStart
  ) {
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

  const baselineWords = imageWordView(baseline);
  const currentWords = imageWordView(current);
  const baselineFingerprints = Array.from({ length: baseline.height }, (_, y) => rowFingerprint(baseline, y, baselineWords));
  const currentFingerprints = Array.from({ length: current.height }, (_, y) => rowFingerprint(current, y, currentWords));

  // diffArrays returns undefined once the edit budget is exhausted.
  const changes = diffArrays(baselineFingerprints, currentFingerprints, {
    maxEditLength: Math.min(MAX_ALIGNMENT_EDIT_LENGTH, rowCount)
  });
  if (!changes) {
    return { kind: 'fallback', reason: 'alignment-limit' };
  }

  const baselineFingerprintCounts = countFingerprints(baselineFingerprints);
  const currentFingerprintCounts = countFingerprints(currentFingerprints);
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
    /** @type {number[]} */
    const unmatchedRemoved = [];
    /** @type {number[]} */
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

    const pairedCount = Math.min(removedCount, addedCount);
    const unmatchedRemovedTail = unmatchedRemoved.slice(pairedCount);
    const unmatchedAddedTail = unmatchedAdded.slice(pairedCount);

    // If a truly unmatched row is also present elsewhere in the opposite image,
    // there is no reliable way to tell movement from insertion. Fall back to
    // coordinate comparison instead of painting an arbitrary occurrence green.
    // Rows repeated MIN_STRUCTURAL_ROW_REPEATS times or more on either side
    // are structural padding and are exempt (see isAmbiguousRow).
    if (
      unmatchedAddedTail.some((fingerprint) => isAmbiguousRow(currentFingerprintCounts, baselineFingerprintCounts, fingerprint)) ||
      unmatchedRemovedTail.some((fingerprint) => isAmbiguousRow(baselineFingerprintCounts, currentFingerprintCounts, fingerprint))
    ) {
      return { kind: 'fallback', reason: 'ambiguous' };
    }

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
