/**
 * memory 本文の「衛生」チェック (表示用)。
 *
 * Claude Code v2.1.284 の changelog: "invisible characters and tags that imitate
 * Claude Code's own markup are neutralized in MEMORY.md and recalled memory notes
 * before they reach Claude"。 つまりファイルに入っていても Claude には届かない
 * (= ディスク上の内容と Claude が読む内容が食い違う) 箇所で、 Web ページ等の
 * 外部入力から memory に紛れ込んだプロンプトインジェクションの痕跡でもありうる。
 *
 * 判定は公式 partiallySanitizeUnicode (src/utils/sanitization.ts) が除去する
 * 文字クラスに合わせる: 書式制御 (Cf: ゼロ幅文字・双方向制御・タグ文字など) と
 * 私用領域 (Co)。 絵文字の ZWJ シーケンス (👩‍💻 など) の ZWJ だけは正当な用途
 * なので数えない。
 */

export type InvisibleChar = {
  readonly codePoint: number;
  readonly count: number;
};

export type HygieneReport = {
  /** 見えない文字 (code point ごとの出現数、 多い順)。 */
  readonly invisible: readonly InvisibleChar[];
  /** Claude Code 自身のマークアップに見えるタグ名 (重複なし)。 */
  readonly markupTags: readonly string[];
};

const INVISIBLE_RE = /[\p{Cf}\p{Co}]/gu;
const PICTOGRAPHIC_RE = /\p{Extended_Pictographic}/u;
const ZWJ = 0x200d;

/**
 * Claude Code がメッセージの区切りに使う XML 風タグ (src/constants/xml.ts など)。
 * `summary` や `status` のように Markdown / HTML で普通に使われる語は誤検知に
 * なるので、 Claude Code 固有の名前だけに絞る。
 */
const MARKUP_TAG_RE =
  /<\/?(system-reminder|command-(?:name|message|args)|local-command-(?:stdout|stderr|caveat)|bash-(?:input|stdout|stderr)|task-notification|teammate-message|channel-message|cross-session-message|fork-boilerplate|team-memory-content|user-prompt-submit-hook)\b[^>]*>/gi;

function isEmojiZwj(text: string, index: number): boolean {
  // 肌色修飾子や異体字セレクタを挟むこともあるので前後 2 文字分 (4 code unit) を見る。
  const before = text.slice(Math.max(0, index - 4), index);
  const after = text.slice(index + 1, index + 5);
  return PICTOGRAPHIC_RE.test(before) && PICTOGRAPHIC_RE.test(after);
}

export function inspectHygiene(text: string): HygieneReport {
  // ファイル先頭の BOM は書式上の印で、 読み込み時に除かれるので数えない。
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const counts = new Map<number, number>();
  for (const match of body.matchAll(INVISIBLE_RE)) {
    const codePoint = match[0].codePointAt(0) ?? 0;
    if (codePoint === ZWJ && isEmojiZwj(body, match.index)) continue;
    counts.set(codePoint, (counts.get(codePoint) ?? 0) + 1);
  }
  const tags = new Set<string>();
  for (const match of body.matchAll(MARKUP_TAG_RE)) {
    if (match[1]) tags.add(match[1].toLowerCase());
  }
  return {
    invisible: [...counts.entries()]
      .map(([codePoint, count]) => ({ codePoint, count }))
      .sort((a, b) => b.count - a.count || a.codePoint - b.codePoint),
    markupTags: [...tags].sort(),
  };
}

/** `U+200B` 形式の表記。 */
export function formatCodePoint(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** よく見る見えない文字の名前 (それ以外は code point だけ表示する)。 */
const KNOWN_NAMES: ReadonlyMap<number, string> = new Map([
  [0x00ad, "SOFT HYPHEN"],
  [0x200b, "ZERO WIDTH SPACE"],
  [0x200c, "ZERO WIDTH NON-JOINER"],
  [0x200d, "ZERO WIDTH JOINER"],
  [0x200e, "LEFT-TO-RIGHT MARK"],
  [0x200f, "RIGHT-TO-LEFT MARK"],
  [0x202a, "LEFT-TO-RIGHT EMBEDDING"],
  [0x202b, "RIGHT-TO-LEFT EMBEDDING"],
  [0x202c, "POP DIRECTIONAL FORMATTING"],
  [0x202d, "LEFT-TO-RIGHT OVERRIDE"],
  [0x202e, "RIGHT-TO-LEFT OVERRIDE"],
  [0x2060, "WORD JOINER"],
  [0x2066, "LEFT-TO-RIGHT ISOLATE"],
  [0x2067, "RIGHT-TO-LEFT ISOLATE"],
  [0x2068, "FIRST STRONG ISOLATE"],
  [0x2069, "POP DIRECTIONAL ISOLATE"],
  [0xfeff, "ZERO WIDTH NO-BREAK SPACE"],
]);

export function describeCodePoint(codePoint: number): string {
  const name =
    KNOWN_NAMES.get(codePoint) ??
    (codePoint >= 0xe0000 && codePoint <= 0xe007f ? "TAG CHARACTER" : null) ??
    (codePoint >= 0xe000 && codePoint <= 0xf8ff ? "PRIVATE USE" : null);
  return name ? `${formatCodePoint(codePoint)} ${name}` : formatCodePoint(codePoint);
}
