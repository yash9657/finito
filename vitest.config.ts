import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// vite-tsconfig-paths is not installed, so resolve the '@' alias to the repo root
// manually (mirrors tsconfig's `"@/*": ["./*"]`) so tests can import '@/lib/...'.
const repoRoot = fileURLToPath(new URL(".", import.meta.url)).replace(/\/$/, "");

export default defineConfig({
  test: {
    environment: "node",
  },
  resolve: {
    alias: {
      "@": repoRoot,
    },
  },
});
