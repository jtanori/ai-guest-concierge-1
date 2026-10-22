-- 0001_init.sql — S01-01 — 25-table baseline schema.
-- Plan of record: docs/01-development-plan.md §2 "Data model" lists exactly 25
-- tables; this migration creates them in that order. D2/D3: FTS + trigram +
-- pgvector columns exist from day one. D5: citations point at article_version_id.
-- Constraints are CHECK-based (not enums) so new channels/states stay reversible.
-- RLS policies and the app role are 0002; immutability triggers are 0003.

-- D2/D3: retrieval columns exist on day one, so the extensions must too.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------- Platform ----------

CREATE TABLE organizations (
  org_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  slug            text NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE properties (
  property_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(org_id) ON DELETE RESTRICT,
  name            text NOT NULL,
  slug            text NOT NULL UNIQUE,
  time_zone       text NOT NULL DEFAULT 'UTC',
  -- D6: per-property AI mode. Draft is deliberately rejected by check per plan
  -- §3 "Draft mode is not a pilot operating mode".
  ai_mode         text NOT NULL DEFAULT 'auto'
                  CHECK (ai_mode IN ('auto', 'draft', 'human_only', 'after_hours')),
  languages       text[] NOT NULL DEFAULT '{es,en}',
  settings        jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);

CREATE TABLE users (
  user_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  neon_auth_user_id text UNIQUE,
  email           text NOT NULL UNIQUE,
  display_name    text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  role_id         smallint PRIMARY KEY,
  name            text NOT NULL UNIQUE
);
INSERT INTO roles (role_id, name) VALUES
  (1, 'owner'), (2, 'manager'), (3, 'front_desk'), (4, 'observer'); -- four roles (S02 scope)

CREATE TABLE memberships (
  membership_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  property_id     uuid NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
  role_id         smallint NOT NULL REFERENCES roles(role_id),
  joined_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, property_id)
);

-- ---------- Channels ----------

CREATE TABLE channel_connections (
  channel_connection_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(org_id),
  property_id     uuid NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
  channel         text NOT NULL CHECK (channel IN ('web', 'whatsapp')),
  status          text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'paused', 'disconnected')),
  config          jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, channel)
);

CREATE TABLE channel_identities (
  identity_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(org_id),
  property_id     uuid NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
  connection_id   uuid NOT NULL REFERENCES channel_connections(channel_connection_id) ON DELETE CASCADE,
  external_id     text NOT NULL,
  display_name    text,
  language        text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, external_id)
);

-- ---------- Conversations ----------

CREATE TABLE conversations (
  conversation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(org_id),
  property_id     uuid NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
  connection_id   uuid NOT NULL REFERENCES channel_connections(channel_connection_id),
  identity_id     uuid REFERENCES channel_identities(identity_id),
  language        text,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  message_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(org_id),
  property_id     uuid NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  direction       text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  author_role     text NOT NULL CHECK (author_role IN ('guest', 'ai', 'staff')),
  body            text NOT NULL,
  language        text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_body_trgm ON messages USING gin (body gin_trgm_ops);

CREATE TABLE message_delivery_events (
  delivery_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(org_id),
  property_id     uuid NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
  message_id      uuid NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
  stage           text NOT NULL
                  CHECK (stage IN ('queued', 'sent', 'delivered', 'failed')),
  provider_message_id text,
  occurred_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------- Requests ----------

CREATE TABLE service_requests (
  request_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(org_id),
  property_id     uuid NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(conversation_id) ON DELETE SET NULL,
  topic           text,
  status          text NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new', 'acknowledged', 'assigned', 'resolved', 'cancelled')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  resolved_at     timestamptz
);

CREATE TABLE assignments (
  assignment_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(org_id),
  property_id     uuid NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
  request_id      uuid NOT NULL REFERENCES service_requests(request_id) ON DELETE CASCADE,
  assigned_to     uuid NOT NULL REFERENCES users(user_id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE internal_notes (
  note_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(org_id),
  property_id     uuid NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  request_id      uuid REFERENCES service_requests(request_id) ON DELETE CASCADE,
  author_user_id  uuid NOT NULL REFERENCES users(user_id),
  body            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (conversation_id IS NOT NULL OR request_id IS NOT NULL)
);

-- ---------- Knowledge ----------

CREATE TABLE knowledge_sources (
  source_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(org_id),
  property_id     uuid NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('manual', 'csv', 'web', 'pdf')),
  title           text NOT NULL,
  url             text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_articles (
  article_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(org_id),
  property_id     uuid NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
  source_id       uuid REFERENCES knowledge_sources(source_id) ON DELETE SET NULL,
  -- content inheritance (plan §2): property rows override brand rows on topic_key
  scope           text NOT NULL CHECK (scope IN ('brand', 'property')),
  topic_key       text NOT NULL,
  title           text NOT NULL,
  language        text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (topic_key, scope, property_id)
);

CREATE TABLE article_versions (
  article_version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(org_id),
  property_id     uuid NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
  article_id      uuid NOT NULL REFERENCES knowledge_articles(article_id) ON DELETE CASCADE,
  version_no      integer NOT NULL,
  body            text NOT NULL,
  embedding       vector(1536),
  tsv             tsvector GENERATED ALWAYS AS (to_tsvector('simple', body)) STORED,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (article_id, version_no)
);
CREATE INDEX article_versions_tsv ON article_versions USING gin (tsv);
CREATE INDEX article_versions_trgm ON article_versions USING gin (body gin_trgm_ops);
CREATE INDEX article_versions_emb ON article_versions USING hnsw (embedding vector_cosine_ops);

CREATE TABLE property_facts (
  fact_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(org_id),
  property_id     uuid NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
  topic_key       text NOT NULL,
  fact_key        text NOT NULL,
  fact_value      text NOT NULL,
  language        text NOT NULL DEFAULT 'es',
  source_id       uuid REFERENCES knowledge_sources(source_id) ON DELETE SET NULL,
  verified        boolean NOT NULL DEFAULT false,
  embedding       vector(1536),
  tsv             tsvector GENERATED ALWAYS AS (to_tsvector('simple', fact_value)) STORED,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, topic_key, fact_key, language)
);
CREATE INDEX property_facts_tsv ON property_facts USING gin (tsv);
CREATE INDEX property_facts_emb ON property_facts USING hnsw (embedding vector_cosine_ops);

-- ---------- AI ----------

CREATE TABLE ai_runs (
  ai_run_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(org_id),
  property_id     uuid NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  message_id      uuid REFERENCES messages(message_id) ON DELETE SET NULL,
  model_id        text NOT NULL,
  prompt_version  text NOT NULL,
  decision        text NOT NULL CHECK (decision IN ('answer', 'escalate', 'no_answer')),
  reason_code     text,
  confidence      numeric(3, 2) CHECK (confidence >= 0 AND confidence <= 1),
  latency_ms      integer,
  usage           jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE citations (
  citation_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(org_id),
  property_id     uuid NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
  ai_run_id       uuid NOT NULL REFERENCES ai_runs(ai_run_id) ON DELETE CASCADE,
  -- D5: cite the version, not the article.
  article_version_id uuid NOT NULL REFERENCES article_versions(article_version_id) ON DELETE RESTRICT
);

CREATE TABLE handoff_reasons (
  handoff_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(org_id),
  property_id     uuid NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  reason_code     text NOT NULL,
  detail          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_gaps (
  gap_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(org_id),
  property_id     uuid NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(conversation_id) ON DELETE SET NULL,
  question        text NOT NULL,
  language        text,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz
);

-- ---------- Cross-cutting ----------

-- Appendix C v1.2.1: exactly 18 events, in this order.
CREATE TABLE events (
  event_id        bigserial PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES organizations(org_id),
  property_id     uuid NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  channel         text NOT NULL CHECK (channel IN ('web', 'whatsapp')),
  language        text,
  topic           text,
  event_type      text NOT NULL CHECK (event_type IN (
    'conversation_started', 'message_received', 'ai_run_completed',
    'ai_answer_sent', 'ai_escalated', 'no_answer_emitted', 'human_takeover',
    'staff_message_sent', 'request_created', 'request_acknowledged',
    'request_assigned', 'request_resolved', 'answer_flagged_wrong',
    'knowledge_gap_created', 'knowledge_gap_closed', 'booking_link_clicked',
    'outbound_webhook_delivered', 'message_failed')),
  payload         jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_property_time ON events (property_id, created_at DESC);
CREATE INDEX events_type ON events (event_type, created_at DESC);

CREATE TABLE rollups (
  rollup_id       bigserial PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES organizations(org_id),
  property_id     uuid NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
  metric          text NOT NULL,
  granularity     text NOT NULL DEFAULT 'daily' CHECK (granularity IN ('daily', 'weekly')),
  window_start    date NOT NULL,
  value           numeric NOT NULL,
  generated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, metric, window_start, granularity)
);

CREATE TABLE audit_log (
  audit_id        bigserial PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES organizations(org_id),
  property_id     uuid NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
  actor_user_id   uuid REFERENCES users(user_id) ON DELETE SET NULL,
  action          text NOT NULL,
  entity_type     text NOT NULL,
  entity_id       text NOT NULL,
  detail          jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_property_time ON audit_log (property_id, created_at DESC);

-- D7: transactional outbox; the DLQ is the 'dead' terminal state.
CREATE TABLE outbox (
  outbox_id       bigserial PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES organizations(org_id),
  property_id     uuid NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('provider_message', 'webhook', 'email', 'sms')),
  payload         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'dead')),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz
);
CREATE INDEX outbox_pending ON outbox (status, next_attempt_at)
  WHERE status IN ('pending', 'failed');
