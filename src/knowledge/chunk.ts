/** Pure, lossless chunking. All offsets and limits count Unicode code points. */
export interface ChunkOptions {
  maxChars?: number;
  overlap?: number;
}

/** First boundary >= value (or boundaries.length). */
function lowerBound(boundaries: number[], value: number): number {
  let lo = 0;
  let hi = boundaries.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (boundaries[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Prefer blank-line paragraphs, then sentences ending in . ! ? 。 ！ ？,
 * optionally followed by closing quotes/brackets. This is a deterministic
 * heuristic, not linguistic segmentation (e.g. abbreviations may split).
 * Separators stay in the preceding chunk: no trimming or text loss.
 * A whole-sentence suffix is repeated only when it fits the overlap budget;
 * unfinished/hard-split sentence fragments are never used as overlap.
 */
export function chunkBody(body: string, opts: ChunkOptions = {}): string[] {
  const maxChars = opts.maxChars ?? 1200;
  const overlap = opts.overlap ?? 150;
  if (
    !Number.isInteger(maxChars) ||
    maxChars < 1 ||
    maxChars > 2000 ||
    !Number.isInteger(overlap) ||
    overlap < 0 ||
    overlap >= maxChars
  ) {
    throw new RangeError(
      "Require integer 1 <= maxChars <= 2000 and 0 <= overlap < maxChars",
    );
  }

  const normalized = body.replace(/\r\n/g, "\n");
  if (!normalized.trim()) return [];
  const points = Array.from(normalized);
  const paragraphs: number[] = [];
  const sentences: number[] = [0];

  // Scan once; absorb separators without dropping them. Keep sentence
  // boundaries separate from paragraph boundaries for whole-sentence overlap.
  for (let i = 0; i < points.length; i++) {
    if (/[.!?。！？]/u.test(points[i]!)) {
      let end = i + 1;
      while (end < points.length && /[.!?。！？"'”’»）)\]]/u.test(points[end]!))
        end++;
      if (end === points.length || /\s/u.test(points[end]!)) {
        while (end < points.length && /\s/u.test(points[end]!)) end++;
        sentences.push(end);
        i = end - 1;
        // A sentence's separators may also end a paragraph.
        if (
          points
            .slice(sentences.at(-2)!, end)
            .join("")
            .match(/\n[^\S\n]*\n\s*$/u)
        ) {
          paragraphs.push(end);
        }
      } else {
        // Skip an unterminated punctuation/closing-mark run in one pass.
        i = end - 1;
      }
    } else if (points[i] === "\n") {
      let end = i + 1;
      while (end < points.length && /\s/u.test(points[end]!)) end++;
      if (points.slice(i + 1, end).includes("\n")) paragraphs.push(end);
      i = end - 1;
    }
  }

  const chunks: string[] = [];
  let start = 0;
  let previousEnd = 0;
  while (start < points.length) {
    const limit = Math.min(start + maxChars, points.length);
    let end = limit;
    if (limit < points.length) {
      // Ignore boundaries within the repeated suffix: each chunk must add text.
      for (const boundaries of [paragraphs, sentences]) {
        const index = lowerBound(boundaries, limit + 1) - 1;
        const candidate = boundaries[index];
        if (candidate !== undefined && candidate > previousEnd) {
          end = candidate;
          break;
        }
      }
    }
    chunks.push(points.slice(start, end).join(""));
    if (end === points.length) break;

    const boundaryIndex = lowerBound(sentences, end);
    const overlapIndex = lowerBound(
      sentences,
      Math.max(end - overlap, start + 1),
    );
    // Both ends must be true sentence boundaries; never repeat a partial sentence.
    const nextStart = sentences[overlapIndex];
    previousEnd = end;
    start =
      sentences[boundaryIndex] === end &&
      nextStart !== undefined &&
      nextStart < end
        ? nextStart
        : end;
  }
  return chunks;
}
