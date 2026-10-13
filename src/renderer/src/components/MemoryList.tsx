import type {
  GlobalMemorySearchHit,
  MemoryHeader,
  MemoryIndexResult,
  MemorySearchHit,
  MemoryType,
} from "@shared/api/contract.ts";
import { MEMORY_CONSTANTS, MEMORY_TYPES } from "@shared/schema/memory.ts";
import { formatFileSize } from "@shared/util/format.ts";
import * as React from "react";

import { memoryTimeMs } from "../hooks/memoryAge.ts";
import { formatLineCount, useTranslation } from "../i18n/index.ts";
import { MemoryListItem } from "./MemoryListItem.tsx";
import { TypeFilterChip } from "./TypeFilterChip.tsx";

export type SearchScope = "project" | "all";
export type MemorySort = "recency" | "name" | "size";

type Props = {
  readonly hasProject: boolean;
  readonly memories: readonly MemoryHeader[];
  readonly index: MemoryIndexResult | null;
  readonly selectedKind: "none" | "index" | "file";
  readonly selectedPath: string | null;
  readonly query: string;
  readonly onQueryChange: (q: string) => void;
  readonly searchScope: SearchScope;
  readonly onSearchScopeChange: (s: SearchScope) => void;
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
  /** 本文一致ヒットを開く (一覧に出ていないファイルや MEMORY.md も開ける)。 */
  readonly onOpenHit: (filePath: string) => void;
  /** scope = "all" のときの全プロジェクト横断ヒット。 */
  readonly globalHits: readonly GlobalMemorySearchHit[];
  readonly onOpenGlobalHit: (hit: GlobalMemorySearchHit) => void;
  readonly bodySearching: boolean;
  readonly bodyTruncated: boolean;
};

/** 上限の何割で一覧に「上限間近」を添えるか (表示上の目安)。 */
const NEAR_LIMIT_RATIO = 0.9;

export function MemoryList(props: Props): React.ReactElement {
  const {
    hasProject,
    memories,
    index,
    selectedKind,
    selectedPath,
    query,
    onQueryChange,
    searchScope,
    onSearchScopeChange,
    typeFilter,
    onTypeFilterChange,
    onSelectIndex,
    onSelectFile,
    onCreateNew,
    bodyHits,
    onOpenHit,
    globalHits,
    onOpenGlobalHit,
    bodySearching,
    bodyTruncated,
  } = props;
  const { t } = useTranslation();
  const [sort, setSort] = React.useState<MemorySort>("recency");

  const handleQueryChange = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onQueryChange(e.target.value);
    },
    [onQueryChange],
  );

  const handleToggleScope = React.useCallback(() => {
    onSearchScopeChange(searchScope === "all" ? "project" : "all");
  }, [searchScope, onSearchScopeChange]);

  // type ごとの件数 (filter 前の全体母数)。 chip に添えて分布を見せる。
  const typeCounts = React.useMemo(() => {
    const counts = new Map<MemoryType, number>();
    for (const m of memories) {
      if (m.type !== null) counts.set(m.type, (counts.get(m.type) ?? 0) + 1);
    }
    return counts;
  }, [memories]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const hit = memories.filter((m) => {
      if (typeFilter !== null && m.type !== typeFilter) return false;
      if (q.length === 0) return true;
      const haystack = [m.filename, m.name ?? "", m.description ?? "", m.type ?? ""]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
    if (sort === "name") {
      return [...hit].sort((a, b) => (a.name ?? a.filename).localeCompare(b.name ?? b.filename));
    }
    if (sort === "size") {
      return [...hit].sort((a, b) => b.byteSize - a.byteSize);
    }
    // recency: frontmatter の `modified` (v2.1.214+) があればそれ、 無ければ mtime。
    // listFiles 自体は公式 scanMemoryFiles と同じ mtime 降順 200 件で返る。
    return [...hit].sort((a, b) => memoryTimeMs(b) - memoryTimeMs(a));
  }, [memories, query, typeFilter, sort]);

  const indexMeta = React.useMemo(() => {
    if (!index) return null;
    if (!index.exists) return t.memoryList.indexNotCreated;
    const { MAX_ENTRYPOINT_LINES, MAX_ENTRYPOINT_BYTES } = MEMORY_CONSTANTS;
    const over = index.wasLineTruncated || index.wasByteTruncated;
    const near =
      !over &&
      Math.max(index.lineCount / MAX_ENTRYPOINT_LINES, index.byteCount / MAX_ENTRYPOINT_BYTES) >=
        NEAR_LIMIT_RATIO;
    const limitNote = over
      ? ` · ${t.memoryList.indexExceededShort}`
      : near
        ? ` · ${t.memoryList.indexNearShort}`
        : "";
    // byte 表記は公式 formatFileSize と同じ表記 (25_000 → "24.4KB") に揃える。
    return `${formatLineCount(t, index.lineCount)} · ${formatFileSize(index.byteCount)}${limitNote}`;
  }, [index, t]);

  const showGlobalHits = searchScope === "all" && query.trim().length > 0;

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
          disabled={!hasProject}
          title={t.memoryList.newTooltip}
        >
          {t.memoryList.newButton}
        </button>
      </div>
      <div className="filter-row">
        <div className="type-filters">
          <TypeFilterChip
            value={null}
            count={memories.length}
            active={typeFilter === null}
            onSelect={onTypeFilterChange}
          />
          {MEMORY_TYPES.map((mt) => (
            <TypeFilterChip
              key={mt}
              value={mt}
              count={typeCounts.get(mt) ?? 0}
              active={typeFilter === mt}
              onSelect={onTypeFilterChange}
            />
          ))}
        </div>
        <div className="tool-row">
          <div className="sort-seg" title={t.memoryList.sortAria}>
            <SortButton
              value="recency"
              label={t.memoryList.sortRecency}
              current={sort}
              onSelect={setSort}
            />
            <SortButton
              value="name"
              label={t.memoryList.sortName}
              current={sort}
              onSelect={setSort}
            />
            <SortButton
              value="size"
              label={t.memoryList.sortSize}
              current={sort}
              onSelect={setSort}
            />
          </div>
          <button
            type="button"
            className={`scope-chip${searchScope === "all" ? " active" : ""}`}
            onClick={handleToggleScope}
            aria-pressed={searchScope === "all"}
            title={t.memoryList.scopeAll}
          >
            ⊕ {t.memoryList.scopeAll}
          </button>
        </div>
      </div>
      {hasProject ? (
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
          {filtered.length === 0 && memories.length === 0 && !index ? (
            <li className="empty">{t.memoryList.emptyList}</li>
          ) : null}
          {filtered.length === 0 && memories.length > 0 ? (
            <li className="empty">{t.memoryList.noMatches}</li>
          ) : null}
        </ul>
      ) : (
        <ul className="memory-list" />
      )}
      {showGlobalHits ? (
        <GlobalHits
          hits={globalHits}
          searching={bodySearching}
          truncated={bodyTruncated}
          onOpen={onOpenGlobalHit}
        />
      ) : query.trim().length > 0 && hasProject ? (
        <BodyHits
          hits={bodyHits}
          searching={bodySearching}
          truncated={bodyTruncated}
          onOpen={onOpenHit}
        />
      ) : null}
    </div>
  );
}

type SortButtonProps = {
  readonly value: MemorySort;
  readonly label: string;
  readonly current: MemorySort;
  readonly onSelect: (s: MemorySort) => void;
};

const SortButton = React.memo(function SortButton(props: SortButtonProps): React.ReactElement {
  const { value, label, current, onSelect } = props;
  const handleClick = React.useCallback(() => {
    onSelect(value);
  }, [onSelect, value]);
  return (
    <button
      type="button"
      className={current === value ? "seg active" : "seg"}
      aria-pressed={current === value}
      onClick={handleClick}
    >
      {label}
    </button>
  );
});

type BodyHitsProps = {
  readonly hits: readonly MemorySearchHit[];
  readonly searching: boolean;
  readonly truncated: boolean;
  readonly onOpen: (filePath: string) => void;
};

const BodyHits = React.memo(function BodyHits(props: BodyHitsProps): React.ReactElement | null {
  const { hits, searching, truncated, onOpen } = props;
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
          <BodyHitRow key={`${h.filePath}#${String(h.line)}`} hit={h} onOpen={onOpen} />
        ))}
      </ul>
    </div>
  );
});

type GlobalHitsProps = {
  readonly hits: readonly GlobalMemorySearchHit[];
  readonly searching: boolean;
  readonly truncated: boolean;
  readonly onOpen: (hit: GlobalMemorySearchHit) => void;
};

const GlobalHits = React.memo(function GlobalHits(
  props: GlobalHitsProps,
): React.ReactElement | null {
  const { hits, searching, truncated, onOpen } = props;
  const { t } = useTranslation();
  if (searching && hits.length === 0) {
    return (
      <div className="body-hits global">
        <h3>{t.memoryList.globalHitsLabel}</h3>
        <p className="empty">{t.memoryList.bodySearching}</p>
      </div>
    );
  }
  if (hits.length === 0) return null;
  return (
    <div className="body-hits global">
      <h3>
        {t.memoryList.globalHitsLabel}
        {truncated ? ` · ${t.memoryList.indexExceededShort}` : ""}
      </h3>
      <ul>
        {hits.map((h) => (
          <GlobalHitRow key={`${h.filePath}#${String(h.line)}`} hit={h} onOpen={onOpen} />
        ))}
      </ul>
    </div>
  );
});

type GlobalHitRowProps = {
  readonly hit: GlobalMemorySearchHit;
  readonly onOpen: (hit: GlobalMemorySearchHit) => void;
};

const GlobalHitRow = React.memo(function GlobalHitRow(
  props: GlobalHitRowProps,
): React.ReactElement {
  const { hit, onOpen } = props;
  const handleClick = React.useCallback(() => {
    onOpen(hit);
  }, [onOpen, hit]);
  return (
    <li>
      <button type="button" className="body-hit" onClick={handleClick} title={hit.filePath}>
        <span className="hit-project">{hit.projectLabel}</span>
        <span className="memory-name">
          {hit.filename}
          <span className="memory-meta">:{String(hit.line)}</span>
        </span>
        <span className="memory-description">{hit.excerpt}</span>
      </button>
    </li>
  );
});

type BodyHitRowProps = {
  readonly hit: MemorySearchHit;
  readonly onOpen: (filePath: string) => void;
};

const BodyHitRow = React.memo(function BodyHitRow(props: BodyHitRowProps): React.ReactElement {
  const { hit, onOpen } = props;
  const handleClick = React.useCallback(() => {
    onOpen(hit.filePath);
  }, [onOpen, hit.filePath]);
  return (
    <li>
      <button type="button" className="body-hit" onClick={handleClick} title={hit.filePath}>
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

const IndexItem = React.memo(function IndexItem(props: IndexItemProps): React.ReactElement {
  const { active, meta, onSelect } = props;
  return (
    <li>
      <button type="button" className={active ? "active index" : "index"} onClick={onSelect}>
        <span className="memory-name">MEMORY.md</span>
        <span className="memory-meta">{meta}</span>
      </button>
    </li>
  );
});
