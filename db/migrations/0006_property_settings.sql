-- 0006_property_settings.sql - S02-02: validated property settings.
--
-- `properties.settings` becomes a closed, typed contract with safe defaults.
-- `'{}'` stays the legacy/unset sentinel and means "use defaults"; any other
-- value must be complete. The validator is IMMUTABLE and does no table access,
-- so it is safe in a CHECK. The TS parser (src/settings/schema.ts) mirrors the
-- same rules with path-aware errors; the CHECK is the backstop for writes that
-- bypass the app.
--
-- No backfill UPDATE: tenant tables are FORCE ROW LEVEL SECURITY and a
-- migration-time UPDATE would be filtered without tenant GUCs. Legacy `'{}'`
-- rows remain valid and parse to defaults.

CREATE OR REPLACE FUNCTION property_settings_valid(p_settings jsonb, p_ai_mode text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_day jsonb;
  v_contact jsonb;
  v_days integer[] := '{}';
  v_open_days integer := 0;
  v_keys text[];
  v_number text;
BEGIN
  IF p_settings IS NULL OR jsonb_typeof(p_settings) IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;

  IF p_settings = '{}'::jsonb THEN
    RETURN true;
  END IF;

  SELECT array_agg(k ORDER BY k) INTO v_keys FROM jsonb_object_keys(p_settings) AS k;
  IF v_keys IS DISTINCT FROM ARRAY[
       'business_hours', 'enabled_topics', 'escalation',
       'retention_days', 'spend_cap', 'tone'
     ] THEN
    RETURN false;
  END IF;

  IF jsonb_typeof(p_settings->'tone') IS DISTINCT FROM 'string' THEN
    RETURN false;
  END IF;
  IF p_settings->>'tone' NOT IN ('warm_professional', 'concise', 'formal') THEN
    RETURN false;
  END IF;

  IF jsonb_typeof(p_settings->'business_hours') IS DISTINCT FROM 'array' THEN
    RETURN false;
  END IF;
  IF jsonb_array_length(p_settings->'business_hours') <> 7 THEN
    RETURN false;
  END IF;

  FOR v_day IN SELECT * FROM jsonb_array_elements(p_settings->'business_hours') LOOP
    IF jsonb_typeof(v_day) IS DISTINCT FROM 'object' THEN
      RETURN false;
    END IF;
    IF NOT (v_day ? 'day') OR NOT (v_day ? 'closed') THEN
      RETURN false;
    END IF;
    IF jsonb_typeof(v_day->'day') IS DISTINCT FROM 'number'
       OR jsonb_typeof(v_day->'closed') IS DISTINCT FROM 'boolean'
       OR (v_day->>'day') !~ '^[0-6]$' THEN
      RETURN false;
    END IF;

    IF (v_day->>'closed')::boolean THEN
      IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(v_day) AS k)
         IS DISTINCT FROM ARRAY['closed', 'day'] THEN
        RETURN false;
      END IF;
    ELSE
      IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(v_day) AS k)
         IS DISTINCT FROM ARRAY['close', 'closed', 'day', 'open'] THEN
        RETURN false;
      END IF;
      IF jsonb_typeof(v_day->'open') IS DISTINCT FROM 'string'
         OR jsonb_typeof(v_day->'close') IS DISTINCT FROM 'string' THEN
        RETURN false;
      END IF;
      IF (v_day->>'open') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
         OR (v_day->>'close') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
         OR (v_day->>'open') >= (v_day->>'close') THEN
        RETURN false;
      END IF;
      v_open_days := v_open_days + 1;
    END IF;

    v_days := v_days || (v_day->>'day')::integer;
  END LOOP;

  -- Unique and sorted: the seven days must appear exactly once, in order.
  IF v_days IS DISTINCT FROM ARRAY[0, 1, 2, 3, 4, 5, 6] THEN
    RETURN false;
  END IF;

  IF p_ai_mode = 'after_hours' AND v_open_days = 0 THEN
    RETURN false;
  END IF;

  IF jsonb_typeof(p_settings->'escalation') IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;
  IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_settings->'escalation') AS k)
     IS DISTINCT FROM ARRAY['contacts'] THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(p_settings->'escalation'->'contacts') IS DISTINCT FROM 'array' THEN
    RETURN false;
  END IF;

  FOR v_contact IN SELECT * FROM jsonb_array_elements(p_settings->'escalation'->'contacts') LOOP
    IF jsonb_typeof(v_contact) IS DISTINCT FROM 'object' THEN
      RETURN false;
    END IF;
    IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(v_contact) AS k)
       IS DISTINCT FROM ARRAY['channel', 'name', 'value'] THEN
      RETURN false;
    END IF;
    IF jsonb_typeof(v_contact->'name') IS DISTINCT FROM 'string'
       OR length(v_contact->>'name') = 0 THEN
      RETURN false;
    END IF;
    IF jsonb_typeof(v_contact->'value') IS DISTINCT FROM 'string'
       OR length(v_contact->>'value') = 0 THEN
      RETURN false;
    END IF;
    IF jsonb_typeof(v_contact->'channel') IS DISTINCT FROM 'string'
       OR v_contact->>'channel' NOT IN ('in_app', 'email') THEN
      RETURN false;
    END IF;
  END LOOP;

  IF jsonb_typeof(p_settings->'enabled_topics') IS DISTINCT FROM 'array' THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_settings->'enabled_topics') AS topic
     WHERE jsonb_typeof(topic) IS DISTINCT FROM 'string'
        OR length(topic #>> '{}') = 0
  ) THEN
    RETURN false;
  END IF;

  IF jsonb_typeof(p_settings->'spend_cap') IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;
  IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_settings->'spend_cap') AS k)
     IS DISTINCT FROM ARRAY['daily_usd', 'per_conversation_usd'] THEN
    RETURN false;
  END IF;

  FOR v_number IN
    SELECT p_settings->'spend_cap'->>k
      FROM unnest(ARRAY['daily_usd', 'per_conversation_usd']) AS keys(k)
  LOOP
    IF v_number IS NULL
       OR v_number !~ '^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$'
       OR v_number::numeric <= 0 THEN
      RETURN false;
    END IF;
  END LOOP;

  IF jsonb_typeof(p_settings->'retention_days') IS DISTINCT FROM 'number' THEN
    RETURN false;
  END IF;
  v_number := p_settings->>'retention_days';
  IF v_number !~ '^[0-9]{1,4}$' OR v_number::integer < 1 OR v_number::integer > 3650 THEN
    RETURN false;
  END IF;

  RETURN true;
END;
$$;

ALTER TABLE properties
  ADD CONSTRAINT properties_settings_valid
  CHECK (property_settings_valid(settings, ai_mode));

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
    "retention_days": 90
  }'::jsonb;

ALTER TABLE properties
  ADD CONSTRAINT properties_languages_supported
  CHECK (cardinality(languages) > 0 AND languages <@ ARRAY['es', 'en']::text[]);

COMMENT ON COLUMN properties.settings IS
  'S02-02 closed settings contract. {} means legacy/unset and parses to defaults; '
  'any other value must be complete. Validated by property_settings_valid(settings, ai_mode) '
  'and mirrored by src/settings/schema.ts.';
