/**
 * S06-03 — the deterministic model behind the eval harness.
 *
 * Why a fake at all: G2 is a product gate, not a model-quality beauty contest,
 * and a gate that depends on a vendor's mood on a Tuesday cannot be a gate. The
 * fake makes the *pipeline* measurable — retrieval, the guardrail, the
 * no-answer path, the citation contract — with byte-identical repeatability and
 * no key, no cost and no network in CI.
 *
 * What it is and is not:
 *
 *  - It **is** a model in the only sense the pipeline cares about: it receives
 *    exactly the prompt a real model receives (same system text, same retrieved
 *    articles, same JSON schema), and it must satisfy the same contract.
 *  - It is **not** a measure of model quality. It answers by quoting the top
 *    retrieved article, which is the best case a model could reach from that
 *    retrieval. So a low score here is a retrieval or guardrail finding, never
 *    a "the AI is dumb" finding — and a high score is not a claim about Gemini.
 *    Live model quality is the nightly canary's job (`--live`).
 *
 * The one behaviour it deliberately imitates: it prefers a sentence that does
 * not contain banned content (prices, availability, "confirmed"). A real model
 * told to answer with a price will get the answer blocked by the guardrail, and
 * so does this one — but only when the article has nothing else to quote.
 */
import { findBannedContent } from "../ai/banned.ts";
import type { AiProvider, AiRequest } from "../ai/provider.ts";

interface PromptArticle {
  articleVersionId: string;
  topicKey: string;
  title: string;
  text: string;
}

const ARTICLE_HEAD =
  /^\[(\d+)\] article_version_id=([0-9a-f-]{36})\ntopic_key=([a-z0-9_.-]+)\ntitle=([^\n]*)\n/;

const SENTENCE_SPLIT = /(?<=[.!?])\s+|\n+/;
const MIN_QUOTE = 15;
const MAX_QUOTE = 300;

/** Parses the `ARTICLES:` block of the prompt the pipeline actually built. */
export function parsePromptArticles(prompt: string): PromptArticle[] {
  const start = prompt.indexOf("ARTICLES:");
  if (start === -1) throw new RangeError("fake provider: prompt has no ARTICLES block");
  const end = prompt.indexOf("\n\nVERIFIED FACT", start);
  const jsonStart = prompt.indexOf("\n\nJSON SHAPE:", start);
  const stop = Math.min(
    ...[end, jsonStart, prompt.length].filter((value) => value !== -1) as number[],
  );
  const block = prompt.slice(start + "ARTICLES:".length, stop).trim();
  if (block.startsWith("(none were retrieved")) return [];

  const articles: PromptArticle[] = [];
  for (const chunk of block.split(/\n(?=\[(\d+)\] article_version_id=)/)) {
    const head = ARTICLE_HEAD.exec(chunk);
    if (head === null) continue;
    articles.push({
      articleVersionId: head[2] as string,
      topicKey: head[3] as string,
      title: head[4] as string,
      text: chunk.slice(head[0].length).trim(),
    });
  }
  return articles;
}

function sentencesOf(text: string): string[] {
  return text
    // The prompt truncates long bodies with a trailing ellipsis that is not in
    // the article, so it must not survive into a quote (the guard checks that
    // the quote is a verbatim substring).
    .replaceAll("…", " ")
    .split(SENTENCE_SPLIT)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= MIN_QUOTE);
}

/**
 * Words that carry no topic. Without this list the fake would "answer" a
 * breakfast question from the quiet-hours article because both contain "time" —
 * which is a property of the stoplist, not a finding about the pipeline.
 */
const STOPWORDS = new Set([
  "the", "and", "for", "you", "your", "our", "can", "could", "would", "what",
  "when", "where", "how", "does", "did", "are", "was", "were", "there", "this",
  "that", "with", "have", "has", "from", "about", "any", "much", "many", "time",
  "hour", "hours", "day", "days", "night", "hotel", "please", "need", "want",
  "que", "los", "las", "del", "por", "para", "con", "una", "uno", "hay", "como",
  "que", "cual", "cuando", "donde", "cuanto", "puedo", "puede", "tienen", "tiene",
  "hora", "horas", "dia", "dias", "noche", "hotel", "favor", "necesito", "quiero",
]);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

/**
 * The sentence the fake answers with: the one that shares the most content
 * words with the question, and only if it shares at least one.
 *
 * Returning `null` is the important half. A model that has articles but none
 * that address the question is *supposed* to say `no_answer` (prompt rule 1);
 * quoting an unrelated sentence because it is the only one available is exactly
 * the behaviour the guardrail exists to stop, so the fake must not fake it.
 */
function pickQuote(article: PromptArticle, questionTokens: readonly string[]): string | null {
  let best: { sentence: string; score: number } | null = null;
  for (const sentence of sentencesOf(article.text)) {
    // Title included: the model sees the title, and a Spanish question about
    // the pool is answerable from an English one-liner whose title names it.
    const sentenceTokens = new Set([...tokens(sentence), ...tokens(article.title)]);
    const score = questionTokens.filter((token) => sentenceTokens.has(token)).length;
    if (score === 0) continue;
    if (findBannedContent(sentence).length > 0) continue;
    if (best === null || score > best.score) best = { sentence, score };
  }
  return best === null ? null : best.sentence.slice(0, MAX_QUOTE).trim();
}

function detectLanguage(question: string): string {
  return /[¿¡ñ]|\b(el|la|los|las|qué|cómo|dónde|cuándo|puedo|tienen|hay)\b/i.test(question)
    ? "es-MX"
    : "en";
}

function guestQuestion(prompt: string): string {
  const marker = "GUEST QUESTION:";
  const index = prompt.indexOf(marker);
  return index === -1 ? "" : prompt.slice(index + marker.length).trim();
}

/** A provider that always answers from the first retrieved article. */
export interface GroundedProvider extends AiProvider {
  readonly requests: AiRequest[];
}

export function createGroundedProvider(modelId = "eval-grounded-2026-01-01"): GroundedProvider {
  const requests: AiRequest[] = [];
  return {
    modelId,
    requests,
    async generate(request: AiRequest): Promise<unknown> {
      requests.push(request);
      const articles = parsePromptArticles(request.prompt);
      const language = detectLanguage(guestQuestion(request.prompt));
      const questionTokens = tokens(guestQuestion(request.prompt));
      // The best-overlap article, not the top-ranked one: retrieval order is a
      // ranking, and a model reads the whole list. This also keeps the fake
      // from turning a ranking weakness into a false answer it would never give.
      let top: PromptArticle | undefined;
      let quote: string | null = null;
      for (const article of articles) {
        const candidate = pickQuote(article, questionTokens);
        if (candidate !== null) {
          top = article;
          quote = candidate;
          break;
        }
      }

      if (top === undefined || quote === null) {
        return {
          decision: "no_answer",
          answer: null,
          language,
          citations: [],
          reason_code: "low_retrieval",
          topic_keys_used: [],
          confidence: 0.2,
        };
      }

      return {
        decision: "answer",
        answer: quote,
        language,
        citations: [{ article_version_id: top.articleVersionId, quote }],
        reason_code: null,
        topic_keys_used: [top.topicKey],
        confidence: 0.9,
      };
    },
  };
}
