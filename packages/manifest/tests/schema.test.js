import { validateManifest, indexManifestEntries, indexRouteResults, CURRENT_SCHEMA_VERSION } from '../src/index.mjs';

const VALID_MANIFEST = {
  generatedAt: '2024-01-01T00:00:00.000Z',
  baseUrl: 'http://localhost:8080',
  screenshots: [
    { id: 'home-desktop', path: '/', viewport: 'desktop', imagePath: 'screenshots/home-desktop.png', width: 1440, height: 900 },
    { id: 'home-mobile', path: '/', viewport: 'mobile', imagePath: 'screenshots/home-mobile.png', width: 390, height: 844 }
  ]
};

describe('@snapdrift/manifest — validateManifest', () => {
  test('accepts a valid manifest', () => {
    const result = validateManifest(VALID_MANIFEST);
    expect(result.screenshots).toHaveLength(2);
  });

  test('accepts manifest with schemaVersion', () => {
    const withVersion = { ...VALID_MANIFEST, schemaVersion: 1 };
    const result = validateManifest(withVersion);
    expect(result.schemaVersion).toBe(1);
  });

  test('accepts manifest without schemaVersion (defaults to 1)', () => {
    const result = validateManifest(VALID_MANIFEST);
    expect(result.schemaVersion).toBeUndefined();
  });

  test('rejects non-object', () => {
    expect(() => validateManifest(null)).toThrow('non-null object');
    expect(() => validateManifest('string')).toThrow('non-null object');
    expect(() => validateManifest([])).toThrow('non-null object');
  });

  test('rejects invalid schemaVersion', () => {
    expect(() => validateManifest({ ...VALID_MANIFEST, schemaVersion: 'bad' })).toThrow('number');
  });

  test('rejects missing generatedAt', () => {
    const { generatedAt, ...without } = VALID_MANIFEST;
    expect(() => validateManifest(without)).toThrow('generatedAt');
  });

  test('rejects empty generatedAt', () => {
    expect(() => validateManifest({ ...VALID_MANIFEST, generatedAt: '' })).toThrow('generatedAt');
  });

  test('rejects missing screenshots array', () => {
    const { screenshots, ...without } = VALID_MANIFEST;
    expect(() => validateManifest(without)).toThrow('screenshots');
  });

  test('rejects duplicate screenshot ids', () => {
    const dup = {
      ...VALID_MANIFEST,
      screenshots: [
        ...VALID_MANIFEST.screenshots,
        { id: 'home-desktop', path: '/dup', viewport: 'desktop', imagePath: 'screenshots/dup.png', width: 1440, height: 900 }
      ]
    };
    expect(() => validateManifest(dup)).toThrow('Duplicate');
  });

  test('rejects screenshot with missing id', () => {
    const bad = { ...VALID_MANIFEST, screenshots: [{ path: '/', width: 100, height: 100 }] };
    expect(() => validateManifest(bad)).toThrow('id');
  });

  test('rejects screenshot with non-positive width', () => {
    const bad = { ...VALID_MANIFEST, screenshots: [{ id: 'a', path: '/', width: 0, height: 100, viewport: 'desktop', imagePath: 'a.png' }] };
    expect(() => validateManifest(bad)).toThrow('width');
  });
});

describe('@snapdrift/manifest — indexManifestEntries', () => {
  test('indexes entries by id filtered by selected routes', () => {
    const indexed = indexManifestEntries(VALID_MANIFEST, ['home-desktop']);
    expect(indexed.size).toBe(1);
    expect(indexed.get('home-desktop').id).toBe('home-desktop');
  });

  test('returns all entries when selected is empty', () => {
    const indexed = indexManifestEntries(VALID_MANIFEST, []);
    expect(indexed.size).toBe(0);
  });

  test('returns all entries when selected matches all ids', () => {
    const indexed = indexManifestEntries(VALID_MANIFEST, ['home-desktop', 'home-mobile']);
    expect(indexed.size).toBe(2);
  });

  test('throws on duplicate ids', () => {
    const dup = {
      ...VALID_MANIFEST,
      screenshots: [
        { id: 'a', path: '/', viewport: 'desktop', imagePath: '1.png', width: 100, height: 100 },
        { id: 'a', path: '/', viewport: 'mobile', imagePath: '2.png', width: 100, height: 100 }
      ]
    };
    expect(() => indexManifestEntries(dup, ['a'])).toThrow('Duplicate');
  });
});

describe('@snapdrift/manifest — indexRouteResults', () => {
  test('indexes routes by id', () => {
    const results = {
      startedAt: '2024-01-01T00:00:00Z',
      routes: [
        { id: 'home', path: '/', viewport: 'desktop', status: 'passed', durationMs: 100 },
        { id: 'about', path: '/about', viewport: 'desktop', status: 'failed', durationMs: 50, error: 'timeout' }
      ]
    };
    const indexed = indexRouteResults(results);
    expect(indexed.size).toBe(2);
    expect(indexed.get('home').status).toBe('passed');
    expect(indexed.get('about').status).toBe('failed');
  });

  test('handles empty routes', () => {
    const indexed = indexRouteResults({ startedAt: '', routes: [] });
    expect(indexed.size).toBe(0);
  });
});

describe('@snapdrift/manifest — CURRENT_SCHEMA_VERSION', () => {
  test('is 1', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(1);
  });
});