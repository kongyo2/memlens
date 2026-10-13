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
 * memlens UI では list / detail の更新時刻表示として軽く使う。
 */
export function formatMemoryAge(timeMs: number, t: Dict): string {
  const days = memoryAgeDays(timeMs);
  if (days === 0) return t.age.today;
  if (days === 1) return t.age.yesterday;
  return `${String(days)} ${t.age.daysAgoSuffix}`;
}

/**
 * memory の「内容がいつ時点のものか」。 Claude Code v2.1.214+ は書き込みのたびに
 * frontmatter の `modified` を記録する (docs/memory.md: "The timestamp shows how
 * current the fact is")。 fs の mtime は git checkout や同期・コピーで動くので、
 * `modified` があればそちらを優先する。
 */
export function memoryTimeMs(item: {
  readonly modifiedMs: number | null;
  readonly mtimeMs: number;
}): number {
  return item.modifiedMs ?? item.mtimeMs;
}

export type MemoryAgeBucket = "fresh" | "recent" | "aging" | "dormant";

/**
 * 鮮度トレース (list 行の左端) 用の age バケット。
 *
 * `fresh` の境界 (≤1 日) は公式 memoryFreshnessText (src/memdir/memoryAge.ts:35)
 * が staleness 注記を付け始める境界と一致させている: 2 日以上前の memory は
 * Claude Code のプロンプト内で「point-in-time observation」と注記される。
 * それより先の 7 / 30 日は表示専用の減衰段階で、 公式挙動には対応しない。
 */
export function memoryAgeBucket(timeMs: number): MemoryAgeBucket {
  const days = memoryAgeDays(timeMs);
  if (days <= 1) return "fresh";
  if (days <= 7) return "recent";
  if (days <= 30) return "aging";
  return "dormant";
}

/**
 * 公式が staleness 注記を付ける対象 (2 日以上前, src/memdir/memoryAge.ts:33)
 * かどうか。 detail header の "point-in-time" chip の表示条件。
 */
export function isStaleFlagged(timeMs: number): boolean {
  return memoryAgeDays(timeMs) >= 2;
}

/** `2026-07-18 10:00` 形式のローカル日時 (tooltip / detail 用)。 */
export function formatTimestamp(timeMs: number): string {
  const d = new Date(timeMs);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
