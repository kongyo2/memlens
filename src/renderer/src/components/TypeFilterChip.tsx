import * as React from "react";

import type { MemoryType } from "@shared/api/contract.ts";

import { useTranslation } from "../i18n/index.ts";

type Props = {
  readonly value: MemoryType | null;
  /** filter 前の母数に対する件数。 分布を chip 上で見せる。 */
  readonly count: number;
  readonly active: boolean;
  readonly onSelect: (value: MemoryType | null) => void;
};

export const TypeFilterChip = React.memo(function TypeFilterChip(
  props: Props,
): React.ReactElement {
  const { value, count, active, onSelect } = props;
  const { t } = useTranslation();
  const handleClick = React.useCallback(() => {
    onSelect(value);
  }, [onSelect, value]);
  const label = value ?? t.memoryList.filterAll;
  const cls = `type-chip type-${value ?? "all"}${active ? " active" : ""}`;
  return (
    <button
      type="button"
      className={cls}
      aria-pressed={active}
      onClick={handleClick}
    >
      {label}
      <span className="chip-count">{count}</span>
    </button>
  );
});
