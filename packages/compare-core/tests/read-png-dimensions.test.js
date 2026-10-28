import pngjs from 'pngjs';
import { readPngDimensions } from '../src/index.mjs';

const { PNG } = pngjs;

function makePng(width = 2, height = 3) {
  return PNG.sync.write(new PNG({ width, height }));
}

describe('readPngDimensions', () => {
  test('reads width and height from a real PNG header', () => {
    expect(readPngDimensions(makePng(7, 13))).toEqual({ width: 7, height: 13 });
  });

  test('does not need pixel data: a header-only prefix is enough', () => {
    expect(readPngDimensions(makePng(7, 13).subarray(0, 24))).toEqual({ width: 7, height: 13 });
  });

  test('returns undefined for a buffer shorter than the IHDR fields', () => {
    expect(readPngDimensions(makePng().subarray(0, 23))).toBeUndefined();
  });

  test('returns undefined without the PNG signature', () => {
    expect(readPngDimensions(Buffer.alloc(64))).toBeUndefined();
    const jpeg = Buffer.alloc(64);
    jpeg.writeUInt16BE(0xffd8, 0);
    expect(readPngDimensions(jpeg)).toBeUndefined();
  });

  test('returns undefined when the first chunk is not IHDR', () => {
    const png = makePng();
    png.write('IDAT', 12, 'ascii');
    expect(readPngDimensions(png)).toBeUndefined();
  });

  test.each([
    ['zero width', 16, 0],
    ['zero height', 20, 0],
    ['width above 2^31 - 1', 16, 2 ** 31],
    ['height above 2^31 - 1', 20, 2 ** 31]
  ])('returns undefined for %s', (_label, offset, value) => {
    const png = makePng();
    png.writeUInt32BE(value, offset);
    expect(readPngDimensions(png)).toBeUndefined();
  });

  test('accepts the maximum spec dimension', () => {
    const png = makePng();
    png.writeUInt32BE(2 ** 31 - 1, 16);
    expect(readPngDimensions(png)).toEqual({ width: 2 ** 31 - 1, height: 3 });
  });

  test('returns undefined for non-Buffer input', () => {
    expect(readPngDimensions(new Uint8Array(64))).toBeUndefined();
    expect(readPngDimensions(undefined)).toBeUndefined();
  });
});
