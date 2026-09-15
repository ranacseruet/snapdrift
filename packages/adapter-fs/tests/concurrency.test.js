import { createConcurrencyLimiter } from '../src/concurrency.mjs';

describe('@snapdrift/adapter-fs — createConcurrencyLimiter', () => {
  test('never runs more than the configured number of tasks at once', async () => {
    const limit = createConcurrencyLimiter(2);
    let active = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        limit(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return index;
        })
      )
    );

    expect(peak).toBe(2);
  });

  test('preserves result order independent of completion order', async () => {
    const limit = createConcurrencyLimiter(3);

    const results = await Promise.all(
      [30, 5, 15, 1].map((delay, index) =>
        limit(async () => {
          await new Promise((resolve) => setTimeout(resolve, delay));
          return index;
        })
      )
    );

    expect(results).toEqual([0, 1, 2, 3]);
  });

  test('propagates task rejections', async () => {
    const limit = createConcurrencyLimiter(1);

    await expect(limit(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  });
});
