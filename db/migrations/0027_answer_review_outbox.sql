-- 0027_answer_review_outbox.sql — S09-04 — review work off the guest's path.
--
-- AC-1: the outbound guest message is committed before any review work starts.
-- AC-2: review work is retried from the outbox on failure, and a failure never
--       re-sends the guest message.
--
-- `outbox` has existed since 0001 with `status`, `attempts`, `next_attempt_at`,
-- `last_error` and `processed_at` — and nothing has ever read it. This is its
-- first consumer, so it sets the conventions the later ones (S09-05's email,
-- S11-01's worker) will inherit rather than invent separately.
--
-- The shape of the guarantee is worth stating, because it is not "review is
-- fast". It is that review work is *not on the guest's path at all*: the turn
-- writes the reply and an outbox row in ONE transaction, commits, and only then
-- can anything look at the row. If the review machinery is slow, broken, or
-- absent, the guest has already been answered — and because the row is written in
-- the same transaction as the reply, there is no window where the reply exists
-- and the review work was lost, nor one where review work exists for a reply that
-- was rolled back.

-- ---------- 1. a new kind of outbox row -------------------------------------
--
-- Additive: no backfill, and every pre-existing row keeps its kind. Re-creating
-- the CHECK is the only way to widen one.
ALTER TABLE outbox DROP CONSTRAINT outbox_kind_check;
ALTER TABLE outbox
  ADD CONSTRAINT outbox_kind_check
  CHECK (kind IN ('provider_message', 'webhook', 'email', 'sms', 'review'));

COMMENT ON CONSTRAINT outbox_kind_check ON outbox IS
  'Appendix C delivery kinds + review (S09-04): work that must survive the transaction that asked for it.';

-- One queued review per answer.
--
-- An outbox is at-least-once by nature, and the consumer below is idempotent, so
-- a duplicate row would be harmless rather than wrong. It would still be wasted
-- work and a misleading `attempts` count, so the queue says once. The predicate
-- excludes 'sent' and 'dead': a finished row must not block a future one, and a
-- dead row is exactly the case where somebody should be able to queue the answer
-- again by hand.
CREATE UNIQUE INDEX outbox_review_queued_once
  ON outbox (property_id, ((payload ->> 'ai_run_id')))
  WHERE kind = 'review' AND status IN ('pending', 'sending', 'failed');

COMMENT ON INDEX outbox_review_queued_once IS
  'S09-04: one queued review per answer per property. Deliberately partial — a sent or dead row must not block a later one.';

-- The claim query needs no new index: 0001's `outbox_pending (status,
-- next_attempt_at) WHERE status IN ('pending','failed')` is already exactly the
-- shape a claim loop wants, and adding a kind-specific one would be a second
-- index over the same rows.

-- ---------- 2. what the review work produces --------------------------------
--
-- A disposition per answer. Without a row to write, "the worker ran" would be
-- indistinguishable from "the worker did nothing", and idempotency (AC-2) would
-- have nothing to be idempotent *about*.
--
-- `needs_review` reads one column the pipeline already writes, `ai_runs.decision`:
-- an escalation after the model was consulted needs a human, an answer that went
-- out does not, and a `no_answer` belongs to the knowledge-gap queue (S09-02)
-- rather than to a second queue for the same fact.
--
-- The tempting rule — "needs review in `draft` mode", which is what S08-04's
-- wording suggests — cannot ever be true: in draft mode the pipeline escalates
-- with zero provider calls, so there is no ai_runs row to dispose of. Draft mode's
-- queue is the inbox. No confidence threshold either, because `settings` has none
-- and inventing one here would be a second, undocumented policy inside a plumbing
-- item.
CREATE TABLE answer_reviews (
  org_id        uuid NOT NULL REFERENCES organizations(org_id),
  property_id   uuid NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
  ai_run_id     uuid NOT NULL,
  needs_review  boolean NOT NULL,
  /** Why. A boolean with no reason is a queue nobody can triage. */
  reason        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  /** NULL until a human has looked at it. Only meaningful when it was asked for. */
  reviewed_at   timestamptz,

  -- The idempotency key: one disposition per answer per tenant. The worker's
  -- INSERT is ON CONFLICT DO NOTHING against this, so a replayed outbox row
  -- cannot produce a second disposition or overwrite the first one's reason.
  PRIMARY KEY (org_id, property_id, ai_run_id),

  -- Same reasoning as answer_flags (0026): the triple has to exist together, so a
  -- row cannot name another property's run and rely on RLS merely hiding it.
  FOREIGN KEY (org_id, property_id, ai_run_id)
    REFERENCES ai_runs (org_id, property_id, ai_run_id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, property_id) REFERENCES properties (org_id, property_id),

  -- The same "shape" family as 0018 (acknowledged_at), 0023, 0025 (resolved_at):
  -- a timestamp may not claim more than its status says. Reviewing an answer that
  -- never needed review is not a fact worth being able to record.
  CHECK (reviewed_at IS NULL OR needs_review)
);

COMMENT ON TABLE answer_reviews IS
  'S09-04: the disposition of one AI answer, written by the outbox worker after the guest has already been replied to.';

-- ---------- 3. RLS + grants (the 0002 tenant-table shape) -------------------

ALTER TABLE answer_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE answer_reviews FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant ON answer_reviews
  USING (org_id = current_org_id() AND property_id = current_property_id())
  WITH CHECK (org_id = current_org_id() AND property_id = current_property_id());

-- SELECT, INSERT and UPDATE (the UPDATE is how `reviewed_at` gets set). No
-- DELETE, and — as 0026 learned the hard way — saying so is not enough: 0002's
-- ALTER DEFAULT PRIVILEGES already granted all four at CREATE TABLE, so the
-- revocation below is what actually removes it. A disposition that can be deleted
-- is a queue whose history can be tidied, and "this answer was never reviewed"
-- becomes indistinguishable from "somebody removed the row".
GRANT SELECT, INSERT, UPDATE ON answer_reviews TO concierge_app;
REVOKE DELETE ON answer_reviews FROM concierge_app;

-- The queue a human reads: what needs a look, oldest first.
CREATE INDEX answer_reviews_queue
  ON answer_reviews (property_id, created_at)
  WHERE needs_review AND reviewed_at IS NULL;

-- ---------- 4. how a worker can see the queue at all ------------------------
--
-- `outbox` is FORCE ROW LEVEL SECURITY, and FORCE applies to the table OWNER too
-- (that is what FORCE means — 0015 spells out why). A worker's whole job is to
-- read rows from *every* tenant, and BYPASSRLS needs a superuser Neon does not
-- give us. So the claim is a SECURITY DEFINER function with its own role, in the
-- shape 0015 established for the guest slug lookup: NOLOGIN, no grants on any
-- tenant table, and the smallest possible window.
--
-- Only the CLAIM needs this. Once a row is claimed the worker sets the tenant GUCs
-- from the row itself and does the work as `concierge_app` under normal RLS, so
-- completing and failing a row are ordinary tenant-scoped statements. The definer
-- primitive is one narrow read, not a general bypass.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'concierge_worker') THEN
    CREATE ROLE concierge_worker NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO concierge_worker;
-- CREATE on the schema, as 0005 established for the other definer roles: under a
-- non-superuser migration role, `ALTER FUNCTION ... OWNER TO` needs it.
GRANT CREATE ON SCHEMA public TO concierge_worker;
-- SELECT *and* UPDATE, and the UPDATE is not for updating anything.
--
-- The claim is `SELECT ... FOR UPDATE SKIP LOCKED`, and PostgreSQL requires the
-- UPDATE privilege to lock a row for writing even when the statement writes
-- nothing. With SELECT alone the function fails `permission denied for table
-- outbox` — found by the worker test, not by reading the grant list, because
-- "SELECT needs SELECT" is exactly the assumption that looks right.
--
-- The role still cannot INSERT or DELETE, and the function body is one SELECT, so
-- the effective reach of the definer window is unchanged: it can lock and return
-- due review rows, and nothing else.
GRANT SELECT, UPDATE ON outbox TO concierge_worker;

-- Deliberately NOT granted to concierge_app: a definer function whose owner the
-- application role could SET ROLE into is not a definer function (0005 removed
-- exactly that membership for concierge_promoter).

-- A policy for the worker role, and why privileges alone were not enough.
--
-- SECURITY DEFINER changes the ROLE a function body runs as; it does not exempt
-- that role from row-level security. `outbox` is FORCE RLS, whose tenant policy
-- reads `org_id = current_org_id()`, and at claim time the worker has not set any
-- tenant GUCs yet — setting them per row is the whole point of claiming first. So
-- the definer function ran, had the right table privileges, and returned zero
-- rows: an empty queue that looks exactly like a healthy one. Found by the worker
-- test asserting `claimed: 1`, not by reading the policy.
--
-- BYPASSRLS is not available (it needs a superuser, which is why 0015 went the
-- narrow-role route for the guest slug lookup in the first place), so the worker
-- gets its own permissive policy instead — the same containment argument as
-- `concierge_public`: the role is NOLOGIN, is not a member of anything the
-- application can SET ROLE into, holds no grants on any other tenant table, and is
-- reachable only through the one function below. Split SELECT and UPDATE rather
-- than one FOR ALL, because `SELECT ... FOR UPDATE` is checked against BOTH
-- policies and a blanket FOR ALL would also advertise INSERT and DELETE that the
-- table privileges already refuse.
CREATE POLICY worker_claim_select ON outbox
  FOR SELECT TO concierge_worker
  USING (true);
CREATE POLICY worker_claim_lock ON outbox
  FOR UPDATE TO concierge_worker
  USING (true) WITH CHECK (true);

COMMENT ON POLICY worker_claim_select ON outbox IS
  'S09-04: the review worker claims across every tenant. Reachable only through claim_review_outbox(), whose role is NOLOGIN and holds nothing else.';
CREATE FUNCTION claim_review_outbox(batch_limit integer)
RETURNS TABLE(claimed_id bigint, claimed_org uuid, claimed_property uuid, claimed_payload jsonb, claimed_attempts integer)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT o.outbox_id, o.org_id, o.property_id, o.payload, o.attempts
    FROM outbox o
   WHERE o.kind = 'review'
     AND o.status IN ('pending', 'failed')
     -- A row whose retry is not due yet is not claimable; that is what
     -- next_attempt_at is for, and ignoring it would turn backoff into a no-op.
     AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= now())
   ORDER BY o.outbox_id
   LIMIT greatest(1, batch_limit)
   -- SKIP LOCKED, not plain FOR UPDATE: two workers must claim different rows
   -- rather than queue behind each other, and neither may block the other's
   -- batch. The lock is held by the CALLING transaction, so the claim and the
   -- work have to share one — which is why the worker claims a single row at a
   -- time instead of a batch up front.
   FOR UPDATE SKIP LOCKED
$$;

-- Ownership transfer needs the migration role to be able to SET ROLE into the new
-- owner, which a non-superuser cannot do without membership. 0015's idiom grants
-- it for the duration; 0005 is the reason it must not stay granted — a login role
-- that is a member of a definer role can SET ROLE into it and reach whatever
-- permissive policy that role has, which here is "every tenant's outbox".
DO $$
BEGIN
  EXECUTE format('GRANT concierge_worker TO %I', current_user);
END $$;

ALTER FUNCTION claim_review_outbox(integer) OWNER TO concierge_worker;

DO $$
BEGIN
  EXECUTE format('REVOKE concierge_worker FROM %I', current_user);
END $$;

-- ALTER ... OWNER discards the ACL and restores EXECUTE FOR PUBLIC (0003/0004/0009
-- all re-tighten after transferring), so re-tighten here too.
--
-- EXECUTE goes to concierge_app only, and deliberately NOT to CURRENT_USER the way
-- 0009 does: the worker always `SET LOCAL ROLE concierge_app` before claiming, so
-- the login role never needs it, and granting it would let a session that forgot
-- to switch roles claim across every tenant.
REVOKE ALL ON FUNCTION claim_review_outbox(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_review_outbox(integer) TO concierge_app;

COMMENT ON FUNCTION claim_review_outbox(integer) IS
  'S09-04: claim due review rows across every tenant. The one cross-tenant read the worker needs; the work itself runs under normal RLS.';
