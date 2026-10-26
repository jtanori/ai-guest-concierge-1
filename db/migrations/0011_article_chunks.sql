-- 0011_article_chunks.sql — S04-02: every published version is chunked and
-- embedded.
--
-- WHY A SECOND RETRIEVAL LAYER EXISTS AT ALL: `article_versions` already has a
-- whole-body embedding and a `tsv` column, and S02-05 retrieves from it. That
-- works only while articles are short. A 3,000-word noticeboard has one vector
-- for forty paragraphs: cosine similarity to any single one of them is diluted,
-- and `ts_rank` over the whole body cannot tell "pool closes at 20:00" from
-- "the spa closes at 20:00" when both live in the same document. A chunk is the
-- unit the guest's question is actually comparable to. `article_versions`
-- keeps its whole-body embedding: it is what S05 cites and what a
-- version-level rerank reads.
--
-- WHY `ordinal` IS PART OF THE IDENTITY: a chunk is only meaningful in
-- sequence ("verification pending" is not a contradiction of "passport
-- required", but the pair of chunks must not be reordered by a re-run). The
-- unique key `(article_version_id, ordinal)` plus the identity-immutable
-- trigger below mean a re-chunk can replace a row but never silently move text
-- to a different position.
--
-- WHY THE TENANT FK IS COMPOSITE: a chunk that points at another tenant's
-- version would be both a leak and a cross-tenant retrieval hit. 0001 gave
-- `article_versions` the `UNIQUE (org_id, property_id, article_version_id)`
-- this FK needs, so the shape is enforced by Postgres, not by the service.
--
-- WHY DELETE IS GRANTED (unlike 0010's tables): this table holds derived data,
-- and the AC is a two-sided invariant — "every is_current version has >= 1
-- chunk" AND "every chunk resolves to a current version". Publishing v2 must
-- therefore remove v1's chunks in the same transaction, or retired text stays
-- retrievable-by-chunk and the second half of the AC is false. Nothing is lost:
-- v1's body and its whole-body embedding remain on the immutable
-- `article_versions` row, which is what citations point at.

CREATE TABLE article_chunks (
  chunk_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL,
  property_id        uuid NOT NULL,
  article_version_id uuid NOT NULL,
  -- 0-based position within the version; the citation order S05 renders.
  ordinal            integer NOT NULL CHECK (ordinal >= 0),
  body               text NOT NULL,
  -- 1536 is D3's lock; a provider that emits anything else fails in
  -- `assertEmbeddingDimension` before this column can coerce it.
  embedding          vector(1536),
  tsv                tsvector GENERATED ALWAYS AS (to_tsvector('simple', body)) STORED,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT article_chunks_body_not_blank CHECK (length(btrim(body)) > 0),
  -- chunkBody's hard ceiling; a longer row means the chunker or a caller
  -- bypassed it, and pgvector cannot help with that.
  CONSTRAINT article_chunks_body_length CHECK (length(body) <= 2000),
  UNIQUE (article_version_id, ordinal),
  FOREIGN KEY (org_id, property_id, article_version_id)
    REFERENCES article_versions (org_id, property_id, article_version_id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, property_id) REFERENCES properties (org_id, property_id)
);

-- One index per retrieval mode S04-03 fuses: lexical (tsv), fuzzy/typo-tolerant
-- (trigram) and vector. The tenant index is what the RLS predicate and the
-- "chunks for this version" delete both use.
CREATE INDEX article_chunks_tsv ON article_chunks USING gin (tsv);
CREATE INDEX article_chunks_trgm ON article_chunks USING gin (body gin_trgm_ops);
CREATE INDEX article_chunks_emb ON article_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX article_chunks_tenant ON article_chunks (org_id, property_id, article_version_id);

-- A chunk's identity is (version, ordinal). Re-embedding may rewrite `body`'s
-- vector (a model change is legitimate), but text must never migrate to a
-- different ordinal or version under the same row: that would silently
-- repoint an existing citation.
CREATE OR REPLACE FUNCTION article_chunks_identity_immutable()
  RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.chunk_id <> OLD.chunk_id
     OR NEW.org_id <> OLD.org_id
     OR NEW.property_id <> OLD.property_id
     OR NEW.article_version_id <> OLD.article_version_id
     OR NEW.ordinal <> OLD.ordinal THEN
    RAISE EXCEPTION 'article_chunks identity (chunk_id, version, ordinal, tenant) is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER article_chunks_identity_immutable
  BEFORE UPDATE ON article_chunks
  FOR EACH ROW EXECUTE FUNCTION article_chunks_identity_immutable();

-- ---------- RLS + grants (the 0002 tenant-table shape) ----------

ALTER TABLE article_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE article_chunks FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant ON article_chunks
  USING (org_id = current_org_id() AND property_id = current_property_id())
  WITH CHECK (org_id = current_org_id() AND property_id = current_property_id());

-- DELETE is deliberate: publishing a new current version removes the retired
-- version's chunks (see the header). The immutable source row is untouched.
GRANT SELECT, INSERT, UPDATE, DELETE ON article_chunks TO concierge_app;

COMMENT ON TABLE article_chunks IS
  'S04-02: retrieval unit. Derived from an immutable article_version.body; '
  'only the current version of an article keeps chunks (AC-1).';
