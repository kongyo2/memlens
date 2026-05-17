import * as React from "react";

import type { CreateMemoryRequest, MemoryType } from "@shared/api/contract.ts";
import { MEMORY_TYPES } from "@shared/schema/memory.ts";

type Props = {
  readonly memoryDir: string;
  readonly onClose: () => void;
  readonly onCreate: (req: CreateMemoryRequest) => void | Promise<void>;
};

export function CreateMemoryDialog(props: Props): React.ReactElement {
  const { memoryDir, onClose, onCreate } = props;
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
        setError("name は必須です");
        return;
      }
      if (trimmedDescription.length === 0) {
        setError("description は必須です");
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
    ],
  );

  return (
    <dialog
      className="modal-backdrop"
      open
      aria-labelledby="create-modal-title"
    >
      <form className="modal" onSubmit={handleSubmit}>
        <h3 id="create-modal-title">新規 memory を作成</h3>
        <p className="modal-hint">
          memoryDir: <code>{memoryDir}</code>
        </p>
        <label>
          name
          <input
            type="text"
            value={name}
            onChange={handleName}
            placeholder="例: user-deep-go-experience"
            aria-label="memory name"
            required
          />
        </label>
        <label>
          description
          <input
            type="text"
            value={description}
            onChange={handleDescription}
            placeholder="一行で memory の中身を説明"
            aria-label="memory description"
            required
          />
        </label>
        <label>
          type
          <select value={type} onChange={handleType} aria-label="memory type">
            {MEMORY_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label>
          filename
          <input
            type="text"
            value={filename}
            onChange={handleFilename}
            placeholder={defaultFilename}
            aria-label="memory filename"
          />
          <span className="hint">
            実際の保存名: <code>{defaultFilename}.md</code>
          </span>
        </label>
        <label>
          body
          <textarea
            value={body}
            onChange={handleBody}
            placeholder="memory 本文 (markdown)"
            rows={8}
            aria-label="memory body"
          />
        </label>
        {error ? <p className="modal-error">{error}</p> : null}
        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={submitting}>
            キャンセル
          </button>
          <button type="submit" className="primary" disabled={submitting}>
            {submitting ? "作成中…" : "作成"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
