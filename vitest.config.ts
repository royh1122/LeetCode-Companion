import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/extension/test/**/*.test.ts", "apps/web/test/**/*.test.{ts,tsx}"],
    environment: "node",
    pool: "forks",
  },
});
