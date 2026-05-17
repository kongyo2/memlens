import * as React from "react";

import type { CreateMemoryRequest, MemoryType } from "@shared/api/contract.ts";
import { MEMORY_TYPES } from "@shared/schema/memory.ts";

import { useTranslation } from "../i18n/index.ts";

type Props = {
  readonly memoryDir: string;
  readonly onClose: () => void;
  readonly onCreate: (req: CreateMemoryRequest) => void | Promise<void>;
};

export function CreateMemoryDialog(props: Props): React.ReactElement {
  const { memoryDir, onClose, onCreate } = props;
  const { t } = useTranslation();
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [type, setType] = React.useState<MemoryType>("user");
  const [filename, setFilename] = React.useState("");
  const [body, setBody] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleName = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setName(e.target.value);
    },
    [],
  );
  const handleDescription = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setDescription(e.target.value);
    },
    [],
  );
  const handleFilename = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setFilename(e.target.value);
    },
    [],
  );
  const handleType = React.useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const v = e.target.value;
      if ((MEMORY_TYPES as readonly string[]).includes(v)) {
        setType(v as MemoryType);
      }
    },
    [],
  );
  const handleBody = React.useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setBody(e.target.value);
    },
    [],
  );

  const defaultFilename = React.useMemo(() => {
    if (filename.trim().length > 0) return filename.trim();
    const seed = name.trim() || `${type}-memory`;
    const slug = seed
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return `${type}_${slug || "untitled"}`;
  }, [filename, name, type]);

  const handleSubmit = React.useCallback(
    async (e: { preventDefault(): void }) => {
      e.preventDefault();
      setError(null);
      const trimmedName = name.trim();
      const trimmedDescription = description.trim();
      if (trimmedName.length === 0) {
        setError(t.create.errorNameRequired);
        return;
      }
      if (trimmedDescription.length === 0) {
        setError(t.create.errorDescRequired);
        return;
      }
      setSubmitting(true);
      try {
        await onCreate({
          memoryDir,
          filename: defaultFilename,
          frontmatter: {
            name: trimmedName,
            description: trimmedDescription,
            type,
          },
          body,
        });
        onClose();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSubmitting(false);
      }
    },
    [
      name,
      description,
      defaultFilename,
      memoryDir,
      type,
      body,
      onClose,
      onCreate,
      t.create.errorNameRequired,
      t.create.errorDescRequired,
    ],
  );

  return (
    <dialog
      className="modal-backdrop"
      open
      aria-labelledby="create-modal-title"
    >
      <form className="modal" onSubmit={handleSubmit}>
        <h3 id="create-modal-title">{t.create.title}</h3>
        <p className="modal-hint">
          {t.create.memoryDirLabel} <code>{memoryDir}</code>
        </p>
        <label>
          {t.create.name}
          <input
            type="text"
            value={name}
            onChange={handleName}
            placeholder={t.create.namePlaceholder}
            aria-label={t.create.nameAria}
            required
          />
        </label>
        <label>
          {t.create.description}
          <input
            type="text"
            value={description}
            onChange={handleDescription}
            placeholder={t.create.descPlaceholder}
            aria-label={t.create.descAria}
            required
          />
        </label>
        <label>
          {t.create.type}
          <select
            value={type}
            onChange={handleType}
            aria-label={t.create.typeAria}
          >
            {MEMORY_TYPES.map((mt) => (
              <option key={mt} value={mt}>
                {mt}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t.create.filename}
          <input
            type="text"
            value={filename}
            onChange={handleFilename}
            placeholder={defaultFilename}
            aria-label={t.create.filenameAria}
          />
          <span className="hint">
            {t.create.filenameHintPrefix} <code>{defaultFilename}.md</code>
          </span>
        </label>
        <label>
          {t.create.body}
          <textarea
            value={body}
            onChange={handleBody}
            placeholder={t.create.bodyPlaceholder}
            rows={8}
            aria-label={t.create.bodyAria}
          />
        </label>
        {error ? <p className="modal-error">{error}</p> : null}
        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={submitting}>
            {t.detail.cancel}
          </button>
          <button type="submit" className="primary" disabled={submitting}>
            {submitting ? t.create.submitting : t.create.submit}
          </button>
        </div>
      </form>
    </dialog>
  );
}
