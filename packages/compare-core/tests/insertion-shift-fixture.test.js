import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';
import { compareOffsetAligned } from '../src/compare-images.mjs';
import { compareImages } from '../src/index.mjs';
import { analyzeOffsetRuns, HIGHLIGHT_RUN, hotRuns, MAX_OFFSET_MATRIX_BYTES, OFFSET_MAX, OFFSET_MIN } from '../src/offset-align.mjs';
import { syntheticAlignmentCases } from './synthetic-alignment-cases.mjs';

const { PNG } = pngjs;
const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/insertion-shift');

/**
 * @param {string} name
 * @returns {Promise<Buffer>}
 */
function readFixture(name) {
  return fs.readFile(path.join(fixtureDir, name));
}

describe('insertion-shift fixture', () => {
  test('preserves the original pair checksums and the recorded pre-fix fallback', async () => {
    const annotation = JSON.parse(await readFixture('annotation.json'));
    const regression = JSON.parse(await readFixture('regression-baseline.json'));
    const baseline = await readFixture('baseline.png');
    const current = await readFixture('current.png');

    expect(createHash('sha256').update(baseline).digest('hex')).toBe(annotation.pair.baseline.sha256);
    expect(createHash('sha256').update(current).digest('hex')).toBe(annotation.pair.current.sha256);
    expect(regression.comparison).toMatchObject({
      policyVersion: 2,
      mode: 'coordinate-fallback',
      fallbackReason: 'alignment-limit',
      differentPixels: 1851288,
      totalPixels: 8127360
    });
  });

  test('highlights the changelog edit and leaves the shifted page matched', () => {
    const reportPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'insertion-shift-report.mjs');
    const child = spawnSync(process.execPath, [reportPath], { encoding: 'utf8' });
    expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: '' });
    const report = JSON.parse(child.stdout);
    expect(report).toMatchObject({
      mode: 'vertical-aligned',
      alignmentStrategy: 'offset',
      tolerance: 32,
      fallbackReason: null,
      dimensionsChanged: true,
      canvas: { width: 1440, height: expect.any(Number) },
      metricsMatch: true,
      buffersEqual: true,
      contiguous: true,
      baselineCursor: 5622,
      currentCursor: 5644,
      glyphKind: 'changed',
      headingKind: 'matched',
      headingHighlights: 0,
      insertion: { kind: 'inserted', currentStart: 1266, length: 112 },
      insertionGreen: true,
      deletionRed: true,
      row1496Kind: 'matched',
      link: { kind: 'matched', baselineStart: 1496, currentStart: 1518, highlights: 0 },
      card: { kind: 'matched', offset: 112 },
      lowerHighlights: 0,
      localGapKind: 'changed'
    });
    // Blank spacer rows are structural, not content: the deletion paints its
    // 23 ink rows and the insertion its 20 ink rows, so the measured change is
    // the content pixels plus the glyph and local-gap residuals, not the full
    // 90 deleted and 112 inserted rows.
    expect(report.differentPixels).toBeGreaterThan(60_000);
    expect(report.differentPixels).toBeLessThan(100_000);
    expect(report.totalPixels).toBe(report.canvas.width * report.canvas.height);
    expect(report.outputCursor).toBe(report.canvas.height);
    expect(report.orangeGlyph).toBeGreaterThanOrEqual(6);
    expect(report.deletion.kind).toBe('deleted');
    // The annotated ink starts at y=1420. The rendered deletion starts at 1406:
    // three card-tail rows are trimmed so they do not overlap the lower run,
    // and the blank rows before the ink have no free current partner. Pin both
    // edges so a mapping that deletes the page still fails.
    expect(report.deletion).toMatchObject({ baselineStart: 1406, length: 90 });
    expect(report.deletion.baselineStart + report.deletion.length).toBe(1496);
    expect(report.comparedOffsetsValid).toBe(true);
    expect(report.neighborCompares).toBeGreaterThan(0);
    expect(report.localHighlights).toBeGreaterThan(0);
    expect(report.localGapKind).not.toBe('deleted');
  }, 30_000);

  test('reports each merged content interval with the row-weighted mean cost', async () => {
    const mapped = analyzeOffsetRuns(PNG.sync.read(await readFixture('baseline.png')), PNG.sync.read(await readFixture('current.png')));
    expect(mapped.kind).toBe('mapped');
    if (mapped.kind !== 'mapped') return;

    // Adjacent ±1 runs merge into one interval; pin that the fixture has one
    // so the weighted mean is exercised rather than a single-run average.
    const merged = mapped.contentIntervals.filter((interval) =>
      new Set(mapped.rows.slice(interval.start, interval.end).map((row) => row.offset)).size > 1
    );
    expect(merged.length).toBeGreaterThan(0);
    for (const interval of mapped.contentIntervals) {
      const rows = mapped.rows.slice(interval.start, interval.end);
      const rowMean = rows.reduce((sum, row) => sum + row.cost, 0) / rows.length;
      expect(interval.meanCost).toBeCloseTo(rowMean, 12);
    }
  }, 30_000);

  test('interval highlight and structured counts equal a direct scan of final rows', async () => {
    const baseline = PNG.sync.read(await readFixture('baseline.png'));
    const current = PNG.sync.read(await readFixture('current.png'));
    const mapped = analyzeOffsetRuns(baseline, current);
    expect(mapped.kind).toBe('mapped');
    if (mapped.kind !== 'mapped') return;
    expect(mapped.contentIntervals.length).toBeGreaterThan(0);
    expect(mapped.contentIntervals.some((interval) => interval.highlightRows > 0)).toBe(true);

    // The cache reuse must be invisible in the diagnostic output: recompute
    // `hotRuns` for every final stable row at its own recorded offset. Merged
    // intervals alternate ±1 offsets, so the scan follows each row, not the
    // interval's first offset.
    for (const interval of mapped.contentIntervals) {
      let highlightRows = 0;
      let structuredRows = 0;
      for (let y = interval.start; y < interval.end; y += 1) {
        const row = mapped.rows[y];
        if (row.kind !== 'stable' || row.offset === null) continue;
        const runsAtOffset = hotRuns(baseline, current, row.y, row.offset);
        if (runsAtOffset.noise >= HIGHLIGHT_RUN) highlightRows += 1;
        if (runsAtOffset.structured >= 4) structuredRows += 1;
      }
      expect(interval.highlightRows).toBe(highlightRows);
      expect(interval.structuredRows).toBe(structuredRows);
    }
  }, 30_000);
});

describe('synthetic alignment cases', () => {
  const cases = syntheticAlignmentCases();

  test('builds an insertion, a same-height replacement, noise, a recolor, and a glyph edit', () => {
    expect(PNG.sync.read(cases.pureInsertion.current).height).toBe(PNG.sync.read(cases.pureInsertion.baseline).height + 1);
    expect(PNG.sync.read(cases.equalHeightInsertDelete.current).height).toBe(PNG.sync.read(cases.equalHeightInsertDelete.baseline).height);

    const noise = PNG.sync.read(cases.scatteredNoise.current);
    const noiseBase = PNG.sync.read(cases.scatteredNoise.baseline);
    let noisePixels = 0;
    for (let index = 0; index < noise.data.length; index += 4) {
      const delta = Math.abs(noise.data[index] - noiseBase.data[index]);
      if (delta !== 0) {
        expect(delta).toBe(1);
        noisePixels += 1;
      }
    }
    expect(noisePixels).toBeGreaterThan(0);

    const recolor = PNG.sync.read(cases.contiguousRecolor.current);
    const recolorBase = PNG.sync.read(cases.contiguousRecolor.baseline);
    let recolorRun = 0;
    for (let x = 0; x < recolor.width; x += 1) {
      const delta = Math.abs(recolor.data[(recolor.width + x) * 4] - recolorBase.data[(recolor.width + x) * 4]);
      if (delta === 60) {
        recolorRun += 1;
      }
    }
    expect(recolorRun).toBe(16);

    const glyph = PNG.sync.read(cases.glyphEdit.current);
    const glyphBase = PNG.sync.read(cases.glyphEdit.baseline);
    let glyphRun = 0;
    for (let x = 0; x < glyph.width; x += 1) {
      const delta = Math.abs(glyph.data[(glyph.width + x) * 4] - glyphBase.data[(glyph.width + x) * 4]);
      if (delta === 140) {
        glyphRun += 1;
      }
    }
    expect(glyphRun).toBe(6);
  });

  test('offset highlighting keeps scattered noise clean and marks a glyph or recolor', () => {
    const options = {
      renderDiffImage: false,
      changedColor: /** @type {const} */ ([255, 140, 0, 255]),
      addedColor: /** @type {const} */ ([0, 170, 0, 255]),
      removedColor: /** @type {const} */ ([255, 0, 0, 255]),
      maxPixels: 32 * 1024 * 1024
    };
    const noise = compareOffsetAligned(PNG.sync.read(cases.scatteredNoise.baseline), PNG.sync.read(cases.scatteredNoise.current), options);
    const glyph = compareOffsetAligned(PNG.sync.read(cases.glyphEdit.baseline), PNG.sync.read(cases.glyphEdit.current), options);
    const recolor = compareOffsetAligned(PNG.sync.read(cases.contiguousRecolor.baseline), PNG.sync.read(cases.contiguousRecolor.current), options);
    const insertion = compareImages(cases.pureInsertion.baseline, cases.pureInsertion.current, { alignment: 'vertical', renderDiffImage: false });

    expect(noise.kind).toBe('aligned');
    expect(glyph.kind).toBe('aligned');
    expect(recolor.kind).toBe('aligned');
    if (noise.kind === 'aligned') expect(noise.result.differentPixels).toBe(0);
    if (glyph.kind === 'aligned') expect(glyph.result.differentPixels).toBe(6);
    if (recolor.kind === 'aligned') expect(recolor.result.differentPixels).toBe(16);
    expect(insertion.comparison).toMatchObject({
      mode: 'vertical-aligned',
      rowMapping: [
        { kind: 'matched', length: 1 },
        { kind: 'inserted', length: 1 },
        { kind: 'matched', length: 2 }
      ]
    });
    expect(insertion.differentPixels).toBe(32);
  });

  test('offset highlighting counts an opacity change and keeps a small alpha delta matched', () => {
    const options = {
      renderDiffImage: false,
      changedColor: /** @type {const} */ ([255, 140, 0, 255]),
      addedColor: /** @type {const} */ ([0, 170, 0, 255]),
      removedColor: /** @type {const} */ ([255, 0, 0, 255]),
      maxPixels: 32 * 1024 * 1024
    };
    const width = 32;
    const height = 4;
    const baseline = new PNG({ width, height });
    const faded = new PNG({ width, height });
    const slight = new PNG({ width, height });
    for (let index = 0; index < baseline.data.length; index += 4) {
      baseline.data[index] = 80;
      baseline.data[index + 1] = 80;
      baseline.data[index + 2] = 80;
      baseline.data[index + 3] = 255;
      faded.data.set(baseline.data.subarray(index, index + 3), index);
      faded.data[index + 3] = 0;
      slight.data.set(baseline.data.subarray(index, index + 3), index);
      slight.data[index + 3] = 240;
    }

    const opaque = compareOffsetAligned(baseline, faded, options);
    const quiet = compareOffsetAligned(baseline, slight, options);
    expect(opaque).toEqual({ kind: 'fallback', reason: 'alignment-limit' });
    const counted = compareImages(PNG.sync.write(baseline), PNG.sync.write(faded), {
      alignment: 'vertical',
      renderDiffImage: false
    });
    expect(counted.differentPixels).toBe(width * height);
    expect(quiet.kind).toBe('aligned');
    if (quiet.kind === 'aligned') expect(quiet.result.differentPixels).toBe(0);
  });

  test('refuses the offset search when the score matrices would exceed their byte budget', () => {
    const offsetCount = OFFSET_MAX - OFFSET_MIN + 1;
    const millionRowBytes = 1_000_000 * offsetCount * 8 + 1_000_000 * (offsetCount + 1) * 2;
    expect(millionRowBytes).toBeGreaterThan(MAX_OFFSET_MATRIX_BYTES);

    const bytesPerRow = offsetCount * 8 + (offsetCount + 1) * 2;
    const height = Math.floor(MAX_OFFSET_MATRIX_BYTES / bytesPerRow) + 1;
    const width = 32;
    const data = new Uint8Array(height * width * 4);
    for (let index = 0; index < data.length; index += 4) {
      data[index] = 80;
      data[index + 1] = 80;
      data[index + 2] = 80;
      data[index + 3] = 255;
    }
    const image = { data, width, height };
    expect(analyzeOffsetRuns(image, image)).toEqual({ kind: 'fallback', reason: 'alignment-limit' });
  });

  test('fully transparent pixels do not fund an offset match', () => {
    const width = 32;
    const height = 8;
    const baseline = new PNG({ width, height });
    const current = new PNG({ width, height });
    for (let index = 0; index < baseline.data.length; index += 4) {
      baseline.data[index] = 220;
      baseline.data[index + 1] = 220;
      baseline.data[index + 2] = 220;
      baseline.data[index + 3] = 0;
      current.data.set(baseline.data.subarray(index, index + 4), index);
    }
    expect(analyzeOffsetRuns(baseline, current).kind === 'mapped' && analyzeOffsetRuns(baseline, current).rows?.some((row) => row.kind === 'stable' && !row.abstain)).toBe(false);
  });

  test('rejects a dissimilar page from the sampled offset search', () => {
    const width = 32;
    const height = 64;
    const baseline = new PNG({ width, height });
    const current = new PNG({ width, height });
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4;
        baseline.data[index] = 80;
        baseline.data[index + 1] = 80;
        baseline.data[index + 2] = 90;
        baseline.data[index + 3] = 255;
        current.data[index] = 200;
        current.data[index + 1] = 40;
        current.data[index + 2] = 40;
        current.data[index + 3] = 255;
      }
    }
    expect(analyzeOffsetRuns(baseline, current)).toEqual({ kind: 'fallback', reason: 'alignment-limit' });
  });

  test('an offset canvas past maxPixels falls back instead of throwing', () => {
    const width = 32;
    const height = 40;
    const baseline = new PNG({ width, height });
    const current = new PNG({ width, height });
    for (let index = 0; index < baseline.data.length; index += 4) {
      baseline.data[index] = 80;
      baseline.data[index + 1] = 80;
      baseline.data[index + 2] = 80;
      baseline.data[index + 3] = 255;
      current.data.set(baseline.data.subarray(index, index + 4), index);
    }
    const options = {
      renderDiffImage: false,
      changedColor: /** @type {const} */ ([255, 140, 0, 255]),
      addedColor: /** @type {const} */ ([0, 170, 0, 255]),
      removedColor: /** @type {const} */ ([255, 0, 0, 255]),
      maxPixels: 10
    };
    expect(compareOffsetAligned(baseline, current, options)).toEqual({ kind: 'fallback', reason: 'alignment-limit' });
  });

  test('compareImages keeps a coordinate result when the offset canvas exceeds maxPixels', () => {
    const width = 32;
    const content = 1000;
    const deleted = 200;
    const inserted = 80;
    const baselineHeight = content + deleted;
    const currentHeight = inserted + content;
    const baseline = new PNG({ width, height: baselineHeight });
    const current = new PNG({ width, height: currentHeight });
    const paint = (png, y, value, alpha = 255) => {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4;
        png.data[index] = value;
        png.data[index + 1] = value;
        png.data[index + 2] = value;
        png.data[index + 3] = alpha;
      }
    };
    for (let y = 0; y < content; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const value = (y & (1 << (x % 16))) !== 0 ? 180 : 60;
        const baselineIndex = (y * width + x) * 4;
        baseline.data[baselineIndex] = value;
        baseline.data[baselineIndex + 1] = value;
        baseline.data[baselineIndex + 2] = value;
        baseline.data[baselineIndex + 3] = 255;
        const currentIndex = ((y + inserted) * width + x) * 4;
        current.data[currentIndex] = value;
        current.data[currentIndex + 1] = value;
        current.data[currentIndex + 2] = value;
        current.data[currentIndex + 3] = x === 0 ? 254 : 255;
      }
    }
    for (let y = content; y < baselineHeight; y += 1) paint(baseline, y, 255);
    for (let y = 0; y < inserted; y += 1) paint(current, y, 30);

    const unionPixels = width * baselineHeight;
    const offsetPixels = width * (inserted + content + deleted);
    expect(offsetPixels).toBeGreaterThan(unionPixels);
    const shared = { alignment: /** @type {const} */ ('vertical'), renderDiffImage: false };
    const fallenBack = compareImages(PNG.sync.write(baseline), PNG.sync.write(current), {
      ...shared,
      maxPixels: unionPixels + width
    });
    expect(fallenBack.comparison).toMatchObject({
      mode: 'coordinate-fallback',
      fallbackReason: 'alignment-limit'
    });
    const aligned = compareImages(PNG.sync.write(baseline), PNG.sync.write(current), {
      ...shared,
      maxPixels: offsetPixels
    });
    expect(aligned.comparison.mode).toBe('vertical-aligned');
  }, 60_000);

  test('leaves an equal-height row replacement on the exact alignment path', () => {
    const options = {
      renderDiffImage: false,
      changedColor: /** @type {const} */ ([255, 140, 0, 255]),
      addedColor: /** @type {const} */ ([0, 170, 0, 255]),
      removedColor: /** @type {const} */ ([255, 0, 0, 255]),
      maxPixels: 32 * 1024 * 1024
    };
    const offset = compareOffsetAligned(
      PNG.sync.read(cases.equalHeightInsertDelete.baseline),
      PNG.sync.read(cases.equalHeightInsertDelete.current),
      options
    );
    expect(offset).toEqual({ kind: 'fallback', reason: 'alignment-limit' });
    const exact = compareImages(cases.equalHeightInsertDelete.baseline, cases.equalHeightInsertDelete.current, {
      alignment: 'vertical',
      renderDiffImage: false
    });
    expect(exact.comparison.mode).toBe('vertical-aligned');
    expect(exact.comparison.fallbackReason).toBeUndefined();
  });

  test('does not invent an offset for repeated text, gradients, whitespace, or several insertions', () => {
    const options = {
      renderDiffImage: false,
      changedColor: /** @type {const} */ ([255, 140, 0, 255]),
      addedColor: /** @type {const} */ ([0, 170, 0, 255]),
      removedColor: /** @type {const} */ ([255, 0, 0, 255]),
      maxPixels: 32 * 1024 * 1024
    };
    /**
     * @param {{ kind: string, result?: { comparison: { rowMapping?: Array<{ kind: string, baselineStart?: number, currentStart?: number }> } } }} result
     * @returns {number[]}
     */
    function pairedOffsets(result) {
      if (result.kind !== 'aligned' || !result.result) return [];
      return (result.result.comparison.rowMapping ?? [])
        .filter((segment) => segment.baselineStart !== undefined && segment.currentStart !== undefined)
        .map((segment) => /** @type {number} */ (segment.currentStart) - /** @type {number} */ (segment.baselineStart));
    }

    const repeated = compareOffsetAligned(
      PNG.sync.read(cases.repeatedText.baseline),
      PNG.sync.read(cases.repeatedText.current),
      options
    );
    expect(pairedOffsets(repeated).every((offset) => offset === 0 || offset === 1)).toBe(true);

    const gradient = compareOffsetAligned(
      PNG.sync.read(cases.gradient.baseline),
      PNG.sync.read(cases.gradient.current),
      options
    );
    expect(gradient.kind).toBe('aligned');
    const gradientOffsets = pairedOffsets(gradient);
    expect(gradientOffsets.every((offset) => offset === 0 || offset === 1)).toBe(true);
    expect(gradientOffsets.at(-1)).toBe(1);
    expect(compareImages(cases.gradient.baseline, cases.gradient.current, {
      alignment: 'vertical',
      renderDiffImage: false
    }).comparison.rowMapping?.filter((segment) => segment.kind === 'inserted')).toHaveLength(1);

    expect(compareOffsetAligned(
      PNG.sync.read(cases.whitespace.baseline),
      PNG.sync.read(cases.whitespace.current),
      options
    )).toEqual({ kind: 'fallback', reason: 'alignment-limit' });
    expect(compareImages(cases.whitespace.baseline, cases.whitespace.current, {
      alignment: 'vertical',
      renderDiffImage: false
    }).differentPixels).toBe(0);
    expect(compareImages(cases.whitespaceBand.baseline, cases.whitespaceBand.current, {
      alignment: 'vertical',
      renderDiffImage: false
    }).differentPixels).toBe(0);

    const several = compareImages(cases.multipleInsertions.baseline, cases.multipleInsertions.current, {
      alignment: 'vertical',
      renderDiffImage: false
    });
    expect(several.comparison.rowMapping?.filter((segment) => segment.kind === 'inserted')).toHaveLength(2);
    const shifted = compareOffsetAligned(
      PNG.sync.read(cases.multipleInsertions.baseline),
      PNG.sync.read(cases.multipleInsertions.current),
      options
    );
    expect(pairedOffsets(shifted).every((offset) => offset >= 0 && offset <= 2)).toBe(true);
  });

  test('a compensating band of duplicate fill rows is structural, not inserted or deleted content', () => {
    const options = {
      renderDiffImage: true,
      changedColor: /** @type {const} */ ([255, 140, 0, 255]),
      addedColor: /** @type {const} */ ([0, 170, 0, 255]),
      removedColor: /** @type {const} */ ([255, 0, 0, 255]),
      maxPixels: 32 * 1024 * 1024
    };
    const baseline = PNG.sync.read(cases.structuralDuplicateBand.baseline);
    const current = PNG.sync.read(cases.structuralDuplicateBand.current);
    const aligned = compareOffsetAligned(baseline, current, options);
    expect(aligned.kind).toBe('aligned');
    if (aligned.kind !== 'aligned') return;

    // Identical text rows shift by three, so only the compensating fill bands
    // are one-sided. They duplicate rows the plan already claims, so nothing is
    // painted: the band is a rendering duplicate, not a new or deleted line.
    expect(aligned.result.differentPixels).toBe(0);
    const mapping = aligned.result.comparison.rowMapping ?? [];
    expect(mapping.filter((segment) => segment.kind === 'inserted').map((segment) => segment.length)).toEqual([3, 3]);
    expect(mapping.filter((segment) => segment.kind === 'deleted').map((segment) => segment.length)).toEqual([2]);
    expect(mapping.some((segment) => segment.kind === 'changed')).toBe(false);

    const diff = PNG.sync.read(/** @type {Buffer} */ (aligned.result.diffImageBuffer));
    let added = 0;
    let removed = 0;
    let changed = 0;
    for (let index = 0; index < diff.data.length; index += 4) {
      const pixel = [diff.data[index], diff.data[index + 1], diff.data[index + 2]];
      if (pixel[0] === options.addedColor[0] && pixel[1] === options.addedColor[1] && pixel[2] === options.addedColor[2]) added += 1;
      else if (pixel[0] === options.removedColor[0] && pixel[1] === options.removedColor[1] && pixel[2] === options.removedColor[2]) removed += 1;
      else if (pixel[0] === options.changedColor[0] && pixel[1] === options.changedColor[1] && pixel[2] === options.changedColor[2]) changed += 1;
    }
    expect({ added, removed, changed }).toEqual({ added: 0, removed: 0, changed: 0 });
  });

  test('one-sided duplicate evidence is content, not displacement', () => {
    const options = {
      renderDiffImage: true,
      changedColor: /** @type {const} */ ([255, 140, 0, 255]),
      addedColor: /** @type {const} */ ([0, 170, 0, 255]),
      removedColor: /** @type {const} */ ([255, 0, 0, 255]),
      maxPixels: 32 * 1024 * 1024
    };
    const baseline = PNG.sync.read(cases.localizedDisplacement.baseline);
    const current = PNG.sync.read(cases.localizedDisplacement.current);
    const aligned = compareOffsetAligned(baseline, current, options);
    expect(aligned.kind).toBe('aligned');
    if (aligned.kind !== 'aligned') return;

    // Four mismatched pixels in row 3 equal a claimed current row one offset
    // away (foreground evidence), but the old baseline pixels they replace do
    // not exist anywhere in a claimed current row. Without background evidence
    // the mark is new content: fewer than CONTENT_INK_MIN pixels cannot excuse
    // a suppression, so the row paints four orange pixels.
    expect(aligned.result.differentPixels).toBe(4);
    const mapping = aligned.result.comparison.rowMapping ?? [];
    expect(mapping.map((segment) => segment.kind)).toEqual(['matched', 'changed', 'matched']);
    expect(mapping.map((segment) => segment.length)).toEqual([3, 1, 2]);
    const diff = PNG.sync.read(/** @type {Buffer} */ (aligned.result.diffImageBuffer));
    let changed = 0;
    for (let index = 0; index < diff.data.length; index += 4) {
      if (diff.data[index] === options.changedColor[0] && diff.data[index + 1] === options.changedColor[1] && diff.data[index + 2] === options.changedColor[2]) changed += 1;
    }
    expect(changed).toBe(4);
  });

  test('a one-sided mismatched run bordering unexplained content stays painted with that content', () => {
    const options = {
      renderDiffImage: false,
      changedColor: /** @type {const} */ ([255, 140, 0, 255]),
      addedColor: /** @type {const} */ ([0, 170, 0, 255]),
      removedColor: /** @type {const} */ ([255, 0, 0, 255]),
      maxPixels: 32 * 1024 * 1024
    };
    const baseline = PNG.sync.read(cases.localizedDisplacementBordered.baseline);
    const current = PNG.sync.read(cases.localizedDisplacementBordered.current);
    const aligned = compareOffsetAligned(baseline, current, options);
    expect(aligned.kind).toBe('aligned');
    if (aligned.kind !== 'aligned') return;

    // Row 3's four displaced pixels border row 4, whose three mismatches find
    // no claimed duplicate anywhere within the window. A suppression there
    // would drop part of a real edit, so both rows paint: 4 + 3 pixels.
    expect(aligned.result.differentPixels).toBe(7);
  });

  test('sixteen one-sided duplicates on one row are a structured recolor, not displacement', () => {
    const options = {
      renderDiffImage: false,
      changedColor: /** @type {const} */ ([255, 140, 0, 255]),
      addedColor: /** @type {const} */ ([0, 170, 0, 255]),
      removedColor: /** @type {const} */ ([255, 0, 0, 255]),
      maxPixels: 32 * 1024 * 1024
    };
    const baseline = PNG.sync.read(cases.localizedDisplacementWide.baseline);
    const current = PNG.sync.read(cases.localizedDisplacementWide.current);
    const aligned = compareOffsetAligned(baseline, current, options);
    expect(aligned.kind).toBe('aligned');
    if (aligned.kind !== 'aligned') return;

    // Sixteen pixels all duplicate a claimed row at the same offset, but the
    // count reaches CONTENT_INK_MIN, so the row is a glyph or region recolor.
    // Displacement suppression must not swallow structured edits.
    expect(aligned.result.differentPixels).toBe(16);
  });

  test('a displacement whose mismatches carry both background and foreground evidence stays matched', () => {
    const options = {
      renderDiffImage: false,
      changedColor: /** @type {const} */ ([255, 140, 0, 255]),
      addedColor: /** @type {const} */ ([0, 170, 0, 255]),
      removedColor: /** @type {const} */ ([255, 0, 0, 255]),
      maxPixels: 32 * 1024 * 1024
    };
    const baseline = PNG.sync.read(cases.displacementBothSides.baseline);
    const current = PNG.sync.read(cases.displacementBothSides.current);
    const aligned = compareOffsetAligned(baseline, current, options);
    expect(aligned.kind).toBe('aligned');
    if (aligned.kind !== 'aligned') return;

    // The glyph marker moved one row down: row 3 and row 4 each have four
    // mismatched pixels. Every mismatch has both a claimed current-side
    // background copy and a claimed baseline-side foreground copy at the same
    // ±1 offset, and the two-row run borders matched rows, so both rows are
    // rendering displacement and the pair reports no differences.
    expect(aligned.result.differentPixels).toBe(0);
    const mapping = aligned.result.comparison.rowMapping ?? [];
    expect(mapping.map((segment) => segment.kind)).toEqual(['matched']);
    expect(mapping.map((segment) => segment.length)).toEqual([6]);
  });

  test('a both-sided displacement run bordering unexplained content stays painted with that content', () => {
    const options = {
      renderDiffImage: false,
      changedColor: /** @type {const} */ ([255, 140, 0, 255]),
      addedColor: /** @type {const} */ ([0, 170, 0, 255]),
      removedColor: /** @type {const} */ ([255, 0, 0, 255]),
      maxPixels: 32 * 1024 * 1024
    };
    const baseline = PNG.sync.read(cases.displacementBordered.baseline);
    const current = PNG.sync.read(cases.displacementBordered.current);
    const aligned = compareOffsetAligned(baseline, current, options);
    expect(aligned.kind).toBe('aligned');
    if (aligned.kind !== 'aligned') return;

    // The two displaced rows have full evidence (4 + 4 pixels), but row 5's
    // three unexplained mismatches border the run. Suppression would drop part
    // of a real edit, so the run paints with it: 8 + 3 pixels.
    expect(aligned.result.differentPixels).toBe(11);
    const mapping = aligned.result.comparison.rowMapping ?? [];
    expect(mapping.map((segment) => segment.kind)).toEqual(['matched', 'changed']);
    expect(mapping.map((segment) => segment.length)).toEqual([3, 3]);
  });

  test('a both-sided 16-pixel displacement is a structured recolor, not displacement', () => {
    const options = {
      renderDiffImage: false,
      changedColor: /** @type {const} */ ([255, 140, 0, 255]),
      addedColor: /** @type {const} */ ([0, 170, 0, 255]),
      removedColor: /** @type {const} */ ([255, 0, 0, 255]),
      maxPixels: 32 * 1024 * 1024
    };
    const baseline = PNG.sync.read(cases.displacementWide.baseline);
    const current = PNG.sync.read(cases.displacementWide.current);
    const aligned = compareOffsetAligned(baseline, current, options);
    expect(aligned.kind).toBe('aligned');
    if (aligned.kind !== 'aligned') return;

    // The wide glyph marker moved one row down and carries both evidence on
    // each row. Each row's mismatch count reaches CONTENT_INK_MIN (16), so both
    // rows are structured recolors and paint: 16 + 16 pixels.
    expect(aligned.result.differentPixels).toBe(32);
    const mapping = aligned.result.comparison.rowMapping ?? [];
    expect(mapping.map((segment) => segment.kind)).toEqual(['matched', 'changed', 'matched']);
    expect(mapping.map((segment) => segment.length)).toEqual([3, 2, 1]);
  });

  test('a new small mark on a uniform background stays painted because its foreground has no baseline copy', () => {
    const options = {
      renderDiffImage: true,
      changedColor: /** @type {const} */ ([255, 140, 0, 255]),
      addedColor: /** @type {const} */ ([0, 170, 0, 255]),
      removedColor: /** @type {const} */ ([255, 0, 0, 255]),
      maxPixels: 32 * 1024 * 1024
    };
    const baseline = PNG.sync.read(cases.smallMarkUniformBackground.baseline);
    const current = PNG.sync.read(cases.smallMarkUniformBackground.current);
    const aligned = compareOffsetAligned(baseline, current, options);
    expect(aligned.kind).toBe('aligned');
    if (aligned.kind !== 'aligned') return;

    // Six black pixels were added on row 3 of uniform white rows. The old white
    // background exists in claimed current rows one offset away, but the new
    // black foreground exists nowhere in the baseline. A background-only
    // duplicate must not suppress it: six pixels stay orange.
    expect(aligned.result.differentPixels).toBe(6);
    const mapping = aligned.result.comparison.rowMapping ?? [];
    expect(mapping.map((segment) => segment.kind)).toEqual(['matched', 'changed', 'matched']);
    expect(mapping.map((segment) => segment.length)).toEqual([3, 1, 2]);
    const diff = PNG.sync.read(/** @type {Buffer} */ (aligned.result.diffImageBuffer));
    let changed = 0;
    for (let index = 0; index < diff.data.length; index += 4) {
      if (diff.data[index] === options.changedColor[0] && diff.data[index + 1] === options.changedColor[1] && diff.data[index + 2] === options.changedColor[2]) changed += 1;
    }
    expect(changed).toBe(6);
  });
});
