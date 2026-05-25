import { generateDriftReport, runDriftCheckCli } from '../src/drift-report.mjs';

describe('@snapdrift/adapter-fs — drift-report', () => {
  test('generateDriftReport is exported as a function', () => {
    expect(typeof generateDriftReport).toBe('function');
  });

  test('runDriftCheckCli is exported as a function', () => {
    expect(typeof runDriftCheckCli).toBe('function');
  });
});