import { determineDriftStatus, shouldFailDriftCheck } from '../src/drift-status.mjs';

/** @type {import('../types/index.d.ts').VisualDiffSummary} */
function makeSummary(overrides = {}) {
  return {
    startedAt: '2026-01-01T00:00:00Z',
    baselineManifestPath: '/baseline/manifest.json',
    currentManifestPath: '/current/manifest.json',
    diffMode: 'report-only',
    threshold: 0.01,
    baselineResultsPath: '/baseline/results.json',
    currentResultsPath: '/current/results.json',
    totalScreenshots: 2,
    matchedScreenshots: 2,
    changedScreenshots: 0,
    missingInBaseline: 0,
    missingInCurrent: 0,
    changed: [],
    missing: [],
    errors: [],
    dimensionChanges: [],
    ...overrides
  };
}

describe('@snapdrift/manifest — determineDriftStatus', () => {
  test('returns "clean" for no changes, no errors, no missing', () => {
    expect(determineDriftStatus(makeSummary())).toBe('clean');
  });

  test('returns "changes-detected" when changedScreenshots > 0', () => {
    expect(determineDriftStatus(makeSummary({ changedScreenshots: 1 }))).toBe('changes-detected');
  });

  test('returns "incomplete" when errors exist', () => {
    expect(determineDriftStatus(makeSummary({ errors: [{ id: 'a', status: 'error', message: 'fail' }] }))).toBe('incomplete');
  });

  test('returns "incomplete" when dimensionChanges exist', () => {
    expect(determineDriftStatus(makeSummary({ dimensionChanges: [{ id: 'a', status: 'dimension-changed' }] }))).toBe('incomplete');
  });

  test('returns "incomplete" when missingInBaseline > 0', () => {
    expect(determineDriftStatus(makeSummary({ missingInBaseline: 1 }))).toBe('incomplete');
  });

  test('returns "incomplete" when missingInCurrent > 0', () => {
    expect(determineDriftStatus(makeSummary({ missingInCurrent: 1 }))).toBe('incomplete');
  });

  test('incomplete takes precedence over changes-detected', () => {
    expect(determineDriftStatus(makeSummary({ changedScreenshots: 1, missingInBaseline: 1 }))).toBe('incomplete');
  });
});

describe('@snapdrift/manifest — shouldFailDriftCheck', () => {
  test('report-only never fails', () => {
    expect(shouldFailDriftCheck(makeSummary({ diffMode: 'report-only', changedScreenshots: 5 }))).toBe(false);
  });

  test('fail-on-changes fails when changes detected', () => {
    expect(shouldFailDriftCheck(makeSummary({ diffMode: 'fail-on-changes', changedScreenshots: 1 }))).toBe(true);
  });

  test('fail-on-changes does not fail on missing alone', () => {
    expect(shouldFailDriftCheck(makeSummary({ diffMode: 'fail-on-changes', missingInBaseline: 1 }))).toBe(false);
  });

  test('fail-on-incomplete fails on missing', () => {
    expect(shouldFailDriftCheck(makeSummary({ diffMode: 'fail-on-incomplete', missingInBaseline: 1 }))).toBe(true);
  });

  test('fail-on-incomplete fails on errors', () => {
    expect(shouldFailDriftCheck(makeSummary({ diffMode: 'fail-on-incomplete', errors: [{ id: 'a', status: 'error', message: 'fail' }] }))).toBe(true);
  });

  test('strict fails on any issue', () => {
    expect(shouldFailDriftCheck(makeSummary({ diffMode: 'strict', changedScreenshots: 1 }))).toBe(true);
    expect(shouldFailDriftCheck(makeSummary({ diffMode: 'strict', missingInCurrent: 1 }))).toBe(true);
    expect(shouldFailDriftCheck(makeSummary({ diffMode: 'strict', errors: [{ id: 'a', status: 'error', message: 'x' }] }))).toBe(true);
  });

  test('clean summary with strict does not fail', () => {
    expect(shouldFailDriftCheck(makeSummary({ diffMode: 'strict' }))).toBe(false);
  });
});