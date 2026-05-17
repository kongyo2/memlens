import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type {
  MemoryHeader,
  MemoryIndexResult,
  MemoryProject,
  ParsedMemoryFile,
} from "@shared/api/contract.ts";

import { extractDisplayMeta } from "../hooks/frontmatter.ts";
import { useTranslation } from "../i18n/index.ts";
import type { Dict } from "../i18n/index.ts";

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
  readonly onRevealInEditor: () => void | Promise<void>;
  readonly loading: boolean;
};

export function MemoryDetail(props: Props): React.ReactElement {
  const { selection, onSave, onDelete, onRevealInEditor, loading } = props;
  const { t } = useTranslation();
  const remarkPlugins = React.useMemo(() => [remarkGfm], []);
  const [editing, setEditing] = React.useState(false);
  const [buffer, setBuffer] = React.useState("");
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const editorRef = React.useRef<HTMLTextAreaElement | null>(null);

  React.useEffect(() => {
    setEditing(false);
    setBuffer("");
    setConfirmDelete(false);
  }, [selection]);

  // 編集モードに入ったら textarea にフォーカスを移す (jsx-a11y/no-autofocus 回避
  // のため autoFocus 属性は使わず、 ユーザのアクション起因の effect で focus する)。
  React.useEffect(() => {
    if (editing) {
      editorRef.current?.focus();
    }
  }, [editing]);

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
    setEditing(true);
  }, [selection]);

  const handleCancelEdit = React.useCallback(() => {
    setEditing(false);
  }, []);

  const handleSave = React.useCallback(async () => {
    await onSave(buffer);
    setEditing(false);
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
      }
    },
    [handleSave],
  );

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

  if (selection.kind === "none") {
    return <div className="placeholder">{t.detail.selectPrompt}</div>;
  }

  const path =
    selection.kind === "file" ? selection.file.path : selection.index.path;
  const body =
    selection.kind === "file"
      ? selection.file.body
      : selection.index.loadedContent;
  const meta =
    selection.kind === "file"
      ? extractDisplayMeta(selection.file.frontmatter, selection.header)
      : { title: "MEMORY.md", description: null, type: null };
  const indexInfo =
    selection.kind === "index" ? buildIndexInfo(selection.index, t) : null;

  return (
    <div className="memory-detail">
      <header>
        <div className="detail-title">
          <h2>{meta.title}</h2>
          <div className="memory-meta-row">
            {meta.type ? (
              <span className={`memory-type type-${meta.type}`}>
                {meta.type}
              </span>
            ) : null}
            {meta.description ? (
              <span className="description">{meta.description}</span>
            ) : null}
          </div>
          <code className="path">{path}</code>
          {indexInfo ? <span className="index-info">{indexInfo}</span> : null}
        </div>
        <div className="actions">
          {editing ? (
            <>
              <button
                type="button"
                className="primary"
                onClick={handleSave}
                disabled={loading}
              >
                {t.detail.save}
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
      ) : (
        <article className="markdown">
          <ReactMarkdown remarkPlugins={remarkPlugins}>{body}</ReactMarkdown>
        </article>
      )}
    </div>
  );
}

function buildIndexInfo(index: MemoryIndexResult, t: Dict): string {
  const exceeded = index.wasLineTruncated || index.wasByteTruncated;
  const base = `${String(index.lineCount)} ${t.detail.indexLineUnit} / ${String(index.byteCount)} bytes`;
  return exceeded ? `${base} · ${t.detail.indexLoadNote}` : base;
}
