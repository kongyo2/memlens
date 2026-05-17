import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const projectRoot = dirname(fileURLToPath(import.meta.url));

const sharedAlias = {
  "@shared": resolve(projectRoot, "src/shared"),
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
      lib: { entry: resolve(projectRoot, "src/preload/index.ts") },
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
    plugins: [react()],
  },
});
