import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';
import { compareOffsetAligned } from '../src/compare-images.mjs';
import { compareImages } from '../src/index.mjs';
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
    expect(report.differentPixels).toBeGreaterThan(200_000);
    expect(report.differentPixels).toBeLessThan(500_000);
    expect(report.totalPixels).toBe(report.canvas.width * report.canvas.height);
    expect(report.outputCursor).toBe(report.canvas.height);
    expect(report.orangeGlyph).toBeGreaterThanOrEqual(6);
    expect(report.deletion.kind).toBe('deleted');
    expect(report.deletion.baselineStart).toBeLessThanOrEqual(1420);
    expect(report.deletion.baselineStart + report.deletion.length).toBe(1496);
    expect(report.localHighlights).toBeGreaterThan(0);
    expect(report.localGapKind).not.toBe('deleted');
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
});
