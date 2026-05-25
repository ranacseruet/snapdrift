import {
  validateSnapdriftConfig,
  selectConfiguredRoutes,
  selectRoutesForChangedFiles,
  resolveFromWorkingDirectory,
  splitCommaList,
  VALID_DIFF_MODES,
  SNAPDRIFT_NAVIGATION_TIMEOUT_MS,
  SNAPDRIFT_SETTLE_DELAY_MS
} from '../src/config.mjs';

const VALID_CONFIG = {
  baselineArtifactName: 'snapdrift-baseline',
  workingDirectory: '.',
  baseUrl: 'http://localhost:3000',
  resultsFile: 'results.json',
  manifestFile: 'manifest.json',
  screenshotsRoot: 'screenshots',
  routes: [
    { id: 'home', path: '/', viewport: 'desktop' },
    { id: 'about', path: '/about', viewport: 'mobile' }
  ],
  diff: { threshold: 0.01, mode: 'report-only' }
};

describe('@snapdrift/manifest — validateSnapdriftConfig', () => {
  test('accepts valid config', () => {
    const result = validateSnapdriftConfig(VALID_CONFIG);
    expect(result.routes).toHaveLength(2);
  });

  test('rejects non-object', () => {
    expect(() => validateSnapdriftConfig(null)).toThrow('expected a JSON object');
  });

  test('rejects missing required string fields', () => {
    const copy = { ...VALID_CONFIG, baseUrl: '' };
    expect(() => validateSnapdriftConfig(copy)).toThrow('baseUrl must be a non-empty string');
  });

  test('rejects empty routes', () => {
    const copy = { ...VALID_CONFIG, routes: [] };
    expect(() => validateSnapdriftConfig(copy)).toThrow('at least one route');
  });

  test('rejects duplicate route ids', () => {
    const copy = { ...VALID_CONFIG, routes: [
      { id: 'home', path: '/', viewport: 'desktop' },
      { id: 'home', path: '/home', viewport: 'desktop' }
    ]};
    expect(() => validateSnapdriftConfig(copy)).toThrow('duplicates');
  });

  test('rejects invalid diff mode', () => {
    const copy = { ...VALID_CONFIG, diff: { threshold: 0.01, mode: 'invalid' } };
    expect(() => validateSnapdriftConfig(copy)).toThrow('diff.mode');
  });

  test('rejects threshold out of range', () => {
    const copy = { ...VALID_CONFIG, diff: { threshold: 2, mode: 'report-only' } };
    expect(() => validateSnapdriftConfig(copy)).toThrow('threshold');
  });
});

describe('@snapdrift/manifest — selectConfiguredRoutes', () => {
  const config = VALID_CONFIG;

  test('returns all routes when no ids requested', () => {
    const result = selectConfiguredRoutes(config, []);
    expect(result.routes).toHaveLength(2);
    expect(result.selectedRouteIds).toEqual(['home', 'about']);
  });

  test('filters to requested ids', () => {
    const result = selectConfiguredRoutes(config, ['home']);
    expect(result.routes).toHaveLength(1);
    expect(result.selectedRouteIds).toEqual(['home']);
  });

  test('throws for unknown ids', () => {
    expect(() => selectConfiguredRoutes(config, ['missing'])).toThrow('Unknown');
  });
});

describe('@snapdrift/manifest — selectRoutesForChangedFiles', () => {
  test('no changes returns shouldRun false', () => {
    const result = selectRoutesForChangedFiles(VALID_CONFIG, []);
    expect(result.shouldRun).toBe(false);
    expect(result.reason).toBe('no_changed_files');
  });

  test('shared exact file triggers all routes', () => {
    const config = { ...VALID_CONFIG, selection: { sharedExact: ['package.json'] } };
    const result = selectRoutesForChangedFiles(config, ['package.json']);
    expect(result.shouldRun).toBe(true);
    expect(result.reason).toBe('shared_snapdrift_change');
  });

  test('route changePaths match triggers scoped routes', () => {
    const config = { ...VALID_CONFIG, routes: [
      { id: 'home', path: '/', viewport: 'desktop', changePaths: ['src/components/Home/'] }
    ]};
    const result = selectRoutesForChangedFiles(config, ['src/components/Home/index.tsx']);
    expect(result.shouldRun).toBe(true);
    expect(result.selectedRouteIds).toEqual(['home']);
  });
});

describe('@snapdrift/manifest — splitCommaList', () => {
  test('splits comma-separated values', () => {
    expect(splitCommaList('a, b, c')).toEqual(['a', 'b', 'c']);
  });

  test('filters empty', () => {
    expect(splitCommaList('a,,b')).toEqual(['a', 'b']);
  });

  test('handles undefined', () => {
    expect(splitCommaList(undefined)).toEqual([]);
  });
});

describe('@snapdrift/manifest — resolveFromWorkingDirectory', () => {
  test('resolves relative path against working directory', () => {
    const result = resolveFromWorkingDirectory({ ...VALID_CONFIG, workingDirectory: '/project' }, 'results.json');
    expect(result).toContain('/project');
    expect(result).toContain('results.json');
  });
});

describe('@snapdrift/manifest — constants', () => {
  test('VALID_DIFF_MODES includes expected modes', () => {
    expect(VALID_DIFF_MODES).toContain('report-only');
    expect(VALID_DIFF_MODES).toContain('strict');
  });

  test('SNAPDRIFT_NAVIGATION_TIMEOUT_MS is positive', () => {
    expect(SNAPDRIFT_NAVIGATION_TIMEOUT_MS).toBeGreaterThan(0);
  });

  test('SNAPDRIFT_SETTLE_DELAY_MS is positive', () => {
    expect(SNAPDRIFT_SETTLE_DELAY_MS).toBeGreaterThan(0);
  });
});