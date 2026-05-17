import * as React from "react";

import type {
  CreateMemoryRequest,
  MemoryHeader,
  MemoryIndexResult,
  MemoryProject,
  MemorySearchHit,
  MemorySettings,
  MemoryType,
} from "@shared/api/contract.ts";

import { CreateMemoryDialog } from "./components/CreateMemoryDialog.tsx";
import { MemoryDetail, type Selection } from "./components/MemoryDetail.tsx";
import { MemoryList } from "./components/MemoryList.tsx";
import { ProjectList } from "./components/ProjectList.tsx";
import { SettingsPanel } from "./components/SettingsPanel.tsx";
import { useTranslation } from "./i18n/index.ts";

const LAST_PROJECT_STORAGE_KEY = "memlens.lastProjectName";

export function App(): React.ReactElement {
  const { t, locale, setLocale } = useTranslation();
  const [projects, setProjects] = React.useState<readonly MemoryProject[]>([]);
  const [currentProject, setCurrentProject] =
    React.useState<MemoryProject | null>(null);
  const [selectedProject, setSelectedProject] =
    React.useState<MemoryProject | null>(null);
  const [memories, setMemories] = React.useState<readonly MemoryHeader[]>([]);
  const [index, setIndex] = React.useState<MemoryIndexResult | null>(null);
  const [selection, setSelection] = React.useState<Selection>({ kind: "none" });
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [typeFilter, setTypeFilter] = React.useState<MemoryType | null>(null);
  const [showCreate, setShowCreate] = React.useState(false);
  const [showSettings, setShowSettings] = React.useState(false);
  const [settings, setSettings] = React.useState<MemorySettings | null>(null);
  const [bodyHits, setBodyHits] = React.useState<readonly MemorySearchHit[]>(
    [],
  );
  const [bodySearching, setBodySearching] = React.useState(false);
  const [bodyTruncated, setBodyTruncated] = React.useState(false);

  // localStorage に最後に開いていた project name を保持して、 アプリ再起動時に
  // 自動で復元する。 project.name は sanitize 済みの安定 ID なので key として
  // そのまま使える。 復元前提なので 1 度復元したら以後は selection-side で更新。
  const [restoredProjectName, setRestoredProjectName] = React.useState<
    string | null
  >(() => {
    try {
      return globalThis.localStorage?.getItem(LAST_PROJECT_STORAGE_KEY);
    } catch {
      return null;
    }
  });

  const reportError = React.useCallback((e: unknown) => {
    setError(e instanceof Error ? e.message : String(e));
  }, []);

  const refreshProjects = React.useCallback(async () => {
    try {
      const list = await window.memlens.memory.listProjects();
      setProjects(list);
    } catch (e: unknown) {
      reportError(e);
    }
  }, [reportError]);

  const refreshSettings = React.useCallback(async () => {
    try {
      const s = await window.memlens.memory.getSettings();
      setSettings(s);
    } catch (e: unknown) {
      reportError(e);
    }
  }, [reportError]);

  const refreshCurrentProject = React.useCallback(async () => {
    try {
      const cur = await window.memlens.memory.resolveProjectForPath(".");
      setCurrentProject(cur);
    } catch (e: unknown) {
      reportError(e);
    }
  }, [reportError]);

  React.useEffect(() => {
    void refreshProjects();
    void refreshSettings();
    void refreshCurrentProject();
  }, [refreshProjects, refreshSettings, refreshCurrentProject]);

  const refreshProjectContent = React.useCallback(
    async (project: MemoryProject) => {
      setLoading(true);
      try {
        const [files, idx] = await Promise.all([
          window.memlens.memory.listFiles(project.memoryDir),
          window.memlens.memory.readIndex(project.memoryDir),
        ]);
        setMemories(files);
        setIndex(idx);
      } catch (e: unknown) {
        reportError(e);
      } finally {
        setLoading(false);
      }
    },
    [reportError],
  );

  // 選択中 project の memoryDir を fs.watch (主に Claude Code 本体が memory を
  // 書いたタイミングで UI を自動更新するため)。 unmount / 再選択時に解除する。
  React.useEffect(() => {
    if (!selectedProject) return;
    const project = selectedProject;
    const unsubscribe = window.memlens.memory.watch(project.memoryDir, () => {
      void refreshProjectContent(project);
    });
    return () => {
      unsubscribe();
    };
  }, [selectedProject, refreshProjectContent]);

  // body 全文一致検索: query 入力を 250ms debounce して server-side search に
  // 投げる。 query が空 / project 未選択なら即クリアする。 race は最後の
  // request だけを反映する単純な ID で防ぐ (AbortController を渡せる IPC で
  // ないため)。
  React.useEffect(() => {
    if (!selectedProject) {
      setBodyHits([]);
      setBodySearching(false);
      setBodyTruncated(false);
      return;
    }
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setBodyHits([]);
      setBodySearching(false);
      setBodyTruncated(false);
      return;
    }
    const dir = selectedProject.memoryDir;
    let cancelled = false;
    setBodySearching(true);
    const handle = setTimeout(() => {
      void window.memlens.memory
        .search(dir, trimmed)
        .then((res) => {
          if (cancelled) return null;
          setBodyHits(res.hits);
          setBodyTruncated(res.truncated);
          return null;
        })
        .catch((e: unknown) => {
          if (!cancelled) reportError(e);
        })
        .finally(() => {
          if (!cancelled) setBodySearching(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [selectedProject, query, reportError]);

  const handleSelectProject = React.useCallback(
    (project: MemoryProject) => {
      setSelectedProject(project);
      setSelection({ kind: "none" });
      try {
        globalThis.localStorage?.setItem(
          LAST_PROJECT_STORAGE_KEY,
          project.name,
        );
      } catch {
        /* persist failure should not break the UI */
      }
      void refreshProjectContent(project);
    },
    [refreshProjectContent],
  );

  // projects 取得後、 localStorage に保存された project に自動でジャンプする
  // (1 度限り)。 hit がなければ復元を諦めて以後の手動選択に任せる。
  React.useEffect(() => {
    if (restoredProjectName === null) return;
    if (projects.length === 0) return;
    if (selectedProject !== null) {
      setRestoredProjectName(null);
      return;
    }
    const match = projects.find((p) => p.name === restoredProjectName);
    if (match) {
      handleSelectProject(match);
    }
    setRestoredProjectName(null);
  }, [restoredProjectName, projects, selectedProject, handleSelectProject]);

  const handleSelectIndex = React.useCallback(() => {
    if (!selectedProject || !index) return;
    setSelection({ kind: "index", project: selectedProject, index });
  }, [selectedProject, index]);

  const handleSelectFile = React.useCallback(
    async (header: MemoryHeader) => {
      if (!selectedProject) return;
      setLoading(true);
      try {
        const file = await window.memlens.memory.readFile(header.filePath);
        setSelection({
          kind: "file",
          project: selectedProject,
          header,
          file,
        });
      } catch (e: unknown) {
        reportError(e);
      } finally {
        setLoading(false);
      }
    },
    [selectedProject, reportError],
  );

  const refreshAfterEdit = React.useCallback(
    async (project: MemoryProject, target: Selection): Promise<void> => {
      await refreshProjectContent(project);
      if (target.kind === "file") {
        const updated = await window.memlens.memory.readFile(target.file.path);
        setSelection({
          kind: "file",
          project,
          header: target.header,
          file: updated,
        });
      } else if (target.kind === "index") {
        const idx = await window.memlens.memory.readIndex(project.memoryDir);
        setSelection({ kind: "index", project, index: idx });
      }
    },
    [refreshProjectContent],
  );

  const handleSave = React.useCallback(
    async (raw: string) => {
      if (selection.kind === "none") return;
      setLoading(true);
      try {
        if (selection.kind === "file") {
          await window.memlens.memory.writeFile(selection.file.path, raw);
        } else {
          await window.memlens.memory.writeIndex(
            selection.project.memoryDir,
            raw,
          );
        }
        await refreshAfterEdit(selection.project, selection);
      } catch (e: unknown) {
        reportError(e);
      } finally {
        setLoading(false);
      }
    },
    [selection, refreshAfterEdit, reportError],
  );

  const handleDelete = React.useCallback(async () => {
    if (selection.kind !== "file") return;
    setLoading(true);
    try {
      await window.memlens.memory.deleteFile(selection.file.path);
      setSelection({ kind: "none" });
      await refreshProjectContent(selection.project);
    } catch (e: unknown) {
      reportError(e);
    } finally {
      setLoading(false);
    }
  }, [selection, refreshProjectContent, reportError]);

  const handleRevealInEditor = React.useCallback(async () => {
    if (selection.kind === "none") return;
    const target =
      selection.kind === "file" ? selection.file.path : selection.index.path;
    try {
      await window.memlens.memory.revealInEditor(target);
    } catch (e: unknown) {
      reportError(e);
    }
  }, [selection, reportError]);

  const handleOpenFolder = React.useCallback(async () => {
    if (!selectedProject) return;
    try {
      await window.memlens.memory.openInFolder(selectedProject.memoryDir);
    } catch (e: unknown) {
      reportError(e);
    }
  }, [selectedProject, reportError]);

  const handleRefresh = React.useCallback(() => {
    void refreshProjects();
    void refreshCurrentProject();
    void refreshSettings();
    if (selectedProject) {
      void refreshProjectContent(selectedProject);
    }
  }, [
    refreshProjects,
    refreshCurrentProject,
    refreshSettings,
    refreshProjectContent,
    selectedProject,
  ]);

  const handleClearError = React.useCallback(() => {
    setError(null);
  }, []);

  const handleOpenCreate = React.useCallback(() => {
    setShowCreate(true);
  }, []);
  const handleCloseCreate = React.useCallback(() => {
    setShowCreate(false);
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
        const input = document.querySelector<HTMLInputElement>(
          "input.search[type=search]",
        );
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
  const handleCreate = React.useCallback(
    async (req: CreateMemoryRequest) => {
      const header = await window.memlens.memory.createFile(req);
      if (selectedProject) {
        await refreshProjectContent(selectedProject);
        const file = await window.memlens.memory.readFile(header.filePath);
        setSelection({
          kind: "file",
          project: selectedProject,
          header,
          file,
        });
      }
    },
    [selectedProject, refreshProjectContent],
  );

  const handleOpenSettings = React.useCallback(() => {
    void refreshSettings();
    setShowSettings(true);
  }, [refreshSettings]);
  const handleCloseSettings = React.useCallback(() => {
    setShowSettings(false);
  }, []);

  const handleToggleLocale = React.useCallback(() => {
    setLocale(locale === "ja" ? "en" : "ja");
  }, [locale, setLocale]);

  const otherLocaleLabel = locale === "ja" ? "EN" : "日本語";

  return (
    <div className="app">
      <aside className="projects">
        <header>
          <h2>{t.app.projects}</h2>
          <div className="header-actions">
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
              disabled={loading}
              title={t.app.openSettings}
            >
              ⚙
            </button>
            <button
              type="button"
              className="ghost"
              onClick={handleRefresh}
              disabled={loading}
              title={t.app.refresh}
            >
              ↻
            </button>
          </div>
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
      <aside className="memories">
        <header>
          {selectedProject ? (
            <>
              <h2 title={selectedProject.name}>
                {selectedProject.decodedProjectPath ?? selectedProject.name}
              </h2>
              <button
                type="button"
                className="ghost"
                onClick={handleOpenFolder}
                disabled={loading}
                title={t.app.openInExplorer}
              >
                📂
              </button>
            </>
          ) : (
            <h2>{t.app.selectProject}</h2>
          )}
        </header>
        {selectedProject ? (
          <MemoryList
            memories={memories}
            index={index}
            selectedKind={selection.kind}
            selectedPath={
              selection.kind === "file" ? selection.file.path : null
            }
            query={query}
            onQueryChange={setQuery}
            typeFilter={typeFilter}
            onTypeFilterChange={setTypeFilter}
            onSelectIndex={handleSelectIndex}
            onSelectFile={handleSelectFile}
            onCreateNew={handleOpenCreate}
            bodyHits={bodyHits}
            bodySearching={bodySearching}
            bodyTruncated={bodyTruncated}
          />
        ) : null}
      </aside>
      <section className="detail">
        <MemoryDetail
          selection={selection}
          onSave={handleSave}
          onDelete={handleDelete}
          onRevealInEditor={handleRevealInEditor}
          loading={loading}
        />
      </section>
      {error ? (
        <div className="error" role="alert">
          <span>{error}</span>
          <button
            type="button"
            onClick={handleClearError}
            aria-label={t.app.closeError}
          >
            ×
          </button>
        </div>
      ) : null}
      {showCreate && selectedProject ? (
        <CreateMemoryDialog
          memoryDir={selectedProject.memoryDir}
          onClose={handleCloseCreate}
          onCreate={handleCreate}
        />
      ) : null}
      {showSettings ? (
        <SettingsPanel settings={settings} onClose={handleCloseSettings} />
      ) : null}
    </div>
  );
}
