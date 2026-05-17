import { memoryAgeDays } from "@shared/util/format.ts";

import type { Dict } from "../i18n/index.ts";

/**
 * 公式 memoryAge (src/memdir/memoryAge.ts:15) と同等のローカライズ表現。
 *
 *   - 0 日 → today / 今日
 *   - 1 日 → yesterday / 昨日
 *   - 2 日以上 → "{n} days ago" / "{n} 日前"
 *
 * Claude Code 本体は memory の staleness をプロンプトで強調する用途で使うが、
 * memlens UI では list / detail の mtime 表示として軽く使う。
 */
export function formatMemoryAge(mtimeMs: number, t: Dict): string {
  const days = memoryAgeDays(mtimeMs);
  if (days === 0) return t.age.today;
  if (days === 1) return t.age.yesterday;
  return `${String(days)} ${t.age.daysAgoSuffix}`;
}
