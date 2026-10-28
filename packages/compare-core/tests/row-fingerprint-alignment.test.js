// @ts-check
import { alignRows } from '../src/vertical-align.mjs';

/**
 * Fill every pixel of each row with the same RGBA color. Rows with distinct
 * colors therefore have distinct bytes and distinct fingerprints.
 *
 * @param {number} width
 * @param {number[]} rowValues grayscale value per row, one entry per row
 * @returns {{ data: Uint8Array, width: number, height: number }}
 */
function rowImage(width, rowValues) {
  const data = new Uint8Array(width * rowValues.length * 4);
  rowValues.forEach((value, y) => {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      data[index] = value;
      data[index + 1] = value;
      data[index + 2] = value;
      data[index + 3] = 255;
    }
  });
  return { data, width, height: rowValues.length };
}

/**
 * Place the same bytes at a byte offset that is not 4-aligned, so the
 * fingerprint loop cannot build a Uint32Array word view and takes its byte
 * fallback. Fingerprints must still equal the word-view fingerprints of the
 * same rows in another image.
 *
 * @param {{ data: Uint8Array, width: number, height: number }} image
 * @returns {{ data: Uint8Array, width: number, height: number }}
 */
function misalignedCopy(image) {
  const backing = new Uint8Array(image.data.byteLength + 2);
  backing.set(image.data, 2);
  return {
    data: backing.subarray(2, 2 + image.data.byteLength),
    width: image.width,
    height: image.height
  };
}

/**
 * A tall synthetic page whose every row has a unique byte pattern.
 *
 * @param {number} width
 * @param {number} height
 * @returns {{ data: Uint8Array, width: number, height: number }}
 */
function tallUniqueRows(width, height) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const red = y & 255;
    const green = (y >> 8) & 255;
    const blue = (y * 7) & 255;
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      data[index] = red;
      data[index + 1] = green;
      data[index + 2] = blue;
      data[index + 3] = 255;
    }
  }
  return { data, width, height };
}

describe('@snapdrift/compare-core — row fingerprint alignment', () => {
  test('matches byte-identical rows across an insertion and marks a changed row', () => {
    const width = 32;
    const baseline = rowImage(width, [20, 80, 140]);
    const inserted = rowImage(width, [20, 200, 80, 140]);
    const changed = rowImage(width, [20, 220, 140]);

    expect(alignRows(baseline, inserted)).toEqual({
      kind: 'aligned',
      height: 4,
      segments: [
        { outputStart: 0, length: 1, kind: 'matched', baselineStart: 0, currentStart: 0 },
        { outputStart: 1, length: 1, kind: 'inserted', currentStart: 1 },
        { outputStart: 2, length: 2, kind: 'matched', baselineStart: 1, currentStart: 2 }
      ]
    });

    expect(alignRows(baseline, changed)).toEqual({
      kind: 'aligned',
      height: 3,
      segments: [
        { outputStart: 0, length: 1, kind: 'matched', baselineStart: 0, currentStart: 0 },
        { outputStart: 1, length: 1, kind: 'changed', baselineStart: 1, currentStart: 1 },
        { outputStart: 2, length: 1, kind: 'matched', baselineStart: 2, currentStart: 2 }
      ]
    });
  });

  test('the same rows fingerprint equally through a word view and the byte fallback', () => {
    const width = 32;
    const alignedRows = rowImage(width, [20, 80, 140, 200]);
    const shiftedRows = misalignedCopy(rowImage(width, [220, 20, 80, 140, 200]));

    const alignment = alignRows(alignedRows, shiftedRows);
    expect(alignment).toEqual({
      kind: 'aligned',
      height: 5,
      segments: [
        { outputStart: 0, length: 1, kind: 'inserted', currentStart: 0 },
        { outputStart: 1, length: 4, kind: 'matched', baselineStart: 0, currentStart: 1 }
      ]
    });
  });

  test('a tall exact pair with one inserted row stays aligned without a fallback', () => {
    const width = 1440;
    const baseline = tallUniqueRows(width, 8000);
    const shiftedData = new Uint8Array(width * 8001 * 4);
    shiftedData.fill(255, 0, width * 4);
    shiftedData.set(baseline.data, width * 4);
    const shifted = { data: shiftedData, width, height: 8001 };

    const alignment = alignRows(baseline, shifted);
    expect(alignment).toEqual({
      kind: 'aligned',
      height: 8001,
      segments: [
        { outputStart: 0, length: 1, kind: 'inserted', currentStart: 0 },
        { outputStart: 1, length: 8000, kind: 'matched', baselineStart: 0, currentStart: 1 }
      ]
    });
    // The inserted row's bytes are unique on the opposite side, so it is not
    // ambiguous; an aligned result also proves no verification-failed fallback.
  }, 30_000);
});
