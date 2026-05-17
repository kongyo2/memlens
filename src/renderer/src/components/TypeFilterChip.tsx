import * as React from "react";

import type { MemoryType } from "@shared/api/contract.ts";

import { useTranslation } from "../i18n/index.ts";

type Props = {
  readonly value: MemoryType | null;
  readonly active: boolean;
  readonly onSelect: (value: MemoryType | null) => void;
};

export const TypeFilterChip = React.memo(function TypeFilterChip(
  props: Props,
): React.ReactElement {
  const { value, active, onSelect } = props;
  const { t } = useTranslation();
  const handleClick = React.useCallback(() => {
    onSelect(value);
  }, [onSelect, value]);
  const label = value ?? t.memoryList.filterAll;
  const cls = `type-chip type-${value ?? "all"}${active ? " active" : ""}`;
  return (
    <button type="button" className={cls} onClick={handleClick}>
      {label}
    </button>
  );
});
