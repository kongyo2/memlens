import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const projectRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.{ts,tsx}", "tests/**/*.{test,spec}.{ts,tsx}"],
    globals: false,
  },
  resolve: {
    alias: {
      "@shared": resolve(projectRoot, "src/shared"),
      "@renderer": resolve(projectRoot, "src/renderer/src"),
    },
  },
});
