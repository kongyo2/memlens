import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import { basename, dirname, join, normalize, resolve, sep } from "node:path";

import { shell } from "electron";

import type { ParsedMemoryFile } from "@shared/api/contract.ts";
import {
  type CreateMemoryRequest,
  MEMORY_CONSTANTS,
  type MemoryHeader,
  type MemoryIndexResult,
  type MemoryProject,
  type MemorySearchHit,
  type MemorySearchResult,
  type MemorySettings,
} from "@shared/schema/memory.ts";

import { mapConcurrent } from "./concurrency.ts";
import {
  buildFrontmatterText,
  extractMemoryType,
  extractStringField,
  parseFrontmatter,
} from "./frontmatter.ts";
import { findCanonicalGitRoot } from "./gitRoot.ts";
import { computeLoadedIndex } from "./indexLoad.ts";
import { readFileHead } from "./readFileHead.ts";
import { guessProjectPath, sanitizePath } from "./sanitize.ts";
import { resolveMemorySettings } from "./settings.ts";

const {
  ENTRYPOINT_NAME,
  FRONTMATTER_MAX_LINES,
  MAX_MEMORY_FILES,
  MAX_SANITIZED_LENGTH,
  MEMORY_DIRNAME,
} = MEMORY_CONSTANTS;

const SEARCH_FILE_LIMIT = 500;
const SEARCH_HITS_LIMIT = 200;
const SEARCH_EXCERPT_RADIUS = 80;

/**
 * Windows の予約デバイス名。 拡張子が付いても invalid なまま (`CON.md` 等) なので
 * stem (最初の `.` まで) を大文字小文字無視で照合する。 MS のファイル名規約は
 * 上付き数字の COM¹–COM³ / LPT¹–LPT³ も予約名として挙げているため含める。
 */
const WINDOWS_RESERVED_NAME_RE =
  /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;

/**
 * fs.* 並列度の上限。 Windows は EMFILE が出やすいので保守的に。 1 projectFromEntry
 * あたり readdir + 複数 stat を発行するので、 全プロジェクトを完全並列にすると
 * 数百〜数千 fd を瞬間消費しうる。
 */
const FS_CONCURRENCY = 16;

function normalizePath(p: string): string {
  return normalize(p).normalize("NFC");
}

function projectsRoot(settings: MemorySettings): string {
  return normalizePath(join(settings.baseDir, "projects"));
}

/**
 * recursive readdir が返す相対 path が memoryDir 直下の MEMORY.md か判定する。
 *
 * `f === ENTRYPOINT_NAME` だけで判定すると POSIX / Windows 双方を別個に扱える
 * (Node の readdir は基本 native sep を使うが、 念のため両方チェックする)。
 */
function isTopLevelEntrypoint(relativePath: string): boolean {
  return (
    relativePath === ENTRYPOINT_NAME ||
    relativePath === `.${sep}${ENTRYPOINT_NAME}`
  );
}

/**
 * Renderer から渡されたパスが、許可された memory root のいずれかの配下にあることを保証。
 *
 * 許可される root:
 *   - <baseDir>/projects/   (通常ケース)
 *   - autoMemoryDirectory   (settings 明示指定)
 */
function buildPathGuard(settings: MemorySettings): (absPath: string) => void {
  const roots: string[] = [projectsRoot(settings)];
  if (settings.autoMemoryDirectory) {
    roots.push(
      normalizePath(settings.autoMemoryDirectory).replace(/[/\\]+$/, ""),
    );
  }
  return (absPath) => {
    const candidate = normalizePath(absPath);
    for (const root of roots) {
      if (candidate === root || candidate.startsWith(root + sep)) return;
    }
    throw new Error(`Path escapes allowed memory roots: ${absPath}`);
  };
}

/**
 * 公開 API: 任意の path が memory root の配下にあることを検証。
 *
 * IPC の watch 系 handler が、 fs.watch を呼ぶ前にこのチェックを通す。 invoke 系
 * は各サービス関数内部で同じガードを通している (二重チェックを避けるため共用)。
 */
export async function assertPathAllowed(absPath: string): Promise<void> {
  const settings = await resolveMemorySettings();
  buildPathGuard(settings)(absPath);
}

/** memory ディレクトリ 1 つ分の一覧メタ情報。 */
type MemoryDirStats = {
  readonly fileCount: number;
  readonly hasIndex: boolean;
  readonly lastModifiedMs: number;
};

/**
 * memoryDir を走査して fileCount / hasIndex / lastModifiedMs を集計する。
 * 通常プロジェクト (projectFromEntry) と virtual project (custom dir) が
 * 同じロジックを共有する。 memoryDir が存在しない / directory でないときは null。
 *
 * 1) 一覧と hasIndex 判定はメタ情報走査だけで完結する。 hasIndex は memoryDir
 *    直下の MEMORY.md のみ (team/MEMORY.md のようなネストした index は
 *    listFiles と同じく通常ファイル扱い)。
 * 2) lastModifiedMs は per-file stat の MAX (memory dir 自体の mtime は
 *    Windows/ext4 で memory file の rewrite ごとには更新されない可能性があり、
 *    auto memory の最新化が UI 上の sort に反映されないバグの原因になっていた)。
 *    並列に集約するので O(N) でも N≤200 cap 内では負担にならない。
 */
async function scanMemoryDirStats(
  memoryDir: string,
): Promise<MemoryDirStats | null> {
  let dirMtimeMs: number;
  try {
    const stat = await fs.stat(memoryDir);
    if (!stat.isDirectory()) return null;
    dirMtimeMs = stat.mtimeMs;
  } catch {
    return null;
  }
  let entries: Dirent[];
  try {
    entries = await fs.readdir(memoryDir, {
      withFileTypes: true,
      recursive: true,
    });
  } catch {
    entries = [];
  }
  let hasIndex = false;
  const mdRelPaths: string[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!e.name.endsWith(".md")) continue;
    const rel = relativeFromDirent(e, memoryDir);
    mdRelPaths.push(rel);
    if (isTopLevelEntrypoint(rel)) hasIndex = true;
  }
  const mtimes = await mapConcurrent(
    mdRelPaths,
    FS_CONCURRENCY,
    async (rel) => {
      try {
        const st = await fs.stat(join(memoryDir, rel));
        return st.mtimeMs;
      } catch {
        return 0;
      }
    },
  );
  // lastModifiedMs は「dir 自体の mtime と全ファイル mtime の MAX」。
  //   - in-place rewrite はファイル mtime だけを進める (dir は変わらない)
  //   - 削除 / rename は dir mtime だけを進める (残存ファイルは変わらない)
  // 片方だけ見るとどちらかの操作が sort に反映されない。
  let lastModifiedMs = dirMtimeMs;
  for (const m of mtimes) {
    if (m > lastModifiedMs) lastModifiedMs = m;
  }
  return { fileCount: mdRelPaths.length, hasIndex, lastModifiedMs };
}

async function projectFromEntry(
  root: string,
  name: string,
): Promise<MemoryProject | null> {
  const projectDir = join(root, name);
  const memoryDir = join(projectDir, MEMORY_DIRNAME);
  const stats = await scanMemoryDirStats(memoryDir);
  if (stats === null) return null;
  return {
    name,
    memoryDir: normalizePath(memoryDir) + sep,
    projectDir: normalizePath(projectDir) + sep,
    decodedProjectPath: guessProjectPath(name),
    ...stats,
  };
}

/**
 * `recursive: true` で readdir した Dirent から memoryDir 起点の相対 path を作る。
 * Node の Dirent.parentPath は memoryDir 起点の絶対 path を返すので、 そこから
 * 切り出す。
 *
 * engines の下限 Node 20.10–20.11 では親 dir は旧名の `path` プロパティにしか
 * 入っていない (20.12 / 21.4 で `parentPath` に改名)。 `parentPath` だけ見ると
 * 旧 Node で全ネスト entry が memoryDir 直下扱いになり、 team/MEMORY.md を
 * top-level index と誤認する。 両方を見る。
 */
function relativeFromDirent(d: Dirent, memoryDir: string): string {
  const compat = d as { parentPath?: string; path?: string };
  const parent = compat.parentPath ?? compat.path ?? memoryDir;
  if (parent === memoryDir) return d.name;
  return join(parent.slice(memoryDir.length + 1), d.name);
}

export async function listProjects(): Promise<MemoryProject[]> {
  const settings = await resolveMemorySettings();
  const root = projectsRoot(settings);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const projects = await mapConcurrent(
    entries.filter((e) => e.isDirectory()),
    FS_CONCURRENCY,
    (e) => projectFromEntry(root, e.name),
  );
  const out = projects.filter((p): p is MemoryProject => p !== null);

  // autoMemoryDirectory が通常一覧に出ない場所を指す場合、virtual project として
  // 追加。 stats は通常プロジェクトと同じ per-file mtime 集計を使う。 dir が
  // まだ作られていなくても entry 自体は出す (Claude Code は初回書き込みで
  // 遅延作成するため、「これから使われる場所」を見せておく方が分かりやすい)。
  if (settings.autoMemoryDirectory) {
    const normalized = normalizePath(settings.autoMemoryDirectory).replace(
      /[/\\]+$/,
      "",
    );
    if (!isListedUnderProjectsRoot(normalized, root)) {
      const stats = (await scanMemoryDirStats(normalized)) ?? {
        fileCount: 0,
        hasIndex: false,
        lastModifiedMs: 0,
      };
      out.push({
        name: `(custom) ${basename(normalized) || normalized}`,
        memoryDir: normalizePath(normalized) + sep,
        projectDir: normalizePath(dirname(normalized)) + sep,
        decodedProjectPath: normalized,
        ...stats,
      });
    }
  }

  return out.sort((a, b) => {
    if (b.lastModifiedMs !== a.lastModifiedMs) {
      return b.lastModifiedMs - a.lastModifiedMs;
    }
    return a.name.localeCompare(b.name);
  });
}

/**
 * memoryDir が通常の一覧 (projectFromEntry) で既に表示される場所かどうか。
 *
 * 通常一覧が表示するのは <projectsRoot>/<name>/memory の形だけなので、
 * projects root 配下でもその形でない custom dir (深い階層や別名ディレクトリ)
 * は virtual project として追加しないと UI から不可視になる。
 */
function isListedUnderProjectsRoot(memoryDir: string, root: string): boolean {
  if (basename(memoryDir) !== MEMORY_DIRNAME) return false;
  const projectDir = dirname(memoryDir);
  return dirname(projectDir) === root && basename(projectDir).length > 0;
}

export async function listFiles(memoryDir: string): Promise<MemoryHeader[]> {
  const settings = await resolveMemorySettings();
  const guard = buildPathGuard(settings);
  guard(memoryDir);
  let files: string[];
  try {
    files = await fs.readdir(memoryDir, { recursive: true });
  } catch {
    return [];
  }
  // 直下の MEMORY.md だけが「auto memory の index」で、 readIndex 経由で別 UI を持つ。
  // team subdirectory の MEMORY.md (e.g. <memoryDir>/team/MEMORY.md) はそれ自体が
  // memory file なので一覧に残す。 公式 scanMemoryFiles (src/memdir/memoryScan.ts:42)
  // は `basename(f) !== 'MEMORY.md'` でフィルタしているが、 team-mem では
  // findRelevantMemories 側で別経路に分けるためここの差分が UX に出ない。 memlens は
  // GUI なので「team の MEMORY.md も普通に閲覧/編集できる」方が直感的。
  const mdFiles = files.filter(
    (f) => f.endsWith(".md") && !isTopLevelEntrypoint(f),
  );
  const headers = await mapConcurrent(
    mdFiles,
    FS_CONCURRENCY,
    async (relativePath): Promise<MemoryHeader | null> => {
      const filePath = join(memoryDir, relativePath);
      const [stat, head] = await Promise.all([
        fs.stat(filePath).catch(() => null),
        readFileHead(filePath, FRONTMATTER_MAX_LINES),
      ]);
      if (!stat || !stat.isFile() || !head) return null;
      const limited =
        head.content.split(/\r?\n/).slice(0, FRONTMATTER_MAX_LINES).join("\n") +
        "\n";
      const { frontmatter } = parseFrontmatter(limited);
      return {
        filename: relativePath.replaceAll("\\", "/"),
        filePath,
        mtimeMs: stat.mtimeMs,
        byteSize: stat.size,
        name: extractStringField(frontmatter, "name"),
        description: extractStringField(frontmatter, "description"),
        type: extractMemoryType(frontmatter),
      };
    },
  );
  return headers
    .filter((h): h is MemoryHeader => h !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_MEMORY_FILES);
}

export async function readFile(absPath: string): Promise<ParsedMemoryFile> {
  const settings = await resolveMemorySettings();
  buildPathGuard(settings)(absPath);
  const [stat, raw] = await Promise.all([
    fs.stat(absPath),
    fs.readFile(absPath, { encoding: "utf8" }),
  ]);
  const { frontmatter, body } = parseFrontmatter(raw);
  return {
    path: absPath,
    raw,
    frontmatter,
    body,
    mtimeMs: stat.mtimeMs,
  };
}

export async function writeFile(absPath: string, raw: string): Promise<void> {
  const settings = await resolveMemorySettings();
  buildPathGuard(settings)(absPath);
  await fs.mkdir(dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, raw, { encoding: "utf8" });
}

export async function deleteFile(absPath: string): Promise<void> {
  const settings = await resolveMemorySettings();
  buildPathGuard(settings)(absPath);
  if (isProtectedEntrypoint(absPath, settings)) {
    throw new Error(
      `${ENTRYPOINT_NAME} cannot be deleted; clear its content via the editor instead.`,
    );
  }
  await fs.unlink(absPath);
}

/**
 * absPath が「memory root 直下の MEMORY.md」 (= readIndex が扱う index 本体)
 * かどうか。 listFiles は team/MEMORY.md のようなネストした index を通常の
 * memory file として一覧に出すので、 削除禁止は本物の entrypoint に限定する
 * (basename だけで弾くと、 一覧に出るのに消せないファイルが生まれる)。
 */
function isProtectedEntrypoint(
  absPath: string,
  settings: MemorySettings,
): boolean {
  const candidate = normalizePath(absPath);
  if (basename(candidate) !== ENTRYPOINT_NAME) return false;
  const memoryDir = dirname(candidate);
  if (settings.autoMemoryDirectory) {
    const custom = normalizePath(settings.autoMemoryDirectory).replace(
      /[/\\]+$/,
      "",
    );
    if (memoryDir === custom) return true;
  }
  const root = projectsRoot(settings);
  return (
    basename(memoryDir) === MEMORY_DIRNAME &&
    dirname(dirname(memoryDir)) === root
  );
}

export async function createFile(
  req: CreateMemoryRequest,
): Promise<MemoryHeader> {
  const settings = await resolveMemorySettings();
  const guard = buildPathGuard(settings);
  guard(req.memoryDir);
  const filename = req.filename.endsWith(".md")
    ? req.filename
    : `${req.filename}.md`;
  // 内部に path separator を含めない (サブディレクトリは別 API で許可する想定)
  if (filename.includes("/") || filename.includes("\\")) {
    throw new Error("filename must not contain path separators");
  }
  // Windows で無効な文字 / 制御文字は fs 側の cryptic な EINVAL になる前に
  // 明確なエラーで弾く (memlens の第一ターゲットは Windows 11)。
  // oxlint-disable-next-line no-control-regex -- 制御文字そのものを検査したい
  if (/[<>:"|?*\u0000-\u001f]/.test(filename)) {
    throw new Error("filename contains characters that are invalid on Windows");
  }
  if (WINDOWS_RESERVED_NAME_RE.test(filename)) {
    throw new Error("filename is a reserved device name on Windows");
  }
  if (filename === ENTRYPOINT_NAME) {
    throw new Error(`Use writeIndex to manage ${ENTRYPOINT_NAME}`);
  }
  const target = join(req.memoryDir, filename);
  guard(target);
  await fs.mkdir(req.memoryDir, { recursive: true });
  const text = buildFrontmatterText(req.frontmatter) + req.body.trimStart();
  // `wx` で O_EXCL を立て、 access → write 間の race を防ぐ。 同名ファイルが
  // 既にあれば EEXIST が飛ぶのでそれをユーザ向けエラーに変換する。
  try {
    await fs.writeFile(target, text, { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: string }).code === "EEXIST"
    ) {
      throw new Error(`File already exists: ${filename}`, { cause: err });
    }
    throw err;
  }
  const stat = await fs.stat(target);
  return {
    filename,
    filePath: target,
    mtimeMs: stat.mtimeMs,
    byteSize: stat.size,
    name: req.frontmatter.name,
    description: req.frontmatter.description,
    type: req.frontmatter.type,
  };
}

export async function readIndex(memoryDir: string): Promise<MemoryIndexResult> {
  const settings = await resolveMemorySettings();
  buildPathGuard(settings)(memoryDir);
  const indexPath = join(memoryDir, ENTRYPOINT_NAME);
  let raw: string;
  try {
    raw = await fs.readFile(indexPath, { encoding: "utf8" });
  } catch {
    return {
      path: indexPath,
      content: "",
      loadedContent: "",
      lineCount: 0,
      byteCount: 0,
      wasLineTruncated: false,
      wasByteTruncated: false,
      exists: false,
    };
  }
  // 公式のロード経路 (claudemd.ts) と同じく frontmatter / block-level HTML
  // コメントを除去した内容に対して 200 行 / 25KB を測る。 raw はエディタ用に
  // そのまま返す。
  const t = computeLoadedIndex(raw);
  return {
    path: indexPath,
    content: raw,
    loadedContent: t.content,
    lineCount: t.lineCount,
    byteCount: t.byteCount,
    wasLineTruncated: t.wasLineTruncated,
    wasByteTruncated: t.wasByteTruncated,
    exists: true,
  };
}

export async function writeIndex(
  memoryDir: string,
  content: string,
): Promise<void> {
  const settings = await resolveMemorySettings();
  buildPathGuard(settings)(memoryDir);
  await fs.mkdir(memoryDir, { recursive: true });
  const indexPath = join(memoryDir, ENTRYPOINT_NAME);
  await fs.writeFile(indexPath, content, { encoding: "utf8" });
}

export async function search(
  memoryDir: string,
  query: string,
): Promise<MemorySearchResult> {
  const settings = await resolveMemorySettings();
  buildPathGuard(settings)(memoryDir);
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return { query, hits: [], scanned: 0, truncated: false };
  }
  const needle = trimmed.toLowerCase();
  let files: string[];
  try {
    files = await fs.readdir(memoryDir, { recursive: true });
  } catch {
    return { query, hits: [], scanned: 0, truncated: false };
  }
  // readdir(recursive) は directory や .md 以外の entry も返すので、 上限判定は
  // .md に絞った後で行う (絞る前だと大量の非 .md があるだけで truncated 扱いに
  // なってしまう)。
  const allMd = files.filter((f) => f.endsWith(".md"));
  const mdFiles = allMd.slice(0, SEARCH_FILE_LIMIT);
  let truncated = allMd.length > SEARCH_FILE_LIMIT;

  type FileRead = {
    relativePath: string;
    filePath: string;
    raw: string | null;
  };
  const reads: readonly FileRead[] = await mapConcurrent(
    mdFiles,
    FS_CONCURRENCY,
    async (relativePath): Promise<FileRead> => {
      const filePath = join(memoryDir, relativePath);
      try {
        const raw = await fs.readFile(filePath, { encoding: "utf8" });
        return { relativePath, filePath, raw };
      } catch {
        return { relativePath, filePath, raw: null };
      }
    },
  );

  const hits: MemorySearchHit[] = [];
  let scanned = 0;
  outer: for (const { relativePath, filePath, raw } of reads) {
    if (raw === null) continue;
    scanned++;
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      const idx = line.toLowerCase().indexOf(needle);
      if (idx < 0) continue;
      const start = Math.max(0, idx - SEARCH_EXCERPT_RADIUS);
      const end = Math.min(
        line.length,
        idx + needle.length + SEARCH_EXCERPT_RADIUS,
      );
      const excerpt =
        (start > 0 ? "…" : "") +
        line.slice(start, end) +
        (end < line.length ? "…" : "");
      hits.push({
        filePath,
        filename: relativePath.replaceAll("\\", "/"),
        line: i + 1,
        excerpt,
      });
      if (hits.length >= SEARCH_HITS_LIMIT) {
        truncated = true;
        break outer;
      }
    }
  }
  return { query, hits, scanned, truncated };
}

export async function openInFolder(absPath: string): Promise<void> {
  const settings = await resolveMemorySettings();
  buildPathGuard(settings)(absPath);
  shell.showItemInFolder(absPath);
}

export async function revealInEditor(absPath: string): Promise<void> {
  const settings = await resolveMemorySettings();
  buildPathGuard(settings)(absPath);
  await shell.openPath(absPath);
}

export async function getSettings(): Promise<MemorySettings> {
  return resolveMemorySettings();
}

export async function resolveProjectForPath(
  absPath: string,
): Promise<MemoryProject | null> {
  const settings = await resolveMemorySettings();
  // renderer は "." のような相対 path を投げてくる (cwd バッジ用)。
  // findCanonicalGitRoot / sanitizePath は絶対 path 前提なので先に解決する
  // (相対のままだと ancestor 列挙が空になり常に null が返っていた)。
  const abs = resolve(absPath);
  const canonical = (await findCanonicalGitRoot(abs)) ?? abs;
  const sanitized = sanitizePath(canonical);
  const root = projectsRoot(settings);
  const resolved = await findProjectDirEntry(root, sanitized);
  if (resolved === null) return null;
  return projectFromEntry(root, resolved);
}

/**
 * 公式 findProjectDir (src/utils/sessionStoragePortable.ts:354) の薄い移植。
 *
 * 完全一致がなく、 かつ sanitize 結果が MAX_SANITIZED_LENGTH を超えていれば
 * プレフィックス一致のディレクトリを探す。 Bun.hash と djb2Hash で hash 接尾辞が
 * 違うケース (公式 CLI と memlens で同じ長 path に対して別 sanitized 名になる)
 * を救うためのフォールバック。
 *
 * 公式は `find` で最初の一致を返すが、 同じ 200 char プレフィックスを持つ別パスが
 * 複数登録されていると誤って別プロジェクトを返してしまう (長 path で末尾だけが
 * 違うケース)。 ここでは「一意に決まったとき」だけ返し、 ambiguous なときは null
 * を返して呼び出し元に解決不能であることを伝える。
 */
async function findProjectDirEntry(
  root: string,
  sanitized: string,
): Promise<string | null> {
  try {
    const st = await fs.stat(join(root, sanitized));
    if (st.isDirectory()) return sanitized;
  } catch {
    /* fallthrough */
  }
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return null;
  const prefix = sanitized.slice(0, MAX_SANITIZED_LENGTH);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  let unique: string | null = null;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!e.name.startsWith(prefix + "-")) continue;
    if (unique !== null) {
      // 同じ 200-char prefix にぶつかる別パスが既にある → 解決不能。
      return null;
    }
    unique = e.name;
  }
  return unique;
}
