/**
 * S04-03 — brand vs property resolution.
 *
 * 0001 gives `knowledge_articles.scope` two values: `brand` (shared content a
 * hotel inherits) and `property` (what this hotel wrote itself). When both
 * cover the same `topic_key`, the property's text wins — not "the better
 * score", because a brand article scoring higher is exactly the case a local
 * team is trying to override. Brand exists to FILL GAPS, never to outvote the
 * hotel that is legally answerable for the answer.
 *
 * Fusion happens before this: hybrid.ts ranks every candidate together, then
 * this module drops the shadowed brand hits. That order matters, because a
 * property hit pushed out of the top-N by a brand hit could never be rescued
 * afterwards.
 */
import type pg from "pg";
import { assertTenantShape, type TenantContext } from "../db/tenant.ts";

export interface ScopedHit {
  articleVersionId: string;
  topicKey: string;
  scope: "brand" | "property";
}

/**
 * Drops every brand hit for a topic the property covers.
 *
 * `coverage` is passed in by the caller because the property's own article can
 * be missing from the retrieved list entirely — the hotel's chunk simply did
 * not score for this question, while the brand's did. That is THE case this
 * rule exists for: a local correction ("the spa closes at 19:00 on holidays")
 * must not be out-voted by generic brand prose just because the guest's
 * phrasing happened to match the brand text. So coverage is a property of the
 * CONTENT, not of the ranking.
 *
 * Where coverage is not supplied (a unit test, or an explicit scope where the
 * brand/property question is already settled in SQL), the rule falls back to
 * what is visible in the list.
 */
export function preferProperty<T extends ScopedHit>(
  hits: readonly T[],
  coverage?: ReadonlySet<string>,
): T[] {
  const propertyTopics = new Set<string>(
    hits.filter((hit) => hit.scope === "property").map((hit) => hit.topicKey),
  );
  for (const topic of coverage ?? []) propertyTopics.add(topic);
  if (propertyTopics.size === 0) return [...hits];
  return hits.filter((hit) => hit.scope === "property" || !propertyTopics.has(hit.topicKey));
}

/**
 * Every topic the property has published content for, current only.
 *
 * Deliberately not scoped by language: a hotel that wrote a Spanish article on
 * pool hours has taken a position on pool hours, and an English brand article
 * should not fill that gap with a different fact.
 */
export async function propertyCoveredTopics(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
): Promise<Set<string>> {
  assertTenantShape(context);
  const result = await client.query<{ topic_key: string }>(
    `SELECT DISTINCT ka.topic_key
       FROM knowledge_articles ka
       JOIN article_versions av
         ON av.article_id = ka.article_id
        AND av.org_id = ka.org_id
        AND av.property_id = ka.property_id
        AND av.is_current
      WHERE ka.org_id = $1
        AND ka.property_id = $2
        AND ka.scope = 'property'`,
    [context.orgId, context.propertyId],
  );
  return new Set(result.rows.map((row) => row.topic_key));
}

/**
 * The winning hits for one topic: property-scoped if any exist, otherwise
 * brand. The charter's shape, kept because S05 resolves a topic before it
 * generates an answer and should not re-implement the rule.
 */
export function resolveTopic<T extends ScopedHit>(
  _context: TenantContext,
  topicKey: string,
  hits: readonly T[],
): T[] {
  const forTopic = hits.filter((hit) => hit.topicKey === topicKey);
  const property = forTopic.filter((hit) => hit.scope === "property");
  return property.length > 0 ? property : forTopic;
}
