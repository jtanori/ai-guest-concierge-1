/**
 * One clock for a business row and the event that records it.
 *
 * Issue #147, option 3. Before this, the two sides of a reconciliation were stamped
 * independently: business tables take `created_at timestamptz NOT NULL DEFAULT now()`
 * (the Postgres transaction timestamp) while the paired event took a JS-side
 * `new Date()`. A window boundary falling between those two readings reported
 * `delta ±1` — a timing artifact indistinguishable from missing instrumentation, which
 * is the one thing a reconciliation must never produce.
 *
 * The fix is not to compare more cleverly but to stop having two values: each producer
 * reads its own row's `created_at` back out of the INSERT and hands that exact value to
 * `emitEvent`, so the row and its event cannot disagree.
 *
 * WHY THIS IS SQL AND NOT `new Date(row.created_at).toISOString()`
 *
 * node-pg parses `timestamptz` into a JS `Date`, and a `Date` holds **milliseconds**.
 * Postgres holds **microseconds**. So the obvious round-trip silently truncates:
 *
 *     stored    2026-10-26 23:11:39.871571+00
 *     via JS    2026-10-26T23:11:39.871Z          <- lost 571us
 *
 * That is not a cosmetic loss. It reintroduces exactly the bug being fixed, at a
 * smaller scale: the event lands up to 999us *before* its own business row, and a
 * window boundary inside that gap still yields `delta ±1`. A fix that is merely 1000x
 * less likely to fire is not a fix, and it is the kind that survives review for months
 * because the suite stays green.
 *
 * So the timestamp is rendered to text **inside Postgres**, at full precision, and never
 * passes through a JS `Date`. Verified against PostgreSQL 16.2: rendering a row's
 * `created_at` this way and inserting it into `events.created_at` compares equal to the
 * business row (`ok = true`), microsecond for microsecond.
 *
 * `AT TIME ZONE 'UTC'` is explicit rather than inherited: `::text` on a `timestamptz`
 * renders in the *session* timezone, so a connection whose `TimeZone` is not UTC would
 * otherwise produce a string that is correct but confusing, and whose meaning changes if
 * the session setting ever differs between writer and reader.
 *
 * WHY NOT SIMPLY LET `events.created_at DEFAULT now()` APPLY
 *
 * That almost works, and it is worth recording why it was rejected. `now()` is the
 * transaction timestamp and does not advance within a transaction — measured: two
 * readings 300ms apart returned the identical `23:11:39.196Z`, and an event inserted
 * after that delay still equalled its business row exactly. So for the seven reconciled
 * tables that use the column default, omitting the timestamp would align both sides for
 * free.
 *
 * It was rejected for two measured reasons:
 *
 *  1. It only holds while the emit stays inside the business write's transaction. An
 *     event emitted in a *separate* transaction drifted **52ms** in measurement. Nothing
 *     in the type system or the schema enforces that co-location, so the correctness of
 *     the reconciliation would rest on an invariant no test asserts and a future refactor
 *     could break silently. Reading the row's own value back is correct regardless of
 *     where the emit happens.
 *  2. `messages` does not use the column default. `insertMessage` stamps
 *     `clock_timestamp()` on purpose (`guest/service.ts`), because both messages of a
 *     turn are written in one transaction and `now()` would tie them to the microsecond,
 *     leaving `ORDER BY created_at` to fall back to a random UUID. Measured against a
 *     default-stamped event, the message row landed **1ms ahead** — so the one table that
 *     most needs ordering is the one table the shortcut cannot serve.
 *
 * Explicit read-back is uniform across all eight metrics, needs no exception for
 * `messages`, and does not depend on transaction boundaries staying as they are.
 */

/**
 * `RETURNING` fragment: the row's own `created_at` as exact ISO-8601 UTC text with
 * microseconds, aliased `created_at_iso`.
 *
 * Use it in the INSERT that creates the business row, then pass the value straight into
 * `EventContext.createdAt`:
 *
 * ```ts
 * const row = await client.query<{ request_id: string } & CreatedAtIsoRow>(
 *   `INSERT INTO service_requests (...)
 *    VALUES (...)
 *    RETURNING request_id, ${CREATED_AT_ISO_SQL}`,
 *   [...],
 * );
 * // one timestamp, both sides
 * await emitEvent(client, context, "request_created", { ...ctx, createdAt: row.rows[0]!.created_at_iso }, {...});
 * ```
 *
 * The literal contains single and double quotes but **no backticks**, so it is safe to
 * interpolate into the backtick template literals this codebase uses for SQL. (A backtick
 * inside such a literal terminates it, and the file then collects zero tests — that has
 * bitten this repo twice.)
 */
export const CREATED_AT_ISO_SQL =
  `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_iso`;

/**
 * The row shape an INSERT using {@link CREATED_AT_ISO_SQL} returns. Intersect it with
 * whatever else the producer needs:
 *
 * ```ts
 * client.query<{ flag_id: string } & CreatedAtIsoRow>(...)
 * ```
 */
export interface CreatedAtIsoRow {
  created_at_iso: string;
}

/**
 * The transaction clock, rendered the same exact way, for an event whose statement has
 * no paired business row to read back.
 *
 * `now()` is the *transaction* timestamp: it does not advance between statements. Two
 * readings 300ms apart in one transaction return the identical value, which is why a
 * column default of `now()` and this expression agree without coordination. Use it when
 * the emitting statement is an UPDATE or a conflict-suppressed INSERT that returns no
 * row, so the event still carries a database-sourced stamp rather than a JS reading.
 *
 * Do NOT use it as a shortcut in place of {@link CREATED_AT_ISO_SQL} where a real row
 * exists — `messages` stamps `clock_timestamp()`, which deliberately advances within the
 * transaction, and this expression would not match it.
 */
export const TX_NOW_ISO_SQL =
  `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_iso`;
