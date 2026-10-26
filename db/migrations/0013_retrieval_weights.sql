-- 0013_retrieval_weights.sql — S04-03: fusion weights become property
-- settings, REQUIRED and backfilled (operator decision 2026-10-25).
--
-- WHY SETTINGS AT ALL: the three candidate lists S04-03 fuses fail in
-- different ways. Lexical (tsvector) is exact but brittle to Spanish
-- inflection ("cerrar" vs "cierra"); trigram survives typos and accents;
-- vector survives paraphrase. Which one dominates is a per-property editorial
-- judgement — a spa whose guests ask in English over Spanish content wants
-- different weights from a city hotel — so it is a setting, not a constant.
--
-- WHY REQUIRED WITH A BACKFILL: an absent key would mean "some row uses an
-- implicit default and nobody can tell which". The contract is closed and
-- exact-key (0006), so the new key is required and every existing row is
-- rewritten to the neutral default (1,1,1 = plain RRF).
--
-- HOW THE OLD RULES ARE KEPT: 0006's validator is ~170 lines of per-field
-- rules. Rather than re-transcribe them — a single dropped clause would
-- silently weaken every other field — it stays in place untouched, and a new
-- `property_settings_valid_v2` validates `p_settings - 'retrieval_weights'`
-- with it before checking the new key. The six pre-existing keys therefore
-- behave byte-for-byte as 0006 shipped.
--
-- WHY THE CONSTRAINT IS REBOUND RATHER THAN THE FUNCTION REPLACED: a CHECK
-- constraint stores the *function OID* it was parsed against, not its name.
-- Renaming `property_settings_valid` (the obvious move) leaves the constraint
-- pointing at the renamed function, so the table silently keeps enforcing the
-- OLD rules while a shiny new function sits unused beside it. This migration
-- therefore DROPs and re-ADDs the constraint so the expression binds to the
-- new validator. That also means the new rules are checked against every
-- existing row at ADD time — which is exactly the proof VALIDATE would give,
-- and it makes the backfill order below load-bearing.
--
-- RLS NOTE: `properties` is FORCE ROW LEVEL SECURITY, so a migration-time
-- UPDATE is filtered for a plain owner (exactly what 0006's header warns
-- about). The backfill therefore lifts FORCE for the duration of this
-- transaction and restores it before the transaction commits; without that,
-- a non-superuser migration would silently update zero rows and the VALIDATE
-- below would fail on a database that has real settings.

-- 1. Backfill every complete settings object with the neutral default.
--    `{}` rows stay `{}`: they mean "unset" and keep parsing to defaults.
--    Doing this first is what lets step 4's ADD CONSTRAINT validate.
ALTER TABLE properties NO FORCE ROW LEVEL SECURITY;

UPDATE properties
   SET settings = jsonb_set(
         settings,
         '{retrieval_weights}',
         '{"lexical": 1, "vector": 1, "trigram": 1}'::jsonb,
         true)
 WHERE settings <> '{}'::jsonb
   AND NOT (settings ? 'retrieval_weights');

ALTER TABLE properties FORCE ROW LEVEL SECURITY;

-- 2. The new validator: 0006's contract on everything except the new key, plus
--    a required, well-shaped `retrieval_weights`.
CREATE OR REPLACE FUNCTION property_settings_valid_v2(p_settings jsonb, p_ai_mode text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_rest      jsonb;
  v_keys      text[];
  v_lexical   text;
  v_vector    text;
  v_trigram   text;
BEGIN
  IF p_settings IS NULL OR jsonb_typeof(p_settings) IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;

  -- `{}` is 0006's legacy/unset sentinel: no backfill, parses to defaults.
  IF p_settings = '{}'::jsonb THEN
    RETURN true;
  END IF;

  v_rest := p_settings - 'retrieval_weights';

  -- A settings object that carries ONLY the new key is not a complete object.
  IF v_rest = '{}'::jsonb THEN
    RETURN false;
  END IF;

  -- Everything 0006 enforced, unchanged, over the six original keys.
  IF NOT property_settings_valid(v_rest, p_ai_mode) THEN
    RETURN false;
  END IF;

  -- The new key: an object with exactly the three weights, each a finite
  -- non-negative number, and at least one of them positive (an all-zero
  -- weight vector would make every score 0 and the ranking arbitrary).
  IF jsonb_typeof(p_settings->'retrieval_weights') IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;

  SELECT array_agg(k ORDER BY k) INTO v_keys
    FROM jsonb_object_keys(p_settings->'retrieval_weights') AS k;
  IF v_keys IS DISTINCT FROM ARRAY['lexical', 'trigram', 'vector'] THEN
    RETURN false;
  END IF;

  IF jsonb_typeof(p_settings->'retrieval_weights'->'lexical') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_settings->'retrieval_weights'->'vector') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_settings->'retrieval_weights'->'trigram') IS DISTINCT FROM 'number' THEN
    RETURN false;
  END IF;

  v_lexical := p_settings->'retrieval_weights'->>'lexical';
  v_vector  := p_settings->'retrieval_weights'->>'vector';
  v_trigram := p_settings->'retrieval_weights'->>'trigram';

  -- `::numeric` parsing also rejects 'NaN'/'Infinity' written as strings, and
  -- the regex keeps a numeric-looking string from passing as a number.
  IF v_lexical !~ '^[0-9]+(\.[0-9]+)?$'
     OR v_vector !~ '^[0-9]+(\.[0-9]+)?$'
     OR v_trigram !~ '^[0-9]+(\.[0-9]+)?$' THEN
    RETURN false;
  END IF;

  IF (v_lexical::numeric + v_vector::numeric + v_trigram::numeric) <= 0 THEN
    RETURN false;
  END IF;

  RETURN true;
END;
$$;

-- 3. Rebind the constraint to the new validator (see the header: a CHECK keeps
--    the OID it was parsed against, so a rename would silently keep the old
--    rules). The name is preserved for every test and reader that looks it up.
ALTER TABLE properties DROP CONSTRAINT properties_settings_valid;

ALTER TABLE properties
  ADD CONSTRAINT properties_settings_valid
  CHECK (property_settings_valid_v2(settings, ai_mode));

-- 4. The column DEFAULT from 0006 is a complete object too, so it must carry
--    the new key — otherwise every INSERT that omits `settings` violates the
--    CHECK it was written to satisfy.
ALTER TABLE properties
  ALTER COLUMN settings SET DEFAULT '{
    "tone": "warm_professional",
    "business_hours": [
      {"day": 0, "closed": false, "open": "08:00", "close": "22:00"},
      {"day": 1, "closed": false, "open": "08:00", "close": "22:00"},
      {"day": 2, "closed": false, "open": "08:00", "close": "22:00"},
      {"day": 3, "closed": false, "open": "08:00", "close": "22:00"},
      {"day": 4, "closed": false, "open": "08:00", "close": "22:00"},
      {"day": 5, "closed": false, "open": "08:00", "close": "22:00"},
      {"day": 6, "closed": false, "open": "08:00", "close": "22:00"}
    ],
    "escalation": {"contacts": []},
    "enabled_topics": [],
    "spend_cap": {"daily_usd": 10, "per_conversation_usd": 0.5},
    "retention_days": 90,
    "retrieval_weights": {"lexical": 1, "vector": 1, "trigram": 1}
  }'::jsonb;

COMMENT ON COLUMN properties.settings IS
  'S02-02 closed settings contract, extended by S04-03 with required '
  'retrieval_weights (fusion weights for hybrid retrieval). {} means '
  'legacy/unset and parses to defaults; any other value must be complete. '
  'Validated by property_settings_valid_v2(settings, ai_mode) — which delegates '
  'the six original keys to property_settings_valid() — and mirrored by '
  'src/settings/schema.ts.';
