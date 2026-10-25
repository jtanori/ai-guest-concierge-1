-- 0009_property_facts.sql - S03-03: verified, effective-dated facts.
--
-- Hours and prices are data, not prose: the answer to "a que hora cierra la
-- alberca" comes from lookupFact (a verified row), never from the model. 0001
-- gave property_facts only the value, the language and a bare `verified`
-- flag, so nothing recorded WHO verified a fact, WHEN the value takes effect,
-- or WHICH article version it came from (D5's citation link).
--
-- The constraints added here are the integrity half of the service:
--   unit              a closed set, so a closing time is never stored as
--                     arbitrary prose
--   verified_fields   "verified" must name its verifier, its time and its
--                     effective date, or the word means nothing
--   source_version    tenant-composite FK, so a fact can only cite a version
--                     of the same (org, property)
--
-- WHY THE 0001 UNIQUE IS DROPPED: contradiction detection needs two rows with
-- the same key AND the same effective date to coexist - that is exactly what
-- the fixture's pool pair is (21:00 vs 20:00, both closing_time, both
-- 2026-01-01). UNIQUE (property_id, topic_key, fact_key, language) would make
-- the second row impossible, and a different effective_from would hide the
-- pair from listContradictions, whose group key includes effective_from.
-- verifyFact is what refuses the second value; a partial unique index keeps
-- the stronger promise for rows that ARE verified - at most one verified
-- value per key and effective date - while unverified rows stay free to
-- coexist so the contradiction queue can show them. Operator-approved
-- 2026-10-25 (review on PR #32); the charter was amended in the same PR.
--
-- WHY THE CHECK IS NOT VALID: ADD CONSTRAINT ... CHECK validates existing
-- rows, and a pre-0009 verified row has effective_from = NULL (the column did
-- not exist), so a validated CHECK would abort this migration on any database
-- that already verified a fact - before the seed's ON CONFLICT backfill could
-- run. NOT VALID keeps the promise for every row written from now on while
-- leaving legacy verified rows for an operator to re-verify or unverify; they
-- are invisible to lookupFact anyway (effective_from NULL never satisfies
-- `effective_from <= on`). tests/db/facts.db.test.ts asserts convalidated.
--
-- WHY VERIFIED IS DEFENDED IN THE DATABASE: `concierge_app` holds UPDATE on
-- this table (0002), so without a guard any service call, bug or injection
-- could flip verified itself - publishing an un-reviewed value that
-- lookupFact would then answer as human-confirmed, with no actor, no
-- contradiction check and no audit row. 0003 solved the same class for
-- article_versions.is_current with a NOLOGIN definer role, and that is the
-- pattern reused here:
--
--   1. property_facts_guard_verification() (BEFORE INSERT OR UPDATE)
--      - any change to the fact's content or citation resets
--        verified/verified_by/verified_at, whatever the role, so raw SQL can
--        never mutate a value and keep its verification;
--      - verified=false rows never carry a stamp;
--      - false -> true, and any rewrite of the stamp, is refused unless
--        current_user IS concierge_fact_verifier.
--   2. verify_property_fact(fact_id, actor) is SECURITY DEFINER under that
--      role: it refuses an actor who is not the session user
--      (app.current_user_id, set by withStaffSession) or not a member of the
--      property (0004's current_membership_role), then writes verified,
--      verified_by and verified_at in one statement. The migration owner is
--      deliberately NOT left as a member, so neither the login role nor the
--      table owner can reach the trusted context (0004/0005 review rule).
--   3. concierge_app keeps UPDATE on the content/citation columns only;
--      verified, verified_by and verified_at are no longer app-writable at
--      all - defense in depth beneath the trigger, which still guards the
--      owner.
--
-- No backfill UPDATE: tenant tables are FORCE ROW LEVEL SECURITY, so a
-- migration-time UPDATE would silently run without tenant GUCs and touch
-- nothing. Existing rows take the `unit` default ('text') and stay
-- unverified; the demo seed fills the fixture's unit/effective/source-version
-- values on its ON CONFLICT path.

ALTER TABLE property_facts
  ADD COLUMN unit text NOT NULL DEFAULT 'text',
  ADD COLUMN effective_from date,
  ADD COLUMN source_article_version_id uuid,
  ADD COLUMN verified_by uuid REFERENCES users(user_id),
  ADD COLUMN verified_at timestamptz;

ALTER TABLE property_facts
  ADD CONSTRAINT property_facts_unit_check
    CHECK (unit IN ('text', 'time-of-day', 'hours', 'currency-amount',
                    'duration', 'distance', 'count')),
  ADD CONSTRAINT property_facts_verified_fields
    CHECK (verified = false OR (verified_by IS NOT NULL
                                AND verified_at IS NOT NULL
                                AND effective_from IS NOT NULL))
    NOT VALID,
  ADD CONSTRAINT property_facts_source_version_fk
    FOREIGN KEY (org_id, property_id, source_article_version_id)
    REFERENCES article_versions (org_id, property_id, article_version_id)
    ON DELETE SET NULL (source_article_version_id);

-- Two rows must be able to share a key while they still disagree (S03-03
-- AC-2/AC-3); see the note at the top.
ALTER TABLE property_facts
  DROP CONSTRAINT property_facts_property_id_topic_key_fact_key_language_key;

-- At most ONE verified value per key + effective date. Partial, so the
-- unverified contradiction pair above is storable.
CREATE UNIQUE INDEX property_facts_verified_key
  ON property_facts (property_id, topic_key, fact_key, language, effective_from)
  WHERE verified;

-- lookupFact's path: exact key, most recent effective date first, and only
-- verified rows exist to be found - so the index is partial on verified and
-- carries both ORDER BY columns (effective_from DESC, created_at DESC), which
-- lets the ORDER BY ... LIMIT 1 run off the index alone while the
-- unverified variants this file deliberately allows accumulate underneath.
CREATE INDEX property_facts_lookup
  ON property_facts (property_id, topic_key, fact_key, language,
                     effective_from DESC, created_at DESC)
  WHERE verified;

-- ---------- the trusted verification context (0003's pattern) ----------

-- Roles are cluster-scoped (they outlive each test scratch database), so
-- creation is guarded like concierge_app/promoter.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'concierge_fact_verifier') THEN
    CREATE ROLE concierge_fact_verifier NOLOGIN;
  END IF;
END $$;

-- The ownership transfer below needs SET ROLE on the new owner, and a
-- non-superuser migration role (Neon) may only transfer ownership to a role
-- that holds CREATE on the schema (0003/0004 review rule).
GRANT concierge_fact_verifier TO CURRENT_USER;
GRANT CREATE ON SCHEMA public TO concierge_fact_verifier;

CREATE OR REPLACE FUNCTION property_facts_guard_verification() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Content or citation changed: the verification referred to what was there
  -- before, so it is dropped - for every role, including the table owner.
  IF TG_OP = 'UPDATE'
     AND (NEW.topic_key                  IS DISTINCT FROM OLD.topic_key
       OR NEW.fact_key                   IS DISTINCT FROM OLD.fact_key
       OR NEW.fact_value                 IS DISTINCT FROM OLD.fact_value
       OR NEW.language                   IS DISTINCT FROM OLD.language
       OR NEW.unit                       IS DISTINCT FROM OLD.unit
       OR NEW.effective_from             IS DISTINCT FROM OLD.effective_from
       OR NEW.source_id                  IS DISTINCT FROM OLD.source_id
       OR NEW.source_article_version_id  IS DISTINCT FROM OLD.source_article_version_id)
  THEN
    NEW.verified      := false;
    NEW.verified_by   := NULL;
    NEW.verified_at   := NULL;
    RETURN NEW;
  END IF;

  IF NEW.verified THEN
    IF current_user::text <> 'concierge_fact_verifier' THEN
      IF TG_OP = 'UPDATE' AND OLD.verified THEN
        RAISE EXCEPTION 'property_facts.verified_by/verified_at are immutable once verified (only verify_property_fact() writes them; % blocked by db/migrations/0009_property_facts.sql)', TG_OP;
      END IF;
      RAISE EXCEPTION 'property_facts.verified flips true only inside verify_property_fact() (no actor, no contradiction check and no audit row behind a raw UPDATE; blocked by db/migrations/0009_property_facts.sql)';
    END IF;
    RETURN NEW;
  END IF;

  -- Unverified rows carry no stamp: keeps the CHECK satisfiable and stops a
  -- caller from parking a verifier's id next to a value nobody confirmed.
  NEW.verified_by := NULL;
  NEW.verified_at := NULL;
  RETURN NEW;
END $$;

CREATE TRIGGER property_facts_guard_verification
  BEFORE INSERT OR UPDATE ON property_facts
  FOR EACH ROW EXECUTE FUNCTION property_facts_guard_verification();

-- The privileged write. SECURITY DEFINER means current_user inside it is
-- concierge_fact_verifier, which is what the trigger honors; everything else
-- is refused. Tenant context comes from the withTenant GUCs (RLLS cannot be
-- relied on here - the definer role has an all-rows policy below) and the
-- actor is pinned to the session identity, never to a request field.
CREATE OR REPLACE FUNCTION verify_property_fact(p_fact_id uuid, p_actor uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org     uuid := uuid(nullif(current_setting('app.current_org_id', true), ''));
  v_prop    uuid := uuid(nullif(current_setting('app.current_property_id', true), ''));
  v_session uuid := uuid(nullif(current_setting('app.current_user_id', true), ''));
BEGIN
  IF v_org IS NULL OR v_prop IS NULL THEN
    RAISE EXCEPTION 'verify_property_fact: requires the tenant context (app.current_org_id / app.current_property_id)';
  END IF;
  IF v_session IS NULL OR v_session IS DISTINCT FROM p_actor THEN
    RAISE EXCEPTION 'verify_property_fact: actor % is not the session user (%)', p_actor, coalesce(v_session::text, 'none');
  END IF;
  IF current_membership_role(v_prop) IS NULL THEN
    RAISE EXCEPTION 'verify_property_fact: user % is not a member of property %', p_actor, v_prop;
  END IF;

  UPDATE property_facts
     SET verified = true,
         verified_by = p_actor,
         verified_at = now()
   WHERE org_id = v_org
     AND property_id = v_prop
     AND fact_id = p_fact_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'verify_property_fact: fact % is not in tenant (%, %)', p_fact_id, v_org, v_prop;
  END IF;
  RETURN true;
END $$;

-- OWNERSHIP first, ACLs after: ALTER ... OWNER discards them and restores
-- EXECUTE FOR PUBLIC, exactly as in 0003/0004.
ALTER FUNCTION verify_property_fact(uuid, uuid) OWNER TO concierge_fact_verifier;
REVOKE EXECUTE ON FUNCTION verify_property_fact(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION verify_property_fact(uuid, uuid) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION verify_property_fact(uuid, uuid) TO concierge_app;
-- The membership probe inside the function is 0004's definer helper; its
-- EXECUTE grant covers concierge_app only, so the verifier needs its own.
GRANT EXECUTE ON FUNCTION current_membership_role(uuid) TO concierge_fact_verifier;

-- All-rows access for the definer context: FORCE RLS applies to every role
-- but a superuser, and the function enforces the tenant itself from the GUCs
-- (the promoter policy in 0003 is the same shape).
CREATE POLICY property_facts_fact_verifier ON property_facts
  FOR ALL TO concierge_fact_verifier
  USING (true) WITH CHECK (true);
GRANT SELECT, UPDATE ON property_facts TO concierge_fact_verifier;

-- The app writes facts, never the verdict: revoke the blanket UPDATE from
-- 0002 and hand back only the content and citation columns. INSERT stays
-- (the trigger refuses verified = true there), SELECT stays (lookup is the
-- point), and the seed's ON CONFLICT path touches only granted columns.
REVOKE UPDATE ON property_facts FROM concierge_app;
GRANT UPDATE (topic_key, fact_key, fact_value, language, unit, effective_from,
              source_id, source_article_version_id)
  ON property_facts TO concierge_app;

-- On Neon the deployed login role IS the migration role, so leaving it a
-- member would make `SET ROLE concierge_fact_verifier` reachable from the
-- application connection (0004/0005 review rule). Only the owner keeps it.
REVOKE concierge_fact_verifier FROM CURRENT_USER;
