import * as React from "react";

import { useTranslation } from "../i18n/index.ts";

type Props = {
  readonly currentFilename: string;
  readonly onClose: () => void;
  /** 失敗時は throw する (エラーはこの dialog 内に表示する)。 */
  readonly onRename: (newFilename: string) => void | Promise<void>;
};

/**
 * memory ファイルの basename を変更する小さな dialog。
 *
 * `filename` は memoryDir からの相対 path (sub/dir/topic.md) でありうるが、
 * rename API は basename しか変えないので、 入力欄には basename だけを出す。
 */
export function RenameMemoryDialog(props: Props): React.ReactElement {
  const { currentFilename, onClose, onRename } = props;
  const { t } = useTranslation();
  const base = currentFilename.split("/").at(-1) ?? currentFilename;
  const stem = base.endsWith(".md") ? base.slice(0, -3) : base;
  const [value, setValue] = React.useState(stem);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleChange = React.useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setValue(e.target.value);
  }, []);

  const handleSubmit = React.useCallback(
    async (e: { preventDefault(): void }) => {
      e.preventDefault();
      setError(null);
      setSubmitting(true);
      try {
        await onRename(value);
        onClose();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSubmitting(false);
      }
    },
    [value, onRename, onClose],
  );

  return (
    <dialog className="modal-backdrop" open aria-labelledby="rename-modal-title">
      <form className="modal" onSubmit={handleSubmit}>
        <h3 id="rename-modal-title">{t.detail.renameTitle}</h3>
        <p className="modal-hint">
          <code>{currentFilename}</code>
        </p>
        <label>
          {t.detail.renameFilenameLabel}
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={handleChange}
            aria-label={t.detail.renameFilenameLabel}
            spellCheck={false}
            required
          />
          <span className="hint">{t.detail.renameHint}</span>
        </label>
        {error ? <p className="modal-error">{error}</p> : null}
        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={submitting}>
            {t.detail.cancel}
          </button>
          <button type="submit" className="primary" disabled={submitting}>
            {submitting ? t.detail.renameSubmitting : t.detail.renameSubmit}
          </button>
        </div>
      </form>
    </dialog>
  );
}
