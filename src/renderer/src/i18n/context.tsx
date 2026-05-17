import * as React from "react";

import { en } from "./locales/en.ts";
import { ja } from "./locales/ja.ts";
import type { Dict } from "./locales/types.ts";

export type Locale = "ja" | "en";

const DICTS: Record<Locale, Dict> = { ja, en };
const STORAGE_KEY = "memlens.locale";

type LocaleContextValue = {
  readonly locale: Locale;
  readonly setLocale: (l: Locale) => void;
  readonly t: Dict;
};

const LocaleContext = React.createContext<LocaleContextValue | null>(null);

function detectInitialLocale(): Locale {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (stored === "ja" || stored === "en") return stored;
  } catch {
    /* localStorage 不可な環境 (sandbox 等) は無視 */
  }
  const nav =
    typeof globalThis.navigator !== "undefined"
      ? globalThis.navigator.language
      : "";
  return nav.toLowerCase().startsWith("ja") ? "ja" : "en";
}

type Props = {
  readonly children: React.ReactNode;
};

export function LocaleProvider(props: Props): React.ReactElement {
  const [locale, setLocaleState] = React.useState<Locale>(detectInitialLocale);

  const setLocale = React.useCallback((l: Locale): void => {
    setLocaleState(l);
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, l);
    } catch {
      /* persist failure should not break the UI */
    }
  }, []);

  React.useEffect(() => {
    try {
      globalThis.document?.documentElement.setAttribute("lang", locale);
    } catch {
      /* document 無い環境では何もしない */
    }
  }, [locale]);

  const value = React.useMemo<LocaleContextValue>(
    () => ({ locale, setLocale, t: DICTS[locale] }),
    [locale, setLocale],
  );

  return (
    <LocaleContext.Provider value={value}>
      {props.children}
    </LocaleContext.Provider>
  );
}

export function useTranslation(): LocaleContextValue {
  const ctx = React.useContext(LocaleContext);
  if (!ctx) {
    throw new Error("LocaleProvider is not mounted");
  }
  return ctx;
}
