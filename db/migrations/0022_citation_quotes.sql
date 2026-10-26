-- 0022_citation_quotes.sql — S08-02 — keep the sentence, not just the source.
--
-- S05-03 shipped `citations` with the version id and nothing else, and said so
-- in `src/ai/history.ts`: "the verbatim `quote` from the model output is not
-- persisted ... If the quote is ever needed for dispute resolution it belongs
-- in a new column, not in a JSON blob — and that is a migration, not a silent
-- change here." This is that migration.
--
-- Why it matters for staff: the AC is "staff can see the cited text verbatim".
-- With only the version id, the pane can show the whole article — a staff
-- member then has to find the sentence themselves, in a 19,000-character
-- noticeboard, while a guest waits. The quote is the anchor the model actually
-- used, and the guard (`src/ai/guard.ts`) has already proven it appears in that
-- version: this column stores a string we verified, not a claim we trust.
--
-- NULLABLE ON PURPOSE. Every citation written before this migration has no
-- quote, and inventing one would be falsifying history. The detail view falls
-- back to the version body for those rows, which is exactly what S05-03 could
-- offer.
ALTER TABLE citations
  ADD COLUMN quote text;

-- The bounds mirror the contract that produced the value
-- (`src/ai/contract.ts`: `quoteChars: 400`), so a row that could never have
-- come out of the model is refused here too. `btrim` because a quote of spaces
-- is not a quote.
ALTER TABLE citations
  ADD CONSTRAINT citations_quote_shape
  CHECK (quote IS NULL OR length(btrim(quote)) BETWEEN 1 AND 400);

COMMENT ON COLUMN citations.quote IS
  'S08-02: the verbatim supporting quote the model returned, already proven to appear in the cited version by src/ai/guard.ts. NULL for citations written before 0022 (the detail view then shows the version body).';
