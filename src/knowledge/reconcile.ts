/**
 * S11-05 — three invariants that decide whether a guest can be quoted deleted policy.
 *
 * Retrieval reads `article_chunks`; citations point at `article_versions`. The two
 * are written by different steps of the publish path (chunk + embed, then promote), so
 * they can disagree — and every disagreement has the same shape of consequence: a
 * guest is answered from text the hotel no longer stands behind, or is not answered
 * from text it does.
 *
 *  1. **`current_version_without_chunks`** — the live version of an article has no
 *     chunks. Retrieval is chunk-based (S04-02), so this article is effectively
 *     invisible: the hotel wrote the policy and the assistant cannot find it. It is
 *     the failure that looks like "the bot doesn't know" and is nothing of the kind.
 *  2. **`chunk_on_non_current_version`** — a chunk hangs off a superseded version.
 *     `promote_article_version` flips `is_current` and does **not** delete the old
 *     version's chunks, so this is the live risk: the guest is quoted yesterday's
 *     policy while the current one says something else. Exactly "a deleted policy,
 *     one publish too late".
 *  3. **`chunk_without_parent_version`** — a chunk with no version row at all. The FK
 *     is `ON DELETE CASCADE`, so this cannot happen while that constraint exists; the
 *     assertion is here to fail if a migration ever drops the cascade or an import
 *     path writes around it. It is cheap, and "structurally impossible" is a claim
 *     that should be checked rather than remembered.
 *
 * ## Never repair, always fail
 *
 * The charter is explicit and right: this reports, it does not fix. A reconciler that
 * silently deletes a stale chunk hides the broken publish path that produced it, and
 * the next publish is broken in the same way with nobody watching. A non-zero exit
 * plus a named violation is the product: somebody looks, and fixes the cause.
 *
 * ## Scoped per property
 *
 * Every query takes the tenant from the context and repeats it in the predicate as
 * well as relying on FORCE RLS — the same belt-and-braces the rest of the codebase
 * uses, so the query is correct on a connection that never set a role.
 */
import type pg from "pg";
import { withTenant, type TenantContext } from "../db/tenant.ts";
import { incrementCounter } from "../metrics/counters.ts";

export const EMBEDDING_INVARIANTS = [
  "current_version_without_chunks",
  "chunk_on_non_current_version",
  "chunk_without_parent_version",
] as const;

export type EmbeddingInvariant = (typeof EMBEDDING_INVARIANTS)[number];

export interface EmbeddingViolation {
  invariant: EmbeddingInvariant;
  /** The version the violation is about (the orphan's dangling id in invariant 3). */
  articleVersionId: string;
  /** Set for the two chunk-based invariants. */
  chunkId: string | null;
}

export interface EmbeddingReconcileResult {
  propertyId: string;
  violations: EmbeddingViolation[];
  ok: boolean;
  byInvariant: Record<EmbeddingInvariant, number>;
}

interface ViolationRow {
  article_version_id: string;
  chunk_id: string | null;
}

const QUERIES: Record<EmbeddingInvariant, string> = {
  current_version_without_chunks: `
    SELECT av.article_version_id, NULL::uuid AS chunk_id
      FROM article_versions av
     WHERE av.org_id = $1 AND av.property_id = $2
       AND av.is_current
       AND NOT EXISTS (
         SELECT 1 FROM article_chunks c
          WHERE c.org_id = $1 AND c.property_id = $2
            AND c.article_version_id = av.article_version_id
       )
     ORDER BY av.article_version_id`,
  chunk_on_non_current_version: `
    SELECT c.article_version_id, c.chunk_id
      FROM article_chunks c
      JOIN article_versions av
        ON av.org_id = c.org_id AND av.property_id = c.property_id
       AND av.article_version_id = c.article_version_id
     WHERE c.org_id = $1 AND c.property_id = $2
       AND NOT av.is_current
     ORDER BY c.article_version_id, c.ordinal`,
  chunk_without_parent_version: `
    SELECT c.article_version_id, c.chunk_id
      FROM article_chunks c
     WHERE c.org_id = $1 AND c.property_id = $2
       AND NOT EXISTS (
         SELECT 1 FROM article_versions av
          WHERE av.org_id = c.org_id AND av.property_id = c.property_id
            AND av.article_version_id = c.article_version_id
       )
     ORDER BY c.article_version_id, c.chunk_id`,
};

/**
 * Run all three invariants for one property inside its own tenant transaction.
 *
 * The counter is incremented once per violation with the tenant labels S07-06 allows,
 * so an alert can fire on `embedding_drift_total` without this module inventing a log
 * format. **It has no consumer yet** — see the caveat in the runbook (S11-04 is blocked
 * behind S11-01, which is blocked behind S06-01).
 */
export async function reconcileEmbeddings(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
): Promise<EmbeddingReconcileResult> {
  return withTenant(client, context, async (scoped) => {
    const byInvariant: Record<EmbeddingInvariant, number> = {
      current_version_without_chunks: 0,
      chunk_on_non_current_version: 0,
      chunk_without_parent_version: 0,
    };
    const violations: EmbeddingViolation[] = [];

    for (const invariant of EMBEDDING_INVARIANTS) {
      const result = await scoped.query<ViolationRow>(QUERIES[invariant], [
        context.orgId,
        context.propertyId,
      ]);
      byInvariant[invariant] = result.rows.length;
      for (const row of result.rows) {
        violations.push({
          invariant,
          articleVersionId: row.article_version_id,
          chunkId: row.chunk_id,
        });
        incrementCounter("embedding_drift_total", {
          org_id: context.orgId,
          property_id: context.propertyId,
        });
      }
    }

    return {
      propertyId: context.propertyId,
      violations,
      ok: violations.length === 0,
      byInvariant,
    };
  });
}

/**
 * The failure message, in the form an operator can act on: the invariant, the ids,
 * and nothing else. "Reconciliation failed" would send whoever is paged looking at
 * pgvector settings instead of at the publish path.
 */
export function describeViolations(result: EmbeddingReconcileResult, slug: string): string {
  if (result.ok) return `${slug}: all three invariants hold`;
  return result.violations
    .map((violation) => {
      const target =
        violation.chunkId === null
          ? `article_version ${violation.articleVersionId}`
          : `chunk ${violation.chunkId} → article_version ${violation.articleVersionId}`;
      return `${slug}: ${violation.invariant} (${target})`;
    })
    .join("\n");
}
