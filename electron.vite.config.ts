import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import type { Plugin } from "vite";

const projectRoot = dirname(fileURLToPath(import.meta.url));

const sharedAlias = {
  "@shared": resolve(projectRoot, "src/shared"),
};

/**
 * 本番ビルドの renderer HTML に CSP を注入する。
 *
 * dev では Vite / react-refresh がインライン script を注入するため meta を
 * 直書きすると HMR が壊れる。 apply: "build" で本番だけに絞る。 renderer は
 * ローカル bundle のみを読む前提なので self 以外を全て遮断する
 * (style の 'unsafe-inline' は将来 style attribute を使っても壊れないための
 * Electron 慣例的な緩和)。
 */
const injectCspPlugin: Plugin = {
  name: "memlens:inject-csp",
  apply: "build",
  transformIndexHtml(html) {
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
    ].join("; ");
    return html.replace(
      "<title>",
      `<meta http-equiv="Content-Security-Policy" content="${csp}" />\n    <title>`,
    );
  },
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias },
    build: {
      lib: { entry: resolve(projectRoot, "src/main/index.ts") },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias },
    build: {
      // sandbox: true の renderer では preload を ESM で読めないので CommonJS で出す
      // (package.json が "type": "module" なので拡張子は .cjs になる)。
      lib: { entry: resolve(projectRoot, "src/preload/index.ts"), formats: ["cjs"] },
    },
  },
  renderer: {
    root: resolve(projectRoot, "src/renderer"),
    resolve: {
      alias: {
        ...sharedAlias,
        "@renderer": resolve(projectRoot, "src/renderer/src"),
      },
    },
    build: {
      rollupOptions: {
        input: resolve(projectRoot, "src/renderer/index.html"),
      },
    },
    plugins: [react(), injectCspPlugin],
  },
});
