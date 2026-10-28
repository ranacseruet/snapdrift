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
  test('preserves the pair checksums', async () => {
    const recorded = JSON.parse(await readFixture('regression-baseline.json'));

    expect(createHash('sha256').update(await readFixture('baseline.png')).digest('hex')).toBe(recorded.pair.baseline.sha256);
    expect(createHash('sha256').update(await readFixture('current.png')).digest('hex')).toBe(recorded.pair.current.sha256);
  });

  test('aligns the shifted page instead of falling back on repeated card padding', async () => {
    const result = compareImages(await readFixture('baseline.png'), await readFixture('current.png'), {
      alignment: 'vertical',
      renderDiffImage: false
    });
    expect(result.comparison).toMatchObject({
      policyVersion: 2,
      mode: 'vertical-aligned',
      canvas: { width: 1440 }
    });
    expect(result.comparison.fallbackReason).toBeUndefined();
    // The pre-fix coordinate fallback reported 527,929 different pixels.
    expect(result.differentPixels).toBeLessThan(100_000);
    expect(result.totalPixels).toBe(result.comparison.canvas.width * result.comparison.canvas.height);
    // The new Security card line adds 22 rows (14 text rows plus 8 rows of card
    // padding); the remaining inserted rows are 1px render shifts.
    const insertedRows = result.comparison.rowMapping.filter((segment) => segment.kind === 'inserted' && segment.length > 1);
    expect(insertedRows.reduce((sum, segment) => sum + segment.length, 0)).toBe(22);
  });
});
