import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type {
  MemoryHeader,
  MemoryIndexResult,
  MemoryProject,
  ParsedMemoryFile,
} from "@shared/api/contract.ts";
import { MEMORY_CONSTANTS } from "@shared/schema/memory.ts";
import { formatFileSize } from "@shared/util/format.ts";

import { extractDisplayMeta } from "../hooks/frontmatter.ts";
import { formatMemoryAge, isStaleFlagged } from "../hooks/memoryAge.ts";
import { modKeyLabel } from "../hooks/platform.ts";
import { useTranslation } from "../i18n/index.ts";

export type Selection =
  | { readonly kind: "none" }
  | {
      readonly kind: "index";
      readonly project: MemoryProject;
      readonly index: MemoryIndexResult;
    }
  | {
      readonly kind: "file";
      readonly project: MemoryProject;
      readonly header: MemoryHeader;
      readonly file: ParsedMemoryFile;
    };

type Props = {
  readonly selection: Selection;
  readonly onSave: (raw: string) => void | Promise<void>;
  readonly onDelete: () => void | Promise<void>;
  readonly onAskRename: () => void;
  readonly onRevealInEditor: () => void | Promise<void>;
  readonly loading: boolean;
  readonly platform: string;
};

export function MemoryDetail(props: Props): React.ReactElement {
  const {
    selection,
    onSave,
    onDelete,
    onAskRename,
    onRevealInEditor,
    loading,
    platform,
  } = props;
  const { t } = useTranslation();
  const remarkPlugins = React.useMemo(() => [remarkGfm], []);
  const [editing, setEditing] = React.useState(false);
  const [previewingEdit, setPreviewingEdit] = React.useState(false);
  const [buffer, setBuffer] = React.useState("");
  const [original, setOriginal] = React.useState("");
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const editorRef = React.useRef<HTMLTextAreaElement | null>(null);

  React.useEffect(() => {
    setEditing(false);
    setPreviewingEdit(false);
    setBuffer("");
    setOriginal("");
    setConfirmDelete(false);
    setCopied(false);
  }, [selection]);

  // 編集モードに入ったら textarea にフォーカスを移す (jsx-a11y/no-autofocus 回避
  // のため autoFocus 属性は使わず、 ユーザのアクション起因の effect で focus する)。
  React.useEffect(() => {
    if (editing && !previewingEdit) {
      editorRef.current?.focus();
    }
  }, [editing, previewingEdit]);

  const handleBufferChange = React.useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setBuffer(e.target.value);
    },
    [],
  );

  const handleEnterEdit = React.useCallback(() => {
    if (selection.kind === "none") return;
    const raw =
      selection.kind === "file" ? selection.file.raw : selection.index.content;
    setBuffer(raw);
    setOriginal(raw);
    setPreviewingEdit(false);
    setEditing(true);
  }, [selection]);

  const handleCancelEdit = React.useCallback(() => {
    setEditing(false);
    setPreviewingEdit(false);
  }, []);

  const dirty = editing && buffer !== original;

  const handleSave = React.useCallback(async () => {
    await onSave(buffer);
    setEditing(false);
    setPreviewingEdit(false);
  }, [buffer, onSave]);

  // Cmd/Ctrl+S で save, Esc で cancel。 textarea にフォーカスがあるときだけ
  // 効くようにし、 IME 入力 (composing) は妨げない。
  const handleEditorKey = React.useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.nativeEvent.isComposing) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void handleSave();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setEditing(false);
        setPreviewingEdit(false);
      }
    },
    [handleSave],
  );

  const handleShowWrite = React.useCallback(() => {
    setPreviewingEdit(false);
  }, []);
  const handleShowPreview = React.useCallback(() => {
    setPreviewingEdit(true);
  }, []);

  const handleAskDelete = React.useCallback(() => {
    setConfirmDelete(true);
  }, []);

  const handleCancelDelete = React.useCallback(() => {
    setConfirmDelete(false);
  }, []);

  const handleDelete = React.useCallback(async () => {
    await onDelete();
  }, [onDelete]);

  const handleRevealInEditor = React.useCallback(() => {
    void onRevealInEditor();
  }, [onRevealInEditor]);

  const path =
    selection.kind === "none"
      ? null
      : selection.kind === "file"
        ? selection.file.path
        : selection.index.path;

  const handleCopyPath = React.useCallback(() => {
    if (path === null) return;
    void navigator.clipboard
      .writeText(path)
      .then(() => {
        setCopied(true);
        setTimeout(() => {
          setCopied(false);
        }, 1600);
        return null;
      })
      .catch(() => {
        /* clipboard 不可の環境では無視 (UI を壊さない) */
      });
  }, [path]);

  if (selection.kind === "none" || path === null) {
    const mod = modKeyLabel(platform);
    return (
      <div className="placeholder">
        <span className="brand-lens big" aria-hidden="true" />
        <p>{t.detail.selectPrompt}</p>
        <p className="shortcuts">
          <span className="sc">
            <kbd>{mod}F</kbd> {t.detail.shortcutSearch}
          </span>
          <span className="sc">
            <kbd>{mod}N</kbd> {t.detail.shortcutNew}
          </span>
          <span className="sc">
            <kbd>{mod}R</kbd> {t.detail.shortcutReload}
          </span>
        </p>
      </div>
    );
  }

  const body =
    selection.kind === "file"
      ? selection.file.body
      : selection.index.loadedContent;
  const meta =
    selection.kind === "file"
      ? extractDisplayMeta(selection.file.frontmatter, selection.header)
      : { title: "MEMORY.md", description: null, type: null };
  const age =
    selection.kind === "file"
      ? formatMemoryAge(selection.header.mtimeMs, t)
      : null;
  const stale =
    selection.kind === "file" && isStaleFlagged(selection.header.mtimeMs);

  return (
    <div className="memory-detail" key={path}>
      <header className="doc-head">
        <div className="detail-title">
          <div className="doc-eyebrow">
            {meta.type ? (
              <span className={`memory-type type-${meta.type}`}>
                {meta.type}
              </span>
            ) : null}
            {selection.kind === "index" ? (
              <span className="memory-type type-index">index</span>
            ) : null}
            {age ? <span className="doc-age">{age}</span> : null}
            {stale ? (
              <span className="stale-chip" title={t.detail.staleTitle}>
                {t.detail.staleChip}
              </span>
            ) : null}
          </div>
          <h2>{meta.title}</h2>
          {meta.description ? (
            <p className="description">{meta.description}</p>
          ) : null}
          {selection.kind === "index" ? (
            <BudgetMeter index={selection.index} />
          ) : null}
          <div className="path-row">
            <code className="path">{path}</code>
            <button
              type="button"
              className="ghost tiny"
              onClick={handleCopyPath}
              title={t.detail.copyPath}
            >
              {copied ? t.detail.copied : t.detail.copyPath}
            </button>
          </div>
        </div>
        <div className="actions">
          {editing ? (
            <>
              <div className="edit-tabs">
                <button
                  type="button"
                  className={previewingEdit ? "seg" : "seg active"}
                  aria-pressed={!previewingEdit}
                  onClick={handleShowWrite}
                >
                  {t.detail.write}
                </button>
                <button
                  type="button"
                  className={previewingEdit ? "seg active" : "seg"}
                  aria-pressed={previewingEdit}
                  onClick={handleShowPreview}
                >
                  {t.detail.preview}
                </button>
              </div>
              <button
                type="button"
                className="primary"
                onClick={handleSave}
                disabled={loading || !dirty}
              >
                {dirty ? `● ${t.detail.save}` : t.detail.save}
              </button>
              <button
                type="button"
                onClick={handleCancelEdit}
                disabled={loading}
              >
                {t.detail.cancel}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={handleEnterEdit}
                disabled={loading}
              >
                {t.detail.edit}
              </button>
              {selection.kind === "file" ? (
                <button type="button" onClick={onAskRename} disabled={loading}>
                  {t.detail.rename}
                </button>
              ) : null}
              <button
                type="button"
                className="ghost"
                onClick={handleRevealInEditor}
                disabled={loading}
                title={t.detail.externalEditorTitle}
              >
                {t.detail.externalEditor}
              </button>
              {selection.kind === "file" ? (
                confirmDelete ? (
                  <>
                    <button
                      type="button"
                      className="danger"
                      onClick={handleDelete}
                      disabled={loading}
                    >
                      {t.detail.confirmDelete}
                    </button>
                    <button
                      type="button"
                      onClick={handleCancelDelete}
                      disabled={loading}
                    >
                      {t.detail.cancel}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="danger"
                    onClick={handleAskDelete}
                    disabled={loading}
                  >
                    {t.detail.askDelete}
                  </button>
                )
              ) : null}
            </>
          )}
        </div>
      </header>
      {editing ? (
        previewingEdit ? (
          <article className="markdown">
            <ReactMarkdown remarkPlugins={remarkPlugins}>
              {buffer}
            </ReactMarkdown>
          </article>
        ) : (
          <textarea
            ref={editorRef}
            className="editor"
            aria-label="memory content editor"
            value={buffer}
            onChange={handleBufferChange}
            onKeyDown={handleEditorKey}
            spellCheck={false}
            disabled={loading}
          />
        )
      ) : (
        <article className="markdown">
          <ReactMarkdown remarkPlugins={remarkPlugins}>{body}</ReactMarkdown>
        </article>
      )}
    </div>
  );
}

type BudgetMeterProps = {
  readonly index: MemoryIndexResult;
};

/**
 * MEMORY.md のロードバジェット計。
 *
 * Claude Code は MEMORY.md の先頭 200 行 / 25KB だけをロードする
 * (公式 src/memdir/memdir.ts:35,38 の MAX_ENTRYPOINT_LINES / _BYTES)。
 * 「あとどれだけ書けるか」を 2 本のゲージで見せる。 超過はゲージが満杯 +
 * over 表示になる。
 */
const BudgetMeter = React.memo(function BudgetMeter(
  props: BudgetMeterProps,
): React.ReactElement | null {
  const { index } = props;
  const { t } = useTranslation();
  const { MAX_ENTRYPOINT_LINES, MAX_ENTRYPOINT_BYTES } = MEMORY_CONSTANTS;
  const linePct = Math.min(100, (index.lineCount / MAX_ENTRYPOINT_LINES) * 100);
  const bytePct = Math.min(100, (index.byteCount / MAX_ENTRYPOINT_BYTES) * 100);
  const lineStyle = React.useMemo(
    () => ({ width: `${String(linePct)}%` }),
    [linePct],
  );
  const byteStyle = React.useMemo(
    () => ({ width: `${String(bytePct)}%` }),
    [bytePct],
  );
  if (!index.exists) return null;
  const over = index.wasLineTruncated || index.wasByteTruncated;
  return (
    <div
      className={over ? "budget-meter over" : "budget-meter"}
      title={over ? t.detail.indexLoadNote : t.detail.budgetTitle}
    >
      <span className="meter-title">{t.detail.budgetTitle}</span>
      <div className="meter-row">
        <span className="meter-label">{t.detail.indexLineUnit}</span>
        <span className="meter-track">
          <span className="meter-fill" style={lineStyle} />
        </span>
        <span className="meter-value">
          {String(index.lineCount)}/{String(MAX_ENTRYPOINT_LINES)}
        </span>
      </div>
      <div className="meter-row">
        <span className="meter-label">bytes</span>
        <span className="meter-track">
          <span className="meter-fill" style={byteStyle} />
        </span>
        <span className="meter-value">
          {formatFileSize(index.byteCount)}/
          {formatFileSize(MAX_ENTRYPOINT_BYTES)}
        </span>
      </div>
    </div>
  );
});
