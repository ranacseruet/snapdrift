// @ts-check
/**
 * Phase 0 diagnostic for issue #178. Measures piecewise vertical-offset runs
 * on a PNG pair and records the current v2 comparison as a regression baseline.
 *
 * Offset votes come from baseline ink (luminance at or above INK_LUMA on the
 * baseline row). Flat background rows abstain. A current-only bright pixel
 * does not vote, or a blank baseline row would look deleted whenever the
 * offset lands on text. After the path is chosen, each row may move by one
 * pixel to the neighbor that matches it, so a line that fits the next offset
 * is not glued onto a mismatch. The offset window is searched; nothing here
 * is seeded with a known height delta.
 *
 * Usage (from the repository root):
 *   node packages/compare-core/scripts/measure-offset-runs.mjs \
 *     packages/compare-core/tests/fixtures/insertion-shift/baseline.png \
 *     packages/compare-core/tests/fixtures/insertion-shift/current.png
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import pngjs from 'pngjs';
import { compareImages } from '../src/index.mjs';

const { PNG } = pngjs;

/** Inclusive offset window, in current-row minus baseline-row. */
const OFFSET_MIN = -40;
const OFFSET_MAX = 160;
/** Column stride used only while scoring candidate offsets. */
const SEARCH_STRIDE = 2;
/** A pixel is noise-eligible at or below this per-channel delta. */
const NOISE_DELTA = 2;
/** Above this, a contiguous run is a structured residual rather than edge noise. */
const STRUCTURED_DELTA = 32;
/** A row this far from every neighboring offset is a local mismatch, not a stable run. */
const LOCAL_MISMATCH_COST = 0.5;
/** Structured pixels beyond this are a misaligned band, not a glyph-sized edit. */
const STRUCTURED_HOT_LIMIT = 40;
/** Luminance at or above this is ink. Dark page fill below it does not vote. */
const INK_LUMA = 32;
/** Fewer ink samples than this and the row abstains (cost 0 at every offset). */
const MIN_INK_SAMPLES = 8;
/** Contiguous above-noise pixels that mark a structured residual inside a stable run. */
const HIGHLIGHT_RUN = 6;
/**
 * Extra cost of leaving the current offset. A one-row border preference must
 * not split a run; a short run of text that only matches a new offset must.
 */
const OFFSET_SWITCH_COST = 1.5;
/**
 * Cost of leaving a baseline row unmatched. Below a real text match, above a
 * row whose ink matches nowhere in the window (a deleted band).
 */
const UNMATCHED_COST = 0.45;

/**
 * @param {Buffer} buffer
 * @returns {string}
 */
function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Fraction of baseline ink pixels whose RGB channels are outside the noise delta.
 * Returns 0 when the baseline row has too little ink to be evidence.
 *
 * @param {import('pngjs').PNG} baseline
 * @param {import('pngjs').PNG} current
 * @param {number} baselineY
 * @param {number} offset
 * @returns {number}
 */
function rowInkCost(baseline, current, baselineY, offset) {
  const currentY = baselineY + offset;
  if (currentY < 0 || currentY >= current.height) {
    return 1;
  }
  const width = baseline.width;
  const baselineRow = baselineY * width * 4;
  const currentRow = currentY * width * 4;
  let ink = 0;
  let hot = 0;
  for (let x = 0; x < width; x += SEARCH_STRIDE) {
    const baselineIndex = baselineRow + x * 4;
    const currentIndex = currentRow + x * 4;
    const baselineLuma =
      baseline.data[baselineIndex] * 0.299 +
      baseline.data[baselineIndex + 1] * 0.587 +
      baseline.data[baselineIndex + 2] * 0.114;
    if (baselineLuma < INK_LUMA) {
      continue;
    }
    ink += 1;
    const above =
      Math.abs(baseline.data[baselineIndex] - current.data[currentIndex]) > NOISE_DELTA ||
      Math.abs(baseline.data[baselineIndex + 1] - current.data[currentIndex + 1]) > NOISE_DELTA ||
      Math.abs(baseline.data[baselineIndex + 2] - current.data[currentIndex + 2]) > NOISE_DELTA;
    if (above) {
      hot += 1;
    }
  }
  if (ink < MIN_INK_SAMPLES) {
    return 0;
  }
  return hot / ink;
}

/**
 * @param {import('pngjs').PNG} baseline
 * @param {import('pngjs').PNG} current
 * @param {number} baselineY
 * @param {number} offset
 * @returns {{ noise: number, structured: number, structuredHot: number }}
 */
function hotRuns(baseline, current, baselineY, offset) {
  const currentY = baselineY + offset;
  const width = baseline.width;
  if (currentY < 0 || currentY >= current.height) {
    return { noise: width, structured: width, structuredHot: width };
  }
  const baselineRow = baselineY * width * 4;
  const currentRow = currentY * width * 4;
  let noise = 0;
  let structured = 0;
  let structuredHot = 0;
  let noiseRun = 0;
  let structuredRun = 0;
  for (let x = 0; x < width; x += 1) {
    const baselineIndex = baselineRow + x * 4;
    const currentIndex = currentRow + x * 4;
    const delta = Math.max(
      Math.abs(baseline.data[baselineIndex] - current.data[currentIndex]),
      Math.abs(baseline.data[baselineIndex + 1] - current.data[currentIndex + 1]),
      Math.abs(baseline.data[baselineIndex + 2] - current.data[currentIndex + 2])
    );
    if (delta > NOISE_DELTA) {
      noiseRun += 1;
      if (noiseRun > noise) {
        noise = noiseRun;
      }
    } else {
      noiseRun = 0;
    }
    if (delta > STRUCTURED_DELTA) {
      structuredHot += 1;
      structuredRun += 1;
      if (structuredRun > structured) {
        structured = structuredRun;
      }
    } else {
      structuredRun = 0;
    }
  }
  return { noise, structured, structuredHot };
}

/**
 * Let a row take the neighboring offset that actually matches it. A row that
 * still mismatches every neighbor is a local gap, not part of the stable run.
 *
 * @param {Array<{ y: number, kind: 'stable' | 'unresolved', offset: number | null, cost: number }>} rows
 * @param {Float64Array[]} costs
 */
function refineNeighborOffsets(rows, costs) {
  return rows.map((row) => {
    if (row.kind !== 'stable' || row.offset === null) {
      return row;
    }
    let bestOffset = row.offset;
    let bestCost = costs[row.y][row.offset - OFFSET_MIN];
    for (const delta of [-1, 1]) {
      const offset = row.offset + delta;
      if (offset < OFFSET_MIN || offset > OFFSET_MAX) {
        continue;
      }
      const cost = costs[row.y][offset - OFFSET_MIN];
      if (cost < bestCost) {
        bestCost = cost;
        bestOffset = offset;
      }
    }
    if (bestCost > LOCAL_MISMATCH_COST) {
      return { y: row.y, kind: /** @type {const} */ ('unresolved'), offset: null, cost: bestCost };
    }
    return { y: row.y, kind: /** @type {const} */ ('stable'), offset: bestOffset, cost: bestCost };
  });
}

/**
 * A one- or two-row hole between the same shift is an edge, not a new edit.
 *
 * @param {Array<{ y: number, kind: 'stable' | 'unresolved', offset: number | null, cost: number }>} rows
 */
function bridgeShortGaps(rows) {
  const bridged = rows.map((row) => ({ ...row }));
  for (let index = 0; index < bridged.length;) {
    if (bridged[index].kind !== 'unresolved') {
      index += 1;
      continue;
    }
    const start = index;
    while (index < bridged.length && bridged[index].kind === 'unresolved') {
      index += 1;
    }
    const before = start > 0 ? bridged[start - 1] : undefined;
    const after = index < bridged.length ? bridged[index] : undefined;
    if (
      index - start <= 2 &&
      before?.kind === 'stable' &&
      after?.kind === 'stable' &&
      before.offset !== null &&
      after.offset !== null &&
      Math.abs(before.offset - after.offset) <= 1
    ) {
      for (let fill = start; fill < index; fill += 1) {
        bridged[fill] = {
          y: bridged[fill].y,
          kind: /** @type {const} */ ('stable'),
          offset: before.offset,
          cost: bridged[fill].cost
        };
      }
    }
  }
  return bridged;
}

/**
 * A stable sliver sandwiched between two unresolved bands is part of that gap.
 *
 * @param {Array<{ y: number, kind: 'stable' | 'unresolved', offset: number | null, cost: number }>} rows
 */
function absorbShortStable(rows) {
  const absorbed = rows.map((row) => ({ ...row }));
  for (let index = 0; index < absorbed.length;) {
    if (absorbed[index].kind !== 'stable') {
      index += 1;
      continue;
    }
    const start = index;
    while (index < absorbed.length && absorbed[index].kind === 'stable' && absorbed[index].offset === absorbed[start].offset) {
      index += 1;
    }
    const before = start > 0 ? absorbed[start - 1] : undefined;
    const after = index < absorbed.length ? absorbed[index] : undefined;
    if (index - start <= 3 && before?.kind === 'unresolved' && after?.kind === 'unresolved') {
      for (let fill = start; fill < index; fill += 1) {
        absorbed[fill] = {
          y: absorbed[fill].y,
          kind: /** @type {const} */ ('unresolved'),
          offset: null,
          cost: absorbed[fill].cost
        };
      }
    }
  }
  return absorbed;
}

/**
 * Collapse per-row ink costs into long constant-offset runs.
 * Changing offset pays {@link OFFSET_SWITCH_COST}. A row whose ink matches
 * nowhere in the window takes the unmatched state.
 *
 * @param {Float64Array[]} costs
 * @returns {Array<{ y: number, kind: 'stable' | 'unresolved', offset: number | null, cost: number }>}
 */
function collapseOffsetPath(costs) {
  const offsetCount = OFFSET_MAX - OFFSET_MIN + 1;
  const rowCount = costs.length;
  const unmatched = offsetCount;
  /** @type {Float64Array[]} */
  const pathCost = [new Float64Array(offsetCount + 1), new Float64Array(offsetCount + 1)];
  const back = Array.from({ length: rowCount }, () => new Int16Array(offsetCount + 1));

  for (let state = 0; state < unmatched; state += 1) {
    pathCost[0][state] = costs[0][state];
    back[0][state] = -1;
  }
  pathCost[0][unmatched] = UNMATCHED_COST;
  back[0][unmatched] = -1;

  // Tied path costs are common on blank rows, which match every offset. Keep
  // the incumbent on a tie so the window edge does not win the argmin.
  let incumbent = 0;
  for (let y = 1; y < rowCount; y += 1) {
    const previous = pathCost[(y - 1) % 2];
    const next = pathCost[y % 2];
    let bestPrevious = incumbent;
    for (let state = 0; state <= unmatched; state += 1) {
      if (previous[state] < previous[bestPrevious]) {
        bestPrevious = state;
      }
    }
    incumbent = bestPrevious;
    const switchFrom = previous[bestPrevious] + OFFSET_SWITCH_COST;
    let zeroOffsets = 0;
    for (let index = 0; index < unmatched; index += 1) {
      if (costs[y][index] === 0) {
        zeroOffsets += 1;
      }
    }
    // Several offsets matching perfectly means this row carries no distinctive
    // shape. It must not fund a jump onto an arbitrary offset, and it must not
    // push a deleted band out of the unmatched state.
    const lowInformation = zeroOffsets >= 3;
    for (let state = 0; state < unmatched; state += 1) {
      const emission = lowInformation ? (state === bestPrevious ? 0 : 1) : costs[y][state];
      const stay = previous[state];
      if (stay <= switchFrom) {
        next[state] = stay + emission;
        back[y][state] = state;
      } else {
        next[state] = switchFrom + emission;
        back[y][state] = bestPrevious;
      }
    }
    const unmatchedEmission = lowInformation ? (bestPrevious === unmatched ? 0 : 1) : UNMATCHED_COST;
    const stayUnmatched = previous[unmatched];
    if (stayUnmatched <= switchFrom) {
      next[unmatched] = stayUnmatched + unmatchedEmission;
      back[y][unmatched] = unmatched;
    } else {
      next[unmatched] = switchFrom + unmatchedEmission;
      back[y][unmatched] = bestPrevious;
    }
  }

  const last = pathCost[(rowCount - 1) % 2];
  let state = 0;
  for (let candidate = 1; candidate <= unmatched; candidate += 1) {
    if (last[candidate] < last[state]) {
      state = candidate;
    }
  }

  /** @type {number[]} */
  const chosen = new Array(rowCount);
  for (let y = rowCount - 1; y >= 0; y -= 1) {
    chosen[y] = state;
    state = back[y][state];
  }

  return chosen.map((chosenState, y) => {
    if (chosenState === unmatched) {
      return { y, kind: /** @type {const} */ ('unresolved'), offset: null, cost: UNMATCHED_COST };
    }
    return {
      y,
      kind: /** @type {const} */ ('stable'),
      offset: chosenState + OFFSET_MIN,
      cost: costs[y][chosenState]
    };
  });
}

/**
 * @param {import('pngjs').PNG} baseline
 * @param {import('pngjs').PNG} current
 */
function measureOffsetRuns(baseline, current) {
  if (baseline.width !== current.width) {
    return { kind: 'width-mismatch', width: { baseline: baseline.width, current: current.width } };
  }

  const started = performance.now();
  const offsetCount = OFFSET_MAX - OFFSET_MIN + 1;
  /** @type {Float64Array[]} */
  const costs = Array.from({ length: baseline.height }, () => new Float64Array(offsetCount));
  for (let y = 0; y < baseline.height; y += 1) {
    for (let offset = OFFSET_MIN; offset <= OFFSET_MAX; offset += 1) {
      costs[y][offset - OFFSET_MIN] = rowInkCost(baseline, current, y, offset);
    }
  }
  const scoredAt = performance.now();
  const refined = refineNeighborOffsets(collapseOffsetPath(costs), costs);
  // A neighbor offset can make the ink cost look clean while a wide band of
  // high-delta pixels is still wrong. A glyph edit is a handful of those
  // pixels; a glued line is dozens. Split the line out of the stable run.
  const rows = absorbShortStable(bridgeShortGaps(refined.map((row) => {
    if (row.kind !== 'stable' || row.offset === null) {
      return row;
    }
    const residual = hotRuns(baseline, current, row.y, row.offset);
    if (residual.structuredHot > STRUCTURED_HOT_LIMIT) {
      return { y: row.y, kind: /** @type {const} */ ('unresolved'), offset: null, cost: row.cost };
    }
    return row;
  })));

  /** @type {Array<{ start: number, end: number, kind: string, offset: number | null, highlightRows: number, structuredRows: number, meanCost: number }>} */
  const runs = [];
  for (let index = 0; index < rows.length;) {
    const kind = rows[index].kind;
    const offset = rows[index].offset;
    const start = index;
    let costSum = rows[index].cost;
    index += 1;
    while (index < rows.length && rows[index].kind === kind && rows[index].offset === offset) {
      costSum += rows[index].cost;
      index += 1;
    }
    let highlightRows = 0;
    let structuredRows = 0;
    if (kind === 'stable' && offset !== null) {
      for (let y = start; y < index; y += 1) {
        const runsAtOffset = hotRuns(baseline, current, y, offset);
        if (runsAtOffset.noise >= HIGHLIGHT_RUN) {
          highlightRows += 1;
        }
        if (runsAtOffset.structured >= 4) {
          structuredRows += 1;
        }
      }
    }
    runs.push({
      start,
      end: index,
      kind,
      offset,
      highlightRows,
      structuredRows,
      meanCost: costSum / (index - start)
    });
  }

  /** @type {typeof runs} */
  const contentIntervals = [];
  for (const run of runs) {
    const previous = contentIntervals.at(-1);
    const adjacentShift =
      previous &&
      previous.kind === 'stable' &&
      run.kind === 'stable' &&
      previous.offset !== null &&
      run.offset !== null &&
      Math.abs(previous.offset - run.offset) <= 1;
    if (previous && adjacentShift) {
      previous.end = run.end;
      previous.highlightRows += run.highlightRows;
      previous.structuredRows += run.structuredRows;
      previous.meanCost = (previous.meanCost + run.meanCost) / 2;
      continue;
    }
    contentIntervals.push({ ...run });
  }

  return {
    kind: 'measured',
    elapsedMs: performance.now() - started,
    scoreMs: scoredAt - started,
    constants: {
      offsetMin: OFFSET_MIN,
      offsetMax: OFFSET_MAX,
      searchStride: SEARCH_STRIDE,
      noiseDelta: NOISE_DELTA,
      inkLuma: INK_LUMA,
      minInkSamples: MIN_INK_SAMPLES,
      highlightRun: HIGHLIGHT_RUN,
      offsetSwitchCost: OFFSET_SWITCH_COST,
      unmatchedCost: UNMATCHED_COST,
      localMismatchCost: LOCAL_MISMATCH_COST,
      structuredDelta: STRUCTURED_DELTA,
      structuredHotLimit: STRUCTURED_HOT_LIMIT
    },
    rowCount: baseline.height,
    currentHeight: current.height,
    runCount: runs.length,
    contentIntervalCount: contentIntervals.length,
    runs,
    contentIntervals
  };
}

const baselinePath = process.argv[2];
const currentPath = process.argv[3];
if (!baselinePath || !currentPath) {
  console.error('usage: node measure-offset-runs.mjs <baseline.png> <current.png>');
  process.exit(1);
}

const baselineBuffer = await fs.readFile(baselinePath);
const currentBuffer = await fs.readFile(currentPath);
const before = process.memoryUsage();
const regressionStarted = performance.now();
const regression = compareImages(baselineBuffer, currentBuffer, { alignment: 'vertical', renderDiffImage: false });
const regressionMs = performance.now() - regressionStarted;
const after = process.memoryUsage();

const baselinePng = PNG.sync.read(baselineBuffer);
const currentPng = PNG.sync.read(currentBuffer);
const mapping = measureOffsetRuns(baselinePng, currentPng);

const report = {
  fixtures: {
    baseline: { path: baselinePath, sha256: sha256(baselineBuffer), width: baselinePng.width, height: baselinePng.height },
    current: { path: currentPath, sha256: sha256(currentBuffer), width: currentPng.width, height: currentPng.height }
  },
  regression: {
    elapsedMs: regressionMs,
    rssDeltaBytes: after.rss - before.rss,
    comparison: regression.comparison,
    mismatchRatio: regression.mismatchRatio,
    differentPixels: regression.differentPixels,
    totalPixels: regression.totalPixels
  },
  mapping
};

console.log(JSON.stringify(report, null, 2));
