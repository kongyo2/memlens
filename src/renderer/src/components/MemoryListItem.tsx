import * as React from "react";

import type { MemoryHeader } from "@shared/api/contract.ts";

import { formatMemoryAge, memoryAgeBucket } from "../hooks/memoryAge.ts";
import { useTranslation } from "../i18n/index.ts";

type Props = {
  readonly header: MemoryHeader;
  readonly active: boolean;
  readonly onSelect: (header: MemoryHeader) => void;
};

export const MemoryListItem = React.memo(function MemoryListItem(
  props: Props,
): React.ReactElement {
  const { header, active, onSelect } = props;
  const { t } = useTranslation();
  const handleClick = React.useCallback(() => {
    onSelect(header);
  }, [onSelect, header]);
  const typeLabel = header.type ?? "?";
  const typeClass = `memory-type type-${header.type ?? "unknown"}`;
  const age = formatMemoryAge(header.mtimeMs, t);
  // 鮮度トレース: 公式の staleness 境界 (2 日以上で point-in-time 注記,
  // src/memdir/memoryAge.ts:33) を fresh/recent の境目に写した age バケット。
  const bucket = memoryAgeBucket(header.mtimeMs);
  return (
    <li>
      <button
        type="button"
        className={active ? "active" : ""}
        data-age={bucket}
        onClick={handleClick}
      >
        <span className="trace" aria-hidden="true" />
        <span className={typeClass}>{typeLabel}</span>
        <span className="memory-name">{header.name ?? header.filename}</span>
        <span className="memory-meta" title={header.filename}>
          {age}
        </span>
        {header.description ? (
          <span className="memory-description">{header.description}</span>
        ) : null}
      </button>
    </li>
  );
});
