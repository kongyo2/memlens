import { z } from "zod";

/**
 * Claude Code auto memory のコントラクト。
 *
 * 公式実装の根拠は
 *   - src/memdir/memoryTypes.ts (MEMORY_TYPES, parseMemoryType)
 *   - src/memdir/memdir.ts (MAX_ENTRYPOINT_LINES, MAX_ENTRYPOINT_BYTES)
 *   - src/memdir/memoryScan.ts (MAX_MEMORY_FILES, FRONTMATTER_MAX_LINES)
 *   - src/memdir/paths.ts (isAutoMemoryEnabled, getAutoMemPath の env precedence)
 *   - src/tools/AgentTool/agentMemory.ts (subagent memory の配置)
 *   - src/utils/sessionStoragePortable.ts (sanitizePath, MAX_SANITIZED_LENGTH=200)
 * と、 公式ドキュメント (docs/memory.md, docs/errors.md, docs/sessions.md) を参照。
 */

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export const memoryTypeSchema = z.enum(MEMORY_TYPES);
export type MemoryType = z.infer<typeof memoryTypeSchema>;

/** 公式 parseMemoryType と同じ挙動: 未知値は undefined フォールバック。 */
export function parseMemoryType(raw: unknown): MemoryType | undefined {
  if (typeof raw !== "string") return undefined;
  return (MEMORY_TYPES as readonly string[]).includes(raw) ? (raw as MemoryType) : undefined;
}

/** 公式実装と揃える定数。値は src/memdir/* と公式ドキュメントを直接参照して決定。 */
export const MEMORY_CONSTANTS = {
  /** MEMORY.md の entrypoint としてロードされる最大行数 (src/memdir/memdir.ts:35)。 */
  MAX_ENTRYPOINT_LINES: 200,
  /** MEMORY.md の entrypoint バイト上限 (src/memdir/memdir.ts:38)。 */
  MAX_ENTRYPOINT_BYTES: 25_000,
  /**
   * 上限超過時に公式が求める書き直し目標行数。 docs/errors.md の over-limit
   * エラー例: "Rewrite it to under 140 lines now"。
   */
  INDEX_REWRITE_TARGET_LINES: 140,
  /** index 1 エントリの推奨長 (memdir.ts buildMemoryLines: "under ~150 characters")。 */
  INDEX_ENTRY_TARGET_CHARS: 150,
  /**
   * これを超える index 行は本文を抱え込んでいる (公式 consolidation prompt:
   * "if an index line is over ~200 chars ... shorten the line, move the detail")。
   */
  INDEX_ENTRY_MAX_CHARS: 200,
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
  /** user スコープの subagent memory: <memoryBase>/agent-memory/<agent>/ (agentMemory.ts)。 */
  AGENT_MEMORY_DIRNAME: "agent-memory",
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
export type MemoryFrontmatterWrite = z.infer<typeof memoryFrontmatterWriteSchema>;

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
  /**
   * frontmatter の `modified` (Claude Code v2.1.214+ が書き込み時に記録する
   * ISO 8601) を epoch ms にしたもの。 無ければ null。
   */
  modifiedMs: z.number().nullable(),
  /**
   * frontmatter のフェンスはあるが YAML として読めない。 この場合 Claude Code
   * にも name / description / type が見えない (recall で選ばれにくくなる)。
   */
  frontmatterInvalid: z.boolean(),
});
export type MemoryHeader = z.infer<typeof memoryHeaderSchema>;

/** MEMORY.md 内の 1 行に関する指摘 (line は raw ファイルの 1 始まり行番号)。 */
export const indexLineIssueSchema = z.object({
  line: z.number(),
  /** 行の文字数 (code point 単位)。 */
  length: z.number(),
  /** 表示用に短くした行テキスト。 */
  preview: z.string(),
});

export const indexDanglingLinkSchema = z.object({
  line: z.number(),
  /** リンク先 (memoryDir 相対, `/` 区切り)。 */
  target: z.string(),
});

/**
 * MEMORY.md の手入れ状況。 公式の index ルール (memdir.ts / consolidation
 * prompt) に照らした指摘をまとめる:
 *   - index は frontmatter を持たない
 *   - 1 エントリ 1 行・~150 文字。 ~200 文字超の行は本文を抱えている
 *   - 古い・存在しない memory へのポインタは消す / 新しい memory は追記する
 */
export const indexHealthSchema = z.object({
  hasFrontmatter: z.boolean(),
  longEntries: z.array(indexLineIssueSchema),
  danglingLinks: z.array(indexDanglingLinkSchema),
  /** index からリンクされていない top-level の memory ファイル (memoryDir 相対)。 */
  orphans: z.array(z.string()),
  /** index からリンクされている実在ファイル (memoryDir 相対, `/` 区切り)。 */
  linkedFiles: z.array(z.string()),
});
export type IndexHealth = z.infer<typeof indexHealthSchema>;

/** MEMORY.md インデックスの読み出し結果。 */
export const memoryIndexResultSchema = z.object({
  path: z.string(),
  /** ディスク上の raw 内容 (truncate 前)。 */
  content: z.string(),
  /** Claude Code が実際にロードする内容 (frontmatter / HTML コメント除去 + 上限で切った後)。 */
  loadedContent: z.string(),
  /** 上限で切られてロードされない部分 (切られていなければ空文字)。 */
  droppedContent: z.string(),
  /** frontmatter / コメント除去後の行数 (公式と同じ測り方)。 */
  lineCount: z.number(),
  /** frontmatter / コメント除去後の文字数 (公式は string length で 25KB を測る)。 */
  byteCount: z.number(),
  /** 実際にロードされる行数。 */
  loadedLineCount: z.number(),
  wasLineTruncated: z.boolean(),
  wasByteTruncated: z.boolean(),
  exists: z.boolean(),
  health: indexHealthSchema,
});
export type MemoryIndexResult = z.infer<typeof memoryIndexResultSchema>;

/**
 * 一覧に並ぶ memory ディレクトリの種類。
 *   - project: ~/.claude/projects/<sanitized>/memory/
 *   - custom:  autoMemoryDirectory / cowork override が projects/ の外を指すとき
 *   - agent:   user スコープの subagent memory (<memoryBase>/agent-memory/<agent>/)
 */
export const memoryProjectKindSchema = z.enum(["project", "custom", "agent"]);
export type MemoryProjectKind = z.infer<typeof memoryProjectKindSchema>;

/** 一覧に並ぶ 1 つの memory ディレクトリ。 */
export const memoryProjectSchema = z.object({
  kind: memoryProjectKindSchema,
  /**
   * 一意な識別名。 project は物理フォルダ名 (sanitize 済み, 例:
   * "C--Users-alice-projects-foo")、 custom は "(custom) <basename>"、 agent は
   * "agent:<dir>"。 sanitize 済み名は英数字と `-` だけなので衝突しない。
   */
  name: z.string(),
  /** UI に出す短い名前 (agent は agent 名、 それ以外は name と同じ)。 */
  displayName: z.string(),
  /** memoryDir の絶対パス (末尾 sep 付き, NFC)。 */
  memoryDir: z.string(),
  /** projectDir の絶対パス (末尾 sep 付き, NFC)。 */
  projectDir: z.string(),
  /** 元のワークツリーパス (復元できなければ null)。 */
  decodedProjectPath: z.string().nullable(),
  /**
   * decodedProjectPath の確からしさ。 transcript = セッション記録の cwd から
   * 取得 (sanitize して一致を確認済み)、 guess = フォルダ名からの推測 (`-` が
   * `/` か `-` か区別できないので不正確になりうる)。
   */
  projectPathSource: z.enum(["transcript", "guess"]).nullable(),
  /** memory ファイル個数 (MEMORY.md を含む実 .md 数)。 */
  fileCount: z.number(),
  /** memoryDir に MEMORY.md が存在するか。 */
  hasIndex: z.boolean(),
  /** memoryDir 直下の最新更新時刻 (空なら 0)。 */
  lastModifiedMs: z.number(),
});
export type MemoryProject = z.infer<typeof memoryProjectSchema>;

/**
 * 値の出どころ。 shell = memlens 起動時の環境変数、 それ以外は settings ファイル
 * (の `env` ブロックを含む) の層。
 */
export const valueOriginSchema = z.enum(["shell", "policy", "flag", "user"]);
export type ValueOrigin = z.infer<typeof valueOriginSchema>;

/** auto memory 設定 (env + settings.json から解決)。 */
export const memorySettingsSchema = z.object({
  /** 最終的に auto memory が有効か。 */
  enabled: z.boolean(),
  /** どの優先度層で値が決まったか (UI でその根拠を提示するため)。 */
  enabledSource: z.enum([
    "env-safe-mode",
    "env-disable",
    "env-simple",
    "env-remote",
    "settings",
    "default",
  ]),
  /** enabled を決めた環境変数 / 設定キーの出どころ (default のときは null)。 */
  enabledOrigin: valueOriginSchema.nullable(),
  /**
   * autoMemoryDirectory の解決結果 (絶対 path, 末尾 sep, NFC)。
   * 優先順 (公式 src/memdir/paths.ts:223):
   *   1. CLAUDE_COWORK_MEMORY_PATH_OVERRIDE (`cowork` source)
   *   2. settings.autoMemoryDirectory: policy → flag → user
   *      (公式は project / local も含むが GUI に cwd が無いため memlens は対象外)
   */
  autoMemoryDirectory: z.string().nullable(),
  /** どの層が autoMemoryDirectory を提供したか。 */
  autoMemoryDirectorySource: z.enum(["cowork", "policy", "flag", "user"]).nullable(),
  /** cowork override の環境変数がどこで設定されたか (cowork 以外は null)。 */
  autoMemoryDirectoryOrigin: valueOriginSchema.nullable(),
  /** Claude Code の設定ディレクトリ (CLAUDE_CONFIG_DIR, 既定 ~/.claude)。 */
  configDir: z.string(),
  /** memory の base (CLAUDE_CODE_REMOTE_MEMORY_DIR があればそれ、 無ければ configDir)。 */
  baseDir: z.string(),
  /** CLAUDE_CODE_REMOTE_MEMORY_DIR が設定されていればその値。 */
  remoteMemoryDir: z.string().nullable(),
  /**
   * 有効な CLAUDE_CODE_PROJECT_DIR_NAME (v2.1.234+)。 CLAUDE_CONFIG_DIR と併用時
   * だけ効き、 cwd に関係なく projects/<name>/ が使われる。
   */
  projectDirName: z.string().nullable(),
  /**
   * 適用された managed policy のソース。 mdm = macOS 構成プロファイル /
   * Windows HKLM、 file = managed-settings.json (+ .d)、 hkcu = Windows HKCU。
   */
  policySource: z.enum(["mdm", "file", "hkcu"]).nullable(),
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
  /** ヒットした project の識別名。 */
  projectName: z.string(),
  /** ヒットした project の memoryDir (末尾 sep 付き)。 */
  memoryDir: z.string(),
  /** UI 表示用の project ラベル (decodedProjectPath ?? displayName)。 */
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
export type GlobalMemorySearchResult = z.infer<typeof globalMemorySearchResultSchema>;

/** 新規 memory ファイル作成リクエスト。 */
export const createMemoryRequestSchema = z.object({
  memoryDir: z.string(),
  /** ファイル名 (kebab-case 推奨, `.md` は省略可)。 */
  filename: z.string().min(1),
  frontmatter: memoryFrontmatterWriteSchema,
  body: z.string(),
  /**
   * 公式の保存手順 (Step 2) と同じく、 MEMORY.md に
   * `- [Title](file.md) — one-line hook` のポインタ行を追記する。
   */
  addToIndex: z.boolean().optional(),
});
export type CreateMemoryRequest = z.infer<typeof createMemoryRequestSchema>;

/**
 * 保存の前提条件。 null なら検査せずに書く (ユーザが「上書き」を選んだとき)。
 * content は編集を始めた時点のディスク上の raw 内容で、 null は「まだ存在しない」。
 */
export const writeExpectationSchema = z.object({ content: z.string().nullable() }).nullable();
export type WriteExpectation = z.infer<typeof writeExpectationSchema>;

/**
 * 保存結果。 conflict は「編集を始めた時点の内容」とディスク上の内容が
 * 食い違った (Claude Code などが並行して書き換えた) ことを表し、 何も書かない。
 * current はディスク上の最新内容 (削除されていれば null)。
 */
export const writeResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("saved") }),
  z.object({ status: z.literal("conflict"), current: z.string().nullable() }),
]);
export type WriteResult = z.infer<typeof writeResultSchema>;

/** rename の結果。 */
export const renameResultSchema = z.object({
  /** rename 後の絶対パス。 */
  path: z.string(),
  /** MEMORY.md 内で張り替えたリンクの数。 */
  indexLinksUpdated: z.number(),
});
export type RenameResult = z.infer<typeof renameResultSchema>;
