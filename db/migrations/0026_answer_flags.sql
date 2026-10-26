-- 0026_answer_flags.sql — S09-03 — "wrong or outdated", attributable to a run.
--
-- The AC is one sentence and it is about *attribution*: a flag has to name the
-- exact `ai_run` that produced the answer. That is what makes it useful later —
-- per-model accuracy, per-prompt-version regressions, and "the answer that cited
-- this article version was called wrong nine times" are all queries over a flag
-- that points at a run. A flag attached to a message, or to a conversation, or to
-- a free-text ai_run_id in a JSONB payload, answers none of them.
--
-- S08-02 already renders `data-ai-run-id` on every AI bubble and reconstructs the
-- run's citations from `ai_runs`; this is the write side of the same hook.

CREATE TABLE answer_flags (
  org_id        uuid NOT NULL REFERENCES organizations(org_id),
  property_id   uuid NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
  flag_id       uuid NOT NULL DEFAULT gen_random_uuid(),
  -- The run that produced the answer being called wrong. NOT NULL: a flag with no
  -- run behind it is an opinion about nothing, and the item exists to make the
  -- opinion queryable.
  ai_run_id     uuid NOT NULL,
  -- Who said so. NOT NULL and a real FK to users, never a name typed into a box:
  -- "wrong or outdated" is a claim about a colleague's content and it has to be
  -- attributable, or the first disputed flag ends the practice.
  flagged_by    uuid NOT NULL REFERENCES users(user_id),
  note          text CHECK (note IS NULL OR length(note) <= 2000),
  created_at    timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (org_id, property_id, flag_id),

  -- One flag per person per answer.
  --
  -- A second click is a phone on a bad connection, not a second opinion, so the
  -- duplicate has to be refused by the schema rather than deduped by the caller:
  -- nine flags from one person would read as nine people, which is the exact
  -- inflation `hits` on the gap queue exists to avoid.
  UNIQUE (org_id, property_id, ai_run_id, flagged_by),

  -- The composite FK is the security property, and it is the reason the tenant
  -- columns are repeated here instead of being derived.
  --
  -- A bare `ai_run_id REFERENCES ai_runs(ai_run_id)` would let a row name a run
  -- that exists — in somebody else's property. The RLS policy below would then
  -- hide it, but "hidden" is not "refused": the insert would succeed, the flag
  -- would be orphaned from every query that reads it, and the failure would be
  -- invisible until somebody noticed a count that never moved. Requiring the
  -- (org_id, property_id, ai_run_id) TRIPLE to exist in `ai_runs` means a foreign
  -- run id cannot be referenced at all, no matter what the session's GUCs say.
  FOREIGN KEY (org_id, property_id, ai_run_id)
    REFERENCES ai_runs (org_id, property_id, ai_run_id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, property_id) REFERENCES properties (org_id, property_id)
);

COMMENT ON TABLE answer_flags IS
  'S09-03: one-click "wrong or outdated" on an AI answer, attributable to the ai_run that produced it. Append-only by design.';

-- ---------- RLS + grants (the 0002 tenant-table shape) ----------

ALTER TABLE answer_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE answer_flags FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant ON answer_flags
  USING (org_id = current_org_id() AND property_id = current_property_id())
  WITH CHECK (org_id = current_org_id() AND property_id = current_property_id());

-- SELECT and INSERT only. No UPDATE, no DELETE.
--
-- The difference from every other tenant table is deliberate: a flag is a
-- person's statement at a moment, in the same category as `audit_log`. Letting
-- the app role rewrite or remove one means a disputed flag can be quietly
-- withdrawn, and then "nine people called this answer wrong" is a number nobody
-- can trust. Retracting a flag is a product decision (S10's review queue may want
-- it) and it should arrive as its own column or a new row, not as the ability to
-- delete this one.
--
-- **The GRANT below is not what enforces this, and the REVOKE is.** 0002 runs
-- `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE
-- ON TABLES TO concierge_app`, so the CREATE TABLE above already handed
-- concierge_app all four before this line ran. A GRANT is additive: listing two
-- privileges does not withdraw the other two. `\dp answer_flags` after only the
-- GRANT reads `concierge_app=arwd` — the append-only design would have been a
-- comment, not a constraint. 0007 is the precedent for exactly this fix on
-- `audit_log`, which is why that table reads `concierge_app=ar`.
GRANT SELECT, INSERT ON answer_flags TO concierge_app;
REVOKE UPDATE, DELETE ON answer_flags FROM concierge_app;

-- And the trigger, as 0003 does for `audit_log` and `events`: the REVOKE binds
-- concierge_app, but the migration role and any future role with the grant are
-- still able to write. `raise_immutable()` is the same function those two tables
-- use, so "append-only" means one thing everywhere in this schema.
CREATE TRIGGER answer_flags_append_only
  BEFORE UPDATE OR DELETE ON answer_flags
  FOR EACH ROW EXECUTE FUNCTION raise_immutable();

COMMENT ON TRIGGER answer_flags_append_only ON answer_flags IS
  'S09-03: a flag is a statement by a person at a time. It cannot be rewritten or withdrawn, so the count of them stays trustworthy.';

-- The detail view asks "which of these runs are flagged?" for a whole
-- conversation at once, so it reads by run id and groups in one pass.
CREATE INDEX answer_flags_by_run
  ON answer_flags (org_id, property_id, ai_run_id, created_at);

-- And the review surface (S09-04) will want "the most-flagged answers first",
-- which is a count over runs rather than a lookup by one.
CREATE INDEX answer_flags_recent
  ON answer_flags (property_id, created_at DESC);
