-- 0020_embed_settings.sql — S07-01: who is allowed to frame the guest chat.
--
-- AC-2 of S07-01 is "a copy-paste <script>/iframe snippet embeds the same chat
-- on the hotel site". An embeddable page is a page inside somebody else's
-- document, which means the property has to be able to say WHICH document. That
-- allowlist is per property — a hotel's own site is not another hotel's — so it
-- is settings, not a constant, and the closed settings contract (0006) plus its
-- first extension (0013) mean adding a key is a migration, not a JSON edit.
--
-- WHY REQUIRED WITH A BACKFILL, EXACTLY LIKE 0013: an absent key would mean
-- "some rows use an implicit allowlist and nobody can tell which". It is
-- backfilled to the EMPTY list, which is the safe default and the honest one:
-- until somebody names an origin, nobody may embed. A default of "*" would
-- quietly turn every property into a frameable page on launch day, which is a
-- clickjacking surface on a chat that can open service requests.
--
-- WHY THE OLD RULES ARE KEPT: 0013's `property_settings_valid_v2` is ~90 lines
-- of per-field rules on top of 0006's ~170. Re-transcribing either — or both —
-- to add one key is how a dropped clause silently weakens `spend_cap` or
-- `business_hours`. So the new validator strips `embed`, hands the rest to v2,
-- and then checks only the new key. The eight pre-existing keys keep behaving
-- byte-for-byte as they shipped.
--
-- WHY THE CONSTRAINT IS REBOUND: a CHECK stores the function OID it was parsed
-- against, not the name (0013's header explains this at length). The constraint
-- is dropped and re-added so it binds to v3; every existing row is therefore
-- validated against the new rules at ADD time, which is why the backfill below
-- must run first.
--
-- RLS NOTE: `properties` is FORCE ROW LEVEL SECURITY, so a migration-time UPDATE
-- is filtered for a plain owner. FORCE is lifted for the backfill and restored
-- before the transaction commits — without it the UPDATE would silently touch
-- zero rows and the ADD CONSTRAINT would fail on any database with real data.

-- 1. Backfill: an empty allowlist, which means "nobody may embed yet".
ALTER TABLE properties NO FORCE ROW LEVEL SECURITY;

UPDATE properties
   SET settings = jsonb_set(settings, '{embed}', '{"allowed_origins": []}'::jsonb, true)
 WHERE settings <> '{}'::jsonb
   AND NOT (settings ? 'embed');

ALTER TABLE properties FORCE ROW LEVEL SECURITY;

-- 2. The validator: everything v2 enforced, plus a required `embed`.
--
-- An origin is `scheme://host[:port]` and nothing else: no path, no trailing
-- slash, no userinfo, no wildcard. Wildcards are refused deliberately — an
-- allowlist of `https://*.example.com` is a list of every subdomain anyone can
-- ever create, including one an attacker registers a CNAME for. A property that
-- needs three origins writes three origins.
CREATE OR REPLACE FUNCTION property_settings_valid_v3(p_settings jsonb, p_ai_mode text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_rest    jsonb;
  v_keys    text[];
  v_origin  jsonb;
  v_seen    text[] := '{}';
  v_value   text;
BEGIN
  IF p_settings IS NULL OR jsonb_typeof(p_settings) IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;

  -- `{}` stays the legacy/unset sentinel: no backfill, parses to defaults.
  IF p_settings = '{}'::jsonb THEN
    RETURN true;
  END IF;

  v_rest := p_settings - 'embed';
  IF v_rest = '{}'::jsonb THEN
    RETURN false;
  END IF;

  IF NOT property_settings_valid_v2(v_rest, p_ai_mode) THEN
    RETURN false;
  END IF;

  IF jsonb_typeof(p_settings->'embed') IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;

  SELECT array_agg(k ORDER BY k) INTO v_keys
    FROM jsonb_object_keys(p_settings->'embed') AS k;
  IF v_keys IS DISTINCT FROM ARRAY['allowed_origins'] THEN
    RETURN false;
  END IF;

  IF jsonb_typeof(p_settings->'embed'->'allowed_origins') IS DISTINCT FROM 'array' THEN
    RETURN false;
  END IF;

  FOR v_origin IN SELECT * FROM jsonb_array_elements(p_settings->'embed'->'allowed_origins') LOOP
    IF jsonb_typeof(v_origin) IS DISTINCT FROM 'string' THEN
      RETURN false;
    END IF;
    v_value := v_origin #>> '{}';

    -- Origin shape: lowercase scheme and host, optional numeric port.
    IF v_value !~ '^https?://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$' THEN
      RETURN false;
    END IF;

    -- Duplicates are a configuration smell, not a security hole, but a list
    -- that contains itself twice cannot be counted on to match a length check.
    IF v_value = ANY (v_seen) THEN
      RETURN false;
    END IF;
    v_seen := v_seen || v_value;
  END LOOP;

  -- A sane ceiling: a property embeds on its own site(s), not on forty.
  IF array_length(v_seen, 1) > 10 THEN
    RETURN false;
  END IF;

  RETURN true;
END;
$$;

COMMENT ON FUNCTION property_settings_valid_v3 IS
  'S07-01: v2 settings plus a required `embed.allowed_origins` list of bare '
  'origins (scheme://host[:port]). Empty means nobody may frame the guest chat.';

-- 3. Rebind the constraint to v3 (see the header).
ALTER TABLE properties DROP CONSTRAINT properties_settings_valid;

ALTER TABLE properties
  ADD CONSTRAINT properties_settings_valid
  CHECK (property_settings_valid_v3(settings, ai_mode));

-- 4. The column DEFAULT from 0013 is a complete object too, so it must carry the
--    new key — otherwise every INSERT that omits `settings` violates the CHECK.
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
    "retrieval_weights": {"lexical": 1, "vector": 1, "trigram": 1},
    "embed": {"allowed_origins": []}
  }'::jsonb;
