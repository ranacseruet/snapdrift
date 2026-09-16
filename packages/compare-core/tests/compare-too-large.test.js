/** @jest-environment node */

import { jest } from '@jest/globals';

const readPng = jest.fn();

class MockPNG {
  static sync = { read: readPng };
}

jest.unstable_mockModule('pngjs', () => ({ default: { PNG: MockPNG } }));

const { compareImages, ComparisonTooLargeError, MAX_COMPARISON_PIXELS } = await import('../src/index.mjs');

/**
 * Build a PNG header buffer with the given IHDR dimensions but no image data.
 * @param {number} width
 * @param {number} height
 * @returns {Buffer}
 */
function pngHeader(width, height) {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

describe('@snapdrift/compare-core — comparison size limit', () => {
  beforeEach(() => {
    readPng.mockReset();
  });

  test('throws a typed comparison_too_large error before allocating the union canvas', () => {
    const oversizedWidth = MAX_COMPARISON_PIXELS + 1;
    readPng
      .mockReturnValueOnce({ width: oversizedWidth, height: 1, data: new Uint8Array(0) })
      .mockReturnValueOnce({ width: oversizedWidth, height: 1, data: new Uint8Array(0) });

    let error;
    try {
      compareImages(Buffer.alloc(0), Buffer.alloc(0));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ComparisonTooLargeError);
    expect(error).toMatchObject({ code: 'comparison_too_large' });
    expect(error.message).toMatch(/comparison_too_large/);
  });

  test('rejects oversized header dimensions before decoding the image buffers', () => {
    const oversized = pngHeader(MAX_COMPARISON_PIXELS + 1, 1);

    let error;
    try {
      compareImages(oversized, oversized);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ComparisonTooLargeError);
    expect(readPng).not.toHaveBeenCalled();
  });

  test('accepts a union above the default when the caller raises maxPixels', () => {
    const width = MAX_COMPARISON_PIXELS + 1;
    const pixels = Buffer.alloc(0);
    readPng
      .mockReturnValueOnce({ width, height: 1, data: pixels })
      .mockReturnValueOnce({ width, height: 1, data: pixels });

    const result = compareImages(Buffer.alloc(0), Buffer.alloc(0), {
      maxPixels: width * 2,
      renderDiffImage: false
    });
    expect(result.comparison.canvas).toEqual({ width, height: 1 });
  });

  test('reports the caller-supplied ceiling in the error message', () => {
    const width = 2_000_000;
    readPng
      .mockReturnValueOnce({ width, height: 1, data: new Uint8Array(0) })
      .mockReturnValueOnce({ width, height: 1, data: new Uint8Array(0) });

    let error;
    try {
      compareImages(Buffer.alloc(0), Buffer.alloc(0), { maxPixels: 1_000_000 });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ComparisonTooLargeError);
    expect(error.message).toContain('exceeds the maximum of 1000000 pixels');
  });

  test('falls back to the default ceiling for a missing or invalid maxPixels', () => {
    const oversized = pngHeader(MAX_COMPARISON_PIXELS + 1, 1);

    for (const maxPixels of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      let error;
      try {
        compareImages(oversized, oversized, { maxPixels });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ComparisonTooLargeError);
      expect(error.message).toContain(`exceeds the maximum of ${MAX_COMPARISON_PIXELS} pixels`);
    }
  });
});
