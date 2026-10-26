import { describe, expect, it } from "vitest";
import { assertChunkShape, chunkBody, MAX_CHUNK_CHARS } from "../../src/knowledge/chunk.ts";

/** Walk source offsets, accounting only for bounded overlap; require full coverage. */
function assertCoverage(
  source: string,
  chunks: string[],
  maxChars: number,
  overlap: number,
) {
  const points = Array.from(source.replace(/\r\n/g, "\n"));
  let possibleEnds = new Set([0]);
  for (const chunk of chunks) {
    const text = Array.from(chunk);
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(maxChars);
    const nextEnds = new Set<number>();
    // Repeated source text can have several valid alignments. Keep all of
    // them instead of greedily mistaking new repeated text for overlap.
    for (const covered of possibleEnds) {
      for (
        let start = Math.max(0, covered - overlap);
        start <= covered;
        start++
      ) {
        if (start + text.length <= covered) continue;
        if (points.slice(start, start + text.length).join("") === chunk) {
          nextEnds.add(start + text.length);
        }
      }
    }
    expect(
      nextEnds.size,
      `chunk must extend the covered source: ${chunk}`,
    ).toBeGreaterThan(0);
    possibleEnds = nextEnds;
  }
  expect(possibleEnds.has(points.length)).toBe(true);
}

describe("chunkBody", () => {
  it("returns no chunks for empty or whitespace-only input", () => {
    for (const body of ["", " \t\n\r\n", "\u2003"])
      expect(chunkBody(body)).toEqual([]);
  });

  it("normalizes CRLF without trimming other text", () => {
    expect(chunkBody("  Hola.\r\n\r\nBye! \r")).toEqual(["  Hola.\n\nBye! \r"]);
  });

  it("keeps short and exact-limit bodies intact", () => {
    expect(chunkBody("Pool hours: 09:00–21:00.")).toEqual([
      "Pool hours: 09:00–21:00.",
    ]);
    expect(chunkBody("abcde", { maxChars: 5, overlap: 0 })).toEqual(["abcde"]);
  });

  it("prefers a paragraph boundary over a later sentence boundary", () => {
    const body = "First.\n\nSecond. Third.";
    const chunks = chunkBody(body, { maxChars: 16, overlap: 0 });
    expect(chunks[0]).toBe("First.\n\n");
    expect(chunks.join("")).toBe(body);
  });

  it("recognizes paragraphs even without sentence punctuation", () => {
    const body = "Heading\n \nSome following text";
    expect(chunkBody(body, { maxChars: 15, overlap: 0 })[0]).toBe(
      "Heading\n \n",
    );
  });

  it("prefers complete sentences and overlaps a whole-sentence suffix", () => {
    const body = "One. Two. Three. Four.";
    const chunks = chunkBody(body, { maxChars: 12, overlap: 5 });
    expect(chunks).toEqual(["One. Two. ", "Two. Three. ", "Four."]);
    assertCoverage(body, chunks, 12, 5);
  });

  it("uses zero overlap when a complete sentence cannot fit", () => {
    const body = "Long sentence. Next sentence. Last.";
    const chunks = chunkBody(body, { maxChars: 20, overlap: 3 });
    expect(chunks.join("")).toBe(body);
    assertCoverage(body, chunks, 20, 3);
  });

  it("does not overlap a fragment after hard-splitting an oversized sentence", () => {
    const body = "abcdefghijklmnop. Next.";
    const chunks = chunkBody(body, { maxChars: 10, overlap: 9 });
    expect(chunks).toEqual(["abcdefghij", "klmnop. ", "Next."]);
    expect(chunks.join("")).toBe(body);
  });

  it("handles closing quotes and multilingual terminal punctuation", () => {
    const body = "“Hola!” Sí。 Fin？ Más.";
    const chunks = chunkBody(body, { maxChars: 12, overlap: 0 });
    expect(chunks[0]).toBe("“Hola!” Sí。 ");
    expect(chunks.join("")).toBe(body);
  });

  it("splits unbroken text at the limit, preserving every code point", () => {
    const body = "x".repeat(3001);
    const chunks = chunkBody(body, { maxChars: 1000, overlap: 999 });
    expect(chunks.map((s) => s.length)).toEqual([1000, 1000, 1000, 1]);
    expect(chunks.join("")).toBe(body);
  });

  it("never splits a surrogate pair and counts Unicode code points", () => {
    const body = "😀🚀a🙂b🌊";
    const chunks = chunkBody(body, { maxChars: 2, overlap: 0 });
    expect(chunks).toEqual(["😀🚀", "a🙂", "b🌊"]);
    expect(chunks.join("")).toBe(body);
    expect(chunkBody("😀x", { maxChars: 1, overlap: 0 })).toEqual(["😀", "x"]);
  });

  it("chunks a 3,000-word article deterministically with lossless bounded overlap", () => {
    const body = Array.from(
      { length: 600 },
      (_, i) => `Sentence ${i} has five words.`,
    ).join(" ");
    expect(body.split(/\s/u)).toHaveLength(3000);
    const chunks = chunkBody(body);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunkBody(body)).toEqual(chunks);
    assertCoverage(body, chunks, 1200, 150);
  });

  it("always progresses even when almost the entire chunk may overlap", () => {
    const body = "A. ".repeat(50) + "Done.";
    const chunks = chunkBody(body, { maxChars: 10, overlap: 9 });
    expect(chunks.length).toBeLessThanOrEqual(Array.from(body).length);
    assertCoverage(body, chunks, 10, 9);
  });

  it("preserves text across many deterministic combinations of options", () => {
    const bodies = [
      "aa\n\nbb. cc! dd? ",
      "é😀 sentence.\n\nNext. ",
      "a".repeat(80) + ". End.",
    ];
    for (let maxChars = 1; maxChars <= 25; maxChars++) {
      for (const overlap of [0, maxChars - 1]) {
        for (const body of bodies) {
          const chunks = chunkBody(body, { maxChars, overlap });
          assertCoverage(body, chunks, maxChars, overlap);
          expect(chunkBody(body, { maxChars, overlap })).toEqual(chunks);
        }
      }
    }
  });

  it.each([0, -1, 2001, 1.5, NaN, Infinity, -Infinity])(
    "rejects maxChars %s",
    (maxChars) => {
      expect(() => chunkBody("text", { maxChars, overlap: 0 })).toThrow(
        RangeError,
      );
    },
  );

  it.each([-1, 1.5, NaN, Infinity, -Infinity, 10, 11])(
    "rejects overlap %s",
    (overlap) => {
      expect(() => chunkBody("text", { maxChars: 10, overlap })).toThrow(
        RangeError,
      );
    },
  );

  it("validates options even for empty bodies", () => {
    expect(() => chunkBody("", { maxChars: 0 })).toThrow(RangeError);
    expect(chunkBody("text", { overlap: 0 })).toEqual(["text"]);
  });

  it.each([1, 2, 100, 150, 151, 1200, 2000])(
    "adapts omitted overlap to a maxChars-only override of %s",
    (maxChars) => {
      const body = "A. B. C. ".repeat(30);
      const chunks = chunkBody(body, { maxChars });
      assertCoverage(body, chunks, maxChars, Math.min(150, maxChars - 1));
    },
  );

  it.each(["」", "』", "】"])(
    "recognizes unspaced CJK sentence boundaries followed by %s",
    (closingMark) => {
      const body = `最初。${closingMark}次。${closingMark}最後。`;
      const chunks = chunkBody(body, { maxChars: 6, overlap: 0 });
      expect(chunks[0]).toBe(`最初。${closingMark}`);
      expect(chunks.join("")).toBe(body);
    },
  );

  it("recognizes unspaced CJK sentences without closing marks", () => {
    expect(chunkBody("最初。次。最後。", { maxChars: 4, overlap: 0 })).toEqual([
      "最初。",
      "次。",
      "最後。",
    ]);
  });

  it.each(["؟", "۔", "।", "॥"])(
    "recognizes sentence terminator %s and retains whole-sentence overlap",
    (terminator) => {
      const body = `Ab${terminator} Cd${terminator} Ef${terminator} Gh${terminator}`;
      const chunks = chunkBody(body, { maxChars: 12, overlap: 4 });
      expect(chunks).toEqual([
        `Ab${terminator} Cd${terminator} Ef${terminator} `,
        `Ef${terminator} Gh${terminator}`,
      ]);
      assertCoverage(body, chunks, 12, 4);
    },
  );

  it("bounds output amplification below 2x with extreme overlap options", () => {
    const body = "A. ".repeat(5000);
    const chunks = chunkBody(body, { maxChars: 2000, overlap: 1999 });
    const outputSize = chunks.reduce(
      (sum, chunk) => sum + Array.from(chunk).length,
      0,
    );
    expect(outputSize).toBeLessThan(2 * Array.from(body).length);
    expect(chunks.length).toBeLessThan(20);
    // Distinct test input verifies full coverage as well as the amplification bound.
    const distinct = Array.from(
      { length: 500 },
      (_, i) => `Sentence ${i}. `,
    ).join("");
    const distinctChunks = chunkBody(distinct, {
      maxChars: 2000,
      overlap: 1999,
    });
    assertCoverage(distinct, distinctChunks, 2000, 1999);
    expect(
      distinctChunks.reduce((sum, chunk) => sum + Array.from(chunk).length, 0),
    ).toBeLessThan(2 * Array.from(distinct).length);
  });
});

describe("assertChunkShape (S04-02)", () => {
  it("accepts what chunkBody produces", () => {
    expect(() => assertChunkShape(chunkBody("One sentence. Two sentences."))).not.toThrow();
  });

  it("refuses the empty result that AC-1 forbids", () => {
    expect(() => assertChunkShape([])).toThrow(/at least one chunk/);
    expect(() => assertChunkShape(["   "])).toThrow(/blank/);
  });

  it("refuses a chunk past the database's ceiling", () => {
    expect(() => assertChunkShape(["x".repeat(MAX_CHUNK_CHARS + 1)])).toThrow(/over the 2000/);
    expect(() => assertChunkShape(["x".repeat(MAX_CHUNK_CHARS)])).not.toThrow();
  });
});
