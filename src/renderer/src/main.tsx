import * as React from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import { LocaleProvider } from "./i18n/index.ts";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Root element #root not found");
}

createRoot(rootEl).render(
  <React.StrictMode>
    <LocaleProvider>
      <App />
    </LocaleProvider>
  </React.StrictMode>,
);
