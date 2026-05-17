import * as React from "react";

import type {
  MemoryHeader,
  MemoryIndexResult,
  MemoryType,
} from "@shared/api/contract.ts";
import { MEMORY_TYPES } from "@shared/schema/memory.ts";

import { MemoryListItem } from "./MemoryListItem.tsx";
import { TypeFilterChip } from "./TypeFilterChip.tsx";

type Props = {
  readonly memories: readonly MemoryHeader[];
  readonly index: MemoryIndexResult | null;
  readonly selectedKind: "none" | "index" | "file";
  readonly selectedPath: string | null;
  readonly query: string;
  readonly onQueryChange: (q: string) => void;
  readonly typeFilter: MemoryType | null;
  readonly onTypeFilterChange: (t: MemoryType | null) => void;
  readonly onSelectIndex: () => void;
  readonly onSelectFile: (header: MemoryHeader) => void;
  readonly onCreateNew: () => void;
};

function formatBytes(n: number): string {
  if (n < 1024) return `${String(n)} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

export function MemoryList(props: Props): React.ReactElement {
  const {
    memories,
    index,
    selectedKind,
    selectedPath,
    query,
    onQueryChange,
    typeFilter,
    onTypeFilterChange,
    onSelectIndex,
    onSelectFile,
    onCreateNew,
  } = props;

  const handleQueryChange = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onQueryChange(e.target.value);
    },
    [onQueryChange],
  );

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return memories.filter((m) => {
      if (typeFilter !== null && m.type !== typeFilter) return false;
      if (q.length === 0) return true;
      const haystack = [
        m.filename,
        m.name ?? "",
        m.description ?? "",
        m.type ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [memories, query, typeFilter]);

  const indexMeta = React.useMemo(() => {
    if (!index) return null;
    if (!index.exists) return "未作成";
    const limitNote =
      index.wasLineTruncated || index.wasByteTruncated ? " · 上限超過" : "";
    return `${String(index.lineCount)} 行 · ${formatBytes(index.byteCount)}${limitNote}`;
  }, [index]);

  return (
    <div className="memory-list-pane">
      <div className="memory-toolbar">
        <input
          className="search"
          type="search"
          placeholder="検索 (filename / name / description / body)"
          aria-label="memory 検索"
          value={query}
          onChange={handleQueryChange}
          spellCheck={false}
        />
        <button
          type="button"
          className="primary new-button"
          onClick={onCreateNew}
          title="新規 memory を作成"
        >
          + 新規
        </button>
      </div>
      <div className="type-filters">
        <TypeFilterChip
          value={null}
          active={typeFilter === null}
          onSelect={onTypeFilterChange}
        />
        {MEMORY_TYPES.map((t) => (
          <TypeFilterChip
            key={t}
            value={t}
            active={typeFilter === t}
            onSelect={onTypeFilterChange}
          />
        ))}
      </div>
      <ul className="memory-list">
        {index ? (
          <IndexItem
            active={selectedKind === "index"}
            meta={indexMeta ?? ""}
            onSelect={onSelectIndex}
          />
        ) : null}
        {filtered.map((m) => (
          <MemoryListItem
            key={m.filePath}
            header={m}
            active={selectedKind === "file" && selectedPath === m.filePath}
            onSelect={onSelectFile}
          />
        ))}
        {filtered.length === 0 && !index ? (
          <li className="empty">memory ファイルなし</li>
        ) : null}
        {filtered.length === 0 && memories.length > 0 ? (
          <li className="empty">該当する memory が見つかりません</li>
        ) : null}
      </ul>
    </div>
  );
}

type IndexItemProps = {
  readonly active: boolean;
  readonly meta: string;
  readonly onSelect: () => void;
};

const IndexItem = React.memo(function IndexItem(
  props: IndexItemProps,
): React.ReactElement {
  const { active, meta, onSelect } = props;
  return (
    <li>
      <button
        type="button"
        className={active ? "active index" : "index"}
        onClick={onSelect}
      >
        <span className="memory-name">MEMORY.md</span>
        <span className="memory-meta">{meta}</span>
      </button>
    </li>
  );
});
