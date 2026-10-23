import { defineConfig } from "vitest/config";

// Unit test config: everything EXCEPT the database suites.
// tests/db owns a dedicated config (tests/db/vitest.db.config.ts) with long
// hook timeouts and single-worker execution; it is driven by `npm run db:test`
// (and by the `db-test` CI job), never by `npm test`.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "tests/db/**"],
  },
});
