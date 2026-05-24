import pngjs from 'pngjs';
import { compareBuffers, generateDiffImage, compareWithIgnoreRegions } from '../src/index.mjs';

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

  test('highlights changed pixels with default red color', () => {
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

    // Pixel (0,0) should be red (changed)
    expect(diffPng.data[0]).toBe(255);  // R
    expect(diffPng.data[1]).toBe(0);    // G
    expect(diffPng.data[2]).toBe(0);    // B
    expect(diffPng.data[3]).toBe(255);   // A

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