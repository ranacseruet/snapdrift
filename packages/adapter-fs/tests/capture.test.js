import pngjs from 'pngjs';
import { runBaselineCapture, assertNavigationOk, requirePngDimensions } from '../src/capture.mjs';

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

  describe('requirePngDimensions', () => {
    test('returns width and height for a real PNG', () => {
      expect(requirePngDimensions(PNG.sync.write(new PNG({ width: 7, height: 13 })))).toEqual({ width: 7, height: 13 });
    });

    // Header validation itself is covered in @snapdrift/compare-core; these
    // pin that capture turns a rejected header into a thrown route failure.
    test.each([
      ['truncated', () => PNG.sync.write(new PNG({ width: 2, height: 2 })).subarray(0, 20)],
      ['no signature', () => Buffer.alloc(64)],
      ['zero width', () => {
        const png = PNG.sync.write(new PNG({ width: 2, height: 2 }));
        png.writeUInt32BE(0, 16);
        return png;
      }]
    ])('throws for a %s buffer so the route fails and is retried', (_label, makeBuffer) => {
      expect(() => requirePngDimensions(makeBuffer())).toThrow(/not a valid PNG/);
    });
  });
});
