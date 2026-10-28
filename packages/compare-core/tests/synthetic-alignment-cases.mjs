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
  // Six distinct text rows. The marker sits on every sampled column so an
  // offset search cannot pair two text rows by skipping the one pixel that
  // differs: only the row's own copy at the true offset scores zero.
  const textRows = Array.from({ length: 6 }, (_, index) => {
    const row = fill(WIDTH, 60);
    for (let x = 4; x < WIDTH; x += 2) {
      row[x] = 220 - index * 20;
    }
    return row;
  });
  // Six distinct gray rows. A handful of pixels inside one row are repainted
  // with the value of a claimed row one offset away: a localized rendering
  // displacement, not a content edit, because every mismatched pixel finds its
  // duplicate in the same claimed row.
  const grayRows = [10, 20, 60, 100, 120, 140].map((value) => fill(WIDTH, value));
  const displacedRows = grayRows.map((row) => [...row]);
  for (let x = 8; x < 12; x += 1) {
    displacedRows[3][x] = 60;
  }
  const wideDisplacedRows = grayRows.map((row) => [...row]);
  for (let x = 8; x < 24; x += 1) {
    wideDisplacedRows[3][x] = 60;
  }
  // The same displacement plus an unexplained edit on the neighbor row. The
  // displaced run borders content that the plan cannot explain, so it is part
  // of that edit and must stay painted.
  const borderedRows = displacedRows.map((row) => [...row]);
  for (let x = 0; x < 3; x += 1) {
    borderedRows[4][x] = 25;
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
    },
    repeatedText: {
      baseline: pngFromRows(WIDTH, [rowB, rowB, rowB, rowB, rowC]),
      current: pngFromRows(WIDTH, [rowB, rowB, rowB, rowB, rowB, rowC]),
      note: 'Identical ink rows with one extra copy. A confident offset outside 0 or 1 is the wrong copy.'
    },
    gradient: {
      baseline: pngFromRows(WIDTH, [40, 55, 70, 85, 100, 115].map((value) => fill(WIDTH, value))),
      current: pngFromRows(WIDTH, [40, 200, 55, 70, 85, 100, 115].map((value) => fill(WIDTH, value))),
      note: 'Each row is a distinct gray. One inserted row shifts the rest by exactly one.'
    },
    whitespace: {
      baseline: pngFromRows(WIDTH, [0, 0, 0, 0].map((value) => fill(WIDTH, value))),
      current: pngFromRows(WIDTH, [0, 0, 0, 0].map((value) => fill(WIDTH, value))),
      note: 'A blank band has no ink, so it cannot fund an offset.'
    },
    whitespaceBand: {
      baseline: pngFromRows(WIDTH, [rowB, rowA, rowA, rowA, rowC]),
      current: pngFromRows(WIDTH, [rowB, rowA, rowA, rowA, rowC]),
      note: 'Blank rows between two ink rows. The band must not move the neighbors.'
    },
    multipleInsertions: {
      baseline: pngFromRows(WIDTH, [40, 70, 100, 130, 160].map((value) => fill(WIDTH, value))),
      current: pngFromRows(WIDTH, [40, 200, 70, 100, 220, 130, 160].map((value) => fill(WIDTH, value))),
      note: 'Two inserted rows between distinct neighbors.'
    },
    localizedDisplacement: {
      baseline: pngFromRows(WIDTH, grayRows),
      current: pngFromRows(WIDTH, displacedRows),
      note: 'Four pixels inside a paired row duplicate a claimed row one offset away, so the row is rendering displacement.'
    },
    localizedDisplacementBordered: {
      baseline: pngFromRows(WIDTH, grayRows),
      current: pngFromRows(WIDTH, borderedRows),
      note: 'The same displacement next to unexplained content; the run borders a real edit and must stay painted.'
    },
    localizedDisplacementWide: {
      baseline: pngFromRows(WIDTH, grayRows),
      current: pngFromRows(WIDTH, wideDisplacedRows),
      note: 'Sixteen pixels duplicate a claimed row one offset away; that is a structured recolor, not an edge displacement.'
    },
    structuralDuplicateBand: {
      baseline: pngFromRows(WIDTH, [
        fill(WIDTH, 10), fill(WIDTH, 10),
        fill(WIDTH, 120), fill(WIDTH, 150), fill(WIDTH, 180),
        ...textRows,
        fill(WIDTH, 180), fill(WIDTH, 180), fill(WIDTH, 180),
        fill(WIDTH, 150), fill(WIDTH, 120), fill(WIDTH, 90), fill(WIDTH, 60),
        fill(WIDTH, 10), fill(WIDTH, 10)
      ]),
      current: pngFromRows(WIDTH, [
        fill(WIDTH, 10), fill(WIDTH, 10),
        fill(WIDTH, 120), fill(WIDTH, 150), fill(WIDTH, 180),
        fill(WIDTH, 180), fill(WIDTH, 180), fill(WIDTH, 180),
        ...textRows,
        fill(WIDTH, 180),
        fill(WIDTH, 150), fill(WIDTH, 120), fill(WIDTH, 90), fill(WIDTH, 60),
        fill(WIDTH, 10), fill(WIDTH, 10),
        fill(WIDTH, 10), fill(WIDTH, 10), fill(WIDTH, 10)
      ]),
      note: 'Three near-duplicate fill rows compensate at the top and bottom of a block while identical text rows shift by three; none of them are content.'
    }
  };
}
