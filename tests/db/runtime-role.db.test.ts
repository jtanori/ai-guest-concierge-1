/**
 * S02-01 review round 2 — the runtime pool must actually run as
 * concierge_app. The deployed login role owns the tables and previously
 * stayed a member of the definer roles, so a forgotten SET ROLE meant an RLS
 * bypass; the pool's startup `role` option makes the guarantee structural.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { appPoolConfig } from "../../src/neon/postgres.ts";
import { connectScratch, dropScratch, recreateScratch, scratchUrl } from "./helpers.db.ts";

let admin: pg.Client;
let app: pg.Client;
let userId = "";

describe("runtime role (db)", () => {
  beforeAll(async () => {
    await recreateScratch();
    admin = await connectScratch();
    userId = (await admin.query<{ user_id: string }>(
      "INSERT INTO users (email) VALUES ('runtime@example.com') RETURNING user_id",
    )).rows[0]!.user_id;
    app = new pg.Client(appPoolConfig(scratchUrl()));
    app.on("error", () => undefined);
    await app.connect();
  });

  afterAll(async () => {
    await app.end();
    await admin.end();
    await dropScratch();
  });

  it("opens every pool session as concierge_app, not the login role", async () => {
    const row = await app.query<{ current: string; session: string }>(
      "SELECT current_user AS current, session_user AS session",
    );
    expect(row.rows[0]!.current).toBe("concierge_app");
    expect(row.rows[0]!.session).not.toBe("concierge_app");
  });

  it("sees zero users without context and only the caller with one", async () => {
    const none = await app.query<{ n: string }>("SELECT count(*) AS n FROM users");
    expect(none.rows[0]!.n).toBe("0");

    await app.query("BEGIN");
    try {
      await app.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
      const own = await app.query<{ n: string }>("SELECT count(*) AS n FROM users");
      expect(own.rows[0]!.n).toBe("1");
    } finally {
      await app.query("ROLLBACK");
    }
  });
});
