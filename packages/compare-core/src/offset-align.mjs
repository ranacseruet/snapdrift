// @ts-check

/**
 * Piecewise vertical-offset alignment for comparison policy v2.
 *
 * Exact row fingerprints stay in `vertical-align.mjs`. This path runs when
 * that search hits its edit cap: long stretches of a page can share one
 * vertical offset even when antialiasing keeps rows from being byte-identical.
 * The offset window is searched. Nothing here is seeded with a known shift.
 *
 * Scoring uses baseline ink only: luminance at or above {@link INK_LUMA} and
 * alpha at or above that same floor. Fully transparent pixels do not vote,
 * even when their RGB is bright. A channel delta at or below {@link NOISE_DELTA}
 * is the measured rendering floor. A delta above {@link STRUCTURED_DELTA} is a
 * structured residual, including an opacity change of that size. A smaller
 * opacity change stays in the mapping and the highlight rule decides whether
 * to paint it. More than {@link STRUCTURED_HOT_LIMIT} structured pixels pulls
 * the row out of the stable run so a wide mismatch is not painted as a small
 * glyph edit.
 *
 * An equal-height replacement stays on the exact Myers path. This search
 * returns alignment-limit for that pair: the switch cost keeps a shifted page
 * on one offset, and it is not spent on a one-row swap.
 *
 * Before the full table is allocated, every {@link PREFLIGHT_ROW_STRIDE}th
 * ink row is scored. The sample stops early once even perfect remaining rows
 * could not pull the mean under the evidence limit, so a dissimilar page
 * falls back without the full search.
 */

/** Inclusive offset window, in current-row minus baseline-row. */
export const OFFSET_MIN = -40;
/** Inclusive offset window, in current-row minus baseline-row. */
export const OFFSET_MAX = 160;
/** Column stride used only while scoring candidate offsets. */
export const SEARCH_STRIDE = 2;
/** A pixel is noise-eligible at or below this per-channel delta. */
export const NOISE_DELTA = 2;
/** Above this, a contiguous run is a structured residual rather than edge noise. */
export const STRUCTURED_DELTA = 32;
/** A row this far from every neighboring offset is a local mismatch, not a stable run. */
export const LOCAL_MISMATCH_COST = 0.5;
/** Structured pixels beyond this are a misaligned band, not a glyph-sized edit. */
export const STRUCTURED_HOT_LIMIT = 40;
/** Luminance at or above this is ink. Dark page fill below it does not vote. */
export const INK_LUMA = 32;
/** Fewer ink samples than this and the row abstains (cost 0 at every in-range offset). */
export const MIN_INK_SAMPLES = 8;
/** Contiguous above-noise pixels that mark a structured residual inside a stable run. */
export const HIGHLIGHT_RUN = 6;
/**
 * Extra cost of leaving the current offset. A one-row border preference must
 * not split a run; a short run of text that only matches a new offset must.
 */
export const OFFSET_SWITCH_COST = 1.5;
/**
 * Cost of leaving a baseline row unmatched. Below a real text match, above a
 * row whose ink matches nowhere in the window (a deleted band).
 */
export const UNMATCHED_COST = 0.45;
/**
 * Pixel visits for the offset search, height × window × sampled columns.
 * The acceptance pair (5622 × 1440) is about 8.1e8 visits and scored in about
 * 1.2s. Past this budget the page keeps the coordinate fallback.
 */
export const MAX_OFFSET_SCORE_VISITS = 1_500_000_000;
/**
 * Bytes for the per-row cost table (Float64) plus the Viterbi backpointers
 * (Int16). The acceptance pair is about 11 MB. A narrow million-row image
 * can pass the visit cap and still need about 2 GB for these matrices, so
 * the search stops before allocating them.
 */
export const MAX_OFFSET_MATRIX_BYTES = 64 * 1024 * 1024;
/**
 * Rows between preflight samples. A dissimilar page's best in-window cost
 * stays high, so this rejects it before the full height × window table.
 * The acceptance pair's sampled mean stays near zero and the full search runs.
 * A dissimilar 1440×5622 pair fell back in about 0.9s; scoring every offset
 * on that pair took about 3.5s.
 */
const PREFLIGHT_ROW_STRIDE = 32;
/** A mapping whose ink rows are this hot is not a usable correspondence. */
const EVIDENCE_MEAN_COST_LIMIT = 0.25;
/** More content intervals than this is a fragmented mapping, not a page of edits. */
export const MAX_OFFSET_CONTENT_INTERVALS = 64;

/**
 * @typedef {{ data: Uint8Array, width: number, height: number }} DecodedPng
 * @typedef {{
 *   y: number,
 *   kind: 'stable' | 'unresolved',
 *   offset: number | null,
 *   compareOffset: number | null,
 *   cost: number,
 *   abstain: boolean
 * }} OffsetRow
 * @typedef {{
 *   start: number,
 *   end: number,
 *   kind: 'stable' | 'unresolved',
 *   offset: number | null,
 *   highlightRows: number,
 *   structuredRows: number,
 *   meanCost: number
 * }} OffsetInterval
 */

/**
 * Baseline ink below the sample minimum cannot vote. Out-of-range offsets
 * still cost 1; this flag only describes the in-range abstention.
 *
 * @param {DecodedPng} baseline
 * @param {number} baselineY
 * @returns {boolean}
 */
/**
 * @param {Uint8Array} data
 * @param {number} index
 * @returns {boolean}
 */
function isBaselineInk(data, index) {
  if (data[index + 3] < INK_LUMA) {
    return false;
  }
  const luma =
    data[index] * 0.299 +
    data[index + 1] * 0.587 +
    data[index + 2] * 0.114;
  return luma >= INK_LUMA;
}

function rowAbstains(baseline, baselineY) {
  const width = baseline.width;
  const baselineRow = baselineY * width * 4;
  let ink = 0;
  for (let x = 0; x < width; x += SEARCH_STRIDE) {
    if (isBaselineInk(baseline.data, baselineRow + x * 4)) {
      ink += 1;
      if (ink >= MIN_INK_SAMPLES) {
        return false;
      }
    }
  }
  return true;
}

/**
 * @param {DecodedPng} baseline
 * @param {DecodedPng} current
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
    if (!isBaselineInk(baseline.data, baselineIndex)) {
      continue;
    }
    ink += 1;
    // Alpha uses the structured bar. A few levels of opacity are rendering
    // noise and must not eject the row; a real fade is not a correspondence.
    const above =
      Math.abs(baseline.data[baselineIndex] - current.data[currentIndex]) > NOISE_DELTA ||
      Math.abs(baseline.data[baselineIndex + 1] - current.data[currentIndex + 1]) > NOISE_DELTA ||
      Math.abs(baseline.data[baselineIndex + 2] - current.data[currentIndex + 2]) > NOISE_DELTA ||
      Math.abs(baseline.data[baselineIndex + 3] - current.data[currentIndex + 3]) > STRUCTURED_DELTA;
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
 * @param {DecodedPng} baseline
 * @param {DecodedPng} current
 * @param {number} baselineY
 * @param {number} offset
 * @returns {{ noise: number, structured: number, structuredHot: number }}
 */
export function hotRuns(baseline, current, baselineY, offset) {
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
      Math.abs(baseline.data[baselineIndex + 2] - current.data[currentIndex + 2]),
      Math.abs(baseline.data[baselineIndex + 3] - current.data[currentIndex + 3])
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
 * @param {OffsetRow[]} rows
 * @param {Float64Array[]} costs
 * @returns {OffsetRow[]}
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
      return {
        y: row.y,
        kind: /** @type {const} */ ('unresolved'),
        offset: null,
        compareOffset: bestOffset,
        cost: bestCost,
        abstain: row.abstain
      };
    }
    return {
      y: row.y,
      kind: /** @type {const} */ ('stable'),
      offset: bestOffset,
      compareOffset: bestOffset,
      cost: bestCost,
      abstain: row.abstain
    };
  });
}

/**
 * A one- or two-row hole between the same shift is an edge, not a new edit.
 *
 * @param {OffsetRow[]} rows
 * @returns {OffsetRow[]}
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
          compareOffset: before.offset,
          cost: bridged[fill].cost,
          abstain: bridged[fill].abstain
        };
      }
    }
  }
  return bridged;
}

/**
 * A stable sliver sandwiched between two unresolved bands is part of that gap.
 *
 * @param {OffsetRow[]} rows
 * @returns {OffsetRow[]}
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
          compareOffset: absorbed[fill].offset,
          cost: absorbed[fill].cost,
          abstain: absorbed[fill].abstain
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
 * @param {boolean[]} abstain
 * @returns {OffsetRow[]}
 */
function collapseOffsetPath(costs, abstain) {
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
      return {
        y,
        kind: /** @type {const} */ ('unresolved'),
        offset: null,
        compareOffset: null,
        cost: UNMATCHED_COST,
        abstain: abstain[y]
      };
    }
    const offset = chosenState + OFFSET_MIN;
    return {
      y,
      kind: /** @type {const} */ ('stable'),
      offset,
      compareOffset: offset,
      cost: costs[y][chosenState],
      abstain: abstain[y]
    };
  });
}

/**
 * @param {DecodedPng} baseline
 * @param {DecodedPng} current
 * @param {OffsetRow[]} rows
 * @returns {OffsetInterval[]}
 */
function summarizeIntervals(baseline, current, rows) {
  /** @type {OffsetInterval[]} */
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

  /** @type {OffsetInterval[]} */
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
  return contentIntervals;
}

/**
 * Best in-window ink cost of every sampled row. Above the evidence limit,
 * the full search cannot produce a usable correspondence.
 *
 * @param {DecodedPng} baseline
 * @param {DecodedPng} current
 * @returns {boolean}
 */
function offsetPreflightRejects(baseline, current) {
  const planned = Math.ceil(baseline.height / PREFLIGHT_ROW_STRIDE);
  let sum = 0;
  let samples = 0;
  for (let y = 0; y < baseline.height; y += PREFLIGHT_ROW_STRIDE) {
    if (rowAbstains(baseline, y)) {
      continue;
    }
    let best = 1;
    for (let offset = OFFSET_MIN; offset <= OFFSET_MAX; offset += 1) {
      const cost = rowInkCost(baseline, current, y, offset);
      if (cost < best) {
        best = cost;
      }
      if (best === 0) {
        break;
      }
    }
    sum += best;
    samples += 1;
    if (sum / planned > EVIDENCE_MEAN_COST_LIMIT) {
      return true;
    }
  }
  return samples > 0 && sum / samples > EVIDENCE_MEAN_COST_LIMIT;
}

/**
 * Score the offset window and collapse it into the Phase 0 row path.
 * Returns a fallback when the search would exceed its visit budget, its
 * matrix budget, or the sampled preflight.
 *
 * @param {DecodedPng} baseline
 * @param {DecodedPng} current
 * @returns {{ kind: 'mapped', rows: OffsetRow[], contentIntervals: OffsetInterval[], scoreMs: number } | { kind: 'fallback', reason: 'width-mismatch' | 'alignment-limit' }}
 */
export function analyzeOffsetRuns(baseline, current) {
  if (baseline.width !== current.width) {
    return { kind: 'fallback', reason: 'width-mismatch' };
  }
  if (baseline.height === 0) {
    return { kind: 'mapped', rows: [], contentIntervals: [], scoreMs: 0 };
  }

  const offsetCount = OFFSET_MAX - OFFSET_MIN + 1;
  const visits = baseline.height * offsetCount * Math.ceil(baseline.width / SEARCH_STRIDE);
  const matrixBytes = baseline.height * offsetCount * 8 + baseline.height * (offsetCount + 1) * 2;
  if (visits > MAX_OFFSET_SCORE_VISITS || matrixBytes > MAX_OFFSET_MATRIX_BYTES) {
    return { kind: 'fallback', reason: 'alignment-limit' };
  }
  if (offsetPreflightRejects(baseline, current)) {
    return { kind: 'fallback', reason: 'alignment-limit' };
  }

  const started = performance.now();
  /** @type {Float64Array[]} */
  const costs = Array.from({ length: baseline.height }, () => new Float64Array(offsetCount));
  /** @type {boolean[]} */
  const abstain = Array.from({ length: baseline.height }, (_, y) => rowAbstains(baseline, y));
  for (let y = 0; y < baseline.height; y += 1) {
    for (let offset = OFFSET_MIN; offset <= OFFSET_MAX; offset += 1) {
      costs[y][offset - OFFSET_MIN] = rowInkCost(baseline, current, y, offset);
    }
  }

  const refined = refineNeighborOffsets(collapseOffsetPath(costs, abstain), costs);
  const rows = absorbShortStable(bridgeShortGaps(refined.map((row) => {
    if (row.kind !== 'stable' || row.offset === null) {
      return row;
    }
    const residual = hotRuns(baseline, current, row.y, row.offset);
    if (residual.structuredHot > STRUCTURED_HOT_LIMIT) {
      return {
        y: row.y,
        kind: /** @type {const} */ ('unresolved'),
        offset: null,
        compareOffset: row.offset,
        cost: row.cost,
        abstain: row.abstain
      };
    }
    return row;
  })));

  return {
    kind: 'mapped',
    rows,
    contentIntervals: summarizeIntervals(baseline, current, rows),
    scoreMs: performance.now() - started
  };
}

/**
 * @param {number} delta
 * @param {'tolerant' | 'residual'} paint
 * @returns {boolean}
 */
export function pixelIsHighlighted(delta, paint) {
  return paint === 'residual' ? delta > NOISE_DELTA : delta > STRUCTURED_DELTA;
}

/**
 * Current-row overlap between two stable runs that can be trimmed off the
 * earlier run. Larger crossings are not a safe vertical mapping.
 */
const MAX_RUN_OVERLAP = 8;

/**
 * @typedef {'tolerant' | 'residual'} OffsetPaint
 * @typedef {{
 *   role: 'paired',
 *   baselineY: number,
 *   currentY: number,
 *   pixelY: number,
 *   paint: OffsetPaint
 * } | {
 *   role: 'deleted',
 *   baselineY: number
 * } | {
 *   role: 'inserted',
 *   currentY: number
 * }} OffsetPlanStep
 */

/**
 * @param {OffsetRow[]} rows
 * @param {number} start
 * @param {number} end
 * @returns {boolean}
 */
function isLocalGap(rows, start, end) {
  const before = start > 0 ? rows[start - 1] : undefined;
  const after = end < rows.length ? rows[end] : undefined;
  return Boolean(
    before?.kind === 'stable' &&
    after?.kind === 'stable' &&
    before.offset !== null &&
    after.offset !== null &&
    Math.abs(before.offset - after.offset) <= 1
  );
}

/**
 * Turn the offset-run mapping into a monotonic row plan.
 *
 * Stable runs that differ by one pixel share one recorded offset so a ±1
 * neighbor match is not an insertion or deletion. Pixels are still read from
 * the row's own offset. An unresolved band between those neighbors is a local
 * mismatch. Any other unresolved band is a deletion. Current rows that no
 * paired baseline row claims are insertions.
 *
 * @param {DecodedPng} baseline
 * @param {DecodedPng} current
 * @returns {{ kind: 'aligned', steps: OffsetPlanStep[] } | { kind: 'fallback', reason: 'width-mismatch' | 'alignment-limit' }}
 */
export function buildOffsetRenderPlan(baseline, current) {
  const mapped = analyzeOffsetRuns(baseline, current);
  if (mapped.kind !== 'mapped') {
    return mapped;
  }
  if (baseline.height === 0 && current.height === 0) {
    return { kind: 'aligned', steps: [] };
  }

  const evidence = mapped.rows.filter((row) => row.kind === 'stable' && !row.abstain);
  if (evidence.length === 0 || mapped.contentIntervals.length > MAX_OFFSET_CONTENT_INTERVALS) {
    return { kind: 'fallback', reason: 'alignment-limit' };
  }
  const evidenceMean = evidence.reduce((sum, row) => sum + row.cost, 0) / evidence.length;
  if (evidenceMean > EVIDENCE_MEAN_COST_LIMIT) {
    return { kind: 'fallback', reason: 'alignment-limit' };
  }

  /** @type {Array<{ role: 'paired', baselineY: number, pixelY: number, paint: OffsetPaint } | { role: 'deleted', baselineY: number }>} */
  const labeled = [];
  for (let index = 0; index < mapped.rows.length;) {
    if (mapped.rows[index].kind !== 'unresolved') {
      const row = mapped.rows[index];
      const pixelOffset = row.offset ?? 0;
      labeled.push({
        role: 'paired',
        baselineY: row.y,
        pixelY: row.y + pixelOffset,
        paint: 'tolerant'
      });
      index += 1;
      continue;
    }
    const start = index;
    while (index < mapped.rows.length && mapped.rows[index].kind === 'unresolved') {
      index += 1;
    }
    if (isLocalGap(mapped.rows, start, index)) {
      const neighbor = mapped.rows[start - 1].offset ?? 0;
      for (let y = start; y < index; y += 1) {
        const pixelOffset = mapped.rows[y].compareOffset ?? neighbor;
        labeled.push({
          role: 'paired',
          baselineY: y,
          pixelY: y + pixelOffset,
          paint: 'residual'
        });
      }
      continue;
    }
    for (let y = start; y < index; y += 1) {
      labeled.push({ role: 'deleted', baselineY: y });
    }
  }

  /**
   * @typedef {{ role: 'paired', rows: Array<{ baselineY: number, pixelY: number, paint: OffsetPaint }>, mapOffset: number, minOffset: number, maxOffset: number } | { role: 'deleted', baselineYs: number[] }} PlanBlock
   */
  /** @type {PlanBlock[]} */
  const blocks = [];
  for (const row of labeled) {
    if (row.role === 'deleted') {
      const previous = blocks.at(-1);
      if (previous?.role === 'deleted') {
        previous.baselineYs.push(row.baselineY);
      } else {
        blocks.push({ role: 'deleted', baselineYs: [row.baselineY] });
      }
      continue;
    }
    const pixelOffset = row.pixelY - row.baselineY;
    const previous = blocks.at(-1);
    const previousRow = previous?.role === 'paired' ? previous.rows.at(-1) : undefined;
    if (
      previous?.role === 'paired' &&
      previousRow &&
      row.baselineY === previousRow.baselineY + 1 &&
      Math.max(previous.maxOffset, pixelOffset) - Math.min(previous.minOffset, pixelOffset) <= 1
    ) {
      previous.rows.push(row);
      previous.minOffset = Math.min(previous.minOffset, pixelOffset);
      previous.maxOffset = Math.max(previous.maxOffset, pixelOffset);
      continue;
    }
    blocks.push({
      role: 'paired',
      rows: [row],
      mapOffset: pixelOffset,
      minOffset: pixelOffset,
      maxOffset: pixelOffset
    });
  }

  for (const block of blocks) {
    if (block.role !== 'paired') continue;
    const offsets = block.rows.map((row) => row.pixelY - row.baselineY).sort((left, right) => left - right);
    block.mapOffset = offsets[offsets.length >> 1];
  }

  for (let guard = 0; guard < 4; guard += 1) {
    let changed = false;
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      if (block.role !== 'paired' || block.rows.length === 0) continue;
      const start = block.rows[0].baselineY + block.mapOffset;
      const end = start + block.rows.length;
      if (start < 0 || end > current.height) {
        return { kind: 'fallback', reason: 'alignment-limit' };
      }
      let nextIndex = index + 1;
      while (nextIndex < blocks.length && blocks[nextIndex].role !== 'paired') {
        nextIndex += 1;
      }
      if (nextIndex >= blocks.length) continue;
      const next = blocks[nextIndex];
      if (next.role !== 'paired' || next.rows.length === 0) continue;
      const nextStart = next.rows[0].baselineY + next.mapOffset;
      const overlap = end - nextStart;
      if (overlap <= 0) continue;
      if (overlap > MAX_RUN_OVERLAP || overlap >= block.rows.length) {
        return { kind: 'fallback', reason: 'alignment-limit' };
      }
      const trimmed = block.rows.splice(block.rows.length - overlap, overlap);
      const deleted = /** @type {PlanBlock} */ ({
        role: 'deleted',
        baselineYs: trimmed.map((row) => row.baselineY)
      });
      blocks.splice(index + 1, 0, deleted);
      // Keep mapOffset. Recomputing it can grow the current-row range back
      // over the next run and loop forever.
      changed = true;
    }
    if (!changed) break;
    if (guard === 3) {
      return { kind: 'fallback', reason: 'alignment-limit' };
    }
  }

  /** @type {OffsetPlanStep[]} */
  const steps = [];
  let cursor = 0;
  for (const block of blocks) {
    if (block.role === 'deleted') {
      for (const baselineY of block.baselineYs) {
        steps.push({ role: 'deleted', baselineY });
      }
      continue;
    }
    if (block.rows.length === 0) continue;
    const mapStart = block.rows[0].baselineY + block.mapOffset;
    if (mapStart < cursor) {
      return { kind: 'fallback', reason: 'alignment-limit' };
    }
    while (cursor < mapStart) {
      steps.push({ role: 'inserted', currentY: cursor });
      cursor += 1;
    }
    for (let index = 0; index < block.rows.length; index += 1) {
      const row = block.rows[index];
      const currentY = mapStart + index;
      const pixelY = row.pixelY >= 0 && row.pixelY < current.height ? row.pixelY : currentY;
      steps.push({
        role: 'paired',
        baselineY: row.baselineY,
        currentY,
        pixelY,
        paint: row.paint
      });
      cursor += 1;
    }
  }
  while (cursor < current.height) {
    steps.push({ role: 'inserted', currentY: cursor });
    cursor += 1;
  }

  const consumedBaseline = steps.filter((step) => step.role !== 'inserted').length;
  if (consumedBaseline !== baseline.height) {
    return { kind: 'fallback', reason: 'alignment-limit' };
  }
  return { kind: 'aligned', steps };
}
