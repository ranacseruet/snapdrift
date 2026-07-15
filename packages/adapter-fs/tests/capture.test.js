import { runBaselineCapture, assertNavigationOk } from '../src/capture.mjs';

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
});
