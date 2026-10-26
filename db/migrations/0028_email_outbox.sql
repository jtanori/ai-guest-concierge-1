-- 0028_email_outbox.sql — S09-05 — a request reaches a human by email.
--
-- AC-1: every new/acknowledged request enqueues an email to the property's
--       escalation contacts.
-- AC-2: provider failure retries via the outbox and never loses the notification.
--
-- `outbox.kind` has included 'email' since 0001, so no vocabulary change is needed
-- here. What is needed is (1) a claim primitive the email worker can use, and
-- (2) a guarantee that one request-stage produces one queued email rather than one
-- per retry.
--
-- AC-2's second half — "never loses the notification" — is a property of this
-- pairing: the row is written in the request's own transaction, so it cannot be
-- lost between "the request exists" and "somebody decided to send mail", and it is
-- only ever removed by being marked sent or dead. A provider that is down for an
-- hour produces a row with attempts and a future next_attempt_at, not a silence.

-- ---------- 1. one claim primitive for every kind ---------------------------
--
-- 0027 added `claim_review_outbox(integer)`, hardcoded to kind='review'. Email is
-- the second consumer and S11-01 will add more, and a definer function per kind is
-- a cross-tenant window per kind — each one another place to get the policy wrong.
-- One function parameterised by kind, owned by the same NOLOGIN `concierge_worker`
-- role with the same two narrow policies, is one window instead of N.
CREATE FUNCTION claim_outbox(p_kind text, batch_limit integer)
RETURNS TABLE(claimed_id bigint, claimed_org uuid, claimed_property uuid, claimed_payload jsonb, claimed_attempts integer)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT o.outbox_id, o.org_id, o.property_id, o.payload, o.attempts
    FROM outbox o
   WHERE o.kind = p_kind
     AND o.status IN ('pending', 'failed')
     -- A row whose retry is not due yet is not claimable; ignoring next_attempt_at
     -- would turn backoff into a no-op.
     AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= now())
   ORDER BY o.outbox_id
   LIMIT greatest(1, batch_limit)
   -- SKIP LOCKED, not plain FOR UPDATE: two workers must claim different rows
   -- rather than queue behind each other. The lock belongs to the CALLING
   -- transaction, so the claim and the work have to share one — which is why both
   -- workers claim a single row at a time instead of a batch up front.
   FOR UPDATE SKIP LOCKED
$$;

-- Ownership transfer needs the migration role to SET ROLE into the new owner,
-- which a non-superuser cannot do without membership (0027 hit exactly this, and
-- tests/db/non-superuser.db.test.ts is what caught it). Granted for the duration
-- and revoked immediately after: a login role left a member of a definer role can
-- SET ROLE into it and reach that role's permissive policy, which here is every
-- tenant's outbox. That is the hole 0005 closed for concierge_promoter.
DO $$
BEGIN
  EXECUTE format('GRANT concierge_worker TO %I', current_user);
END $$;

ALTER FUNCTION claim_outbox(text, integer) OWNER TO concierge_worker;

DO $$
BEGIN
  EXECUTE format('REVOKE concierge_worker FROM %I', current_user);
END $$;

-- ALTER ... OWNER discards the ACL and restores EXECUTE FOR PUBLIC (0003/0004/0009
-- all re-tighten afterwards), so re-tighten. EXECUTE goes to concierge_app only,
-- and not to CURRENT_USER: every worker sets the role before claiming, so the
-- login role never needs it, and granting it would let a session that forgot to
-- switch roles claim across every tenant.
REVOKE ALL ON FUNCTION claim_outbox(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_outbox(text, integer) TO concierge_app;

-- Retire the kind-specific one now that the general one exists. Nothing outside
-- src/review/queue.ts referenced it, and leaving both would mean two definer
-- windows over the same table and two places to keep in step.
DROP FUNCTION claim_review_outbox(integer);

COMMENT ON FUNCTION claim_outbox(text, integer) IS
  'S09-05: claim due outbox rows of one kind across every tenant. The single cross-tenant read the workers need; the work itself runs under normal RLS.';

-- ---------- 2. one queued email per request-stage ---------------------------
--
-- A request is announced twice by design: once when it is created (`new`) and once
-- when a human acknowledges it. Those are two notifications, so the dedupe key is
-- the request AND the stage — keying on the request alone would silently swallow
-- the acknowledgement, which is the more actionable of the two.
--
-- The point of the key is retries. The guest path and the staff path can both be
-- retried by a phone on a bad connection, and an escalation email that arrives
-- three times teaches staff to ignore escalation emails.
--
-- Partial, as 0027's is: a `sent` or `dead` row must not block a later one, and a
-- dead row is exactly the case where re-queueing by hand is the fix.
CREATE UNIQUE INDEX outbox_email_queued_once
  ON outbox (property_id, kind, ((payload ->> 'dedupe_key')))
  WHERE kind = 'email' AND status IN ('pending', 'sending', 'failed');

COMMENT ON INDEX outbox_email_queued_once IS
  'S09-05: one queued email per (request, stage) per property. Deliberately partial — a sent or dead row must not block a later notification.';

-- The claim query needs no new index: 0001's `outbox_pending (status,
-- next_attempt_at) WHERE status IN ('pending','failed')` is already the shape a
-- claim loop wants, and it serves every kind.
