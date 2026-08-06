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
  /**
   * autoMemoryDirectory の解決結果 (絶対 path, 末尾 sep, NFC)。
   * 優先順 (公式 src/memdir/paths.ts:223):
   *   1. CLAUDE_COWORK_MEMORY_PATH_OVERRIDE (`cowork` source)
   *   2. settings.autoMemoryDirectory: policy → flag → user
   *      (公式は local も含むが GUI に cwd が無いため memlens は対象外)
   */
  autoMemoryDirectory: z.string().nullable(),
  /** どの層が autoMemoryDirectory を提供したか。 */
  autoMemoryDirectorySource: z
    .enum(["cowork", "policy", "flag", "user"])
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

/** 全プロジェクト横断検索の 1 ヒット (どの project かの情報を持つ)。 */
export const globalMemorySearchHitSchema = memorySearchHitSchema.extend({
  /** ヒットした project の物理フォルダ名 (sanitize 済み)。 */
  projectName: z.string(),
  /** ヒットした project の memoryDir (末尾 sep 付き)。 */
  memoryDir: z.string(),
  /** UI 表示用の project ラベル (decodedProjectPath ?? name)。 */
  projectLabel: z.string(),
});
export type GlobalMemorySearchHit = z.infer<typeof globalMemorySearchHitSchema>;

export const globalMemorySearchResultSchema = z.object({
  query: z.string(),
  hits: z.array(globalMemorySearchHitSchema),
  /** 走査した project 数。 */
  scannedProjects: z.number(),
  /** 走査したファイル総数。 */
  scannedFiles: z.number(),
  /** どこかの project で打ち切りが発生したか。 */
  truncated: z.boolean(),
});
export type GlobalMemorySearchResult = z.infer<
  typeof globalMemorySearchResultSchema
>;

/** 新規 memory ファイル作成リクエスト。 */
export const createMemoryRequestSchema = z.object({
  memoryDir: z.string(),
  /** ファイル名 (kebab-case 推奨, `.md` は省略可)。 */
  filename: z.string().min(1),
  frontmatter: memoryFrontmatterWriteSchema,
  body: z.string(),
});
export type CreateMemoryRequest = z.infer<typeof createMemoryRequestSchema>;
