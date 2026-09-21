// @ts-check
/**
 * Synthetic pairs for the issue #178 alignment gates.
 * Each case is a few rows wide so a gate can run without the real screenshot pair.
 */

import pngjs from 'pngjs';

const { PNG } = pngjs;

/**
 * @param {number} width
 * @param {number[][]} rows grayscale value per pixel, one array per row
 * @returns {Buffer}
 */
function pngFromRows(width, rows) {
  const png = new PNG({ width, height: rows.length });
  rows.forEach((row, y) => {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const value = row[x] ?? row[0];
      png.data[index] = value;
      png.data[index + 1] = value;
      png.data[index + 2] = value;
      png.data[index + 3] = 255;
    }
  });
  return PNG.sync.write(png);
}

/**
 * @param {number} width
 * @param {number} value
 * @returns {number[]}
 */
function fill(width, value) {
  return Array.from({ length: width }, () => value);
}

const WIDTH = 32;

/**
 * @returns {Record<string, { baseline: Buffer, current: Buffer, note: string }>}
 */
export function syntheticAlignmentCases() {
  const rowA = fill(WIDTH, 20);
  const rowB = fill(WIDTH, 80);
  const rowC = fill(WIDTH, 140);
  const rowInserted = fill(WIDTH, 200);
  const noisy = fill(WIDTH, 20);
  for (let x = 0; x < WIDTH; x += 3) {
    noisy[x] = 21;
  }
  const recolor = fill(WIDTH, 80);
  for (let x = 8; x < 24; x += 1) {
    recolor[x] = 140;
  }
  const glyph = fill(WIDTH, 80);
  for (let x = 12; x < 18; x += 1) {
    glyph[x] = 220;
  }

  return {
    pureInsertion: {
      baseline: pngFromRows(WIDTH, [rowA, rowB, rowC]),
      current: pngFromRows(WIDTH, [rowA, rowInserted, rowB, rowC]),
      note: 'One inserted row between identical neighbors.'
    },
    equalHeightInsertDelete: {
      baseline: pngFromRows(WIDTH, [rowA, rowB, rowC]),
      current: pngFromRows(WIDTH, [rowA, rowC, rowInserted]),
      note: 'The middle row is replaced by a different row and the last row moves up, so the images stay the same height.'
    },
    scatteredNoise: {
      baseline: pngFromRows(WIDTH, [rowA, rowB]),
      current: pngFromRows(WIDTH, [noisy, rowB]),
      note: 'Every third pixel of the first row moves by 1. No contiguous edit.'
    },
    contiguousRecolor: {
      baseline: pngFromRows(WIDTH, [rowA, rowB, rowC]),
      current: pngFromRows(WIDTH, [rowA, recolor, rowC]),
      note: 'Sixteen contiguous pixels in the middle row jump by 60.'
    },
    glyphEdit: {
      baseline: pngFromRows(WIDTH, [rowA, rowB, rowC]),
      current: pngFromRows(WIDTH, [rowA, glyph, rowC]),
      note: 'Six contiguous pixels in the middle row jump by 140, a stand-in for a changed glyph.'
    }
  };
}
