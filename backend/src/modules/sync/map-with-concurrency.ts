/**
 * Bounded map concurrency for Sync.
 *
 * Sync All must process accounts with a bounded pool — never
 * `Promise.all(accounts.map(...))` on unlimited storage accounts — and
 * within-account folder listing uses the same helper. Failures propagate like
 * `Promise.all` (first rejection wins) but the pool never starts more than
 * `concurrency` tasks at once.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++
      if (index >= items.length) return
      results[index] = await fn(items[index], index)
    }
  }

  const poolSize = Math.max(1, Math.min(concurrency, items.length))
  await Promise.all(Array.from({ length: poolSize }, () => worker()))
  return results
}