export const DEFAULT_RUN_CONCURRENCY = 3;
export const MAX_RUN_CONCURRENCY = 100;

export function normalizeRunConcurrency(value = DEFAULT_RUN_CONCURRENCY) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RUN_CONCURRENCY) {
    throw new TypeError(`concurrency must be an integer between 1 and ${MAX_RUN_CONCURRENCY}`);
  }
  return value;
}

// A slot covers the entire cell, including retries, sealing, disposal and Judge
// settlement. Drain every active worker before callers release pinned evidence.
export async function mapConcurrentRunCells(cells, { concurrency, signal }, execute) {
  const limit = normalizeRunConcurrency(concurrency);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const results = new Array(cells.length);
  let next = 0;
  let failed = false;
  let failure;
  async function worker() {
    // Caller cancellation records unstarted cells without launching an Agent.
    // An unexpected failure stops scheduling; active peers still drain.
    while (!failed) {
      const index = next++;
      if (index >= cells.length) return;
      try {
        results[index] = await execute(cells[index], controller.signal);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
        abort();
      }
    }
  }
  try {
    await Promise.allSettled(Array.from({ length: Math.min(limit, cells.length) }, worker));
    if (failed) throw failure;
    return results;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
