import pngjs from 'pngjs';
import { compareBuffers, compareImages, generateDiffImage, compareWithIgnoreRegions } from '../src/index.mjs';

const { PNG } = pngjs;

/**
 * Create a synthetic PNG buffer filled with a solid RGBA color.
 * @param {number} width
 * @param {number} height
 * @param {[number, number, number, number]} color
 * @returns {Buffer}
 */
function solidPng(width, height, color) {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = color[0];
    png.data[i + 1] = color[1];
    png.data[i + 2] = color[2];
    png.data[i + 3] = color[3];
  }
  return PNG.sync.write(png);
}

/**
 * Create a PNG whose rows have distinct solid grayscale values.
 * @param {number[]} rows
 * @param {number} [width]
 * @returns {Buffer}
 */
function rowPng(rows, width = 4) {
  const png = new PNG({ width, height: rows.length });
  rows.forEach((value, y) => {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      png.data[index] = value;
      png.data[index + 1] = value;
      png.data[index + 2] = value;
      png.data[index + 3] = 255;
    }
  });
  return PNG.sync.write(png);
}

describe('@snapdrift/compare-core — compareBuffers', () => {
  test('returns zero mismatch for identical buffers', () => {
    const buf = solidPng(10, 10, [0, 0, 0, 255]);
    const result = compareBuffers(buf, buf);
    expect(result.differentPixels).toBe(0);
    expect(result.totalPixels).toBe(100);
    expect(result.mismatchRatio).toBe(0);
    expect(result.pct).toBe(0);
    expect(result.pixelsChanged).toBe(0);
  });

  test('returns full mismatch for completely different buffers', () => {
    const baseline = solidPng(10, 10, [0, 0, 0, 255]);
    const current = solidPng(10, 10, [255, 255, 255, 255]);
    const result = compareBuffers(baseline, current);
    expect(result.differentPixels).toBe(100);
    expect(result.totalPixels).toBe(100);
    expect(result.mismatchRatio).toBe(1);
  });

  test('returns partial mismatch when some pixels differ', () => {
    const basePng = new PNG({ width: 2, height: 2 });
    for (let i = 0; i < basePng.data.length; i += 4) {
      basePng.data[i] = 0;
      basePng.data[i + 1] = 0;
      basePng.data[i + 2] = 0;
      basePng.data[i + 3] = 255;
    }
    const baseBuf = PNG.sync.write(basePng);

    // Create current with 1 pixel different
    const currentPng = new PNG({ width: 2, height: 2 });
    for (let i = 0; i < currentPng.data.length; i += 4) {
      currentPng.data[i] = 0;
      currentPng.data[i + 1] = 0;
      currentPng.data[i + 2] = 0;
      currentPng.data[i + 3] = 255;
    }
    // Change pixel at (1,1)
    currentPng.data[12] = 255;
    const currentBuf = PNG.sync.write(currentPng);

    const result = compareBuffers(baseBuf, currentBuf);
    expect(result.differentPixels).toBe(1);
    expect(result.totalPixels).toBe(4);
    expect(result.mismatchRatio).toBe(0.25);
  });

  test('throws on dimension mismatch', () => {
    const small = solidPng(10, 10, [0, 0, 0, 255]);
    const large = solidPng(20, 20, [0, 0, 0, 255]);
    expect(() => compareBuffers(small, large)).toThrow('Dimension mismatch');
  });

  test('returns width and height', () => {
    const buf = solidPng(20, 30, [0, 0, 0, 255]);
    const result = compareBuffers(buf, buf);
    expect(result.width).toBe(20);
    expect(result.height).toBe(30);
  });

  test('returns full-precision mismatchRatio (no rounding)', () => {
    // 1 pixel different out of 7 = 1/7 = 0.142857142857...
    const basePng = new PNG({ width: 7, height: 1 });
    for (let i = 0; i < basePng.data.length; i += 4) {
      basePng.data[i] = 0; basePng.data[i + 1] = 0; basePng.data[i + 2] = 0; basePng.data[i + 3] = 255;
    }
    const currentPng = new PNG({ width: 7, height: 1 });
    for (let i = 0; i < currentPng.data.length; i += 4) {
      currentPng.data[i] = 0; currentPng.data[i + 1] = 0; currentPng.data[i + 2] = 0; currentPng.data[i + 3] = 255;
    }
    // Change pixel at (3,0)
    currentPng.data[12] = 255;
    const baseBuf = PNG.sync.write(basePng);
    const currentBuf = PNG.sync.write(currentPng);
    const result = compareBuffers(baseBuf, currentBuf);
    expect(result.mismatchRatio).toBeCloseTo(1 / 7, 10);
    expect(result.pct).toBe(result.mismatchRatio);
  });
});

describe('@snapdrift/compare-core — generateDiffImage', () => {
  test('produces a valid PNG buffer', () => {
    const baseline = solidPng(10, 10, [0, 0, 0, 255]);
    const current = solidPng(10, 10, [255, 255, 255, 255]);
    const diffBuf = generateDiffImage(baseline, current);
    expect(Buffer.isBuffer(diffBuf)).toBe(true);
    // Should be parseable as PNG
    const diffPng = PNG.sync.read(diffBuf);
    expect(diffPng.width).toBe(10);
    expect(diffPng.height).toBe(10);
  });

  test('highlights changed pixels with default orange color', () => {
    const baseline = solidPng(2, 2, [0, 0, 0, 255]);
    // Create current with 1 different pixel
    const currentPng = new PNG({ width: 2, height: 2 });
    for (let i = 0; i < currentPng.data.length; i += 4) {
      currentPng.data[i] = 0;
      currentPng.data[i + 1] = 0;
      currentPng.data[i + 2] = 0;
      currentPng.data[i + 3] = 255;
    }
    currentPng.data[0] = 255;
    const current = PNG.sync.write(currentPng);

    const diffBuf = generateDiffImage(baseline, current);
    const diffPng = PNG.sync.read(diffBuf);

    // Pixel (0,0) should be orange (changed)
    expect(diffPng.data[0]).toBe(255);    // R
    expect(diffPng.data[1]).toBe(140);    // G
    expect(diffPng.data[2]).toBe(0);      // B
    expect(diffPng.data[3]).toBe(255);    // A

    // Pixel (1,0) should be original (unchanged)
    expect(diffPng.data[4]).toBe(0);    // R
    expect(diffPng.data[5]).toBe(0);    // G
    expect(diffPng.data[6]).toBe(0);    // B
    expect(diffPng.data[7]).toBe(255);  // A
  });

  test('uses custom highlight color', () => {
    const baseline = solidPng(2, 2, [0, 0, 0, 255]);
    const current = solidPng(2, 2, [255, 255, 255, 255]);

    const diffBuf = generateDiffImage(baseline, current, { highlightColor: [0, 255, 0, 128] });
    const diffPng = PNG.sync.read(diffBuf);

    // All pixels changed, should be green with alpha 128
    expect(diffPng.data[0]).toBe(0);    // R
    expect(diffPng.data[1]).toBe(255);  // G
    expect(diffPng.data[2]).toBe(0);    // B
    expect(diffPng.data[3]).toBe(128);  // A
  });

  test('highlights an all-changed image with the default orange color', () => {
    const baseline = solidPng(2, 2, [0, 0, 0, 255]);
    const current = solidPng(2, 2, [255, 255, 255, 255]);

    const diffBuf = generateDiffImage(baseline, current);
    const diffPng = PNG.sync.read(diffBuf);

    expect([...diffPng.data.slice(0, 4)]).toEqual([255, 140, 0, 255]);
  });

  test('keeps unchanged pixels at original color', () => {
    const baseline = solidPng(10, 10, [0, 0, 0, 255]);
    const diffBuf = generateDiffImage(baseline, baseline);
    const diffPng = PNG.sync.read(diffBuf);

    // First pixel unchanged = original color
    expect(diffPng.data[0]).toBe(0);
    expect(diffPng.data[1]).toBe(0);
    expect(diffPng.data[2]).toBe(0);
    expect(diffPng.data[3]).toBe(255);
  });

  test('throws on dimension mismatch', () => {
    const small = solidPng(10, 10, [0, 0, 0, 255]);
    const large = solidPng(20, 20, [0, 0, 0, 255]);
    expect(() => generateDiffImage(small, large)).toThrow('Dimension mismatch');
  });

  test('overlays ignore regions with neutral gray', () => {
    const baseline = solidPng(4, 4, [0, 0, 0, 255]);
    const current = solidPng(4, 4, [255, 255, 255, 255]);

    const diffBuf = generateDiffImage(baseline, current, {
      ignoreRegions: [{ x: 0, y: 0, width: 2, height: 2 }]
    });
    const diffPng = PNG.sync.read(diffBuf);

    // Pixel (0,0) in ignore region → gray overlay
    expect(diffPng.data[0]).toBe(128);
    expect(diffPng.data[1]).toBe(128);
    expect(diffPng.data[2]).toBe(128);
    expect(diffPng.data[3]).toBe(128);

    // Pixel (2,0) outside ignore region → orange highlight (changed)
    expect(diffPng.data[32]).toBe(255);
    expect(diffPng.data[33]).toBe(140);
    expect(diffPng.data[34]).toBe(0);
    expect(diffPng.data[35]).toBe(255);
  });

  test('no ignore regions produces same output as before', () => {
    const baseline = solidPng(4, 4, [0, 0, 0, 255]);
    const current = solidPng(4, 4, [255, 255, 255, 255]);

    const withIgnore = generateDiffImage(baseline, current, { ignoreRegions: [] });
    const withoutIgnore = generateDiffImage(baseline, current);

    expect(withIgnore).toEqual(withoutIgnore);
  });

  test('clamps ignore region to image bounds', () => {
    const baseline = solidPng(4, 4, [0, 0, 0, 255]);
    const current = solidPng(4, 4, [255, 255, 255, 255]);

    const diffBuf = generateDiffImage(baseline, current, {
      ignoreRegions: [{ x: 2, y: 2, width: 10, height: 10 }]
    });
    const diffPng = PNG.sync.read(diffBuf);

    // Pixel (3,3) in clamped region → gray
    const offset = (3 * 4 + 3) * 4;
    expect(diffPng.data[offset]).toBe(128);
    expect(diffPng.data[offset + 3]).toBe(128);

    // Pixel (0,0) outside region → red
    expect(diffPng.data[0]).toBe(255);
    expect(diffPng.data[3]).toBe(255);
  });
});

describe('@snapdrift/compare-core — compareWithIgnoreRegions', () => {
  test('excludes ignore region pixels from totals', () => {
    // 4x4 image, baseline all black, current all white
    // Ignore top-left 2x2 region = 4 pixels excluded
    const baseline = solidPng(4, 4, [0, 0, 0, 255]);
    const current = solidPng(4, 4, [255, 255, 255, 255]);

    const result = compareWithIgnoreRegions(baseline, current, [
      { x: 0, y: 0, width: 2, height: 2 }
    ]);
    expect(result.totalPixels).toBe(12); // 16 - 4
    expect(result.differentPixels).toBe(12);
    expect(result.mismatchRatio).toBe(1);
  });

  test('no ignore regions behaves like compareBuffers', () => {
    const baseline = solidPng(10, 10, [0, 0, 0, 255]);
    const current = solidPng(10, 10, [255, 255, 255, 255]);
    const withIgnore = compareWithIgnoreRegions(baseline, current, []);
    const without = compareBuffers(baseline, current);
    expect(withIgnore.differentPixels).toBe(without.differentPixels);
    expect(withIgnore.totalPixels).toBe(without.totalPixels);
  });

  test('clamps ignore region to image bounds', () => {
    const baseline = solidPng(4, 4, [0, 0, 0, 255]);
    const current = solidPng(4, 4, [255, 255, 255, 255]);

    // Region extends beyond image — should be clamped
    const result = compareWithIgnoreRegions(baseline, current, [
      { x: 2, y: 2, width: 10, height: 10 }
    ]);
    // Only 4 pixels in the clamped 2x2 region at (2,2) are ignored
    expect(result.totalPixels).toBe(12);
    expect(result.differentPixels).toBe(12);
  });

  test('overlapping ignore regions do not double-count', () => {
    const baseline = solidPng(4, 4, [0, 0, 0, 255]);
    const current = solidPng(4, 4, [255, 255, 255, 255]);

    // Two overlapping regions covering the same 2x2 area
    const result = compareWithIgnoreRegions(baseline, current, [
      { x: 0, y: 0, width: 2, height: 2 },
      { x: 0, y: 0, width: 2, height: 2 }
    ]);
    // Overlapping regions don't double-exclude — still 4 pixels ignored
    expect(result.totalPixels).toBe(12);
  });

  test('throws on dimension mismatch', () => {
    const small = solidPng(10, 10, [0, 0, 0, 255]);
    const large = solidPng(20, 20, [0, 0, 0, 255]);
    expect(() => compareWithIgnoreRegions(small, large, [])).toThrow('Dimension mismatch');
  });

  test('returns width and height', () => {
    const buf = solidPng(20, 30, [0, 0, 0, 255]);
    const result = compareWithIgnoreRegions(buf, buf, []);
    expect(result.width).toBe(20);
    expect(result.height).toBe(30);
  });
});

describe('@snapdrift/compare-core — compareImages', () => {
  test('v2 aligns a middle insertion and marks only inserted rows green', () => {
    const baseline = rowPng([10, 20, 30, 40, 50, 60]);
    const current = rowPng([10, 20, 30, 200, 210, 40, 50, 60]);

    const result = compareImages(baseline, current, { alignment: 'vertical' });
    const diffPng = PNG.sync.read(result.diffImageBuffer);

    expect(result.differentPixels).toBe(8);
    expect(result.totalPixels).toBe(32);
    expect(result.mismatchRatio).toBe(0.25);
    expect(result.comparison).toMatchObject({
      policyVersion: 2,
      mode: 'vertical-aligned',
      canvas: { width: 4, height: 8 },
      rowMapping: [
        { outputStart: 0, length: 3, kind: 'matched', baselineStart: 0, currentStart: 0 },
        { outputStart: 3, length: 2, kind: 'inserted', currentStart: 3 },
        { outputStart: 5, length: 3, kind: 'matched', baselineStart: 3, currentStart: 5 }
      ]
    });
    for (const y of [0, 1, 2, 5, 6, 7]) {
      expect([...diffPng.data.slice(y * 16, y * 16 + 4)]).not.toEqual([0, 170, 0, 255]);
      expect([...diffPng.data.slice(y * 16, y * 16 + 4)]).not.toEqual([255, 140, 0, 255]);
    }
    for (const y of [3, 4]) {
      expect([...diffPng.data.slice(y * 16, y * 16 + 4)]).toEqual([0, 170, 0, 255]);
    }
  });

  test('v2 pairs a real row edit separately from an insertion', () => {
    const baseline = rowPng([10, 20, 30, 40, 50, 60]);
    const current = rowPng([10, 20, 200, 30, 99, 50, 60]);

    const result = compareImages(baseline, current, { alignment: 'vertical' });
    const diffPng = PNG.sync.read(result.diffImageBuffer);

    expect(result.comparison.mode).toBe('vertical-aligned');
    expect(result.differentPixels).toBe(8);
    expect([...diffPng.data.slice(2 * 16, 2 * 16 + 4)]).toEqual([0, 170, 0, 255]);
    expect([...diffPng.data.slice(4 * 16, 4 * 16 + 4)]).toEqual([255, 140, 0, 255]);
  });

  test('v2 marks deleted rows red and keeps the remaining suffix aligned', () => {
    const baseline = rowPng([10, 20, 30, 200, 210, 40, 50]);
    const current = rowPng([10, 20, 30, 40, 50]);

    const result = compareImages(baseline, current, { alignment: 'vertical' });
    const diffPng = PNG.sync.read(result.diffImageBuffer);

    expect(result.differentPixels).toBe(8);
    expect(result.comparison.rowMapping).toEqual([
      { outputStart: 0, length: 3, kind: 'matched', baselineStart: 0, currentStart: 0 },
      { outputStart: 3, length: 2, kind: 'deleted', baselineStart: 3 },
      { outputStart: 5, length: 2, kind: 'matched', baselineStart: 5, currentStart: 3 }
    ]);
    expect([...diffPng.data.slice(3 * 16, 3 * 16 + 4)]).toEqual([255, 0, 0, 255]);
  });

  test('v2 handles multiple insertions and deletions even when source heights match', () => {
    const baseline = rowPng([10, 20, 30, 40, 50]);
    const current = rowPng([10, 200, 20, 30, 50]);

    const result = compareImages(baseline, current, { alignment: 'vertical' });

    expect(result.comparison).toMatchObject({ policyVersion: 2, mode: 'vertical-aligned', canvas: { width: 4, height: 6 } });
    expect(result.comparison.rowMapping).toEqual([
      { outputStart: 0, length: 1, kind: 'matched', baselineStart: 0, currentStart: 0 },
      { outputStart: 1, length: 1, kind: 'inserted', currentStart: 1 },
      { outputStart: 2, length: 2, kind: 'matched', baselineStart: 1, currentStart: 2 },
      { outputStart: 4, length: 1, kind: 'deleted', baselineStart: 3 },
      { outputStart: 5, length: 1, kind: 'matched', baselineStart: 4, currentStart: 4 }
    ]);
    expect(result.differentPixels).toBe(8);
    expect(result.totalPixels).toBe(24);
  });

  test('v2 falls back conservatively for width changes and ignored regions', () => {
    const baseline = rowPng([10, 20, 30], 4);
    const wider = rowPng([10, 200, 20, 30], 5);

    const widthFallback = compareImages(baseline, wider, { alignment: 'vertical' });
    expect(widthFallback.comparison).toMatchObject({ policyVersion: 2, mode: 'coordinate-fallback', fallbackReason: 'width-mismatch' });

    const ignoredFallback = compareImages(baseline, rowPng([10, 200, 20, 30], 4), {
      alignment: 'vertical',
      ignoreRegions: [{ x: 0, y: 1, width: 4, height: 1 }]
    });
    expect(ignoredFallback.comparison).toMatchObject({ policyVersion: 2, mode: 'coordinate-fallback', fallbackReason: 'ignore-regions' });
  });

  test('v2 falls back when a repeated row makes insertion location ambiguous', () => {
    const baseline = rowPng([10, 20, 10]);
    const current = rowPng([10, 10, 20, 10]);

    const result = compareImages(baseline, current, { alignment: 'vertical' });
    expect(result.comparison).toMatchObject({ policyVersion: 2, mode: 'coordinate-fallback', fallbackReason: 'ambiguous' });
  });

  test('v2 metrics are identical when diff rendering is disabled', () => {
    const baseline = rowPng([10, 20, 30]);
    const current = rowPng([10, 200, 20, 30]);
    const rendered = compareImages(baseline, current, { alignment: 'vertical' });
    const metrics = compareImages(baseline, current, { alignment: 'vertical', renderDiffImage: false });

    expect(metrics.diffImageBuffer).toBeUndefined();
    expect(metrics.differentPixels).toBe(rendered.differentPixels);
    expect(metrics.totalPixels).toBe(rendered.totalPixels);
    expect(metrics.mismatchRatio).toBe(rendered.mismatchRatio);
    expect(metrics.comparison).toEqual(rendered.comparison);
  });

  test('compares top-left overlap without counting empty union corners', () => {
    const baseline = solidPng(2, 2, [0, 0, 0, 255]);
    const current = solidPng(3, 1, [0, 0, 0, 255]);

    const result = compareImages(baseline, current);

    expect(result.width).toBe(3);
    expect(result.height).toBe(2);
    expect(result.totalPixels).toBe(5);
    expect(result.differentPixels).toBe(3);
    expect(result.mismatchRatio).toBe(3 / 5);
    expect(result.comparison).toEqual({
      baseline: { width: 2, height: 2 },
      current: { width: 3, height: 1 },
      canvas: { width: 3, height: 2 },
      dimensionsChanged: true,
      totalPixels: 5
    });

    const diffPng = PNG.sync.read(result.diffImageBuffer);
    // (2,1) is outside both source images and must not dilute the union ratio.
    expect([...diffPng.data.slice((1 * 3 + 2) * 4, (1 * 3 + 2) * 4 + 4)]).toEqual([0, 0, 0, 0]);
  });

  test('counts a transparent one-sided pixel as changed and highlights it', () => {
    const baseline = solidPng(2, 1, [0, 0, 0, 255]);
    const currentPng = new PNG({ width: 3, height: 1 });
    currentPng.data.fill(0);
    for (let offset = 0; offset < 2 * 4; offset += 4) {
      currentPng.data[offset + 3] = 255;
    }
    const current = PNG.sync.write(currentPng);

    const result = compareImages(baseline, current);
    const diffPng = PNG.sync.read(result.diffImageBuffer);

    expect(result.differentPixels).toBe(1);
    expect(result.totalPixels).toBe(3);
    expect(result.pct).toBe(result.mismatchRatio);
    expect(result.pixelsChanged).toBe(result.differentPixels);
    expect([...diffPng.data.slice(8, 12)]).toEqual([0, 170, 0, 255]);
  });

  test('renders current-only pixels as added (green) and baseline-only as removed (red)', () => {
    // Baseline 2x1 black; current 3x1 white.
    const baseline = solidPng(2, 1, [0, 0, 0, 255]);
    const current = solidPng(3, 1, [255, 255, 255, 255]);

    const result = compareImages(baseline, current);
    const diffPng = PNG.sync.read(result.diffImageBuffer);

    // Pixels (0,0) and (1,0): in both, differ → changed → orange
    expect([...diffPng.data.slice(0, 4)]).toEqual([255, 140, 0, 255]);
    expect([...diffPng.data.slice(4, 8)]).toEqual([255, 140, 0, 255]);
    // Pixel (2,0): only in current → added → green
    expect([...diffPng.data.slice(8, 12)]).toEqual([0, 170, 0, 255]);
    expect(result.differentPixels).toBe(3);
    expect(result.comparison.dimensionsChanged).toBe(true);
  });

  test('renders baseline-only pixels as removed (red)', () => {
    // Baseline 3x1 black; current 1x1 white — pixels (1,0) and (2,0) are baseline-only.
    const baseline = solidPng(3, 1, [0, 0, 0, 255]);
    const current = solidPng(1, 1, [255, 255, 255, 255]);

    const result = compareImages(baseline, current);
    const diffPng = PNG.sync.read(result.diffImageBuffer);

    // Pixel (0,0): in both, differs → changed → orange
    expect([...diffPng.data.slice(0, 4)]).toEqual([255, 140, 0, 255]);
    // Pixel (1,0): only in baseline → removed → red
    expect([...diffPng.data.slice(4, 8)]).toEqual([255, 0, 0, 255]);
    // Pixel (2,0): only in baseline → removed → red
    expect([...diffPng.data.slice(8, 12)]).toEqual([255, 0, 0, 255]);
    expect(result.differentPixels).toBe(3);
  });

  test('honors custom addedColor and removedColor', () => {
    // Added case: baseline 2x1 black, current 3x1 with pixel (2,0) white.
    // Pixel (2,0) is current-only → addedColor.
    const addedBaseline = solidPng(2, 1, [0, 0, 0, 255]);
    const addedCurrentPng = new PNG({ width: 3, height: 1 });
    for (let x = 0; x < 3; x++) {
      const i = x * 4;
      addedCurrentPng.data[i] = x < 2 ? 0 : 9;
      addedCurrentPng.data[i + 1] = 0;
      addedCurrentPng.data[i + 2] = 0;
      addedCurrentPng.data[i + 3] = 255;
    }
    const addedCurrent = PNG.sync.write(addedCurrentPng);

    const addedResult = compareImages(addedBaseline, addedCurrent, { addedColor: [0, 0, 255, 255] });
    const addedPng = PNG.sync.read(addedResult.diffImageBuffer);
    // Pixels (0,0) and (1,0) match → baseline color; pixel (2,0) is added → custom blue.
    expect([...addedPng.data.slice(0, 4)]).toEqual([0, 0, 0, 255]);
    expect([...addedPng.data.slice(8, 12)]).toEqual([0, 0, 255, 255]);

    // Removed case: baseline 4x1 black, current 3x1 black — pixel (3,0) is baseline-only.
    const removedBaseline = solidPng(4, 1, [0, 0, 0, 255]);
    const removedCurrent = solidPng(3, 1, [0, 0, 0, 255]);

    const removedResult = compareImages(removedBaseline, removedCurrent, { removedColor: [255, 255, 0, 255] });
    const removedPng = PNG.sync.read(removedResult.diffImageBuffer);
    // Pixel (3,0) is baseline-only → custom yellow.
    expect([...removedPng.data.slice(12, 16)]).toEqual([255, 255, 0, 255]);
  });

  test('excludes masked pixels from the denominator and renders them gray', () => {
    const baseline = solidPng(2, 1, [0, 0, 0, 255]);
    const current = solidPng(3, 1, [255, 255, 255, 255]);

    const result = compareImages(baseline, current, {
      ignoreRegions: [{ x: 2, y: 0, width: 1, height: 1 }]
    });
    const diffPng = PNG.sync.read(result.diffImageBuffer);

    expect(result.totalPixels).toBe(2);
    expect(result.differentPixels).toBe(2);
    expect(result.mismatchRatio).toBe(1);
    expect([...diffPng.data.slice(8, 12)]).toEqual([128, 128, 128, 128]);
  });

  test('returns a zero denominator when masks cover the whole union canvas', () => {
    const baseline = solidPng(2, 2, [0, 0, 0, 255]);
    const current = solidPng(3, 1, [255, 255, 255, 255]);

    const result = compareImages(baseline, current, {
      ignoreRegions: [{ x: -1, y: -1, width: 10, height: 10 }]
    });

    expect(result.totalPixels).toBe(0);
    expect(result.differentPixels).toBe(0);
    expect(result.mismatchRatio).toBe(0);
    expect(result.comparison.totalPixels).toBe(0);
  });

  test('keeps equal-size metrics and diff pixels equivalent to the strict image renderer', () => {
    const baseline = solidPng(2, 2, [0, 0, 0, 255]);
    const current = solidPng(2, 2, [255, 255, 255, 255]);

    const result = compareImages(baseline, current);

    expect(result.comparison).toEqual({
      baseline: { width: 2, height: 2 },
      current: { width: 2, height: 2 },
      canvas: { width: 2, height: 2 },
      dimensionsChanged: false,
      totalPixels: 4
    });
    expect(result.diffImageBuffer).toEqual(generateDiffImage(baseline, current));
  });

  test('does not apply a threshold inside pixel computation', () => {
    const baseline = solidPng(2, 1, [0, 0, 0, 255]);
    const current = solidPng(2, 1, [255, 255, 255, 255]);

    const result = compareImages(baseline, current, /** @type {any} */ ({ threshold: 1 }));

    expect(result.differentPixels).toBe(2);
    expect(result.mismatchRatio).toBe(1);
  });

  test('short-circuits identical buffers and reuses the baseline buffer as the diff image', () => {
    const baseline = solidPng(4, 3, [12, 34, 56, 255]);
    const result = compareImages(baseline, baseline);

    expect(result.differentPixels).toBe(0);
    expect(result.totalPixels).toBe(12);
    expect(result.mismatchRatio).toBe(0);
    expect(result.diffImageBuffer).toBe(baseline);

    const diffPng = PNG.sync.read(result.diffImageBuffer);
    expect(diffPng.width).toBe(4);
    expect(diffPng.height).toBe(3);
    expect(diffPng.data[0]).toBe(12);
  });

  test('skips the diff image when renderDiffImage is false', () => {
    const baseline = solidPng(4, 3, [12, 34, 56, 255]);
    const changed = solidPng(4, 3, [0, 0, 0, 255]);

    const identical = compareImages(baseline, baseline, { renderDiffImage: false });
    expect(identical.diffImageBuffer).toBeUndefined();
    expect(identical.mismatchRatio).toBe(0);

    const different = compareImages(baseline, changed, { renderDiffImage: false });
    expect(different.diffImageBuffer).toBeUndefined();
    expect(different.differentPixels).toBe(12);
    expect(different.mismatchRatio).toBe(1);
  });

  test('rejects malformed ignore regions and highlight colors', () => {
    const baseline = solidPng(2, 1, [0, 0, 0, 255]);

    expect(() => compareImages(baseline, baseline, { ignoreRegions: [/** @type {any} */ ({ x: 0.5, y: 0, width: 1, height: 1 })] })).toThrow(
      /ignoreRegions\[0\]\.x must be a safe integer/
    );
    expect(() => compareImages(baseline, baseline, { ignoreRegions: [/** @type {any} */ ({ x: 0, y: 0, width: -1, height: 1 })] })).toThrow(
      /width and .height must be non-negative/
    );
    expect(() => compareImages(baseline, baseline, { highlightColor: /** @type {any} */ ([1, 2, 3]) })).toThrow(/highlightColor must be an array of four integers/);
    expect(() => compareImages(baseline, baseline, { addedColor: /** @type {any} */ ([-1, 0, 0, 255]) })).toThrow(/addedColor must be an array of four integers/);
    expect(() => compareImages(baseline, baseline, { removedColor: /** @type {any} */ ([1, 2, 3]) })).toThrow(/removedColor must be an array of four integers/);
  });
});
