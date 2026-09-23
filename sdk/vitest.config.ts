import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // The anvil suite is stateful (one chain, tests build on each other): keep files sequential too.
    fileParallelism: false,
  },
});
