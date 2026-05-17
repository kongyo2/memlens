import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import { basename, dirname, join, normalize, sep } from "node:path";

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

import {
  buildFrontmatterText,
  extractMemoryType,
  extractStringField,
  parseFrontmatter,
} from "./frontmatter.ts";
import { findCanonicalGitRoot } from "./gitRoot.ts";
import { guessProjectPath, sanitizePath } from "./sanitize.ts";
import { resolveMemorySettings } from "./settings.ts";
import { truncateEntrypointContent } from "./truncate.ts";

const {
  ENTRYPOINT_NAME,
  FRONTMATTER_MAX_LINES,
  MAX_MEMORY_FILES,
  MEMORY_DIRNAME,
} = MEMORY_CONSTANTS;

const SEARCH_FILE_LIMIT = 500;
const SEARCH_HITS_LIMIT = 200;
const SEARCH_EXCERPT_RADIUS = 80;

function normalizePath(p: string): string {
  return normalize(p).normalize("NFC");
}

function projectsRoot(settings: MemorySettings): string {
  return normalizePath(join(settings.baseDir, "projects"));
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

async function projectFromEntry(
  root: string,
  name: string,
): Promise<MemoryProject | null> {
  const projectDir = join(root, name);
  const memoryDir = join(projectDir, MEMORY_DIRNAME);
  try {
    const stat = await fs.stat(memoryDir);
    if (!stat.isDirectory()) return null;
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
  let fileCount = 0;
  let lastModifiedMs = 0;
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!e.name.endsWith(".md")) continue;
    fileCount++;
    if (e.name === ENTRYPOINT_NAME) hasIndex = true;
    // mtime は per-file stat が必要だが O(N) 走査を避けるため、 memory dir 自体の mtime を取る。
  }
  try {
    const dirStat = await fs.stat(memoryDir);
    lastModifiedMs = dirStat.mtimeMs;
  } catch {
    /* keep 0 */
  }
  return {
    name,
    memoryDir: normalizePath(memoryDir) + sep,
    projectDir: normalizePath(projectDir) + sep,
    decodedProjectPath: guessProjectPath(name),
    fileCount,
    hasIndex,
    lastModifiedMs,
  };
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
  const projects = await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map((e) => projectFromEntry(root, e.name)),
  );
  const out = projects.filter((p): p is MemoryProject => p !== null);

  // autoMemoryDirectory が projects root の外を指す場合、virtual project として追加。
  if (settings.autoMemoryDirectory) {
    const normalized = normalizePath(settings.autoMemoryDirectory).replace(
      /[/\\]+$/,
      "",
    );
    const insideProjects = normalized.startsWith(root + sep);
    if (!insideProjects) {
      const virtualName = `(custom) ${basename(normalized) || normalized}`;
      let fileCount = 0;
      let hasIndex = false;
      let lastModifiedMs = 0;
      try {
        const dirents = await fs.readdir(normalized, {
          withFileTypes: true,
          recursive: true,
        });
        for (const d of dirents) {
          if (!d.isFile() || !d.name.endsWith(".md")) continue;
          fileCount++;
          if (d.name === ENTRYPOINT_NAME) hasIndex = true;
        }
        lastModifiedMs = (await fs.stat(normalized)).mtimeMs;
      } catch {
        /* ignore */
      }
      out.push({
        name: virtualName,
        memoryDir: normalizePath(normalized) + sep,
        projectDir: normalizePath(dirname(normalized)) + sep,
        decodedProjectPath: normalized,
        fileCount,
        hasIndex,
        lastModifiedMs,
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
  const mdFiles = files.filter(
    (f) => f.endsWith(".md") && basename(f) !== ENTRYPOINT_NAME,
  );
  const headers = await Promise.all(
    mdFiles.map(async (relativePath): Promise<MemoryHeader | null> => {
      const filePath = join(memoryDir, relativePath);
      try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) return null;
        const content = await fs.readFile(filePath, { encoding: "utf8" });
        const head =
          content.split(/\r?\n/).slice(0, FRONTMATTER_MAX_LINES).join("\n") +
          "\n";
        const { frontmatter } = parseFrontmatter(head);
        return {
          filename: relativePath.replaceAll("\\", "/"),
          filePath,
          mtimeMs: stat.mtimeMs,
          byteSize: stat.size,
          name: extractStringField(frontmatter, "name"),
          description: extractStringField(frontmatter, "description"),
          type: extractMemoryType(frontmatter),
        };
      } catch {
        return null;
      }
    }),
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
  if (basename(absPath) === ENTRYPOINT_NAME) {
    throw new Error(
      `${ENTRYPOINT_NAME} cannot be deleted; clear its content via the editor instead.`,
    );
  }
  await fs.unlink(absPath);
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
  if (filename === ENTRYPOINT_NAME) {
    throw new Error(`Use writeIndex to manage ${ENTRYPOINT_NAME}`);
  }
  const target = join(req.memoryDir, filename);
  guard(target);
  try {
    await fs.access(target);
    throw new Error(`File already exists: ${filename}`);
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: string }).code === "ENOENT"
    ) {
      // 新規作成パスとして正常
    } else if (
      err instanceof Error &&
      err.message.startsWith("File already exists")
    ) {
      throw err;
    }
  }
  await fs.mkdir(req.memoryDir, { recursive: true });
  const text = buildFrontmatterText(req.frontmatter) + req.body.trimStart();
  await fs.writeFile(target, text, { encoding: "utf8" });
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
  const t = truncateEntrypointContent(raw);
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
  const mdFiles = files
    .filter((f) => f.endsWith(".md"))
    .slice(0, SEARCH_FILE_LIMIT);
  let truncated = files.length > SEARCH_FILE_LIMIT;

  type FileRead = {
    relativePath: string;
    filePath: string;
    raw: string | null;
  };
  const reads: readonly FileRead[] = await Promise.all(
    mdFiles.map(async (relativePath): Promise<FileRead> => {
      const filePath = join(memoryDir, relativePath);
      try {
        const raw = await fs.readFile(filePath, { encoding: "utf8" });
        return { relativePath, filePath, raw };
      } catch {
        return { relativePath, filePath, raw: null };
      }
    }),
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
  const canonical = (await findCanonicalGitRoot(absPath)) ?? absPath;
  const sanitized = sanitizePath(canonical);
  const root = projectsRoot(settings);
  const projectDir = join(root, sanitized);
  try {
    const stat = await fs.stat(projectDir);
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }
  return projectFromEntry(root, sanitized);
}
