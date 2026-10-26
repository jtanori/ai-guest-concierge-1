/**
 * S07-04 AC-2 — what the AI has cost today, and whether that is still allowed.
 *
 * `policyGate` (S05-02) already refuses when the budget is exhausted; it takes
 * `spendTodayUsd` and `conversationSpendUsd` as inputs and says in its own
 * comment that the counter is S07-04's job. This module is that counter. Until
 * it existed, both arguments were `undefined` on every production call, so the
 * caps were configured, documented and never enforced — the worst possible state
 * for a limit, because the settings screen said the property was protected.
 *
 * ## The cost is an estimate, and the code says so
 *
 * The provider adapters return text, not `usageMetadata`, so there is no token
 * count to price. Rather than change the transport contract from a cost-protection
 * item (that contract is S07-06's, and every adapter and test depends on it),
 * this module estimates tokens from characters and prices them from a table.
 *
 * Three consequences, all deliberate:
 *
 *  - **It rounds up.** `chars / 4` is close for English and conservative for
 *    Spanish (more characters per token), and `Math.ceil` keeps it above the
 *    vendor's number rather than below it. A cap that under-counts is worse than
 *    no cap, because it silently overspends.
 *  - **An unknown model is priced as the most expensive known model.** A new
 *    model id appearing in configuration must not mean "free".
 *  - **`calls` and `cost_usd` are both stored.** The count is exact even when the
 *    money is not, so a reconciliation against the invoice can find the drift.
 *
 * Recording real usage is a named follow-up on S07-06, not something this module
 * pretends to have done.
 */
import type pg from "pg";
import type { TenantContext } from "../db/tenant.ts";

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

/** USD per million tokens, from the vendor's published price list. */
export interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
}

/**
 * Prices for the pinned models (DEC-2). These are estimates by nature — a vendor
 * changes a price with a blog post — so the numbers live in exactly one place and
 * the reconciliation step against the invoice is what corrects them.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "gemini-2.5-flash": { inputPerMillion: 0.3, outputPerMillion: 2.5 },
  "gemini-2.5-flash-lite": { inputPerMillion: 0.1, outputPerMillion: 0.4 },
};

/** Characters per token. Deliberately low, so the estimate runs high. */
export const CHARS_PER_TOKEN = 4;

/** One message is never free: an empty answer still cost an input. */
const MIN_TOKENS = 1;

export function estimateTokens(text: string): number {
  const chars = typeof text === "string" ? text.length : 0;
  return Math.max(MIN_TOKENS, Math.ceil(chars / CHARS_PER_TOKEN));
}

/**
 * The worst-known price. Used for a model id that is missing from the table so
 * that a configuration change cannot make a spend cap stop working.
 */
export function worstCasePrice(): ModelPrice {
  const prices = Object.values(MODEL_PRICES);
  return {
    inputPerMillion: Math.max(...prices.map((price) => price.inputPerMillion)),
    outputPerMillion: Math.max(...prices.map((price) => price.outputPerMillion)),
  };
}

export function priceFor(modelId: string): ModelPrice {
  return MODEL_PRICES[modelId] ?? worstCasePrice();
}

/** Cost in USD, rounded UP to six decimals — a counter, never a refund. */
export function costUsd(modelId: string, usage: TokenUsage): number {
  const price = priceFor(modelId);
  const raw =
    (usage.promptTokens * price.inputPerMillion + usage.completionTokens * price.outputPerMillion) /
    1_000_000;
  return Math.ceil(raw * 1_000_000) / 1_000_000;
}

/** The UTC day key. UTC, not the property's zone: a cap resets once, globally. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * What this property and this conversation have spent so far.
 *
 * No caps in this shape, on purpose: the caps come from `PropertySettings`, and
 * the guest request path cannot read settings — `concierge_public` holds a
 * column grant on `properties` that excludes `settings` (0015), because settings
 * carry staff names and contacts. `policyGate` already reads the settings under
 * the app role and compares them with these two numbers, so the comparison
 * happens exactly once, where the money rule lives, and no privilege is widened
 * to move a number around.
 */
export interface SpendSnapshot {
  todayUsd: number;
  conversationUsd: number;
  /** The UTC day the first number belongs to; carried for logs and tests. */
  dayKey: string;
}

interface CounterRow {
  cost_usd: string;
}

async function readCounter(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  scope: "day" | "conversation",
  key: string,
): Promise<number> {
  const result = await client.query<CounterRow>(
    `SELECT cost_usd FROM spend_counters
      WHERE org_id = $1 AND property_id = $2 AND scope = $3 AND key = $4`,
    [context.orgId, context.propertyId, scope, key],
  );
  const row = result.rows[0];
  // `numeric` arrives as a string from the driver; parse it rather than
  // trusting an implicit coercion that would silently turn 0 into NaN.
  return row === undefined ? 0 : Number.parseFloat(row.cost_usd);
}

export async function loadSpend(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  input: { conversationId: string; at?: Date },
): Promise<SpendSnapshot> {
  const dayKey = utcDay(input.at ?? new Date());
  const [todayUsd, conversationUsd] = await Promise.all([
    readCounter(client, context, "day", dayKey),
    readCounter(client, context, "conversation", input.conversationId),
  ]);
  return { todayUsd, conversationUsd, dayKey };
}

export interface RecordSpendInput {
  conversationId: string;
  modelId: string;
  usage: TokenUsage;
  at?: Date;
}

/**
 * Adds one call's estimated cost to both counters, in the caller's transaction.
 *
 * Both rows move together or neither does: a conversation that was charged
 * against the property's daily budget but not its own (or the reverse) would let
 * one guest overspend a shared cap forever.
 */
export async function recordSpend(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  input: RecordSpendInput,
): Promise<number> {
  const cost = costUsd(input.modelId, input.usage);
  const day = utcDay(input.at ?? new Date());

  for (const [scope, key] of [
    ["day", day],
    ["conversation", input.conversationId],
  ] as const) {
    await client.query(
      `INSERT INTO spend_counters (org_id, property_id, scope, key, cost_usd, calls, updated_at)
       VALUES ($1, $2, $3, $4, $5, 1, now())
       ON CONFLICT (org_id, property_id, scope, key)
       DO UPDATE SET cost_usd = spend_counters.cost_usd + EXCLUDED.cost_usd,
                     calls = spend_counters.calls + 1,
                     updated_at = now()`,
      [context.orgId, context.propertyId, scope, key, cost.toFixed(6)],
    );
  }
  return cost;
}
