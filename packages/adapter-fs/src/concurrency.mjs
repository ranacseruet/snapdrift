// @ts-check

/**
 * Returns a function that schedules async tasks with at most `limit` running concurrently.
 * @param {number} limit
 * @returns {<T>(fn: () => Promise<T>) => Promise<T>}
 */
export function createConcurrencyLimiter(limit) {
  let active = 0;
  /** @type {Array<() => void>} */
  const queue = [];
  return function run(fn) {
    return new Promise((resolve, reject) => {
      const execute = () => {
        active++;
        fn().then(resolve, reject).finally(() => {
          active--;
          if (queue.length > 0) queue.shift()();
        });
      };
      if (active < limit) execute();
      else queue.push(execute);
    });
  };
}
