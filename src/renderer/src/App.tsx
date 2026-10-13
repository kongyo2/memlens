import type {
  CreateMemoryRequest,
  GlobalMemorySearchHit,
  MemoryHeader,
  MemoryIndexResult,
  MemoryProject,
  MemorySearchHit,
  MemorySettings,
  MemoryType,
  ParsedMemoryFile,
  WriteExpectation,
} from "@shared/api/contract.ts";
import { formatFileSize } from "@shared/util/format.ts";
import { buildIndexEntry } from "@shared/util/indexEntry.ts";
import * as React from "react";

import { CreateMemoryDialog } from "./components/CreateMemoryDialog.tsx";
import { type DetailDoc, MemoryDetail, type SaveOutcome } from "./components/MemoryDetail.tsx";
import { MemoryList, type SearchScope } from "./components/MemoryList.tsx";
import { ProjectList } from "./components/ProjectList.tsx";
import { RenameMemoryDialog } from "./components/RenameMemoryDialog.tsx";
import { SettingsPanel } from "./components/SettingsPanel.tsx";
import { formatError } from "./hooks/errors.ts";
import { revealLabel } from "./hooks/platform.ts";
import { formatFileCount, useTranslation } from "./i18n/index.ts";

const LAST_PROJECT_STORAGE_KEY = "memlens.lastProjectName";
const SEARCH_DEBOUNCE_MS = 250;
/** window にフォーカスが戻ったときの再走査の最短間隔。 */
const FOCUS_REFRESH_INTERVAL_MS = 10_000;

/** 何を開いているか。 データ本体 (ファイル内容 / index) は別 state に持つ。 */
type Selection =
  | { readonly kind: "none" }
  | { readonly kind: "index" }
  | { readonly kind: "file"; readonly path: string };

type OpenFile = {
  readonly path: string;
  readonly header: MemoryHeader;
  /** 開いている間にディスク上で消えたら null (未保存の編集を守るため選択は残す)。 */
  readonly file: ParsedMemoryFile | null;
};

type SearchResult = {
  /** どの検索 (scope + dir + query) の結果か。 */
  readonly key: string;
  /** scope + dir。 query を打っている間は同じ scope の直前の結果を見せ続ける。 */
  readonly scopeKey: string;
  readonly hits: readonly MemorySearchHit[];
  readonly globalHits: readonly GlobalMemorySearchHit[];
  readonly truncated: boolean;
};

type DialogKind = "none" | "create" | "rename" | "settings";

const NO_HITS: readonly MemorySearchHit[] = [];
const NO_GLOBAL_HITS: readonly GlobalMemorySearchHit[] = [];

function readSavedProjectName(): string | null {
  try {
    return globalThis.localStorage?.getItem(LAST_PROJECT_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function saveProjectName(name: string): void {
  try {
    globalThis.localStorage?.setItem(LAST_PROJECT_STORAGE_KEY, name);
  } catch {
    /* persist failure should not break the UI */
  }
}

/** project 直下の MEMORY.md (index 本体) か。 memoryDir は末尾 sep 付き。 */
function isIndexPath(project: MemoryProject, filePath: string): boolean {
  return filePath === `${project.memoryDir}MEMORY.md`;
}

/** memoryDir 相対 (`/` 区切り) のパスを絶対パスにする。 */
function joinMemoryPath(project: MemoryProject, relPath: string): string {
  const sep = project.memoryDir.endsWith("\\") ? "\\" : "/";
  return project.memoryDir + relPath.split("/").join(sep);
}

/** case-insensitive な既定 fs (Windows / macOS) ではパスを小文字で比べる。 */
function samePath(a: string, b: string, platform: string): boolean {
  return platform === "win32" || platform === "darwin"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

export function App(): React.ReactElement {
  const { t, locale, setLocale } = useTranslation();
  const api = window.memlens.memory;
  const platform = window.memlens.platform;
  const [projects, setProjects] = React.useState<readonly MemoryProject[]>([]);
  const [currentProject, setCurrentProject] = React.useState<MemoryProject | null>(null);
  const [settings, setSettings] = React.useState<MemorySettings | null>(null);
  const [selectedProject, setSelectedProject] = React.useState<MemoryProject | null>(null);
  const [memories, setMemories] = React.useState<readonly MemoryHeader[]>([]);
  const [index, setIndex] = React.useState<MemoryIndexResult | null>(null);
  const [selection, setSelection] = React.useState<Selection>({ kind: "none" });
  const [openFile, setOpenFile] = React.useState<OpenFile | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [searchScope, setSearchScope] = React.useState<SearchScope>("project");
  const [typeFilter, setTypeFilter] = React.useState<MemoryType | null>(null);
  const [dialog, setDialog] = React.useState<DialogKind>("none");
  const [searchResult, setSearchResult] = React.useState<SearchResult | null>(null);

  /** 開いているドキュメントに未保存の編集があるか (MemoryDetail が更新する)。 */
  const dirtyRef = React.useRef(false);
  /** project の中身の読み込み要求の通し番号。 古い応答で新しい表示を上書きしない。 */
  const contentRequestRef = React.useRef(0);
  /** watcher のコールバック等、 effect の外から最新の選択を参照するため。 */
  const selectionRef = React.useRef<Selection>(selection);
  const lastFocusRefreshRef = React.useRef(0);

  React.useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  const reportError = React.useCallback((e: unknown) => {
    setError(formatError(e));
  }, []);

  const confirmDiscard = React.useCallback(
    (): boolean => !dirtyRef.current || globalThis.confirm(t.app.discardConfirm),
    [t.app.discardConfirm],
  );

  const handleDirtyChange = React.useCallback((dirty: boolean) => {
    dirtyRef.current = dirty;
  }, []);

  /** project 一覧・設定・cwd の project をまとめて読み直す。 */
  const refreshOverview = React.useCallback(async (): Promise<readonly MemoryProject[] | null> => {
    const [list, resolved, cwd] = await Promise.allSettled([
      api.listProjects(),
      api.getSettings(),
      api.resolveProjectForPath("."),
    ]);
    if (resolved.status === "fulfilled") setSettings(resolved.value);
    else reportError(resolved.reason);
    if (cwd.status === "fulfilled") setCurrentProject(cwd.value);
    if (list.status === "rejected") {
      reportError(list.reason);
      return null;
    }
    setProjects(list.value);
    return list.value;
  }, [api, reportError]);

  /** 選択中 project の一覧と index を読む。 古い要求の結果は捨てる。 */
  const loadProjectContent = React.useCallback(
    async (project: MemoryProject): Promise<readonly MemoryHeader[] | null> => {
      const request = ++contentRequestRef.current;
      try {
        const [files, idx] = await Promise.all([
          api.listFiles(project.memoryDir),
          api.readIndex(project.memoryDir),
        ]);
        if (request !== contentRequestRef.current) return null;
        setMemories(files);
        setIndex(idx);
        return files;
      } catch (e: unknown) {
        if (request === contentRequestRef.current) reportError(e);
        return null;
      }
    },
    [api, reportError],
  );

  /** 一覧に出ているヘッダを使い、 無ければ (200 件の外など) 個別に読む。 */
  const headerFor = React.useCallback(
    async (path: string, headers: readonly MemoryHeader[] | null): Promise<MemoryHeader> =>
      headers?.find((h) => h.filePath === path) ?? api.readHeader(path),
    [api],
  );

  /** ファイルを開いて表示する。 */
  const showFile = React.useCallback(
    async (path: string, headers: readonly MemoryHeader[] | null): Promise<void> => {
      const [file, header] = await Promise.all([api.readFile(path), headerFor(path, headers)]);
      setSelection({ kind: "file", path });
      setOpenFile({ path, header, file });
    },
    [api, headerFor],
  );

  /**
   * 開いているファイルを読み直す (Claude Code の書き込みを watcher が拾った等)。
   * 消えていたら、 未保存の編集が無ければ閉じ、 あれば内容を null にして残す。
   */
  const reloadOpenFile = React.useCallback(
    async (path: string, headers: readonly MemoryHeader[] | null): Promise<void> => {
      try {
        const [file, header] = await Promise.all([api.readFile(path), headerFor(path, headers)]);
        setOpenFile((prev) => (prev?.path === path ? { path, header, file } : prev));
      } catch {
        if (dirtyRef.current) {
          setOpenFile((prev) => (prev?.path === path ? { ...prev, file: null } : prev));
          return;
        }
        setOpenFile((prev) => (prev?.path === path ? null : prev));
        setSelection((prev) =>
          prev.kind === "file" && prev.path === path ? { kind: "none" } : prev,
        );
      }
    },
    [api, headerFor],
  );

  /** project の中身と、 開いているファイルを読み直す。 */
  const refreshProject = React.useCallback(
    async (project: MemoryProject): Promise<void> => {
      const files = await loadProjectContent(project);
      const current = selectionRef.current;
      if (current.kind === "file") await reloadOpenFile(current.path, files);
    },
    [loadProjectContent, reloadOpenFile],
  );

  const selectProject = React.useCallback(
    (project: MemoryProject) => {
      setSelectedProject(project);
      setSelection({ kind: "none" });
      setOpenFile(null);
      setMemories([]);
      setIndex(null);
      saveProjectName(project.name);
      void loadProjectContent(project);
    },
    [loadProjectContent],
  );

  // 起動時: 一覧・設定を読み、 前回開いていた project を復元する (1 度限り)。
  React.useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([
      api.listProjects(),
      api.getSettings(),
      api.resolveProjectForPath("."),
    ]).then(([list, resolved, cwd]) => {
      if (cancelled) return null;
      if (resolved.status === "fulfilled") setSettings(resolved.value);
      if (cwd.status === "fulfilled") setCurrentProject(cwd.value);
      if (list.status === "rejected") {
        reportError(list.reason);
        return null;
      }
      setProjects(list.value);
      const saved = readSavedProjectName();
      const match = saved === null ? undefined : list.value.find((p) => p.name === saved);
      if (match) selectProject(match);
      return null;
    });
    return () => {
      cancelled = true;
    };
  }, [api, reportError, selectProject]);

  // 選択中 project の memoryDir を fs.watch (主に Claude Code 本体が memory を
  // 書いたタイミングで UI を自動更新するため)。 unmount / 再選択時に解除する。
  React.useEffect(() => {
    if (!selectedProject) return;
    const project = selectedProject;
    const unsubscribe = api.watch(project.memoryDir, () => {
      void refreshProject(project);
    });
    return () => {
      unsubscribe();
    };
  }, [api, selectedProject, refreshProject]);

  // 未保存の編集があるときは window の close / reload を止める。 Electron は
  // ダイアログを出さないので、 main process の will-prevent-unload が確認を出す。
  React.useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      if (!dirtyRef.current) return;
      e.preventDefault();
      e.returnValue = false;
    };
    globalThis.window?.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      globalThis.window?.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, []);

  // 他のアプリ (Claude Code 等) から戻ってきたときに project 一覧を更新する。
  // 選択中 project の中身は watcher が追うので、 ここでは一覧だけ (間引きあり)。
  React.useEffect(() => {
    const onFocus = (): void => {
      const now = Date.now();
      if (now - lastFocusRefreshRef.current < FOCUS_REFRESH_INTERVAL_MS) return;
      lastFocusRefreshRef.current = now;
      void refreshOverview();
    };
    globalThis.window?.addEventListener("focus", onFocus);
    return () => {
      globalThis.window?.removeEventListener("focus", onFocus);
    };
  }, [refreshOverview]);

  // body 全文一致検索: query 入力を debounce して server-side search に投げる。
  // scope = "project" は選択中 memoryDir、 scope = "all" は全 project 横断 (project
  // 未選択でも動く)。 結果は「どの検索の結果か」の key 付きで持ち、 表示は今の
  // 入力と key が一致するものだけ (古い応答が新しい表示を上書きしない)。
  const trimmedQuery = query.trim();
  const searchDir = searchScope === "project" ? (selectedProject?.memoryDir ?? null) : null;
  const scopeKey = searchScope === "project" ? `project\0${searchDir ?? ""}` : "all";
  const searchKey =
    trimmedQuery.length === 0 || (searchScope === "project" && searchDir === null)
      ? null
      : `${scopeKey}\0${trimmedQuery}`;
  React.useEffect(() => {
    if (searchKey === null) return;
    let cancelled = false;
    const handle = setTimeout(() => {
      const request =
        searchDir !== null
          ? api.search(searchDir, trimmedQuery).then((res) => ({
              key: searchKey,
              scopeKey,
              hits: res.hits,
              globalHits: [],
              truncated: res.truncated,
            }))
          : api.searchAll(trimmedQuery).then((res) => ({
              key: searchKey,
              scopeKey,
              hits: [],
              globalHits: res.hits,
              truncated: res.truncated,
            }));
      void request.then(
        (result) => {
          if (!cancelled) setSearchResult(result);
          return null;
        },
        (e: unknown) => {
          if (cancelled) return null;
          reportError(e);
          setSearchResult({ key: searchKey, scopeKey, hits: [], globalHits: [], truncated: false });
          return null;
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [api, searchKey, scopeKey, searchDir, trimmedQuery, reportError]);
  const exactSearch = searchResult !== null && searchResult.key === searchKey ? searchResult : null;
  // 入力中は同じ scope の直前の結果を出しておく (毎キーで一覧が消えてちらつかない)。
  const shownSearch =
    searchKey === null
      ? null
      : (exactSearch ?? (searchResult?.scopeKey === scopeKey ? searchResult : null));
  const searching = searchKey !== null && exactSearch === null;

  const handleSelectProject = React.useCallback(
    (project: MemoryProject) => {
      if (!confirmDiscard()) return;
      selectProject(project);
    },
    [confirmDiscard, selectProject],
  );

  const handleSelectIndex = React.useCallback(() => {
    if (selectionRef.current.kind === "index") return;
    if (!confirmDiscard()) return;
    setSelection({ kind: "index" });
    setOpenFile(null);
  }, [confirmDiscard]);

  /** 選択中 project 内のパスを開く (MEMORY.md なら index ビュー)。 */
  const openPathInProject = React.useCallback(
    async (project: MemoryProject, path: string, headers: readonly MemoryHeader[] | null) => {
      if (isIndexPath(project, path)) {
        setSelection({ kind: "index" });
        setOpenFile(null);
        return;
      }
      await showFile(path, headers);
    },
    [showFile],
  );

  const handleOpenPath = React.useCallback(
    async (path: string) => {
      if (!selectedProject) return;
      const current = selectionRef.current;
      if (current.kind === "file" && current.path === path) return;
      if (!confirmDiscard()) return;
      setBusy(true);
      try {
        await openPathInProject(selectedProject, path, memories);
      } catch (e: unknown) {
        reportError(e);
      } finally {
        setBusy(false);
      }
    },
    [selectedProject, memories, confirmDiscard, openPathInProject, reportError],
  );

  const handleSelectFile = React.useCallback(
    (header: MemoryHeader) => {
      void handleOpenPath(header.filePath);
    },
    [handleOpenPath],
  );

  const handleOpenRelative = React.useCallback(
    (relPath: string) => {
      if (!selectedProject) return;
      void handleOpenPath(joinMemoryPath(selectedProject, relPath));
    },
    [selectedProject, handleOpenPath],
  );

  // 全プロジェクト横断検索のヒットを開く: project を選択してから該当ファイルを開く。
  const handleOpenGlobalHit = React.useCallback(
    async (hit: GlobalMemorySearchHit) => {
      const project = projects.find((p) => p.memoryDir === hit.memoryDir);
      if (!project) return;
      if (!confirmDiscard()) return;
      setSelectedProject(project);
      setSelection({ kind: "none" });
      setOpenFile(null);
      saveProjectName(project.name);
      setBusy(true);
      try {
        const files = await loadProjectContent(project);
        await openPathInProject(project, hit.filePath, files);
      } catch (e: unknown) {
        reportError(e);
      } finally {
        setBusy(false);
      }
    },
    [projects, confirmDiscard, loadProjectContent, openPathInProject, reportError],
  );

  const handleSave = React.useCallback(
    async (raw: string, expectation: WriteExpectation): Promise<SaveOutcome> => {
      if (!selectedProject || selection.kind === "none") return { status: "failed" };
      setBusy(true);
      try {
        const result =
          selection.kind === "file"
            ? await api.writeFile(selection.path, raw, expectation)
            : await api.writeIndex(selectedProject.memoryDir, raw, expectation);
        // 保存できても衝突でも、 ディスク上の最新内容を読み直して見せる。
        await refreshProject(selectedProject);
        return result;
      } catch (e: unknown) {
        reportError(e);
        return { status: "failed" };
      } finally {
        setBusy(false);
      }
    },
    [api, selectedProject, selection, refreshProject, reportError],
  );

  const handleDelete = React.useCallback(
    async (removeIndexEntries: boolean) => {
      if (!selectedProject || selection.kind !== "file") return;
      setBusy(true);
      try {
        await api.deleteFile(selection.path, { removeIndexEntries });
        setSelection({ kind: "none" });
        setOpenFile(null);
        await loadProjectContent(selectedProject);
        void refreshOverview();
      } catch (e: unknown) {
        reportError(e);
      } finally {
        setBusy(false);
      }
    },
    [api, selectedProject, selection, loadProjectContent, refreshOverview, reportError],
  );

  // rename は dialog 側で throw をエラー表示に変換するため、 ここでは握り潰さず
  // に投げ直す。 成功時は一覧を更新し、 rename 後のファイルを開き直す。
  const handleRename = React.useCallback(
    async (newFilename: string, updateIndexLinks: boolean) => {
      if (!selectedProject || selection.kind !== "file") return;
      const result = await api.renameFile(selection.path, newFilename, { updateIndexLinks });
      const files = await loadProjectContent(selectedProject);
      await showFile(result.path, files);
    },
    [api, selectedProject, selection, loadProjectContent, showFile],
  );

  const handleCreate = React.useCallback(
    async (req: CreateMemoryRequest) => {
      if (!selectedProject) return;
      const header = await api.createFile(req);
      const files = await loadProjectContent(selectedProject);
      await showFile(header.filePath, files);
      void refreshOverview();
    },
    [api, selectedProject, loadProjectContent, showFile, refreshOverview],
  );

  /** index に載っていない memory のポインタを MEMORY.md の末尾に足す。 */
  const handleAddIndexEntries = React.useCallback(
    async (files: readonly string[]) => {
      if (!selectedProject || !index || files.length === 0) return;
      const lines = files.map((rel) => {
        const header = memories.find((m) => m.filename === rel);
        return buildIndexEntry(
          header?.name ?? rel.replace(/\.md$/, ""),
          rel,
          header?.description ?? "",
        );
      });
      const base = index.exists ? index.content : "";
      const eol = base.includes("\r\n") ? "\r\n" : "\n";
      const joiner = base.length === 0 || base.endsWith("\n") ? "" : eol;
      const next = `${base}${joiner}${lines.join(eol)}${eol}`;
      setBusy(true);
      try {
        const result = await api.writeIndex(selectedProject.memoryDir, next, {
          content: index.exists ? index.content : null,
        });
        if (result.status === "conflict") setError(t.app.indexChanged);
        await loadProjectContent(selectedProject);
      } catch (e: unknown) {
        reportError(e);
      } finally {
        setBusy(false);
      }
    },
    [api, selectedProject, index, memories, loadProjectContent, reportError, t.app.indexChanged],
  );

  const handleRevealInEditor = React.useCallback(async () => {
    const path =
      selection.kind === "file" ? selection.path : selection.kind === "index" ? index?.path : null;
    if (!path) return;
    try {
      await api.revealInEditor(path);
    } catch (e: unknown) {
      reportError(e);
    }
  }, [api, selection, index, reportError]);

  const handleOpenFolder = React.useCallback(async () => {
    if (!selectedProject) return;
    try {
      await api.openInFolder(selectedProject.memoryDir);
    } catch (e: unknown) {
      reportError(e);
    }
  }, [api, selectedProject, reportError]);

  const handleRefresh = React.useCallback(() => {
    void refreshOverview();
    if (selectedProject) void refreshProject(selectedProject);
  }, [refreshOverview, refreshProject, selectedProject]);

  const handleClearError = React.useCallback(() => {
    setError(null);
  }, []);

  const handleOpenCreate = React.useCallback(() => {
    if (!confirmDiscard()) return;
    setDialog("create");
  }, [confirmDiscard]);
  const handleAskRename = React.useCallback(() => {
    setDialog("rename");
  }, []);
  const handleOpenSettings = React.useCallback(() => {
    void refreshOverview();
    setDialog("settings");
  }, [refreshOverview]);
  const handleCloseDialog = React.useCallback(() => {
    setDialog("none");
  }, []);

  // app-wide keyboard shortcuts:
  //   - Cmd/Ctrl + R: refresh (Chromium 標準は reload なので preventDefault)
  //   - Cmd/Ctrl + N: 新規 memory (project 選択中のみ)
  //   - Cmd/Ctrl + F: search input にフォーカス
  // textarea / input 内では既存挙動を優先するため、 src が一致するときだけ動かす。
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName.toLowerCase() ?? "";
      const isField = tag === "input" || tag === "textarea" || tag === "select";
      const key = e.key.toLowerCase();
      if (key === "r") {
        e.preventDefault();
        handleRefresh();
        return;
      }
      if (key === "n" && !isField && selectedProject) {
        e.preventDefault();
        handleOpenCreate();
        return;
      }
      if (key === "f") {
        const input = document.querySelector<HTMLInputElement>("input.search[type=search]");
        if (input) {
          e.preventDefault();
          input.focus();
          input.select();
        }
      }
    };
    globalThis.window?.addEventListener("keydown", onKey);
    return () => {
      globalThis.window?.removeEventListener("keydown", onKey);
    };
  }, [handleRefresh, handleOpenCreate, selectedProject]);

  const handleToggleLocale = React.useCallback(() => {
    setLocale(locale === "ja" ? "en" : "ja");
  }, [locale, setLocale]);

  const otherLocaleLabel = locale === "ja" ? "EN" : "日本語";

  // catalog header の統計行: 一覧に見えている topic file の数と合計サイズ
  // (MEMORY.md は別枠。 project 一覧の fileCount と同じ数え方)。
  const catalogStats = React.useMemo(() => {
    if (!selectedProject) return null;
    const totalBytes = memories.reduce((sum, m) => sum + m.byteSize, 0);
    const base = `${formatFileCount(t, memories.length)} · ${formatFileSize(totalBytes)}`;
    return index?.exists ? `${base} · MEMORY.md` : base;
  }, [selectedProject, memories, index, t]);

  const doc: DetailDoc | null = React.useMemo(() => {
    if (!selectedProject) return null;
    if (selection.kind === "index") {
      return index ? { kind: "index", project: selectedProject, index } : null;
    }
    if (selection.kind === "file" && openFile?.path === selection.path) {
      return {
        kind: "file",
        project: selectedProject,
        header: openFile.header,
        file: openFile.file,
      };
    }
    return null;
  }, [selectedProject, selection, index, openFile]);

  // 別のドキュメントに移ったら MemoryDetail を作り直す (編集状態のリセット)。
  const docKey =
    selection.kind === "file"
      ? `file:${selection.path}`
      : selection.kind === "index"
        ? `index:${selectedProject?.memoryDir ?? ""}`
        : "none";

  const linkedFromIndex = React.useMemo(() => {
    if (!openFile || !index) return false;
    const rel = openFile.header.filename;
    return index.health.linkedFiles.some((linked) => samePath(linked, rel, platform));
  }, [openFile, index, platform]);

  return (
    <div className="app">
      <div className="topbar">
        <span className="brand" aria-hidden="true">
          <span className="brand-lens" />
          mem<span className="brand-em">lens</span>
        </span>
        <span className="topbar-meta">
          {`${String(projects.filter((p) => p.kind !== "agent").length)} ${t.app.projects.toLowerCase()}`}
        </span>
        <div className="topbar-actions">
          <button
            type="button"
            className="ghost"
            onClick={handleToggleLocale}
            title={t.app.switchLanguage}
            aria-label={t.app.switchLanguage}
          >
            {otherLocaleLabel}
          </button>
          <button
            type="button"
            className="ghost"
            onClick={handleOpenSettings}
            title={t.app.openSettings}
          >
            {t.settings.title}
          </button>
          <button
            type="button"
            className="ghost"
            onClick={handleRefresh}
            disabled={busy}
            title={t.app.refresh}
          >
            ↻ {t.app.refresh}
          </button>
        </div>
      </div>
      <aside className="rail">
        <header className="pane-head">
          <span className="eyebrow">{t.app.projects}</span>
        </header>
        <ProjectList
          projects={projects}
          selected={selectedProject}
          currentProject={currentProject}
          onSelect={handleSelectProject}
        />
        {settings && !settings.enabled ? (
          <div className="settings-warning">
            {t.app.disabledNote}
            <button type="button" className="link" onClick={handleOpenSettings}>
              {t.app.seeReason}
            </button>
          </div>
        ) : null}
      </aside>
      <aside className="catalog">
        <header className="pane-head">
          {selectedProject ? (
            <>
              <div className="pane-head-titles">
                <h2 title={selectedProject.name}>
                  {selectedProject.decodedProjectPath ?? selectedProject.displayName}
                </h2>
                {catalogStats ? <span className="pane-stats">{catalogStats}</span> : null}
              </div>
              <button
                type="button"
                className="ghost"
                onClick={handleOpenFolder}
                disabled={busy}
                title={revealLabel(t, platform)}
                aria-label={revealLabel(t, platform)}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  aria-hidden="true"
                >
                  <path d="M1.5 4a1 1 0 0 1 1-1h3l1.6 1.8h6.4a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4Z" />
                </svg>
              </button>
            </>
          ) : (
            <span className="eyebrow">{t.app.selectProject}</span>
          )}
        </header>
        <MemoryList
          hasProject={selectedProject !== null}
          memories={memories}
          index={index}
          selectedKind={selection.kind}
          selectedPath={selection.kind === "file" ? selection.path : null}
          query={query}
          onQueryChange={setQuery}
          searchScope={searchScope}
          onSearchScopeChange={setSearchScope}
          typeFilter={typeFilter}
          onTypeFilterChange={setTypeFilter}
          onSelectIndex={handleSelectIndex}
          onSelectFile={handleSelectFile}
          onCreateNew={handleOpenCreate}
          bodyHits={shownSearch?.hits ?? NO_HITS}
          onOpenHit={handleOpenPath}
          globalHits={shownSearch?.globalHits ?? NO_GLOBAL_HITS}
          onOpenGlobalHit={handleOpenGlobalHit}
          bodySearching={searching}
          bodyTruncated={shownSearch?.truncated ?? false}
        />
      </aside>
      <section className="stage">
        <MemoryDetail
          key={docKey}
          doc={doc}
          linkedFromIndex={linkedFromIndex}
          busy={busy}
          platform={platform}
          onSave={handleSave}
          onDelete={handleDelete}
          onAskRename={handleAskRename}
          onRevealInEditor={handleRevealInEditor}
          onDirtyChange={handleDirtyChange}
          onOpenFile={handleOpenRelative}
          onAddIndexEntries={handleAddIndexEntries}
        />
      </section>
      {error ? (
        <div className="error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={handleClearError} aria-label={t.app.closeError}>
            ×
          </button>
        </div>
      ) : null}
      {dialog === "create" && selectedProject ? (
        <CreateMemoryDialog
          memoryDir={selectedProject.memoryDir}
          onClose={handleCloseDialog}
          onCreate={handleCreate}
        />
      ) : null}
      {dialog === "rename" && openFile ? (
        <RenameMemoryDialog
          currentFilename={openFile.header.filename}
          linkedFromIndex={linkedFromIndex}
          onClose={handleCloseDialog}
          onRename={handleRename}
        />
      ) : null}
      {dialog === "settings" ? (
        <SettingsPanel settings={settings} onClose={handleCloseDialog} />
      ) : null}
    </div>
  );
}
