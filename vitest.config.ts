import { defineConfig } from "vitest/config";
import path from "path";
export default defineConfig({
  resolve: {
    alias: {
      obsidian: path.resolve(__dirname, "tests/mocks/obsidian.ts"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
  },
});
