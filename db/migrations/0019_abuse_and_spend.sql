-- 0019_abuse_and_spend.sql — S07-04 — the two counters that keep a public
-- endpoint from becoming an unbounded bill.
--
-- The charter calculated `0015_abuse.sql`; 0015 is `guest_chat` (S06-01), so this
-- is 0019 (the charter says to rebase on whatever merged first).
--
-- ## Why counters in Postgres and not in memory
--
-- A rate limiter or a spend cap held in process memory is per-replica: three
-- instances mean three times the limit, and a deploy resets the budget. The
-- whole point of the cap is that it cannot be evaded by adding capacity, so the
-- counter has to be shared and durable — which is the database we already have.
-- The cost is one upsert per guest message; that is cheaper than the model call
-- it protects, by three orders of magnitude.
--
-- ## `rate_limits` — fixed windows, keyed by a hash
--
-- Fixed-window counters, not a sliding log: the log needs a row per request and
-- a delete job, and the failure it protects against (a flood from one client) is
-- caught just as well by a window that resets. The known weakness of a fixed
-- window — a burst straddling the boundary can reach 2× the limit — is
-- acceptable here because the ceiling is a flood control, not a fairness
-- guarantee, and the spend cap is the hard financial stop behind it.
--
-- `key` is a **hash**, never a raw IP. An IP address is personal data under
-- every privacy regime this product will meet, and a rate-limit table is exactly
-- the kind of "operational" table that gets exported during an incident. The
-- application hashes `ip + per-deployment salt` (S11-03 owns the wider PII
-- rules); the database never sees the address, and a leaked table cannot be
-- turned back into a list of who visited which hotel.
--
-- ## `spend_counters` — money, accumulated
--
-- Two scopes in one table rather than two tables: `scope='day'` implements the
-- property's daily cap and `scope='conversation'` the per-conversation cap, and
-- `key` is the conversation id for the latter. A single upsert path means the
-- two caps cannot drift in how they count.
--
-- `cost_usd` is `numeric`, not `double precision`: it is money. The application
-- computes it from token counts and a price table (`src/ai/spend.ts`) and
-- records the estimate it used, so a later reconciliation against the vendor's
-- invoice can find which rows were estimated from character counts.

CREATE TABLE rate_limits (
  org_id        uuid NOT NULL REFERENCES organizations(org_id),
  property_id   uuid NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
  -- 'ip' | 'conversation' | 'property' — the three ceilings AC-1 names.
  bucket        text NOT NULL CHECK (bucket IN ('ip', 'conversation', 'property')),
  -- A hashed IP, a conversation id, or the property's own id for the property
  -- bucket. Text because the three key shapes differ and none of them is a
  -- foreign key in every case.
  key           text NOT NULL CHECK (length(key) BETWEEN 1 AND 128),
  window_start  timestamptz NOT NULL,
  count         integer NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (org_id, property_id, bucket, key, window_start),
  FOREIGN KEY (org_id, property_id) REFERENCES properties (org_id, property_id)
);

CREATE INDEX rate_limits_window ON rate_limits (window_start);

CREATE TABLE spend_counters (
  org_id        uuid NOT NULL REFERENCES organizations(org_id),
  property_id   uuid NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
  scope         text NOT NULL CHECK (scope IN ('day', 'conversation')),
  -- The UTC day (`2026-10-25`) for scope='day'; the conversation id otherwise.
  key           text NOT NULL CHECK (length(key) BETWEEN 1 AND 128),
  cost_usd      numeric(12, 6) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  calls         integer NOT NULL DEFAULT 0 CHECK (calls >= 0),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, property_id, scope, key),
  FOREIGN KEY (org_id, property_id) REFERENCES properties (org_id, property_id)
);

-- ---------- RLS + grants (the 0002 tenant-table shape) ----------

ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limits FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant ON rate_limits
  USING (org_id = current_org_id() AND property_id = current_property_id())
  WITH CHECK (org_id = current_org_id() AND property_id = current_property_id());

ALTER TABLE spend_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE spend_counters FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant ON spend_counters
  USING (org_id = current_org_id() AND property_id = current_property_id())
  WITH CHECK (org_id = current_org_id() AND property_id = current_property_id());

-- DELETE on both, unlike most tenant tables: these are counters with a lifespan.
-- A window row from last month is not history worth keeping, and a retention job
-- (S11) needs to be able to remove it. Refusing DELETE would make the table grow
-- forever while the "nothing can delete an audit row" instinct does not apply —
-- nothing here is evidence of anything.
GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limits TO concierge_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON spend_counters TO concierge_app;

COMMENT ON TABLE rate_limits IS
  'S07-04: fixed-window flood counters per (ip|conversation|property). `key` is a hash for the ip bucket — never a raw address.';
COMMENT ON TABLE spend_counters IS
  'S07-04: accumulated AI spend per property-day and per conversation. Cost is an estimate from src/ai/spend.ts, reconciled against invoices later.';
