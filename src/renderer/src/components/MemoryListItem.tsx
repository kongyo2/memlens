import * as React from "react";

import type { MemoryHeader } from "@shared/api/contract.ts";

type Props = {
  readonly header: MemoryHeader;
  readonly active: boolean;
  readonly onSelect: (header: MemoryHeader) => void;
};

export const MemoryListItem = React.memo(function MemoryListItem(
  props: Props,
): React.ReactElement {
  const { header, active, onSelect } = props;
  const handleClick = React.useCallback(() => {
    onSelect(header);
  }, [onSelect, header]);
  const typeLabel = header.type ?? "?";
  const typeClass = `memory-type type-${header.type ?? "unknown"}`;
  return (
    <li>
      <button
        type="button"
        className={active ? "active" : ""}
        onClick={handleClick}
      >
        <span className={typeClass}>{typeLabel}</span>
        <span className="memory-name">{header.name ?? header.filename}</span>
        {header.description ? (
          <span className="memory-description">{header.description}</span>
        ) : null}
      </button>
    </li>
  );
});
