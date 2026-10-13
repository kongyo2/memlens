import type { MemoryHeader } from "@shared/api/contract.ts";
import * as React from "react";

import {
  formatMemoryAge,
  formatTimestamp,
  memoryAgeBucket,
  memoryTimeMs,
} from "../hooks/memoryAge.ts";
import { useTranslation } from "../i18n/index.ts";

type Props = {
  readonly header: MemoryHeader;
  readonly active: boolean;
  readonly onSelect: (header: MemoryHeader) => void;
};

export const MemoryListItem = React.memo(function MemoryListItem(props: Props): React.ReactElement {
  const { header, active, onSelect } = props;
  const { t } = useTranslation();
  const handleClick = React.useCallback(() => {
    onSelect(header);
  }, [onSelect, header]);
  const typeLabel = header.type ?? "?";
  const typeClass = `memory-type type-${header.type ?? "unknown"}`;
  // 鮮度は frontmatter の `modified` (v2.1.214+) を優先し、 無ければ mtime。
  const timeMs = memoryTimeMs(header);
  const age = formatMemoryAge(timeMs, t);
  // 鮮度トレース: 公式の staleness 境界 (2 日以上で point-in-time 注記,
  // src/memdir/memoryAge.ts:33) を fresh/recent の境目に写した age バケット。
  const bucket = memoryAgeBucket(timeMs);
  const tooltip = [
    header.filename,
    header.modifiedMs !== null
      ? `${t.memoryList.modifiedLabel}: ${formatTimestamp(header.modifiedMs)}`
      : null,
    `${t.memoryList.fileTimeLabel}: ${formatTimestamp(header.mtimeMs)}`,
    header.frontmatterInvalid ? `⚠ ${t.memoryList.invalidFrontmatterMark}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
  return (
    <li>
      <button
        type="button"
        className={active ? "active" : ""}
        data-age={bucket}
        onClick={handleClick}
        title={tooltip}
      >
        <span className="trace" aria-hidden="true" />
        <span className={typeClass}>{typeLabel}</span>
        <span className="memory-name">
          {header.name ?? header.filename}
          {header.frontmatterInvalid ? (
            <span className="invalid-mark" aria-label={t.memoryList.invalidFrontmatterMark}>
              {" "}
              ⚠
            </span>
          ) : null}
        </span>
        <span className="memory-meta">{age}</span>
        {header.description ? (
          <span className="memory-description">{header.description}</span>
        ) : null}
      </button>
    </li>
  );
});
