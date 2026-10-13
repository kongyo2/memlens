import type { MemoryIndexResult } from "@shared/api/contract.ts";
import * as React from "react";

import { useTranslation } from "../i18n/index.ts";

/** 各グループで最初に見せる件数 (index が大きく崩れていても本文を押し流さない)。 */
const LIST_LIMIT = 6;

type Props = {
  readonly index: MemoryIndexResult;
  readonly busy: boolean;
  readonly onOpenFile: (relPath: string) => void;
  readonly onAddIndexEntries: (files: readonly string[]) => void | Promise<void>;
};

/**
 * MEMORY.md の手入れ状況 (main の analyzeIndex の結果) を見せる。
 *
 * 公式の index ルールに照らした指摘: frontmatter を持たない / 1 エントリ 1 行
 * ~150 文字 (~200 文字超は本文を抱えている) / 存在しない memory へのポインタは
 * 消す / 新しい memory はポインタを足す。 問題が無ければ畳んで 1 行だけ出す。
 */
export const IndexHealthPanel = React.memo(function IndexHealthPanel(
  props: Props,
): React.ReactElement {
  const { index, busy, onOpenFile, onAddIndexEntries } = props;
  const { t } = useTranslation();
  const { health } = index;
  const [expanded, setExpanded] = React.useState(false);
  const shown = <T,>(items: readonly T[]): readonly T[] =>
    expanded ? items : items.slice(0, LIST_LIMIT);
  const problems =
    (health.hasFrontmatter ? 1 : 0) +
    health.longEntries.length +
    health.danglingLinks.length +
    health.orphans.length;

  const handleAddPointers = React.useCallback(() => {
    void onAddIndexEntries(health.orphans);
  }, [onAddIndexEntries, health.orphans]);
  const handleShowAll = React.useCallback(() => {
    setExpanded(true);
  }, []);
  const more = (count: number): React.ReactElement | null =>
    !expanded && count > LIST_LIMIT ? (
      <button type="button" className="link health-more" onClick={handleShowAll}>
        +{count - LIST_LIMIT} · {t.detail.healthShowAll}
      </button>
    ) : null;

  if (problems === 0) {
    return (
      <section className="health-panel ok" aria-label={t.detail.healthTitle}>
        <span className="health-title">{t.detail.healthTitle}</span>
        <span className="health-ok">{t.detail.healthOk}</span>
      </section>
    );
  }

  return (
    <section className="health-panel" aria-label={t.detail.healthTitle}>
      <span className="health-title">
        {t.detail.healthTitle} · {problems}
      </span>
      {health.hasFrontmatter ? <p className="health-item">{t.detail.healthFrontmatter}</p> : null}
      {health.longEntries.length > 0 ? (
        <div className="health-group">
          <span className="health-label">
            {t.detail.healthLong} · {health.longEntries.length}
          </span>
          <ul>
            {shown(health.longEntries).map((entry) => (
              <li key={entry.line}>
                <span className="health-line">
                  {t.detail.healthLineLabel} {entry.line} · {entry.length}{" "}
                  {t.detail.healthCharsUnit}
                </span>
                <span className="health-preview">{entry.preview}</span>
              </li>
            ))}
          </ul>
          {more(health.longEntries.length)}
        </div>
      ) : null}
      {health.danglingLinks.length > 0 ? (
        <div className="health-group">
          <span className="health-label">
            {t.detail.healthDangling} · {health.danglingLinks.length}
          </span>
          <ul>
            {shown(health.danglingLinks).map((link) => (
              <li key={`${String(link.line)}:${link.target}`}>
                <span className="health-line">
                  {t.detail.healthLineLabel} {link.line}
                </span>
                <code>{link.target}</code>
              </li>
            ))}
          </ul>
          {more(health.danglingLinks.length)}
        </div>
      ) : null}
      {health.orphans.length > 0 ? (
        <div className="health-group">
          <span className="health-label">
            {t.detail.healthOrphans} · {health.orphans.length}
          </span>
          <ul className="health-orphans">
            {shown(health.orphans).map((name) => (
              <OrphanItem key={name} name={name} onOpen={onOpenFile} />
            ))}
          </ul>
          {more(health.orphans.length)}
          <button type="button" className="tiny" onClick={handleAddPointers} disabled={busy}>
            {t.detail.addPointers}
          </button>
        </div>
      ) : null}
    </section>
  );
});

const OrphanItem = React.memo(function OrphanItem(props: {
  readonly name: string;
  readonly onOpen: (relPath: string) => void;
}): React.ReactElement {
  const { name, onOpen } = props;
  const handleClick = React.useCallback(() => {
    onOpen(name);
  }, [onOpen, name]);
  return (
    <li>
      <button type="button" className="link" onClick={handleClick}>
        {name}
      </button>
    </li>
  );
});
