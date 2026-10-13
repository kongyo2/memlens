import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import { basename, dirname, join, normalize, resolve, sep } from "node:path";

import type { ParsedMemoryFile } from "@shared/api/contract.ts";
import {
  type CreateMemoryRequest,
  type GlobalMemorySearchHit,
  type GlobalMemorySearchResult,
  MEMORY_CONSTANTS,
  type MemoryHeader,
  type MemoryIndexResult,
  type MemoryProject,
  type MemorySearchHit,
  type MemorySearchResult,
  type MemorySettings,
  type RenameResult,
  type WriteExpectation,
  type WriteResult,
} from "@shared/schema/memory.ts";
import { shell } from "electron";

import { mapConcurrent } from "./concurrency.ts";
import {
  buildFrontmatterText,
  extractMemoryType,
  extractModifiedMs,
  extractStringField,
  parseFrontmatter,
  stampModified,
} from "./frontmatter.ts";
import { findCanonicalGitRoot } from "./gitRoot.ts";
import {
  analyzeIndex,
  buildIndexEntry,
  indexPathFor,
  relativeInside,
  removeIndexEntries,
  retargetIndexLinks,
} from "./indexHealth.ts";
import { computeLoadedIndex } from "./indexLoad.ts";
import { projectPathFromTranscripts } from "./projectPath.ts";
import { readFileHead } from "./readFileHead.ts";
import { guessProjectPath, sanitizePath } from "./sanitize.ts";
import { resolveMemorySettings } from "./settings.ts";

const {
  AGENT_MEMORY_DIRNAME,
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
const WINDOWS_RESERVED_NAME_RE = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;

/**
 * fs.* 並列度の上限。 Windows は EMFILE が出やすいので保守的に。 1 projectFromEntry
 * あたり readdir + 複数 stat を発行するので、 全プロジェクトを完全並列にすると
 * 数百〜数千 fd を瞬間消費しうる。
 */
const FS_CONCURRENCY = 16;

function normalizePath(p: string): string {
  return normalize(p).normalize("NFC");
}

function stripTrailingSep(p: string): string {
  return p.replace(/[/\\]+$/, "");
}

function projectsRoot(settings: MemorySettings): string {
  return normalizePath(join(settings.baseDir, "projects"));
}

/** user スコープの subagent memory の置き場 (公式 agentMemory.ts getAgentMemoryDir)。 */
function agentMemoryRoot(settings: MemorySettings): string {
  return normalizePath(join(settings.baseDir, AGENT_MEMORY_DIRNAME));
}

function customDir(settings: MemorySettings): string | null {
  return settings.autoMemoryDirectory
    ? stripTrailingSep(normalizePath(settings.autoMemoryDirectory))
    : null;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** ENOENT / ENOTDIR は「無い」として null、 それ以外の I/O エラーは投げる。 */
async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, { encoding: "utf8" });
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
}

/**
 * 編集結果の改行コードをディスク上の元ファイルに合わせる。 textarea は値を LF に
 * 正規化するので、 CRLF のファイルを編集・保存すると黙って LF に変わっていた。
 */
function matchLineEndings(next: string, reference: string | null): string {
  if (reference === null || !reference.includes("\r\n") || next.includes("\r\n")) return next;
  return next.replace(/\n/g, "\r\n");
}

/**
 * 「読んだ時点の内容から変わっていなければ書く」。 公式 FileWriteTool の
 * staleness check (src/tools/FileWriteTool/FileWriteTool.ts: "File has been
 * modified since read") と同じ考え方で、 Claude Code が並行して memory を書き換えた
 * ときに memlens の保存が黙って上書きしないようにする。 mtime は Windows で内容
 * 無変更でも動く (公式コメント参照) ので内容で比較する。
 *
 *   expected === undefined: 検査しない / null: 存在しないこと / string: その内容であること
 */
async function writeIfUnchanged(
  path: string,
  build: (current: string | null) => string,
  expected: string | null | undefined,
): Promise<WriteResult> {
  const current = await readTextOrNull(path);
  if (expected !== undefined && current !== expected) {
    return { status: "conflict", current };
  }
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, build(current), { encoding: "utf8" });
  return { status: "saved" };
}

/**
 * recursive readdir が返す相対 path が memoryDir 直下の MEMORY.md か判定する。
 *
 * `f === ENTRYPOINT_NAME` だけで判定すると POSIX / Windows 双方を別個に扱える
 * (Node の readdir は基本 native sep を使うが、 念のため両方チェックする)。
 */
function isTopLevelEntrypoint(relativePath: string): boolean {
  return relativePath === ENTRYPOINT_NAME || relativePath === `.${sep}${ENTRYPOINT_NAME}`;
}

/**
 * Renderer から渡されたパスの検証。 memory として扱う場所は次の 3 種類:
 *   - <baseDir>/projects/<project>/memory/  (通常ケース)
 *   - <baseDir>/agent-memory/<agent>/       (user スコープの subagent memory)
 *   - autoMemoryDirectory                   (settings 明示指定)
 *
 * root 配下ならどこでも通すと、 projects/ にある session transcript (.jsonl) を
 * 書き換えたり、 任意の拡張子のファイルを作って revealInEditor (shell.openPath)
 * で実行させたりできてしまう。 そこでディレクトリ操作は memory ディレクトリ
 * そのもの、 ファイル操作はその配下の `.md` だけを受け付ける。
 */
type PathGuard = {
  /** memory ディレクトリそのもの (末尾の区切り文字は可)。 */
  readonly dir: (absPath: string) => void;
  /** memory ディレクトリ配下の `.md` ファイル。 */
  readonly file: (absPath: string) => void;
};

function isMemoryDir(absPath: string, settings: MemorySettings): boolean {
  const candidate = stripTrailingSep(normalizePath(absPath));
  const custom = customDir(settings);
  if (custom !== null && candidate === custom) return true;
  const inProjects = relativeInside(projectsRoot(settings), candidate);
  if (inProjects !== null) {
    const parts = inProjects.split("/");
    return parts.length === 2 && parts[1] === MEMORY_DIRNAME;
  }
  const inAgents = relativeInside(agentMemoryRoot(settings), candidate);
  return inAgents !== null && !inAgents.includes("/");
}

function isMemoryFile(absPath: string, settings: MemorySettings): boolean {
  const candidate = normalizePath(absPath);
  return candidate.endsWith(".md") && memoryDirOf(candidate, settings) !== null;
}

function buildPathGuard(settings: MemorySettings): PathGuard {
  return {
    dir: (absPath) => {
      if (!isMemoryDir(absPath, settings)) {
        throw new Error(`Not an auto memory directory: ${absPath}`);
      }
    },
    file: (absPath) => {
      if (!isMemoryFile(absPath, settings)) {
        throw new Error(`Not a memory file (.md inside a memory directory): ${absPath}`);
      }
    },
  };
}

/**
 * 公開 API: path が memory ディレクトリそのものであることを検証。
 *
 * IPC の watch 系 handler が、 fs.watch を呼ぶ前にこのチェックを通す。 invoke 系
 * は各サービス関数内部で同じガードを通している。
 */
export async function assertMemoryDir(absPath: string): Promise<void> {
  const settings = await resolveMemorySettings();
  buildPathGuard(settings).dir(absPath);
}

/**
 * absPath を含む memory ディレクトリ (末尾 sep 無し)。 projects/<name>/memory、
 * agent-memory/<agent>、 custom dir のいずれか。 該当しなければ null。
 */
function memoryDirOf(absPath: string, settings: MemorySettings): string | null {
  const candidate = normalizePath(absPath);
  const custom = customDir(settings);
  if (custom && (candidate === custom || candidate.startsWith(custom + sep))) return custom;
  const fromRoot = (root: string, depth: number): string | null => {
    const rel = relativeInside(root, candidate);
    if (rel === null) return null;
    const parts = rel.split("/");
    if (parts.length <= depth) return null;
    return join(root, ...parts.slice(0, depth));
  };
  const projectDir = fromRoot(projectsRoot(settings), 2);
  if (projectDir !== null && basename(projectDir) === MEMORY_DIRNAME) return projectDir;
  return fromRoot(agentMemoryRoot(settings), 1);
}

/** memory ディレクトリ 1 つ分の一覧メタ情報。 */
type MemoryDirStats = {
  /** topic file の数 (直下の MEMORY.md は含めない。 catalog の件数と揃える)。 */
  readonly fileCount: number;
  readonly hasIndex: boolean;
  readonly lastModifiedMs: number;
};

/**
 * memoryDir を走査して fileCount / hasIndex / lastModifiedMs を集計する。
 * 通常プロジェクト・virtual project (custom dir)・subagent memory が同じロジックを
 * 共有する。 memoryDir が存在しない / directory でないときは null。
 *
 * 1) 一覧と hasIndex 判定はメタ情報走査だけで完結する。 hasIndex は memoryDir
 *    直下の MEMORY.md のみ (team/MEMORY.md のようなネストした index は
 *    listFiles と同じく通常ファイル扱い)。
 * 2) lastModifiedMs は dir 自体の mtime と per-file stat の MAX。
 *    - in-place rewrite はファイル mtime だけを進める (dir は変わらない)
 *    - 削除 / rename は dir mtime だけを進める (残存ファイルは変わらない)
 */
async function scanMemoryDirStats(memoryDir: string): Promise<MemoryDirStats | null> {
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
    entries = await fs.readdir(memoryDir, { withFileTypes: true, recursive: true });
  } catch {
    entries = [];
  }
  let hasIndex = false;
  let topicCount = 0;
  const mdRelPaths: string[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!e.name.endsWith(".md")) continue;
    const rel = relativeFromDirent(e, memoryDir);
    mdRelPaths.push(rel);
    if (isTopLevelEntrypoint(rel)) hasIndex = true;
    else topicCount++;
  }
  const mtimes = await mapConcurrent(mdRelPaths, FS_CONCURRENCY, async (rel) => {
    try {
      const st = await fs.stat(join(memoryDir, rel));
      return st.mtimeMs;
    } catch {
      return 0;
    }
  });
  let lastModifiedMs = dirMtimeMs;
  for (const m of mtimes) {
    if (m > lastModifiedMs) lastModifiedMs = m;
  }
  return { fileCount: topicCount, hasIndex, lastModifiedMs };
}

async function projectFromEntry(root: string, name: string): Promise<MemoryProject | null> {
  const projectDir = join(root, name);
  const memoryDir = join(projectDir, MEMORY_DIRNAME);
  const stats = await scanMemoryDirStats(memoryDir);
  if (stats === null) return null;
  // 名前からの推測は `-` が `/`・`-`・`.` のどれだったか区別できない。 同じ
  // フォルダの transcript の cwd が取れればそちらを使う。
  const fromTranscript = await projectPathFromTranscripts(projectDir, name);
  const guessed = fromTranscript === null ? guessProjectPath(name) : null;
  return {
    kind: "project",
    name,
    displayName: name,
    memoryDir: normalizePath(memoryDir) + sep,
    projectDir: normalizePath(projectDir) + sep,
    decodedProjectPath: fromTranscript ?? guessed,
    projectPathSource: fromTranscript !== null ? "transcript" : guessed !== null ? "guess" : null,
    ...stats,
  };
}

/**
 * `recursive: true` で readdir した Dirent から memoryDir 起点の相対 path を作る。
 * Node の Dirent.parentPath は memoryDir 起点の絶対 path を返すので、 そこから
 * 切り出す。
 *
 * Node 20.10–20.11 では親 dir は旧名の `path` プロパティにしか入っていない
 * (20.12 / 21.4 で `parentPath` に改名)。 開発ツールの下限はそれより新しいが、
 * 実行時の Node は Electron 同梱版なので両方を見ておく。
 */
function relativeFromDirent(d: Dirent, memoryDir: string): string {
  const compat = d as { parentPath?: string; path?: string };
  const parent = compat.parentPath ?? compat.path ?? memoryDir;
  if (parent === memoryDir) return d.name;
  return join(parent.slice(memoryDir.length + 1), d.name);
}

/**
 * memoryDir が通常の一覧 (projectFromEntry) で既に表示される場所かどうか。
 *
 * 通常一覧が表示するのは <projectsRoot>/<name>/memory の形だけなので、
 * projects root 配下でもその形でない custom dir (深い階層や別名ディレクトリ)
 * は virtual project として追加しないと UI から不可視になる。
 */
function listedProjectName(memoryDir: string, root: string): string | null {
  if (basename(memoryDir) !== MEMORY_DIRNAME) return null;
  const projectDir = dirname(memoryDir);
  if (dirname(projectDir) !== root) return null;
  const name = basename(projectDir);
  return name.length > 0 ? name : null;
}

/**
 * autoMemoryDirectory / cowork override が指す memory ディレクトリを一覧の 1 件に
 * する。 projects/<name>/memory の形ならその通常プロジェクト、 それ以外は
 * virtual project。 dir がまだ無くても entry 自体は出す (Claude Code は初回
 * 書き込みで遅延作成するため、「これから使われる場所」を見せておく)。
 */
async function customDirProject(settings: MemorySettings): Promise<MemoryProject | null> {
  const dir = customDir(settings);
  if (dir === null) return null;
  const root = projectsRoot(settings);
  const listedName = listedProjectName(dir, root);
  if (listedName !== null) return projectFromEntry(root, listedName);
  const stats = (await scanMemoryDirStats(dir)) ?? {
    fileCount: 0,
    hasIndex: false,
    lastModifiedMs: 0,
  };
  const name = `(custom) ${basename(dir) || dir}`;
  return {
    kind: "custom",
    name,
    displayName: name,
    memoryDir: dir + sep,
    projectDir: normalizePath(dirname(dir)) + sep,
    decodedProjectPath: dir,
    projectPathSource: null,
    ...stats,
  };
}

/** user スコープの subagent memory (<memoryBase>/agent-memory/<agent>/) を列挙する。 */
async function listAgentMemories(settings: MemorySettings): Promise<MemoryProject[]> {
  const root = agentMemoryRoot(settings);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const agents = await mapConcurrent(
    entries.filter((e) => e.isDirectory()),
    FS_CONCURRENCY,
    async (e): Promise<MemoryProject | null> => {
      const memoryDir = join(root, e.name);
      const stats = await scanMemoryDirStats(memoryDir);
      if (stats === null) return null;
      return {
        kind: "agent",
        name: `agent:${e.name}`,
        displayName: e.name,
        memoryDir: normalizePath(memoryDir) + sep,
        projectDir: normalizePath(root) + sep,
        decodedProjectPath: null,
        projectPathSource: null,
        ...stats,
      };
    },
  );
  return agents.filter((a): a is MemoryProject => a !== null);
}

function byRecency(a: MemoryProject, b: MemoryProject): number {
  if (b.lastModifiedMs !== a.lastModifiedMs) return b.lastModifiedMs - a.lastModifiedMs;
  return a.name.localeCompare(b.name);
}

async function listProjectsWith(settings: MemorySettings): Promise<MemoryProject[]> {
  const root = projectsRoot(settings);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const [projects, custom, agents] = await Promise.all([
    mapConcurrent(
      entries.filter((e) => e.isDirectory()),
      FS_CONCURRENCY,
      (e) => projectFromEntry(root, e.name),
    ),
    customDirProject(settings),
    listAgentMemories(settings),
  ]);
  const out = projects.filter((p): p is MemoryProject => p !== null);
  if (custom?.kind === "custom") out.push(custom);
  return [...out.sort(byRecency), ...agents.sort(byRecency)];
}

export async function listProjects(): Promise<MemoryProject[]> {
  return listProjectsWith(await resolveMemorySettings());
}

function headerFromParsed(
  relativePath: string,
  filePath: string,
  stat: { mtimeMs: number; size: number },
  text: string,
): MemoryHeader {
  const { frontmatter, invalid } = parseFrontmatter(text);
  return {
    filename: relativePath.replaceAll("\\", "/"),
    filePath,
    mtimeMs: stat.mtimeMs,
    byteSize: stat.size,
    name: extractStringField(frontmatter, "name"),
    description: extractStringField(frontmatter, "description"),
    type: extractMemoryType(frontmatter),
    modifiedMs: extractModifiedMs(frontmatter),
    frontmatterInvalid: invalid,
  };
}

export async function listFiles(memoryDir: string): Promise<MemoryHeader[]> {
  const settings = await resolveMemorySettings();
  buildPathGuard(settings).dir(memoryDir);
  let files: string[];
  try {
    files = await fs.readdir(memoryDir, { recursive: true });
  } catch {
    return [];
  }
  // 直下の MEMORY.md だけが「auto memory の index」で、 readIndex 経由で別 UI を持つ。
  // team subdirectory の MEMORY.md (e.g. <memoryDir>/team/MEMORY.md) はそれ自体が
  // memory file なので一覧に残す。 公式 scanMemoryFiles (src/memdir/memoryScan.ts:42)
  // は `basename(f) !== 'MEMORY.md'` でフィルタしているが、 memlens は GUI なので
  // 「team の MEMORY.md も普通に閲覧/編集できる」方が直感的。
  const mdFiles = files.filter((f) => f.endsWith(".md") && !isTopLevelEntrypoint(f));
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
      // 公式 scan と同じく先頭 FRONTMATTER_MAX_LINES 行だけで frontmatter を読む。
      const limited = head.content.split(/\r?\n/).slice(0, FRONTMATTER_MAX_LINES).join("\n") + "\n";
      return headerFromParsed(relativePath, filePath, stat, limited);
    },
  );
  return headers
    .filter((h): h is MemoryHeader => h !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_MEMORY_FILES);
}

/**
 * 1 ファイル分のヘッダを返す。 一覧 (mtime 降順 200 件) に入らないファイル
 * (検索ヒット等) を開くときに使う。
 */
export async function readHeader(absPath: string): Promise<MemoryHeader> {
  const settings = await resolveMemorySettings();
  buildPathGuard(settings).file(absPath);
  const memoryDir = memoryDirOf(absPath, settings);
  const [stat, raw] = await Promise.all([
    fs.stat(absPath),
    fs.readFile(absPath, { encoding: "utf8" }),
  ]);
  const rel = memoryDir !== null ? relativeInside(memoryDir, absPath) : null;
  return headerFromParsed(rel ?? basename(absPath), absPath, stat, raw);
}

export async function readFile(absPath: string): Promise<ParsedMemoryFile> {
  const settings = await resolveMemorySettings();
  buildPathGuard(settings).file(absPath);
  const [stat, raw] = await Promise.all([
    fs.stat(absPath),
    fs.readFile(absPath, { encoding: "utf8" }),
  ]);
  const { frontmatter, body, invalid } = parseFrontmatter(raw);
  return {
    path: absPath,
    raw,
    frontmatter,
    body,
    mtimeMs: stat.mtimeMs,
    byteSize: stat.size,
    modifiedMs: extractModifiedMs(frontmatter),
    frontmatterInvalid: invalid,
  };
}

/** IPC の保存前提を writeIfUnchanged の expected に変換する。 */
function expectedOf(expectation: WriteExpectation): string | null | undefined {
  return expectation === null ? undefined : expectation.content;
}

/**
 * memory ファイルを書く。 expectation.content は編集を始めた時点の raw 内容で、
 * ディスク上の内容がそれと違えば (Claude Code が並行して書き換えた等) 書かずに
 * conflict を返す。 expectation が null なら検査せずに上書きする (ユーザが
 * 「上書き」を選んだとき)。
 *
 * frontmatter を持つファイルには Claude Code v2.1.214+ と同じく `modified` を記録する。
 */
export async function writeFile(
  absPath: string,
  raw: string,
  expectation: WriteExpectation,
): Promise<WriteResult> {
  const settings = await resolveMemorySettings();
  buildPathGuard(settings).file(absPath);
  return writeIfUnchanged(
    absPath,
    (current) => stampModified(matchLineEndings(raw, current), nowIso()),
    expectedOf(expectation),
  );
}

/**
 * index が absPath (memory ファイル) をどの相対パスで指すかを返す。 top-level の
 * MEMORY.md と、 ファイルがサブディレクトリにある場合はその階層の MEMORY.md の両方。
 */
function indexesFor(
  absPath: string,
  settings: MemorySettings,
): Array<{ indexPath: string; rel: string }> {
  const memoryDir = memoryDirOf(absPath, settings);
  if (memoryDir === null) return [];
  const out: Array<{ indexPath: string; rel: string }> = [];
  for (const dir of new Set([memoryDir, dirname(normalizePath(absPath))])) {
    const rel = relativeInside(dir, normalizePath(absPath));
    if (rel !== null) out.push({ indexPath: indexPathFor(dir), rel });
  }
  return out;
}

/** index を読み、 変換結果が変わったときだけ書き戻す (並行書き込みは 1 回だけ再試行)。 */
async function rewriteIndex(
  indexPath: string,
  transform: (raw: string) => { text: string; count: number },
): Promise<number> {
  for (let attempt = 0; attempt < 2; attempt++) {
    // 再試行は直前の読み出しと書き込みの間に割り込まれたときだけ (順次が本質)。
    // oxlint-disable-next-line no-await-in-loop
    const current = await readTextOrNull(indexPath);
    if (current === null) return 0;
    const { text, count } = transform(current);
    if (count === 0) return 0;
    // oxlint-disable-next-line no-await-in-loop
    const result = await writeIfUnchanged(indexPath, () => stampModified(text, nowIso()), current);
    if (result.status === "saved") return count;
  }
  throw new Error(`${ENTRYPOINT_NAME} changed while it was being updated; try again.`);
}

export async function deleteFile(
  absPath: string,
  options: { readonly removeIndexEntries?: boolean } = {},
): Promise<{ indexEntriesRemoved: number }> {
  const settings = await resolveMemorySettings();
  buildPathGuard(settings).file(absPath);
  if (isProtectedEntrypoint(absPath, settings)) {
    throw new Error(
      `${ENTRYPOINT_NAME} cannot be deleted; clear its content via the editor instead.`,
    );
  }
  await fs.unlink(absPath);
  if (!options.removeIndexEntries) return { indexEntriesRemoved: 0 };
  let removed = 0;
  for (const { indexPath, rel } of indexesFor(absPath, settings)) {
    // index ごとに読み書きが独立しているので順に処理する。
    // oxlint-disable-next-line no-await-in-loop
    removed += await rewriteIndex(indexPath, (raw) => removeIndexEntries(raw, rel));
  }
  return { indexEntriesRemoved: removed };
}

/**
 * absPath が memory ディレクトリ直下の MEMORY.md (= readIndex が扱う index 本体)
 * かどうか。 listFiles は team/MEMORY.md のようなネストした index を通常の
 * memory file として一覧に出すので、 削除禁止は本物の entrypoint に限定する
 * (basename だけで弾くと、 一覧に出るのに消せないファイルが生まれる)。
 */
function isProtectedEntrypoint(absPath: string, settings: MemorySettings): boolean {
  const candidate = normalizePath(absPath);
  if (basename(candidate) !== ENTRYPOINT_NAME) return false;
  return memoryDirOf(candidate, settings) === dirname(candidate);
}

/**
 * 新しい memory ファイル名 (basename) の共通検証。 `.md` 補完済みの値を受け取る。
 *
 * Windows で無効な文字 / 制御文字 / 予約デバイス名は fs 側の cryptic な
 * EINVAL になる前に明確なエラーで弾く。 memory ディレクトリはクラウド同期や
 * リポジトリ共有で OS を跨いで使われうるので、 どのプラットフォームでも最も
 * 厳しい (Windows の) 規則で統一する。 createFile / renameFile が共用する。
 */
function assertValidMemoryFilename(filename: string): void {
  if (filename.length <= ".md".length) {
    throw new Error("filename must not be empty");
  }
  // 内部に path separator を含めない (サブディレクトリは別 API で許可する想定)
  if (filename.includes("/") || filename.includes("\\")) {
    throw new Error("filename must not contain path separators");
  }
  // oxlint-disable-next-line no-control-regex -- 制御文字そのものを検査したい
  if (/[<>:"|?*\u0000-\u001f]/.test(filename)) {
    throw new Error("filename contains characters that are invalid on Windows");
  }
  if (WINDOWS_RESERVED_NAME_RE.test(filename)) {
    throw new Error("filename is a reserved device name on Windows");
  }
  // index のリンクでは `#` が fragment、 `%` がパーセントエンコードとして読まれ、
  // 書いたポインタが別のファイルを指してしまう。
  if (/[#%]/.test(filename)) {
    throw new Error("filename must not contain # or %");
  }
  // Windows は末尾のドットと空白を黙って削るので、 別名で保存されてしまう。
  if (/[. ]$/.test(filename.slice(0, -".md".length))) {
    throw new Error("filename must not end with a dot or a space");
  }
}

function withMdExtension(filename: string): string {
  return filename.endsWith(".md") ? filename : `${filename}.md`;
}

export async function createFile(req: CreateMemoryRequest): Promise<MemoryHeader> {
  const settings = await resolveMemorySettings();
  const guard = buildPathGuard(settings);
  guard.dir(req.memoryDir);
  const filename = withMdExtension(req.filename.trim());
  assertValidMemoryFilename(filename);
  if (filename === ENTRYPOINT_NAME) {
    throw new Error(`Use writeIndex to manage ${ENTRYPOINT_NAME}`);
  }
  const target = join(req.memoryDir, filename);
  guard.file(target);
  await fs.mkdir(req.memoryDir, { recursive: true });
  const text =
    buildFrontmatterText({ ...req.frontmatter, modified: nowIso() }) + req.body.trimStart();
  // `wx` で O_EXCL を立て、 access → write 間の race を防ぐ。 同名ファイルが
  // 既にあれば EEXIST が飛ぶのでそれをユーザ向けエラーに変換する。
  try {
    await fs.writeFile(target, text, { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === "EEXIST") {
      throw new Error(`File already exists: ${filename}`, { cause: err });
    }
    throw err;
  }
  if (req.addToIndex) {
    await appendIndexEntry(
      req.memoryDir,
      buildIndexEntry(req.frontmatter.name, filename, req.frontmatter.description),
    );
  }
  const stat = await fs.stat(target);
  return headerFromParsed(filename, target, stat, text);
}

/**
 * MEMORY.md の末尾にエントリ行を足す (無ければ作る)。 公式の保存手順 Step 2
 * ("add a pointer to that file in MEMORY.md") に相当。
 */
async function appendIndexEntry(memoryDir: string, entry: string): Promise<void> {
  const indexPath = indexPathFor(memoryDir);
  for (let attempt = 0; attempt < 2; attempt++) {
    // 再試行は直前の読み出しと書き込みの間に割り込まれたときだけ (順次が本質)。
    // oxlint-disable-next-line no-await-in-loop
    const current = await readTextOrNull(indexPath);
    const base = current ?? "";
    const eol = base.includes("\r\n") ? "\r\n" : "\n";
    const joiner = base.length === 0 || base.endsWith("\n") ? "" : eol;
    // oxlint-disable-next-line no-await-in-loop
    const result = await writeIfUnchanged(
      indexPath,
      () => stampModified(`${base}${joiner}${entry}${eol}`, nowIso()),
      current,
    );
    if (result.status === "saved") return;
  }
  throw new Error(`${ENTRYPOINT_NAME} changed while the entry was being added; try again.`);
}

/**
 * memory ファイルの basename を変更する。 親ディレクトリは変えない
 * (ディレクトリ間移動は別の操作として扱う)。
 *
 * - 保護対象の top-level MEMORY.md は rename 不可 (index が消えたことになる)。
 * - rename 先が MEMORY.md になるのも不可 (writeIndex 管理領域への侵入を防ぐ)。
 * - 既存ファイルへの上書きは防ぐ。 POSIX の rename(2) は silent replace なので、
 *   事前に存在確認する (check → rename 間の race は残るが、 単一ユーザの GUI
 *   操作では実害がない。 厳密な原子性が要るなら link(2) + unlink だが、 FAT 等
 *   hardlink 非対応 fs で壊れるため採らない)。 大文字小文字だけを変える rename は
 *   case-insensitive な fs だと stat(target) が自分自身に当たるので、 同じ実体
 *   (dev / ino が一致) のときだけ衝突とみなさない。 OS では判定しない (macOS にも
 *   case-sensitive な APFS ボリュームがあり、 そこでは別ファイルを潰してしまう)。
 * - updateIndexLinks なら MEMORY.md 内の旧ファイル名へのリンクを張り替える
 *   (張り替えないと index に存在しないファイルへのポインタが残る)。
 */
export async function renameFile(
  absPath: string,
  newFilename: string,
  options: { readonly updateIndexLinks?: boolean } = {},
): Promise<RenameResult> {
  const settings = await resolveMemorySettings();
  const guard = buildPathGuard(settings);
  guard.file(absPath);
  if (isProtectedEntrypoint(absPath, settings)) {
    throw new Error(`${ENTRYPOINT_NAME} cannot be renamed.`);
  }
  const trimmed = newFilename.trim();
  if (trimmed.length === 0) {
    throw new Error("filename must not be empty");
  }
  const filename = withMdExtension(trimmed);
  assertValidMemoryFilename(filename);
  if (filename === ENTRYPOINT_NAME) {
    throw new Error(`Use writeIndex to manage ${ENTRYPOINT_NAME}`);
  }
  const target = join(dirname(absPath), filename);
  guard.file(target);
  if (target === normalizePath(absPath)) {
    return { path: absPath, indexLinksUpdated: 0 };
  }
  const [source, existing] = await Promise.all([
    fs.stat(absPath, { bigint: true }),
    fs.stat(target, { bigint: true }).catch(() => null),
  ]);
  if (existing !== null && (existing.dev !== source.dev || existing.ino !== source.ino)) {
    throw new Error(`File already exists: ${filename}`);
  }
  const before = indexesFor(absPath, settings);
  await fs.rename(absPath, target);
  let indexLinksUpdated = 0;
  if (options.updateIndexLinks) {
    for (const { indexPath, rel } of before) {
      const toRel = relativeInside(dirname(indexPath), target);
      if (toRel === null) continue;
      // index ごとに読み書きが独立しているので順に処理する。
      // oxlint-disable-next-line no-await-in-loop
      indexLinksUpdated += await rewriteIndex(indexPath, (raw) =>
        retargetIndexLinks(raw, rel, toRel),
      );
    }
  }
  return { path: target, indexLinksUpdated };
}

export async function readIndex(memoryDir: string): Promise<MemoryIndexResult> {
  const settings = await resolveMemorySettings();
  buildPathGuard(settings).dir(memoryDir);
  const indexPath = join(memoryDir, ENTRYPOINT_NAME);
  let raw: string | null;
  try {
    raw = await readTextOrNull(indexPath);
  } catch {
    // 読めない index (権限 / ディレクトリ等) は「無い」として扱い、 一覧は出す。
    raw = null;
  }
  const health = await analyzeIndex(memoryDir, raw);
  if (raw === null) {
    return {
      path: indexPath,
      content: "",
      loadedContent: "",
      droppedContent: "",
      lineCount: 0,
      byteCount: 0,
      loadedLineCount: 0,
      wasLineTruncated: false,
      wasByteTruncated: false,
      exists: false,
      health,
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
    droppedContent: t.dropped,
    lineCount: t.lineCount,
    byteCount: t.byteCount,
    loadedLineCount: t.loadedLineCount,
    wasLineTruncated: t.wasLineTruncated,
    wasByteTruncated: t.wasByteTruncated,
    exists: true,
    health,
  };
}

/**
 * MEMORY.md を書く。 expectation の意味は writeFile と同じ (index が未作成のまま
 * 編集を始めたなら content: null = 「まだ存在しない」前提)。
 */
export async function writeIndex(
  memoryDir: string,
  content: string,
  expectation: WriteExpectation,
): Promise<WriteResult> {
  const settings = await resolveMemorySettings();
  buildPathGuard(settings).dir(memoryDir);
  const indexPath = join(memoryDir, ENTRYPOINT_NAME);
  return writeIfUnchanged(
    indexPath,
    (current) => stampModified(matchLineEndings(content, current), nowIso()),
    expectedOf(expectation),
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 大文字小文字を無視して query を探す matcher。 `toLowerCase()` した行で indexOf
 * すると、 小文字化で長さが変わる文字 (`İ` など) の後ろで抜粋の位置がずれるので、
 * 元の行に対して `iu` の正規表現で照合する。
 */
function makeMatcher(query: string): (line: string) => { index: number; length: number } | null {
  try {
    const re = new RegExp(escapeRegExp(query), "iu");
    return (line) => {
      const m = re.exec(line);
      return m ? { index: m.index, length: m[0].length } : null;
    };
  } catch {
    // 孤立サロゲート等で `u` が使えない query は素朴な比較に落とす。
    const needle = query.toLowerCase();
    return (line) => {
      const index = line.toLowerCase().indexOf(needle);
      return index < 0 ? null : { index, length: needle.length };
    };
  }
}

/** サロゲートペアの途中で切らないよう抜粋の境界を外側へ寄せる。 */
function clampToCodePoints(line: string, start: number, end: number): [number, number] {
  let s = start;
  let e = end;
  const isLow = (i: number): boolean => {
    const c = line.charCodeAt(i);
    return c >= 0xdc00 && c <= 0xdfff;
  };
  if (s > 0 && isLow(s)) s--;
  if (e < line.length && isLow(e)) e++;
  return [s, e];
}

async function searchDir(memoryDir: string, query: string): Promise<MemorySearchResult> {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return { query, hits: [], scanned: 0, truncated: false };
  }
  const match = makeMatcher(trimmed);
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
      const found = match(line);
      if (found === null) continue;
      const [start, end] = clampToCodePoints(
        line,
        Math.max(0, found.index - SEARCH_EXCERPT_RADIUS),
        Math.min(line.length, found.index + found.length + SEARCH_EXCERPT_RADIUS),
      );
      const excerpt =
        (start > 0 ? "…" : "") + line.slice(start, end) + (end < line.length ? "…" : "");
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

export async function search(memoryDir: string, query: string): Promise<MemorySearchResult> {
  const settings = await resolveMemorySettings();
  buildPathGuard(settings).dir(memoryDir);
  return searchDir(memoryDir, query);
}

/** 全 project 横断検索の総ヒット上限。 per-dir の SEARCH_HITS_LIMIT とは別枠。 */
const GLOBAL_SEARCH_HITS_LIMIT = 300;
/**
 * project 単位の並列度。 各 searchDir() が内部で FS_CONCURRENCY 並列の read を
 * 発行するので、 掛け算で fd を食い過ぎないよう小さく抑える。
 */
const GLOBAL_SEARCH_PROJECT_CONCURRENCY = 4;

/**
 * すべての memory ディレクトリ (通常 + custom + subagent) を横断して本文検索する。
 *
 * settings は 1 度だけ解決し、 各 project の走査は searchDir() を共有する
 * (以前は project ごとに settings を読み直していた)。 project 順は listProjects と
 * 同じ「最新更新が先」なので、 上限で打ち切られた場合も新しい memory が優先して
 * 残る。
 */
export async function searchAll(query: string): Promise<GlobalMemorySearchResult> {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return {
      query,
      hits: [],
      scannedProjects: 0,
      scannedFiles: 0,
      truncated: false,
    };
  }
  const projects = await listProjectsWith(await resolveMemorySettings());
  const perProject = await mapConcurrent(
    projects,
    GLOBAL_SEARCH_PROJECT_CONCURRENCY,
    async (project) => {
      try {
        const result = await searchDir(project.memoryDir, trimmed);
        return { project, result };
      } catch {
        // 1 project の失敗 (削除直後の race 等) が全体を落とさないようにする。
        return { project, result: null };
      }
    },
  );

  const hits: GlobalMemorySearchHit[] = [];
  let scannedFiles = 0;
  let truncated = false;
  outer: for (const { project, result } of perProject) {
    if (result === null) continue;
    scannedFiles += result.scanned;
    if (result.truncated) truncated = true;
    for (const hit of result.hits) {
      if (hits.length >= GLOBAL_SEARCH_HITS_LIMIT) {
        truncated = true;
        break outer;
      }
      hits.push({
        ...hit,
        projectName: project.name,
        memoryDir: project.memoryDir,
        projectLabel: project.decodedProjectPath ?? project.displayName,
      });
    }
  }
  return {
    query,
    hits,
    scannedProjects: projects.length,
    scannedFiles,
    truncated,
  };
}

export async function openInFolder(absPath: string): Promise<void> {
  const settings = await resolveMemorySettings();
  // showItemInFolder は開くだけで実行はしないので、 memory ディレクトリも受け付ける。
  if (!isMemoryDir(absPath, settings)) buildPathGuard(settings).file(absPath);
  shell.showItemInFolder(absPath);
}

export async function revealInEditor(absPath: string): Promise<void> {
  const settings = await resolveMemorySettings();
  // shell.openPath は関連付けられたアプリで開く (.bat 等なら実行される) ので
  // memory の .md に限る。
  buildPathGuard(settings).file(absPath);
  const error = await shell.openPath(absPath);
  // shell.openPath は失敗を reject ではなく空でないメッセージで返す。
  if (error.length > 0) throw new Error(error);
}

export async function getSettings(): Promise<MemorySettings> {
  return resolveMemorySettings();
}

/**
 * path で Claude Code を起動したときに使われる auto memory ディレクトリを一覧の
 * 1 件として返す (cwd バッジ用)。 公式 getAutoMemPath の解決順:
 *   1. CLAUDE_COWORK_MEMORY_PATH_OVERRIDE / autoMemoryDirectory (cwd に依らない)
 *   2. CLAUDE_CODE_PROJECT_DIR_NAME (v2.1.234+, CLAUDE_CONFIG_DIR 併用時)
 *   3. <memoryBase>/projects/<sanitize(canonical git root ?? path)>/memory/
 */
export async function resolveProjectForPath(absPath: string): Promise<MemoryProject | null> {
  const settings = await resolveMemorySettings();
  if (settings.autoMemoryDirectory) return customDirProject(settings);
  const root = projectsRoot(settings);
  if (settings.projectDirName !== null) {
    return projectFromEntry(root, settings.projectDirName);
  }
  // renderer は "." のような相対 path を投げてくる (cwd バッジ用)。
  // findCanonicalGitRoot / sanitizePath は絶対 path 前提なので先に解決する。
  const abs = resolve(absPath);
  const canonical = (await findCanonicalGitRoot(abs)) ?? abs;
  const sanitized = sanitizePath(canonical);
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
async function findProjectDirEntry(root: string, sanitized: string): Promise<string | null> {
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
