import { viewportKey, viewportHash, VIEWPORT_PRESETS } from '../src/index.mjs';

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
  test('returns "desktop" for a fully-matching desktop preset descriptor', () => {
    expect(viewportHash({ width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false })).toBe('desktop');
  });

  test('returns "desktop" when optional flags are omitted (they match the preset default)', () => {
    expect(viewportHash({ width: 1440, height: 900 })).toBe('desktop');
  });

  test('returns "mobile" for a fully-matching mobile preset descriptor', () => {
    expect(viewportHash({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true })).toBe('mobile');
  });

  test('returns "mobile" when optional flags are omitted', () => {
    expect(viewportHash({ width: 390, height: 844 })).toBe('mobile');
  });

  test('returns custom for desktop dimensions with conflicting isMobile flag', () => {
    expect(viewportHash({ width: 1440, height: 900, isMobile: true })).toBe('custom:1440x900');
  });

  test('returns custom for mobile dimensions with conflicting isMobile flag', () => {
    expect(viewportHash({ width: 390, height: 844, isMobile: false })).toBe('custom:390x844');
  });

  test('returns custom for non-preset dimensions', () => {
    expect(viewportHash({ width: 1280, height: 720 })).toBe('custom:1280x720');
  });

  test('returns custom when deviceScaleFactor conflicts with preset', () => {
    expect(viewportHash({ width: 1440, height: 900, deviceScaleFactor: 3 })).toBe('custom:1440x900');
  });
});

describe('@snapdrift/manifest — VIEWPORT_PRESETS', () => {
  test('has desktop and mobile entries', () => {
    expect(VIEWPORT_PRESETS.desktop).toBeDefined();
    expect(VIEWPORT_PRESETS.mobile).toBeDefined();
  });

  test('desktop preset has expected dimensions and flags', () => {
    expect(VIEWPORT_PRESETS.desktop.width).toBe(1440);
    expect(VIEWPORT_PRESETS.desktop.height).toBe(900);
    expect(VIEWPORT_PRESETS.desktop.deviceScaleFactor).toBe(1);
    expect(VIEWPORT_PRESETS.desktop.isMobile).toBe(false);
    expect(VIEWPORT_PRESETS.desktop.hasTouch).toBe(false);
  });

  test('mobile preset has expected dimensions and flags', () => {
    expect(VIEWPORT_PRESETS.mobile.width).toBe(390);
    expect(VIEWPORT_PRESETS.mobile.height).toBe(844);
    expect(VIEWPORT_PRESETS.mobile.deviceScaleFactor).toBe(3);
    expect(VIEWPORT_PRESETS.mobile.isMobile).toBe(true);
    expect(VIEWPORT_PRESETS.mobile.hasTouch).toBe(true);
  });
});