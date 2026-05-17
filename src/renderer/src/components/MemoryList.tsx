import * as React from "react";

import type {
  MemoryHeader,
  MemoryIndexResult,
  MemoryType,
} from "@shared/api/contract.ts";
import { MEMORY_TYPES } from "@shared/schema/memory.ts";

import { useTranslation } from "../i18n/index.ts";

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
  const { t } = useTranslation();

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
    if (!index.exists) return t.memoryList.indexNotCreated;
    const limitNote =
      index.wasLineTruncated || index.wasByteTruncated
        ? ` · ${t.memoryList.indexExceededShort}`
        : "";
    return `${String(index.lineCount)} ${t.memoryList.indexLineUnit} · ${formatBytes(index.byteCount)}${limitNote}`;
  }, [
    index,
    t.memoryList.indexNotCreated,
    t.memoryList.indexLineUnit,
    t.memoryList.indexExceededShort,
  ]);

  return (
    <div className="memory-list-pane">
      <div className="memory-toolbar">
        <input
          className="search"
          type="search"
          placeholder={t.memoryList.searchPlaceholder}
          aria-label={t.memoryList.searchAriaLabel}
          value={query}
          onChange={handleQueryChange}
          spellCheck={false}
        />
        <button
          type="button"
          className="primary new-button"
          onClick={onCreateNew}
          title={t.memoryList.newTooltip}
        >
          {t.memoryList.newButton}
        </button>
      </div>
      <div className="type-filters">
        <TypeFilterChip
          value={null}
          active={typeFilter === null}
          onSelect={onTypeFilterChange}
        />
        {MEMORY_TYPES.map((mt) => (
          <TypeFilterChip
            key={mt}
            value={mt}
            active={typeFilter === mt}
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
          <li className="empty">{t.memoryList.emptyList}</li>
        ) : null}
        {filtered.length === 0 && memories.length > 0 ? (
          <li className="empty">{t.memoryList.noMatches}</li>
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
