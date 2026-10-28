import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareImages } from '../src/index.mjs';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/structural-row-insertion');

/**
 * @param {string} name
 * @returns {Promise<Buffer>}
 */
function readFixture(name) {
  return fs.readFile(path.join(fixtureDir, name));
}

describe('structural-row-insertion fixture', () => {
  test('preserves the pair checksums and the recorded pre-fix fallback', async () => {
    const recorded = JSON.parse(await readFixture('regression-baseline.json'));

    expect(createHash('sha256').update(await readFixture('baseline.png')).digest('hex')).toBe(recorded.pair.baseline.sha256);
    expect(createHash('sha256').update(await readFixture('current.png')).digest('hex')).toBe(recorded.pair.current.sha256);
    expect(recorded.preFix.comparison).toMatchObject({
      mode: 'coordinate-fallback',
      fallbackReason: 'ambiguous',
      differentPixels: 527929
    });
  });

  test('aligns the shifted page instead of falling back on repeated card padding', async () => {
    const result = compareImages(await readFixture('baseline.png'), await readFixture('current.png'), {
      alignment: 'vertical',
      renderDiffImage: false
    });
    const kinds = (/** @type {string} */ kind) =>
      result.comparison.rowMapping.filter((segment) => segment.kind === kind).map(({ outputStart, length }) => ({ outputStart, length }));

    expect(result.comparison).toMatchObject({
      policyVersion: 2,
      mode: 'vertical-aligned',
      canvas: { width: 1440, height: 3390 }
    });
    expect(result.comparison.fallbackReason).toBeUndefined();
    expect(result.differentPixels).toBe(69928);
    expect(result.totalPixels).toBe(1440 * 3390);
    // The Tools count (3 to 4) is a changed row group at the top of the page.
    expect(kinds('changed')).toContainEqual({ outputStart: 1058, length: 11 });
    // The new Security card line is 14 text rows plus 8 rows of card padding.
    expect(kinds('inserted')).toEqual(expect.arrayContaining([
      { outputStart: 1938, length: 14 },
      { outputStart: 1962, length: 8 }
    ]));
  });
});
