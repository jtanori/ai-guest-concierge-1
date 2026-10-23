import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/db/**/*.db.test.ts"],
    // Handshakes + a fresh migration chain per run are legitimately slow;
    // giving 60s means a slow docker disk doesn't turn into a red build.
    hookTimeout: 60_000,
    testTimeout: 60_000,
    // The scratch database is per-process; single-threaded keeps every file
    // inside one create/migrate/drop cycle.
    fileParallelism: false,
  },
});
