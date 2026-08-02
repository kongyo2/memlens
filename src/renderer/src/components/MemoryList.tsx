import * as React from "react";

import type {
  MemoryHeader,
  MemoryIndexResult,
  MemorySearchHit,
  MemoryType,
} from "@shared/api/contract.ts";
import { MEMORY_TYPES } from "@shared/schema/memory.ts";
import { formatFileSize } from "@shared/util/format.ts";

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
  /**
   * server-side full-text body search の結果 (App から渡される)。
   * header 一致と別軸で「本文に query を含むファイル」を提示する。
   */
  readonly bodyHits: readonly MemorySearchHit[];
  readonly bodySearching: boolean;
  readonly bodyTruncated: boolean;
};

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
    bodyHits,
    bodySearching,
    bodyTruncated,
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
    // byte 表記は公式 formatFileSize と同じ表記 (25_000 → "24.4KB") に揃える。
    return `${String(index.lineCount)} ${t.memoryList.indexLineUnit} · ${formatFileSize(index.byteCount)}${limitNote}`;
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
      {query.trim().length > 0 ? (
        <BodyHits
          hits={bodyHits}
          searching={bodySearching}
          truncated={bodyTruncated}
          memories={memories}
          onSelectFile={onSelectFile}
        />
      ) : null}
    </div>
  );
}

type BodyHitsProps = {
  readonly hits: readonly MemorySearchHit[];
  readonly searching: boolean;
  readonly truncated: boolean;
  readonly memories: readonly MemoryHeader[];
  readonly onSelectFile: (header: MemoryHeader) => void;
};

const BodyHits = React.memo(function BodyHits(
  props: BodyHitsProps,
): React.ReactElement | null {
  const { hits, searching, truncated, memories, onSelectFile } = props;
  const { t } = useTranslation();
  if (searching && hits.length === 0) {
    return (
      <div className="body-hits">
        <h3>{t.memoryList.bodyHitsLabel}</h3>
        <p className="empty">{t.memoryList.bodySearching}</p>
      </div>
    );
  }
  if (hits.length === 0) return null;
  return (
    <div className="body-hits">
      <h3>
        {t.memoryList.bodyHitsLabel}
        {truncated ? ` · ${t.memoryList.indexExceededShort}` : ""}
      </h3>
      <ul>
        {hits.map((h) => (
          <BodyHitRow
            key={`${h.filePath}#${String(h.line)}`}
            hit={h}
            memories={memories}
            onSelectFile={onSelectFile}
          />
        ))}
      </ul>
    </div>
  );
});

type BodyHitRowProps = {
  readonly hit: MemorySearchHit;
  readonly memories: readonly MemoryHeader[];
  readonly onSelectFile: (header: MemoryHeader) => void;
};

const BodyHitRow = React.memo(function BodyHitRow(
  props: BodyHitRowProps,
): React.ReactElement {
  const { hit, memories, onSelectFile } = props;
  // ヒットしたファイルが header (=listFiles で出ているもの) に存在すれば
  // クリックで選択できる。 MEMORY.md など listFiles に出ないものは表示のみ。
  const header = React.useMemo(
    () => memories.find((m) => m.filePath === hit.filePath) ?? null,
    [memories, hit.filePath],
  );
  const handleClick = React.useCallback(() => {
    if (header) onSelectFile(header);
  }, [header, onSelectFile]);
  return (
    <li>
      <button
        type="button"
        className="body-hit"
        onClick={handleClick}
        disabled={header === null}
        title={hit.filePath}
      >
        <span className="memory-name">
          {hit.filename}
          <span className="memory-meta">:{String(hit.line)}</span>
        </span>
        <span className="memory-description">{hit.excerpt}</span>
      </button>
    </li>
  );
});

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
