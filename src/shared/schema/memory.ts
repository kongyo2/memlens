import { z } from "zod";

/**
 * Claude Code auto memory のコントラクト。
 *
 * 公式実装の根拠は
 *   - src/memdir/memoryTypes.ts (MEMORY_TYPES, parseMemoryType)
 *   - src/memdir/memdir.ts (MAX_ENTRYPOINT_LINES, MAX_ENTRYPOINT_BYTES)
 *   - src/memdir/memoryScan.ts (MAX_MEMORY_FILES, FRONTMATTER_MAX_LINES)
 *   - src/memdir/paths.ts (isAutoMemoryEnabled, getAutoMemPath の env precedence)
 *   - src/utils/sessionStoragePortable.ts (sanitizePath, MAX_SANITIZED_LENGTH=200)
 * を参照。
 */

export const MEMORY_TYPES = [
  "user",
  "feedback",
  "project",
  "reference",
] as const;
export const memoryTypeSchema = z.enum(MEMORY_TYPES);
export type MemoryType = z.infer<typeof memoryTypeSchema>;

/** 公式 parseMemoryType と同じ挙動: 未知値は undefined フォールバック。 */
export function parseMemoryType(raw: unknown): MemoryType | undefined {
  if (typeof raw !== "string") return undefined;
  return (MEMORY_TYPES as readonly string[]).includes(raw)
    ? (raw as MemoryType)
    : undefined;
}

/** 公式実装と揃える定数。値は src/memdir/* を直接参照して決定。 */
export const MEMORY_CONSTANTS = {
  /** MEMORY.md の entrypoint としてロードされる最大行数 (src/memdir/memdir.ts:35)。 */
  MAX_ENTRYPOINT_LINES: 200,
  /** MEMORY.md の entrypoint バイト上限 (src/memdir/memdir.ts:38)。 */
  MAX_ENTRYPOINT_BYTES: 25_000,
  /** scanMemoryFiles の総ファイル上限 (src/memdir/memoryScan.ts:21)。 */
  MAX_MEMORY_FILES: 200,
  /** frontmatter 取得のために先頭から読む行数 (src/memdir/memoryScan.ts:22)。 */
  FRONTMATTER_MAX_LINES: 30,
  /** sanitizePath で 1 path component の上限 (src/utils/sessionStoragePortable.ts:293)。 */
  MAX_SANITIZED_LENGTH: 200,
  /** ~/.claude/projects/<sanitized>/memory/MEMORY.md の固定ファイル名。 */
  ENTRYPOINT_NAME: "MEMORY.md",
  /** ~/.claude/projects/<sanitized>/memory のサブディレクトリ名。 */
  MEMORY_DIRNAME: "memory",
} as const;

/**
 * memlens が UI に渡す frontmatter フィールド集合 (read 用 best-effort)。
 *
 * 公式 ParsedMarkdown.frontmatter は passthrough index signature で任意キーを許す。
 * memlens では以下を主に扱う:
 *   - name        — file slug (任意, 表示名としても使う)
 *   - description — 一覧表示用の 1 行説明
 *   - type        — root 直下の type 値 (Anthropic 推奨形)
 *   - metadata.type — auto memory プロンプトが採用する nested 形 (両方サポート)
 *
 * zod v4 では `.passthrough()` が deprecated のため `z.looseObject` を使う。
 */
export const memoryFrontmatterReadSchema = z.looseObject({
  name: z.string().optional(),
  description: z.string().optional(),
  type: z.string().optional(),
  metadata: z.looseObject({ type: z.string().optional() }).optional(),
});
export type MemoryFrontmatterRead = z.infer<typeof memoryFrontmatterReadSchema>;

/**
 * memlens が新規作成時に書き出す frontmatter の正規形。
 * 公式 MEMORY_FRONTMATTER_EXAMPLE (src/memdir/memoryTypes.ts:261) に合わせて
 * root レベルに type を置く。読み出し時には [[metadata.type]] も両方サポート。
 */
export const memoryFrontmatterWriteSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  type: memoryTypeSchema,
});
export type MemoryFrontmatterWrite = z.infer<
  typeof memoryFrontmatterWriteSchema
>;

/** 一覧表示用ヘッダ。 */
export const memoryHeaderSchema = z.object({
  /** memoryDir からの相対パス (例: "feedback_lint.md" or "sub/dir/topic.md")。 */
  filename: z.string(),
  /** 絶対パス。 */
  filePath: z.string(),
  mtimeMs: z.number(),
  byteSize: z.number(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  type: memoryTypeSchema.nullable(),
});
export type MemoryHeader = z.infer<typeof memoryHeaderSchema>;

/** MEMORY.md インデックスの読み出し結果。 */
export const memoryIndexResultSchema = z.object({
  path: z.string(),
  /** ディスク上の raw 内容 (truncate 前)。 */
  content: z.string(),
  /** Claude Code が実際にロードする truncate 済み内容。 */
  loadedContent: z.string(),
  lineCount: z.number(),
  byteCount: z.number(),
  wasLineTruncated: z.boolean(),
  wasByteTruncated: z.boolean(),
  exists: z.boolean(),
});
export type MemoryIndexResult = z.infer<typeof memoryIndexResultSchema>;

/** ~/.claude/projects/ 配下の 1 プロジェクト。 */
export const memoryProjectSchema = z.object({
  /** 物理フォルダ名 (sanitize 済み, 例: "C--Users-alice-projects-foo")。 */
  name: z.string(),
  /** memoryDir の絶対パス (末尾 sep 付き, NFC)。 */
  memoryDir: z.string(),
  /** projectDir の絶対パス (末尾 sep 付き, NFC)。 */
  projectDir: z.string(),
  /** name から推定した元のワークツリーパス (best-effort, 復元不可なら null)。 */
  decodedProjectPath: z.string().nullable(),
  /** memory ファイル個数 (MEMORY.md を含む実 .md 数)。 */
  fileCount: z.number(),
  /** memoryDir に MEMORY.md が存在するか。 */
  hasIndex: z.boolean(),
  /** memoryDir 直下の最新更新時刻 (空なら 0)。 */
  lastModifiedMs: z.number(),
});
export type MemoryProject = z.infer<typeof memoryProjectSchema>;

/** auto memory 設定 (env + settings.json から解決)。 */
export const memorySettingsSchema = z.object({
  /** 最終的に auto memory が有効か。 */
  enabled: z.boolean(),
  /** どの優先度層で値が決まったか (UI でその根拠を提示するため)。 */
  enabledSource: z.enum([
    "env-disable",
    "env-simple",
    "env-remote",
    "settings",
    "default",
  ]),
  /** settings.json の autoMemoryDirectory (policy/flag/local/user 優先順で解決済み)。 */
  autoMemoryDirectory: z.string().nullable(),
  /** どの settings レイヤーが autoMemoryDirectory を提供したか。 */
  autoMemoryDirectorySource: z
    .enum(["policy", "flag", "local", "user"])
    .nullable(),
  /** ~/.claude のデフォルト base。CLAUDE_CODE_REMOTE_MEMORY_DIR が優先される。 */
  baseDir: z.string(),
  /** CLAUDE_CODE_REMOTE_MEMORY_DIR が設定されていればその値。 */
  remoteMemoryDir: z.string().nullable(),
  /** ~ の展開後の絶対 home directory。 */
  homedir: z.string(),
});
export type MemorySettings = z.infer<typeof memorySettingsSchema>;

/** 検索 1 件のヒット。 */
export const memorySearchHitSchema = z.object({
  filePath: z.string(),
  filename: z.string(),
  /** マッチが見つかった行 (line, raw text)。 */
  line: z.number(),
  excerpt: z.string(),
});
export type MemorySearchHit = z.infer<typeof memorySearchHitSchema>;

export const memorySearchResultSchema = z.object({
  query: z.string(),
  hits: z.array(memorySearchHitSchema),
  /** 走査したファイル数。 */
  scanned: z.number(),
  /** 検索が打ち切られたか (上限を超えた場合 true)。 */
  truncated: z.boolean(),
});
export type MemorySearchResult = z.infer<typeof memorySearchResultSchema>;

/** 新規 memory ファイル作成リクエスト。 */
export const createMemoryRequestSchema = z.object({
  memoryDir: z.string(),
  /** ファイル名 (kebab-case 推奨, `.md` は省略可)。 */
  filename: z.string().min(1),
  frontmatter: memoryFrontmatterWriteSchema,
  body: z.string(),
});
export type CreateMemoryRequest = z.infer<typeof createMemoryRequestSchema>;
