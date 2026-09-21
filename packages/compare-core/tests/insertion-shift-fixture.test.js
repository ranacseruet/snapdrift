import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';
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
  test('preserves the original pair checksums and the pre-fix v2 fallback', async () => {
    const annotation = JSON.parse(await readFixture('annotation.json'));
    const regression = JSON.parse(await readFixture('regression-baseline.json'));
    const baseline = await readFixture('baseline.png');
    const current = await readFixture('current.png');

    expect(createHash('sha256').update(baseline).digest('hex')).toBe(annotation.pair.baseline.sha256);
    expect(createHash('sha256').update(current).digest('hex')).toBe(annotation.pair.current.sha256);

    const result = compareImages(baseline, current, { alignment: 'vertical', renderDiffImage: false });
    expect(result.comparison).toMatchObject({
      policyVersion: regression.comparison.policyVersion,
      mode: regression.comparison.mode,
      fallbackReason: regression.comparison.fallbackReason
    });
    expect(result.differentPixels).toBe(regression.comparison.differentPixels);
    expect(result.totalPixels).toBe(regression.comparison.totalPixels);
  });
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
});
