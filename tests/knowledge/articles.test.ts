import { describe, expect, it } from "vitest";
import {
  ARTICLE_LIMITS,
  ArticleValidationError,
  validateArticleDraft,
  type ArticleDraft,
} from "../../src/knowledge/articles.ts";

function draft(overrides: Partial<ArticleDraft> = {}): ArticleDraft {
  return {
    topicKey: "pool.hours",
    title: "Pool hours",
    body: "The pool is open 07:00-21:00.",
    language: "en",
    ...overrides,
  };
}

function invalid(overrides: Partial<ArticleDraft>): ArticleValidationError {
  try {
    validateArticleDraft(draft(overrides));
  } catch (error) {
    expect(error).toBeInstanceOf(ArticleValidationError);
    return error as ArticleValidationError;
  }
  throw new Error("expected validation to fail");
}

describe("article draft validation (S03-01)", () => {
  it("normalizes a valid draft and preserves the body verbatim", () => {
    const body = "  Line one.\nLine two.  ";
    expect(
      validateArticleDraft(
        draft({
          topicKey: "  pool.hours  ",
          title: "  Pool hours  ",
          body,
          language: "EN" as ArticleDraft["language"],
        }),
      ),
    ).toEqual({
      topicKey: "pool.hours",
      title: "Pool hours",
      body,
      language: "en",
      sourceId: undefined,
    });
  });

  it("accepts a picture-only body (null) and an explicit null source", () => {
    expect(
      validateArticleDraft(draft({ body: null, sourceId: null })),
    ).toMatchObject({ body: null, sourceId: null });
  });

  it("keeps undefined source distinct from null (edit preserves vs clears)", () => {
    expect(validateArticleDraft(draft({ sourceId: undefined })).sourceId).toBeUndefined();
    expect(validateArticleDraft(draft({ sourceId: null })).sourceId).toBeNull();
  });

  it("rejects empty or whitespace-only bodies but accepts a long body at the limit", () => {
    expect(invalid({ body: "" }).field).toBe("body");
    expect(invalid({ body: "   \n\t " }).field).toBe("body");
    expect(
      validateArticleDraft(draft({ body: "x".repeat(ARTICLE_LIMITS.body) })).body,
    ).toHaveLength(ARTICLE_LIMITS.body);
    expect(invalid({ body: "x".repeat(ARTICLE_LIMITS.body + 1) }).field).toBe("body");
    expect(invalid({ body: "bad\u0000body" }).field).toBe("body");
  });

  it("rejects empty, overlong and malformed titles", () => {
    expect(invalid({ title: "   " }).field).toBe("title");
    expect(invalid({ title: "x".repeat(ARTICLE_LIMITS.title + 1) }).field).toBe("title");
  });

  it("rejects malformed topic keys", () => {
    for (const topicKey of ["", "Pool.Hours", "pool hours", ".pool", "pool.", "pool..hours"]) {
      expect(invalid({ topicKey }).field, topicKey).toBe("topicKey");
    }
    expect(
      invalid({ topicKey: "x".repeat(ARTICLE_LIMITS.topicKey + 1) }).field,
    ).toBe("topicKey");
  });

  it("rejects unsupported languages", () => {
    expect(invalid({ language: "fr" as ArticleDraft["language"] }).field).toBe("language");
  });

  it("rejects a malformed source id", () => {
    expect(invalid({ sourceId: "not-a-uuid" }).field).toBe("sourceId");
  });
});
