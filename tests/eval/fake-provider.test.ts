/**
 * S06-03 — the instrument, tested.
 *
 * The fake provider is what makes CI deterministic, so a bug in it becomes a
 * bug in the number the gate acts on. These cases pin the three properties the
 * rest of the harness relies on: it reads the prompt the pipeline built, it
 * quotes text that is really in that prompt (a quote that is not verbatim would
 * be rejected by `verifyAnswer` and mis-scored as a guardrail failure), and it
 * says `no_answer` instead of quoting an article that does not address the
 * question.
 */
import { describe, expect, it } from "vitest";
import { createGroundedProvider, parsePromptArticles } from "../../src/eval/fake-provider.ts";
import { buildPrompt } from "../../src/ai/prompt.ts";
import { verifyAnswer } from "../../src/ai/guard.ts";
import { parseAiOutput } from "../../src/ai/contract.ts";
import type { RetrievalHit } from "../../src/knowledge/retrieval.ts";

const POOL = "3b6f9a2e-1111-4c01-a1a1-000000000001";
const MENU = "3b6f9a2e-1111-4c01-a1a1-000000000002";

function hit(
  articleVersionId: string,
  topicKey: string,
  title: string,
  body: string,
): RetrievalHit {
  return {
    articleVersionId,
    articleId: articleVersionId,
    topicKey,
    title,
    language: "es",
    versionNo: 1,
    body,
    score: 1,
    scope: "property",
  };
}

function promptFor(question: string, hits: RetrievalHit[]): string {
  return buildPrompt({
    question,
    propertyLanguage: "es",
    tone: "warm",
    articles: hits.map((item) => ({
      articleVersionId: item.articleVersionId,
      topicKey: item.topicKey,
      title: item.title,
      text: item.body,
    })),
  }).prompt;
}

async function generate(question: string, hits: RetrievalHit[]) {
  const provider = createGroundedProvider();
  return provider.generate({
    ...buildPrompt({
      question,
      propertyLanguage: "es",
      tone: "warm",
      articles: hits.map((item) => ({
        articleVersionId: item.articleVersionId,
        topicKey: item.topicKey,
        title: item.title,
        text: item.body,
      })),
    }),
    schema: {},
    temperature: 0,
    timeoutMs: 1000,
  });
}

describe("eval fake provider", () => {
  it("reads the article ids and topics out of the real prompt", () => {
    const prompt = promptFor("¿A qué hora cierra la alberca?", [
      hit(POOL, "pool.hours", "Horarios de la alberca", "La alberca cierra a las 21:00."),
    ]);
    expect(parsePromptArticles(prompt)).toEqual([
      {
        articleVersionId: POOL,
        topicKey: "pool.hours",
        title: "Horarios de la alberca",
        text: "La alberca cierra a las 21:00.",
      },
    ]);
  });

  it("answers from the article that shares the question's subject, not rank 1", () => {
    const hits = [
      hit(MENU, "dining.menu", "Menú", "Ensalada de nopales $85\nSopa azteca $95"),
      hit(POOL, "pool.hours", "Horarios de la alberca", "La alberca cierra a las 21:00."),
    ];
    return generate("¿A qué hora cierra la alberca?", hits).then((raw) => {
      const output = raw as { decision: string; citations: Array<{ article_version_id: string; quote: string }> };
      expect(output.decision).toBe("answer");
      expect(output.citations[0]?.article_version_id).toBe(POOL);
      expect(output.citations[0]?.quote).toBe("La alberca cierra a las 21:00.");
    });
  });

  it("produces output that the real guardrail accepts", async () => {
    const hits = [hit(POOL, "pool.hours", "Horarios de la alberca", "La alberca cierra a las 21:00.")];
    const raw = await generate("¿A qué hora cierra la alberca?", hits);
    const output = parseAiOutput(raw, {
      allowedVersionIds: [POOL],
      allowedTopicKeys: ["pool.hours"],
    });
    expect(verifyAnswer(output, hits)).toEqual({ ok: true });
  });

  it("never quotes a banned sentence when a clean one exists", async () => {
    const hits = [
      hit(MENU, "dining.menu", "Menú de cena", "La cena cuesta $350 por persona. El menú cambia cada semana."),
    ];
    const output = (await generate("¿Cuándo cambia el menú de cena?", hits)) as {
      citations: Array<{ quote: string }>;
    };
    expect(output.citations[0]?.quote).toBe("El menú cambia cada semana.");
  });

  it("says no_answer when no retrieved article addresses the question", async () => {
    const hits = [hit(MENU, "dining.menu", "Menú", "Ensalada de nopales $85")];
    const output = (await generate("¿Tienen estacionamiento para bicicletas?", hits)) as {
      decision: string;
      reason_code: string;
    };
    expect(output.decision).toBe("no_answer");
    expect(output.reason_code).toBe("low_retrieval");
  });
});
