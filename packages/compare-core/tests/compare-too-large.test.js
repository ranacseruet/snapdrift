/** @jest-environment node */

import { jest } from '@jest/globals';

const readPng = jest.fn();

class MockPNG {
  static sync = { read: readPng };
}

jest.unstable_mockModule('pngjs', () => ({ default: { PNG: MockPNG } }));

const { compareImages, ComparisonTooLargeError, MAX_COMPARISON_PIXELS } = await import('../src/index.mjs');

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
});
