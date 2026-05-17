/**
 * 並列実行数を上限値で制限しながら順に走らせるシンプルな pool。
 *
 * ~/.claude/projects/ には実運用で 100 以上のサブディレクトリが溜まることが
 * あり、 全件並列 stat/readdir すると Windows で EMFILE / ENFILE になりうる。
 * Node の `fs.promises` は内部 file handle を await 1 つ 1 つ消費するので
 * バースト書きを避けるだけで体感差が出る。
 *
 * `Promise.all` と同じく入力順に結果配列を返すが、 実行は最大 `limit` 並列。
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (limit < 1) throw new RangeError("limit must be >= 1");
  if (items.length === 0) return [];
  const results: R[] = new Array<R>(items.length);
  let cursor = 0;
  async function runOne(): Promise<void> {
    while (cursor < items.length) {
      const i = cursor++;
      const item = items[i] as T;
      // 並列度の本質はここでの逐次 await。 oxlint は並列化を勧めるが、 pool 内の
      // 個別 worker は次タスクへ進む前に終わる必要があるので順次が正しい。
      // oxlint-disable-next-line no-await-in-loop
      results[i] = await worker(item, i);
    }
  }
  const runners: Promise<void>[] = [];
  const n = Math.min(limit, items.length);
  for (let i = 0; i < n; i++) {
    runners.push(runOne());
  }
  await Promise.all(runners);
  return results;
}
