import { runBaselineCapture } from '../src/capture.mjs';

describe('@snapdrift/adapter-fs — capture', () => {
  test('runBaselineCapture is exported as a function', () => {
    expect(typeof runBaselineCapture).toBe('function');
  });
});