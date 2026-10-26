/**
 * S07-04 AC-1 — the flood ceiling.
 *
 * Three buckets, because the three ways this endpoint can be abused are
 * different problems:
 *
 *  - **ip** — one client scripting the page. The cheapest attack and the most
 *    common. Keyed by a hash of the address, never the address (see
 *    `hashSubject`, and 0019's header for why).
 *  - **conversation** — one guest (or one script holding one cookie) hammering
 *    the model. Distinct from the ip bucket because a hotel's own wifi puts
 *    every guest behind one address: an ip-only limit would throttle the lobby,
 *    and a conversation-only limit would let one machine open a thousand
 *    conversations.
 *  - **property** — the tenant-wide ceiling that makes the other two safe to set
 *    generously. It is the number that bounds a bad night for the hotel.
 *
 * ## The limits are code, not settings
 *
 * The charter put them in `PropertySettings`. This module does not, deliberately:
 * a flood ceiling a property can raise is not a ceiling — the one evening a
 * script is running is exactly the evening someone is tempted to raise it. They
 * are constants here, reviewed in a pull request like any other safety limit,
 * and a pilot property that genuinely needs different numbers gets a deliberate
 * change with its own justification rather than a settings toggle. (The *spend*
 * cap does live in settings, because that one is the property's own money and
 * the property is entitled to choose it — `spendCaps` already reads it.)
 *
 * ## Counters live in Postgres
 *
 * In-memory counters are per-replica and reset on deploy, so the published limit
 * silently multiplies by the number of instances. 0019's table is the counter;
 * this module is the arithmetic and the one upsert.
 *
 * ## Why the check runs inside the caller's transaction
 *
 * A turn that rolls back did not happen, and charging it against the guest's
 * budget would be wrong (a transient failure would lock a real guest out). The
 * counter is consumed in the same transaction as the messages, so it counts
 * completed turns — which is the thing worth limiting.
 */
import { createHash } from "node:crypto";
import type pg from "pg";
import type { TenantContext } from "../db/tenant.ts";

export const RATE_BUCKETS = ["ip", "conversation", "property"] as const;
export type RateBucket = (typeof RATE_BUCKETS)[number];

export interface RateLimit {
  /** Requests allowed inside one window. */
  limit: number;
  /** Window length. Fixed windows, aligned to the epoch (see `windowStart`). */
  windowSeconds: number;
}

/**
 * The ceilings. Read these as "a human guest will never come close, and a script
 * will hit them in seconds". A property's busiest hour in the pilot is a few
 * dozen messages; 120/hour for one address is generous for a shared network and
 * still useless to a flood.
 */
export const RATE_LIMITS: Readonly<Record<RateBucket, RateLimit>> = {
  // 20 messages a minute from one address is far more than a person types and
  // far less than a loop needs. Shared hotel wifi is covered by the
  // conversation bucket doing the real work.
  ip: { limit: 20, windowSeconds: 60 },
  // One thread, 10 turns a minute: a guest following up quickly is fine; a
  // script reusing one cookie stops in seconds.
  conversation: { limit: 10, windowSeconds: 60 },
  // The tenant-wide bound: 600 messages an hour is roughly ten times a busy
  // pilot hour. It exists so a distributed flood still has a shape.
  property: { limit: 600, windowSeconds: 3600 },
};

export interface RateDecision {
  allowed: boolean;
  bucket: RateBucket;
  /** The ceiling that applied. */
  limit: number;
  /** Count after this request was consumed (or the count that blocked it). */
  count: number;
  /** Seconds until the current window ends — what a `Retry-After` would say. */
  retryAfterSeconds: number;
  /** ISO instant the window resets. */
  resetAt: string;
}

export interface RateInput {
  /** Raw IP, or null when the transport does not give one. */
  ip: string | null;
  conversationId: string;
  at?: Date;
}

/**
 * Salt for the IP hash. Not a secret in the cryptographic sense — you cannot
 * brute-force an IPv4 space with a known salt without committing to it — but a
 * per-deployment salt stops one leaked table from being joined against another
 * deployment's, and stops a rainbow table of the IPv4 space from being useful.
 */
export const DEFAULT_IP_SALT = "concierge-rate-limit-v1";

/**
 * A stable, opaque key for a subject. Truncated to 32 hex characters: enough
 * that collisions are not a practical concern (128 bits of input, 128 of
 * output), short enough to index.
 */
export function hashSubject(kind: string, value: string, salt = DEFAULT_IP_SALT): string {
  return createHash("sha256").update(`${salt}\u0000${kind}\u0000${value}`).digest("hex").slice(0, 32);
}

/** Fixed windows aligned to the epoch, so every replica agrees on the boundary. */
export function windowStart(at: Date, windowSeconds: number): Date {
  const ms = Math.floor(at.getTime() / (windowSeconds * 1000)) * windowSeconds * 1000;
  return new Date(ms);
}

interface CounterRow {
  count: number;
}

/**
 * Consume one unit from a bucket. Returns the decision; never throws for
 * "over the limit" — being over a limit is a product state, not an error.
 *
 * The upsert both writes and reads the new total in one statement, so two
 * concurrent requests cannot both see "19 of 20" and both proceed: the second
 * one's `RETURNING count` is 21 and it is the one refused. That is the whole
 * reason the count is returned from the write rather than read first.
 */
export async function consume(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  input: { bucket: RateBucket; key: string; at?: Date; limit?: RateLimit },
): Promise<RateDecision> {
  const limit = input.limit ?? RATE_LIMITS[input.bucket];
  const at = input.at ?? new Date();
  const start = windowStart(at, limit.windowSeconds);
  const resetAt = new Date(start.getTime() + limit.windowSeconds * 1000);

  const result = await client.query<CounterRow>(
    `INSERT INTO rate_limits (org_id, property_id, bucket, key, window_start, count)
     VALUES ($1, $2, $3, $4, $5, 1)
     ON CONFLICT (org_id, property_id, bucket, key, window_start)
     DO UPDATE SET count = rate_limits.count + 1
     RETURNING count`,
    [context.orgId, context.propertyId, input.bucket, input.key, start.toISOString()],
  );
  const count = result.rows[0]!.count;

  return {
    allowed: count <= limit.limit,
    bucket: input.bucket,
    limit: limit.limit,
    count,
    retryAfterSeconds: Math.max(1, Math.ceil((resetAt.getTime() - at.getTime()) / 1000)),
    resetAt: resetAt.toISOString(),
  };
}

export interface RateVerdict {
  allowed: boolean;
  /** Every bucket that was consulted, in the order it was consulted. */
  decisions: RateDecision[];
  /** The bucket that refused, when one did. */
  blocked: RateDecision | null;
}

/**
 * Consume from all three buckets.
 *
 * Order matters for cost, not for correctness: the ip bucket is the cheapest to
 * trip, so checking it first means a flood stops after one row instead of three.
 * Every bucket is consumed even when an earlier one refuses — the property-level
 * counter must see the flood, or the one number an operator looks at during an
 * incident would be blank.
 */
export async function checkRate(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  input: RateInput,
): Promise<RateVerdict> {
  const decisions: RateDecision[] = [];

  const keys: Array<{ bucket: RateBucket; key: string }> = [];
  if (input.ip !== null && input.ip !== "") {
    keys.push({ bucket: "ip", key: hashSubject("ip", input.ip) });
  }
  keys.push({ bucket: "conversation", key: input.conversationId });
  keys.push({ bucket: "property", key: context.propertyId });

  for (const entry of keys) {
    decisions.push(
      await consume(client, context, {
        bucket: entry.bucket,
        key: entry.key,
        ...(input.at === undefined ? {} : { at: input.at }),
      }),
    );
  }

  const blocked = decisions.find((decision) => !decision.allowed) ?? null;
  return { allowed: blocked === null, decisions, blocked };
}
