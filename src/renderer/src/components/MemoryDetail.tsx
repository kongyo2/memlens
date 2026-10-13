import type {
  MemoryHeader,
  MemoryIndexResult,
  MemoryProject,
  ParsedMemoryFile,
  WriteExpectation,
  WriteResult,
} from "@shared/api/contract.ts";
import { MEMORY_CONSTANTS } from "@shared/schema/memory.ts";
import { formatFileSize } from "@shared/util/format.ts";
import { splitFrontmatter } from "@shared/util/frontmatterBlock.ts";
import { describeCodePoint, inspectHygiene } from "@shared/util/hygiene.ts";
import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { extractDisplayMeta } from "../hooks/frontmatter.ts";
import {
  formatMemoryAge,
  formatTimestamp,
  isStaleFlagged,
  memoryTimeMs,
} from "../hooks/memoryAge.ts";
import { modKeyLabel } from "../hooks/platform.ts";
import { formatLineCount, useTranslation } from "../i18n/index.ts";
import { IndexHealthPanel } from "./IndexHealthPanel.tsx";

/** detail pane に表示するドキュメント。 */
export type DetailDoc =
  | {
      readonly kind: "index";
      readonly project: MemoryProject;
      readonly index: MemoryIndexResult;
    }
  | {
      readonly kind: "file";
      readonly project: MemoryProject;
      readonly header: MemoryHeader;
      /** 開いている間にディスク上で削除されたら null (未保存の編集を守るため残す)。 */
      readonly file: ParsedMemoryFile | null;
    };

/** 保存の結果。 failed は App 側でエラー表示済み。 */
export type SaveOutcome = WriteResult | { readonly status: "failed" };

type Props = {
  readonly doc: DetailDoc | null;
  /** 開いているファイルが MEMORY.md からリンクされているか (削除時のポインタ掃除用)。 */
  readonly linkedFromIndex: boolean;
  readonly busy: boolean;
  readonly platform: string;
  readonly onSave: (raw: string, expectation: WriteExpectation) => Promise<SaveOutcome>;
  readonly onDelete: (removeIndexEntries: boolean) => void | Promise<void>;
  readonly onAskRename: () => void;
  readonly onRevealInEditor: () => void | Promise<void>;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly onOpenFile: (relPath: string) => void;
  readonly onAddIndexEntries: (files: readonly string[]) => void | Promise<void>;
};

const REMARK_PLUGINS = [remarkGfm];

/** textarea は値を LF に正規化するので、 比較も LF に揃えて行う。 */
function toLf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function docPath(doc: DetailDoc): string {
  return doc.kind === "file" ? doc.header.filePath : doc.index.path;
}

/** ディスク上の現在の raw (存在しなければ null)。 */
function diskRaw(doc: DetailDoc): string | null {
  if (doc.kind === "file") return doc.file?.raw ?? null;
  return doc.index.exists ? doc.index.content : null;
}

/**
 * 1 つのドキュメント (memory ファイル / MEMORY.md) の閲覧と編集。
 *
 * App はドキュメントのパスを key にしてこのコンポーネントを描くので、 別の
 * ドキュメントに移ると編集状態ごと作り直される。 同じドキュメントの再読込
 * (Claude Code の書き込みを watcher が拾った等) では編集中のバッファを保ち、
 * 「編集開始時点の内容」と「今のディスク上の内容」を比べて食い違いを知らせる。
 */
export function MemoryDetail(props: Props): React.ReactElement {
  const { doc } = props;
  if (doc === null) return <Placeholder platform={props.platform} />;
  return <DocumentView {...props} doc={doc} />;
}

type DocumentViewProps = Omit<Props, "doc"> & { readonly doc: DetailDoc };

function DocumentView(props: DocumentViewProps): React.ReactElement {
  const {
    doc,
    linkedFromIndex,
    busy,
    onSave,
    onDelete,
    onAskRename,
    onRevealInEditor,
    onDirtyChange,
    onOpenFile,
    onAddIndexEntries,
  } = props;
  const { t } = useTranslation();
  const [editing, setEditing] = React.useState(false);
  const [previewingEdit, setPreviewingEdit] = React.useState(false);
  /** 編集を始めた時点のディスク上の raw (null = まだ存在しなかった)。 */
  const [baseline, setBaseline] = React.useState<{ readonly raw: string | null } | null>(null);
  const [buffer, setBuffer] = React.useState("");
  /** 保存しようとしたらディスク上の内容が変わっていた。 */
  const [conflict, setConflict] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [removePointer, setRemovePointer] = React.useState(true);
  const [copied, setCopied] = React.useState(false);
  const editorRef = React.useRef<HTMLTextAreaElement | null>(null);
  const copiedTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const current = diskRaw(doc);
  const path = docPath(doc);
  const dirty = editing && baseline !== null && buffer !== toLf(baseline.raw ?? "");
  const changedOnDisk = editing && baseline !== null && current !== baseline.raw;
  const deletedOnDisk = doc.kind === "file" && doc.file === null;

  // 編集モードに入ったら textarea にフォーカスを移す (jsx-a11y/no-autofocus 回避
  // のため autoFocus 属性は使わず、 ユーザのアクション起因の effect で focus する)。
  React.useEffect(() => {
    if (editing && !previewingEdit) editorRef.current?.focus();
  }, [editing, previewingEdit]);

  // 未保存の編集の有無を App に伝える (別ドキュメントへの移動や window close の確認用)。
  React.useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  React.useEffect(
    () => () => {
      onDirtyChange(false);
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
    },
    [onDirtyChange],
  );

  const hygiene = React.useMemo(
    () => (current === null ? null : inspectHygiene(current)),
    [current],
  );
  // 編集中のプレビューも frontmatter と本文を分けて描く。
  const previewSplit = React.useMemo(
    () => (editing && previewingEdit ? splitFrontmatter(buffer) : null),
    [editing, previewingEdit, buffer],
  );

  const handleBufferChange = React.useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setBuffer(e.target.value);
  }, []);

  const handleEnterEdit = React.useCallback(() => {
    setBaseline({ raw: current });
    setBuffer(toLf(current ?? ""));
    setPreviewingEdit(false);
    setConflict(false);
    setConfirmDelete(false);
    setEditing(true);
  }, [current]);

  const leaveEdit = React.useCallback(() => {
    setEditing(false);
    setPreviewingEdit(false);
    setConflict(false);
    setBaseline(null);
  }, []);

  const handleCancelEdit = React.useCallback(() => {
    if (dirty && !globalThis.confirm(t.app.discardConfirm)) return;
    leaveEdit();
  }, [dirty, leaveEdit, t.app.discardConfirm]);

  const save = React.useCallback(
    async (force: boolean) => {
      if (baseline === null) return;
      setSaving(true);
      // onSave は失敗を "failed" で返すが、 万一 reject しても saving を戻せるようにする。
      const outcome = await onSave(buffer, force ? null : { content: baseline.raw }).catch(
        (): SaveOutcome => ({ status: "failed" }),
      );
      setSaving(false);
      if (outcome.status === "saved") {
        leaveEdit();
      } else if (outcome.status === "conflict") {
        setConflict(true);
      }
    },
    [baseline, buffer, onSave, leaveEdit],
  );

  const handleSave = React.useCallback(() => {
    void save(false);
  }, [save]);
  const handleOverwrite = React.useCallback(() => {
    void save(true);
  }, [save]);

  // Cmd/Ctrl+S で save, Esc で cancel。 textarea にフォーカスがあるときだけ
  // 効くようにし、 IME 入力 (composing) は妨げない。
  const handleEditorKey = React.useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.nativeEvent.isComposing) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty) void save(false);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        handleCancelEdit();
      }
    },
    [dirty, save, handleCancelEdit],
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
  const handleRemovePointer = React.useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setRemovePointer(e.target.checked);
  }, []);
  const handleDelete = React.useCallback(() => {
    void onDelete(linkedFromIndex && removePointer);
  }, [onDelete, linkedFromIndex, removePointer]);
  const handleRevealInEditor = React.useCallback(() => {
    void onRevealInEditor();
  }, [onRevealInEditor]);

  const handleCopyPath = React.useCallback(() => {
    void navigator.clipboard
      .writeText(path)
      .then(() => {
        setCopied(true);
        if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
        copiedTimer.current = setTimeout(() => {
          setCopied(false);
        }, 1600);
        return null;
      })
      .catch(() => {
        /* clipboard 不可の環境では無視 (UI を壊さない) */
      });
  }, [path]);

  const isFile = doc.kind === "file";
  const file = doc.kind === "file" ? doc.file : null;
  const header = doc.kind === "file" ? doc.header : null;
  const meta =
    doc.kind === "file"
      ? extractDisplayMeta(file?.frontmatter ?? null, doc.header)
      : { title: "MEMORY.md", description: null, type: null };
  const timeSource = file ?? header;
  const timeMs = timeSource ? memoryTimeMs(timeSource) : null;
  const modifiedMs = timeSource?.modifiedMs ?? null;
  const fileMtimeMs = timeSource?.mtimeMs ?? null;
  const frontmatterInvalid = file?.frontmatterInvalid ?? header?.frontmatterInvalid ?? false;
  const body = file?.body ?? "";
  // 読めない frontmatter は本文から外れるので、 ブロックを別に見せる。
  const invalidYaml = frontmatterInvalid && file ? splitFrontmatter(file.raw).yaml : null;
  const conflictMessage =
    deletedOnDisk || (conflict && current === null)
      ? t.detail.deletedOnDisk
      : t.detail.changedOnDisk;
  const showConflict = editing && (conflict || changedOnDisk || deletedOnDisk);

  return (
    <div className="memory-detail">
      <header className="doc-head">
        <div className="detail-title">
          <div className="doc-eyebrow">
            {meta.type ? (
              <span className={`memory-type type-${meta.type}`}>{meta.type}</span>
            ) : null}
            {doc.kind === "index" ? <span className="memory-type type-index">index</span> : null}
            {timeMs !== null ? <span className="doc-age">{formatMemoryAge(timeMs, t)}</span> : null}
            {timeMs !== null && isStaleFlagged(timeMs) ? (
              <span className="stale-chip" title={t.detail.staleTitle}>
                {t.detail.staleChip}
              </span>
            ) : null}
            {frontmatterInvalid ? (
              <span className="warn-chip" title={t.detail.frontmatterInvalidTitle}>
                {t.detail.frontmatterInvalidChip}
              </span>
            ) : null}
            <HygieneChips report={hygiene} />
          </div>
          <h2>{meta.title}</h2>
          {meta.description ? <p className="description">{meta.description}</p> : null}
          {modifiedMs !== null || fileMtimeMs !== null ? (
            <p className="doc-times">
              {modifiedMs !== null ? (
                <span title={t.detail.modifiedTitle}>
                  {t.detail.modifiedPrefix} {formatTimestamp(modifiedMs)}
                </span>
              ) : null}
              {fileMtimeMs !== null ? (
                <span>
                  {t.detail.fileTimePrefix} {formatTimestamp(fileMtimeMs)}
                </span>
              ) : null}
            </p>
          ) : null}
          {doc.kind === "index" ? <BudgetMeter index={doc.index} /> : null}
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
                disabled={saving || busy || !dirty}
              >
                {/* 未保存の印は見た目だけ (読み上げ名は「保存」のまま)。 */}
                {dirty ? <span aria-hidden="true">● </span> : null}
                {t.detail.save}
              </button>
              <button type="button" onClick={handleCancelEdit} disabled={saving}>
                {t.detail.cancel}
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={handleEnterEdit} disabled={busy || deletedOnDisk}>
                {t.detail.edit}
              </button>
              {isFile ? (
                <button type="button" onClick={onAskRename} disabled={busy || deletedOnDisk}>
                  {t.detail.rename}
                </button>
              ) : null}
              <button
                type="button"
                className="ghost"
                onClick={handleRevealInEditor}
                disabled={busy || current === null}
                title={t.detail.externalEditorTitle}
              >
                {t.detail.externalEditor}
              </button>
              {isFile && !confirmDelete ? (
                <button
                  type="button"
                  className="danger"
                  onClick={handleAskDelete}
                  disabled={busy || deletedOnDisk}
                >
                  {t.detail.askDelete}
                </button>
              ) : null}
            </>
          )}
          {isFile && confirmDelete && !editing ? (
            <div className="confirm-row">
              {linkedFromIndex ? (
                <label className="inline-check">
                  <input type="checkbox" checked={removePointer} onChange={handleRemovePointer} />
                  {t.detail.removePointer}
                </label>
              ) : null}
              <button type="button" className="danger" onClick={handleDelete} disabled={busy}>
                {t.detail.confirmDelete}
              </button>
              <button type="button" onClick={handleCancelDelete} disabled={busy}>
                {t.detail.cancel}
              </button>
            </div>
          ) : null}
        </div>
      </header>
      {showConflict ? (
        <div className="doc-banner" role="alert">
          <span>{conflictMessage}</span>
          <div className="banner-actions">
            <button
              type="button"
              className="danger"
              onClick={handleOverwrite}
              disabled={saving || busy}
            >
              {t.detail.overwrite}
            </button>
            <button type="button" onClick={leaveEdit} disabled={saving}>
              {t.detail.discardEdits}
            </button>
          </div>
        </div>
      ) : null}
      {editing ? (
        previewingEdit ? (
          <div className="doc-scroll">
            {previewSplit?.yaml != null ? (
              <FrontmatterSource yaml={previewSplit.yaml} invalid={false} />
            ) : null}
            <article className="markdown">
              <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>
                {previewSplit?.body ?? buffer}
              </ReactMarkdown>
            </article>
          </div>
        ) : (
          <textarea
            ref={editorRef}
            className="editor"
            aria-label="memory content editor"
            value={buffer}
            onChange={handleBufferChange}
            onKeyDown={handleEditorKey}
            spellCheck={false}
            readOnly={saving}
          />
        )
      ) : doc.kind === "index" ? (
        <IndexReading
          index={doc.index}
          onOpenFile={onOpenFile}
          onAddIndexEntries={onAddIndexEntries}
          busy={busy}
        />
      ) : (
        <div className="doc-scroll">
          {invalidYaml !== null ? <FrontmatterSource yaml={invalidYaml} invalid /> : null}
          <article className="markdown">
            <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{body}</ReactMarkdown>
          </article>
        </div>
      )}
    </div>
  );
}

/**
 * frontmatter ブロックをソースのまま見せる。 Markdown として描くと `---` が罫線、
 * 中身が setext 見出しに化けて読めない。 読めない (YAML エラー) ときは理由を添える。
 */
function FrontmatterSource(props: {
  readonly yaml: string;
  readonly invalid: boolean;
}): React.ReactElement {
  const { yaml, invalid } = props;
  const { t } = useTranslation();
  const tail = yaml.length === 0 || yaml.endsWith("\n") ? "" : "\n";
  return (
    <figure className={invalid ? "frontmatter-src invalid" : "frontmatter-src"}>
      {invalid ? <figcaption>{t.detail.frontmatterInvalidTitle}</figcaption> : null}
      <pre>
        <code>{`---\n${yaml}${tail}---`}</code>
      </pre>
    </figure>
  );
}

const Placeholder = React.memo(function Placeholder(props: {
  readonly platform: string;
}): React.ReactElement {
  const { t } = useTranslation();
  const mod = modKeyLabel(props.platform);
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
});

const HygieneChips = React.memo(function HygieneChips(props: {
  readonly report: ReturnType<typeof inspectHygiene> | null;
}): React.ReactElement | null {
  const { report } = props;
  const { t } = useTranslation();
  if (report === null) return null;
  const hiddenCount = report.invisible.reduce((sum, c) => sum + c.count, 0);
  return (
    <>
      {hiddenCount > 0 ? (
        <span
          className="warn-chip"
          title={[
            t.detail.hiddenCharsTitle,
            ...report.invisible.map((c) => `${describeCodePoint(c.codePoint)} ×${String(c.count)}`),
          ].join("\n")}
        >
          {t.detail.hiddenCharsChip} ×{hiddenCount}
        </span>
      ) : null}
      {report.markupTags.length > 0 ? (
        <span
          className="warn-chip"
          title={[t.detail.markupTitle, ...report.markupTags.map((tag) => `<${tag}>`)].join("\n")}
        >
          {t.detail.markupChip}
        </span>
      ) : null}
    </>
  );
});

type IndexReadingProps = {
  readonly index: MemoryIndexResult;
  readonly busy: boolean;
  readonly onOpenFile: (relPath: string) => void;
  readonly onAddIndexEntries: (files: readonly string[]) => void | Promise<void>;
};

/**
 * MEMORY.md の閲覧ビュー。 Claude Code が実際にロードする部分を表示し、 上限で
 * 切られる場合は切断位置と、 ロードされない残りを薄く続けて見せる (公式の WARNING
 * 文言は v2.1.268 で「何行切れたか・どこから切れたか」を含む形に変わっており、
 * 同じ情報をここで示す)。
 */
const IndexReading = React.memo(function IndexReading(
  props: IndexReadingProps,
): React.ReactElement {
  const { index, busy, onOpenFile, onAddIndexEntries } = props;
  const { t } = useTranslation();
  const truncated = index.wasLineTruncated || index.wasByteTruncated;
  const droppedLines = truncated ? index.lineCount - index.loadedLineCount : 0;
  const droppedSize = Math.max(0, index.byteCount - index.loadedContent.length);
  return (
    <div className="doc-scroll">
      <IndexHealthPanel
        index={index}
        busy={busy}
        onOpenFile={onOpenFile}
        onAddIndexEntries={onAddIndexEntries}
      />
      {truncated ? <p className="doc-advice">{t.detail.overLimitAdvice}</p> : null}
      <article className="markdown">
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{index.loadedContent}</ReactMarkdown>
        {truncated ? (
          <>
            <div className="cut-line">
              <span className="cut-label">{t.detail.cutMarker}</span>
              <span className="cut-detail">
                {`${formatLineCount(t, droppedLines)} · ${formatFileSize(droppedSize)} ${t.detail.cutLinesSuffix}`}
              </span>
            </div>
            <div className="dropped">
              <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{index.droppedContent}</ReactMarkdown>
            </div>
          </>
        ) : null}
      </article>
    </div>
  );
});

type BudgetMeterProps = {
  readonly index: MemoryIndexResult;
};

/** 上限の何割で「間近」と見せるか (表示上の目安。 公式の閾値ではない)。 */
const NEAR_LIMIT_RATIO = 0.9;

/**
 * MEMORY.md のロードバジェット計。
 *
 * Claude Code は MEMORY.md の先頭 200 行 / 25KB だけをロードする
 * (公式 src/memdir/memdir.ts:35,38 の MAX_ENTRYPOINT_LINES / _BYTES)。
 * 「あとどれだけ書けるか」を 2 本のゲージで見せる。 超過はゲージが満杯 +
 * over 表示、 9 割を超えたら near 表示になる。
 */
const BudgetMeter = React.memo(function BudgetMeter(
  props: BudgetMeterProps,
): React.ReactElement | null {
  const { index } = props;
  const { t } = useTranslation();
  const { MAX_ENTRYPOINT_LINES, MAX_ENTRYPOINT_BYTES } = MEMORY_CONSTANTS;
  const lineRatio = index.lineCount / MAX_ENTRYPOINT_LINES;
  const byteRatio = index.byteCount / MAX_ENTRYPOINT_BYTES;
  const lineStyle = React.useMemo(
    () => ({ width: `${String(Math.min(100, lineRatio * 100))}%` }),
    [lineRatio],
  );
  const byteStyle = React.useMemo(
    () => ({ width: `${String(Math.min(100, byteRatio * 100))}%` }),
    [byteRatio],
  );
  if (!index.exists) return null;
  const over = index.wasLineTruncated || index.wasByteTruncated;
  const near = !over && Math.max(lineRatio, byteRatio) >= NEAR_LIMIT_RATIO;
  const state = over ? " over" : near ? " near" : "";
  return (
    <div
      className={`budget-meter${state}`}
      title={over ? t.detail.indexLoadNote : near ? t.detail.nearLimit : t.detail.budgetTitle}
    >
      <span className="meter-title">
        {t.detail.budgetTitle}
        {near ? ` · ${t.detail.nearLimit}` : ""}
      </span>
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
          {formatFileSize(index.byteCount)}/{formatFileSize(MAX_ENTRYPOINT_BYTES)}
        </span>
      </div>
    </div>
  );
});
