import { viewportKey, viewportHash } from '../src/index.mjs';

describe('@snapdrift/manifest — viewportKey', () => {
  test('passes preset strings through unchanged', () => {
    expect(viewportKey('desktop')).toBe('desktop');
    expect(viewportKey('mobile')).toBe('mobile');
  });

  test('formats custom viewports as custom:WxH', () => {
    expect(viewportKey({ width: 1280, height: 720 })).toBe('custom:1280x720');
    expect(viewportKey({ width: 768, height: 1024 })).toBe('custom:768x1024');
  });
});

describe('@snapdrift/manifest — viewportHash', () => {
  test('returns "desktop" for the desktop preset descriptor', () => {
    expect(viewportHash({ width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false })).toBe('desktop');
  });

  test('returns "desktop" with defaults', () => {
    expect(viewportHash({ width: 1440, height: 900 })).toBe('desktop');
  });

  test('returns "mobile" for the mobile preset descriptor', () => {
    expect(viewportHash({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true })).toBe('mobile');
  });

  test('returns "mobile" with defaults', () => {
    expect(viewportHash({ width: 390, height: 844, isMobile: true })).toBe('mobile');
  });

  test('returns custom format for non-preset dimensions', () => {
    expect(viewportHash({ width: 1280, height: 720 })).toBe('custom:1280x720');
  });

  test('returns custom for desktop dimensions with mobile flag', () => {
    expect(viewportHash({ width: 1440, height: 900, isMobile: true })).toBe('custom:1440x900');
  });
});