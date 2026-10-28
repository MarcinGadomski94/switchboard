/**
 * `work` over `items` with at most `limit` running at once; the answers keep the
 * items' order. D144: the Diff, its count and turn checkpoints read a session's
 * working trees a few at a time instead of one after another.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      out[index] = await work(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  return out;
}
