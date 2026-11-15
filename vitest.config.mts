import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/extension/test/**/*.test.ts", "tests/scripts/**/*.test.ts"],
    environment: "node",
    pool: "forks",
  },
});
