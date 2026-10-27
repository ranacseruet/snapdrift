import pngjs from 'pngjs';
import { runBaselineCapture, assertNavigationOk, readPngDimensions } from '../src/capture.mjs';

const { PNG } = pngjs;

describe('@snapdrift/adapter-fs — capture', () => {
  test('runBaselineCapture is exported as a function', () => {
    expect(typeof runBaselineCapture).toBe('function');
  });

  describe('assertNavigationOk', () => {
    const route = { id: 'json-formatter-desktop', path: '/json-formatter/', viewport: 'desktop' };
    const url = 'http://127.0.0.1:8080/json-formatter/';

    test('throws on a 404 response so an error page is never captured', () => {
      expect(() => assertNavigationOk({ status: () => 404 }, route, url)).toThrow(/HTTP 404/);
      expect(() => assertNavigationOk({ status: () => 404 }, route, url)).toThrow(route.id);
    });

    test('throws on a 500 response', () => {
      expect(() => assertNavigationOk({ status: () => 500 }, route, url)).toThrow(/HTTP 500/);
    });

    test('passes on a 200 response', () => {
      expect(() => assertNavigationOk({ status: () => 200 }, route, url)).not.toThrow();
    });

    test('passes on a 3xx response (Playwright reports the final status after redirects)', () => {
      expect(() => assertNavigationOk({ status: () => 301 }, route, url)).not.toThrow();
    });

    test('passes when response is null (non-navigation scheme, e.g. about:blank)', () => {
      expect(() => assertNavigationOk(null, route, url)).not.toThrow();
    });
  });

  describe('readPngDimensions', () => {
    test('reads width and height from a real PNG without decoding it', () => {
      const png = new PNG({ width: 7, height: 13 });
      expect(readPngDimensions(PNG.sync.write(png))).toEqual({ width: 7, height: 13 });
    });

    test('rejects a buffer shorter than the IHDR chunk', () => {
      const png = PNG.sync.write(new PNG({ width: 2, height: 2 }));
      expect(() => readPngDimensions(png.subarray(0, 20))).toThrow(/not a valid PNG/);
    });

    test('rejects a buffer without the PNG signature', () => {
      expect(() => readPngDimensions(Buffer.alloc(64))).toThrow(/not a valid PNG/);
    });

    test('rejects a PNG whose first chunk is not IHDR', () => {
      const png = PNG.sync.write(new PNG({ width: 2, height: 2 }));
      png.write('IDAT', 12, 'ascii');
      expect(() => readPngDimensions(png)).toThrow(/not a valid PNG/);
    });
  });
});
