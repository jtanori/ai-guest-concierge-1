import type pg from "pg";
import { FIXTURE_ARTICLES, FIXTURE_FACTS } from "../fixtures/fixture-hotel.ts";
import { assertChunkShape, chunkBody } from "../knowledge/chunk.ts";
import { DEFAULT_SETTINGS, mergeSettings } from "../settings/schema.ts";
import { stubEmbedding } from "./embedding.ts";
import {
  DEMO_GAP_ID,
  DEMO_ORG_ID,
  DEMO_PROPERTY_ID,
  DEMO_SOURCE_ID,
  DEMO_STAFF,
  stableUuid,
} from "./ids.ts";

export interface SeedSummary {
  orgs: number;
  properties: number;
  users: number;
  memberships: number;
  knowledge_sources: number;
  knowledge_articles: number;
  article_versions: number;
  property_facts: number;
  knowledge_gaps: number;
  /** S04-02: rows written for the fixture's published versions. */
  article_chunks: number;
}

const BRAND_SCOPED = new Set(["art-pool-website"]);
const TOPICS = [...new Set(FIXTURE_ARTICLES.map((article) => article.topicKey))];
const SETTINGS = mergeSettings(DEFAULT_SETTINGS, { enabled_topics: TOPICS });

const SUMMARY: SeedSummary = {
  orgs: 1,
  properties: 1,
  users: DEMO_STAFF.length,
  memberships: DEMO_STAFF.length,
  knowledge_sources: 1,
  knowledge_articles: FIXTURE_ARTICLES.length,
  article_versions: FIXTURE_ARTICLES.length,
  property_facts: FIXTURE_FACTS.length,
  knowledge_gaps: 1,
  // Filled as chunks are written; a fixture body change changes the count.
  article_chunks: 0,
};

function vectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}

async function setTenant(client: pg.Client): Promise<void> {
  await client.query("SELECT set_config('app.current_org_id', $1, true)", [DEMO_ORG_ID]);
  await client.query("SELECT set_config('app.current_property_id', $1, true)", [DEMO_PROPERTY_ID]);
}

async function withMembershipRole<T>(
  client: pg.Client,
  fn: () => Promise<T>,
): Promise<T> {
  const membership = await client.query<{ member: boolean }>(
    "SELECT pg_has_role(current_user, 'concierge_membership', 'MEMBER') AS member",
  );
  const needsGrant = !membership.rows[0]!.member;

  await client.query("SAVEPOINT seed_identity");
  try {
    if (needsGrant) await client.query("GRANT concierge_membership TO CURRENT_USER");
    await client.query("SET LOCAL ROLE concierge_membership");
    const result = await fn();
    await client.query("RESET ROLE");
    if (needsGrant) await client.query("REVOKE concierge_membership FROM CURRENT_USER");
    await client.query("RELEASE SAVEPOINT seed_identity");
    return result;
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT seed_identity");
    await client.query("RESET ROLE");
    await client.query("RELEASE SAVEPOINT seed_identity");
    throw error;
  }
}

export async function seedDemo(client: pg.Client): Promise<SeedSummary> {
  await client.query("SET LOCAL ROLE concierge_app");
  await setTenant(client);

  await client.query(
    `INSERT INTO organizations (org_id, name, slug)
     VALUES ($1, 'Hotel Casa Mesa', 'demo')
     ON CONFLICT (org_id) DO UPDATE SET name = EXCLUDED.name`,
    [DEMO_ORG_ID],
  );

  await client.query(
    `INSERT INTO properties
       (org_id, property_id, name, slug, time_zone, ai_mode, languages, settings)
     VALUES ($1, $2, 'Hotel Casa Mesa - adversarial fixture', 'demo',
             'America/Mexico_City', 'auto', '{es,en}'::text[], $3::jsonb)
     ON CONFLICT (property_id) DO UPDATE
       SET name = EXCLUDED.name,
           time_zone = EXCLUDED.time_zone,
           ai_mode = EXCLUDED.ai_mode,
           languages = EXCLUDED.languages,
           settings = EXCLUDED.settings`,
    [DEMO_ORG_ID, DEMO_PROPERTY_ID, JSON.stringify(SETTINGS)],
  );

  await client.query("RESET ROLE");

  await withMembershipRole(client, async () => {
    for (const staff of DEMO_STAFF) {
      await client.query(
        `INSERT INTO users (user_id, neon_auth_user_id, email, display_name)
         VALUES ($1, NULL, $2, $3)
         ON CONFLICT (user_id) DO NOTHING`,
        [staff.userId, staff.email, staff.displayName],
      );
    }
    for (const staff of DEMO_STAFF) {
      await client.query(
        `INSERT INTO memberships (membership_id, user_id, property_id, role_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, property_id) DO NOTHING`,
        [stableUuid(`membership:${staff.key}`), staff.userId, DEMO_PROPERTY_ID, staff.roleId],
      );
    }
  });

  await client.query("SET LOCAL ROLE concierge_app");
  await setTenant(client);

  await client.query(
    `INSERT INTO knowledge_sources (source_id, org_id, property_id, kind, title)
     VALUES ($1, $2, $3, 'manual', 'Demo property manual')
     ON CONFLICT (source_id) DO NOTHING`,
    [DEMO_SOURCE_ID, DEMO_ORG_ID, DEMO_PROPERTY_ID],
  );

  for (const article of FIXTURE_ARTICLES) {
    const articleId = stableUuid(`article:${article.articleId}`);
    const scope = BRAND_SCOPED.has(article.articleId) ? "brand" : "property";

    await client.query(
      `INSERT INTO knowledge_articles
         (article_id, org_id, property_id, source_id, scope, topic_key, title, language)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (article_id) DO NOTHING`,
      [
        articleId,
        DEMO_ORG_ID,
        DEMO_PROPERTY_ID,
        DEMO_SOURCE_ID,
        scope,
        article.topicKey,
        article.title,
        article.language,
      ],
    );

    await client.query(
      `INSERT INTO article_versions
         (article_version_id, org_id, property_id, article_id, version_no, is_current, body, embedding)
       VALUES ($1, $2, $3, $4, 1, false, $5, NULL)
       ON CONFLICT (article_version_id) DO NOTHING`,
      [
        article.articleVersionId,
        DEMO_ORG_ID,
        DEMO_PROPERTY_ID,
        articleId,
        article.body,
      ],
    );

    if (article.body === null) continue;

    await client.query(
      `UPDATE article_versions
          SET embedding = $1::vector
        WHERE article_version_id = $2 AND embedding IS NULL`,
      [vectorLiteral(stubEmbedding(article.body)), article.articleVersionId],
    );

    const version = await client.query<{ is_current: boolean; promoted_at: Date | null }>(
      "SELECT is_current, promoted_at FROM article_versions WHERE article_version_id = $1",
      [article.articleVersionId],
    );
    if (!version.rows[0]!.is_current && version.rows[0]!.promoted_at === null) {
      await client.query("SELECT promote_article_version($1)", [article.articleVersionId]);
    }

    // S04-02: the demo database must satisfy AC-1 ("every is_current version
    // has >= 1 chunk") without an API key, so the fixture is chunked with the
    // same deterministic stub the seed already uses for its whole-body vector.
    // Every fixture article has exactly one version, so there is no retired
    // sibling to clear here; the conflict arm keeps a re-seed a no-op and the
    // ordinal sweep removes chunks left behind by a shortened fixture body.
    const chunks = chunkBody(article.body);
    assertChunkShape(chunks);
    await client.query(
      "DELETE FROM article_chunks WHERE article_version_id = $1 AND ordinal >= $2",
      [article.articleVersionId, chunks.length],
    );
    for (const [ordinal, chunk] of chunks.entries()) {
      await client.query(
        `INSERT INTO article_chunks
           (org_id, property_id, article_version_id, ordinal, body, embedding)
         VALUES ($1, $2, $3, $4, $5, $6::vector)
         ON CONFLICT (article_version_id, ordinal) DO UPDATE
            SET body = EXCLUDED.body, embedding = EXCLUDED.embedding
          WHERE article_chunks.body IS DISTINCT FROM EXCLUDED.body
             OR article_chunks.embedding IS DISTINCT FROM EXCLUDED.embedding`,
        [
          DEMO_ORG_ID,
          DEMO_PROPERTY_ID,
          article.articleVersionId,
          ordinal,
          chunk,
          vectorLiteral(stubEmbedding(chunk)),
        ],
      );
      SUMMARY.article_chunks += 1;
    }
  }

  for (const fact of FIXTURE_FACTS) {
    // S03-03: fact_key is the LOGICAL key (closing_time), not the fixture id,
    // so the two pool rows collide on (topic, fact_key, language,
    // effective_from) and become a real contradiction for listContradictions.
    // The conflict path rewrites the four fields 0009 added so an existing
    // demo database picks them up without a reset; counts stay 5 and an
    // operator's verification is never undone by a seed. The WHERE makes a
    // repeat seed a genuine no-op: a row whose fixture values already match is
    // not written at all (no dead tuple, and nothing for 0009's guard trigger
    // to inspect, so a verified fact is untouched - review round 3).
    await client.query(
      `INSERT INTO property_facts
         (fact_id, org_id, property_id, topic_key, fact_key, fact_value, language,
          unit, effective_from, source_id, source_article_version_id, verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (fact_id) DO UPDATE
          SET fact_key = EXCLUDED.fact_key,
              unit = EXCLUDED.unit,
              effective_from = EXCLUDED.effective_from,
              source_article_version_id = EXCLUDED.source_article_version_id
        WHERE property_facts.fact_key IS DISTINCT FROM EXCLUDED.fact_key
           OR property_facts.unit IS DISTINCT FROM EXCLUDED.unit
           OR property_facts.effective_from IS DISTINCT FROM EXCLUDED.effective_from
           OR property_facts.source_article_version_id
              IS DISTINCT FROM EXCLUDED.source_article_version_id`,
      [
        stableUuid(`fact:${fact.factId}`),
        DEMO_ORG_ID,
        DEMO_PROPERTY_ID,
        fact.topicKey,
        fact.factKey,
        fact.value,
        fact.language,
        fact.unit,
        fact.effectiveFrom,
        DEMO_SOURCE_ID,
        fact.sourceArticleVersionId,
        fact.verified,
      ],
    );
  }

  await client.query(
    `INSERT INTO knowledge_gaps (gap_id, org_id, property_id, question, language, status)
     VALUES ($1, $2, $3, $4, 'es', 'open')
     ON CONFLICT (gap_id) DO NOTHING`,
    [
      DEMO_GAP_ID,
      DEMO_ORG_ID,
      DEMO_PROPERTY_ID,
      "Parking policy article has no extractable text (noticeboard photo)",
    ],
  );

  await client.query("RESET ROLE");
  return SUMMARY;
}
