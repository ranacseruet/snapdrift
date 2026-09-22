// @ts-check
/**
 * Runs the full-page offset comparison outside Jest's VM.
 * The tight offset search is about a second in normal Node and much slower
 * when Jest evaluates it, so the fixture test spawns this script.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';
import { compareImages } from '../src/index.mjs';

const { PNG } = pngjs;
const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/insertion-shift');
const ORANGE = [255, 140, 0, 255];
const GREEN = [0, 170, 0, 255];
const RED = [255, 0, 0, 255];

/**
 * @param {number[]} color
 * @param {number[]} expected
 * @returns {boolean}
 */
function sameColor(color, expected) {
  return color.every((value, index) => value === expected[index]);
}

/**
 * @param {import('../types/index.d.ts').ComparisonRowMapping[]} mapping
 * @param {'baseline' | 'current'} side
 * @param {number} y
 */
function segmentAt(mapping, side, y) {
  return mapping.find((segment) => {
    const start = side === 'baseline' ? segment.baselineStart : segment.currentStart;
    return start !== undefined && y >= start && y < start + segment.length;
  });
}

const baseline = await fs.readFile(path.join(fixtureDir, 'baseline.png'));
const current = await fs.readFile(path.join(fixtureDir, 'current.png'));
const rendered = compareImages(baseline, current, { alignment: 'vertical' });
const metrics = compareImages(baseline, current, { alignment: 'vertical', renderDiffImage: false });
const again = compareImages(baseline, current, { alignment: 'vertical' });
const mapping = rendered.comparison.rowMapping ?? [];
const diff = PNG.sync.read(rendered.diffImageBuffer);

/**
 * @param {'baseline' | 'current'} side
 * @param {number} y
 */
function outputY(side, y) {
  const segment = segmentAt(mapping, side, y);
  if (!segment) return undefined;
  const start = side === 'baseline' ? segment.baselineStart : segment.currentStart;
  if (start === undefined) return undefined;
  return { segment, y: segment.outputStart + (y - start) };
}

/**
 * @param {number} y
 * @param {number} x
 * @returns {number[]}
 */
function pixel(y, x) {
  const index = (y * diff.width + x) * 4;
  return [...diff.data.subarray(index, index + 4)];
}

let baselineCursor = 0;
let currentCursor = 0;
let outputCursor = 0;
let contiguous = true;
let neighborCompares = 0;
let comparedOffsetsValid = true;
for (const segment of mapping) {
  if (segment.comparedOffset !== undefined) {
    neighborCompares += segment.length;
    const comparedStart = (segment.currentStart ?? 0) + segment.comparedOffset;
    if (
      (segment.comparedOffset !== -1 && segment.comparedOffset !== 1) ||
      (segment.kind !== 'matched' && segment.kind !== 'changed') ||
      segment.currentStart === undefined ||
      comparedStart < 0 ||
      comparedStart + segment.length > rendered.comparison.current.height
    ) {
      comparedOffsetsValid = false;
    }
  }
  if (segment.outputStart !== outputCursor) contiguous = false;
  if (segment.baselineStart !== undefined) {
    if (segment.baselineStart !== baselineCursor) contiguous = false;
    baselineCursor += segment.length;
  }
  if (segment.currentStart !== undefined) {
    if (segment.currentStart !== currentCursor) contiguous = false;
    currentCursor += segment.length;
  }
  outputCursor += segment.length;
}

let orangeGlyph = 0;
for (let y = 1155; y < 1157; y += 1) {
  const row = outputY('baseline', y);
  if (!row) continue;
  for (let x = 778; x < 785; x += 1) {
    if (sameColor(pixel(row.y, x), ORANGE)) orangeGlyph += 1;
  }
}

/**
 * @param {number} outputRow
 * @returns {number}
 */
function highlightCount(outputRow) {
  let count = 0;
  for (let x = 0; x < diff.width; x += 1) {
    const color = pixel(outputRow, x);
    if (sameColor(color, ORANGE) || sameColor(color, GREEN) || sameColor(color, RED)) count += 1;
  }
  return count;
}

const heading = outputY('baseline', 1200);
const link = outputY('baseline', 1500);
const card = outputY('baseline', 1270);
const glyph = outputY('baseline', 1155);
const removed = segmentAt(mapping, 'baseline', 1422);
const inserted = segmentAt(mapping, 'current', 1266);
let lowerHighlights = 0;
for (let y = 1800; y < 1900; y += 1) {
  const row = outputY('baseline', y);
  if (!row) {
    lowerHighlights += 1;
    continue;
  }
  for (let x = 0; x < diff.width; x += 40) {
    const color = pixel(row.y, x);
    if (sameColor(color, ORANGE) || sameColor(color, GREEN) || sameColor(color, RED)) lowerHighlights += 1;
  }
}
let localHighlights = 0;
for (let y = 5315; y < 5318; y += 1) {
  const row = outputY('baseline', y);
  if (!row) continue;
  for (let x = 0; x < diff.width; x += 1) {
    if (sameColor(pixel(row.y, x), ORANGE)) localHighlights += 1;
  }
}

console.log(JSON.stringify({
  mode: rendered.comparison.mode,
  fallbackReason: rendered.comparison.fallbackReason ?? null,
  dimensionsChanged: rendered.comparison.dimensionsChanged,
  differentPixels: rendered.differentPixels,
  totalPixels: rendered.totalPixels,
  canvas: rendered.comparison.canvas,
  metricsMatch: metrics.differentPixels === rendered.differentPixels &&
    metrics.totalPixels === rendered.totalPixels &&
    metrics.mismatchRatio === rendered.mismatchRatio &&
    JSON.stringify(metrics.comparison) === JSON.stringify(rendered.comparison) &&
    metrics.diffImageBuffer === undefined,
  buffersEqual: Buffer.isBuffer(again.diffImageBuffer) && again.diffImageBuffer.equals(rendered.diffImageBuffer),
  contiguous,
  baselineCursor,
  currentCursor,
  outputCursor,
  glyphKind: glyph?.segment.kind ?? null,
  orangeGlyph,
  headingKind: heading?.segment.kind ?? null,
  headingHighlights: heading ? highlightCount(heading.y) : -1,
  insertion: inserted ? { kind: inserted.kind, currentStart: inserted.currentStart, length: inserted.length } : null,
  insertionGreen: Boolean(outputY('current', 1270) && sameColor(pixel(outputY('current', 1270).y, 700), GREEN)),
  deletion: removed ? { kind: removed.kind, baselineStart: removed.baselineStart, length: removed.length } : null,
  deletionRed: Boolean(outputY('baseline', 1422) && sameColor(pixel(outputY('baseline', 1422).y, 700), RED)),
  row1496Kind: segmentAt(mapping, 'baseline', 1496)?.kind ?? null,
  link: link ? { kind: link.segment.kind, baselineStart: link.segment.baselineStart, currentStart: link.segment.currentStart, highlights: highlightCount(link.y) } : null,
  card: card ? { kind: card.segment.kind, offset: (card.segment.currentStart ?? 0) - (card.segment.baselineStart ?? 0) } : null,
  lowerHighlights,
  localGapKind: outputY('baseline', 5316)?.segment.kind ?? null,
  localHighlights,
  comparedOffsetsValid,
  neighborCompares
}));
