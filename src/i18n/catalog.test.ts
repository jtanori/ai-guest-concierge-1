import { describe, expect, it } from "vitest";
import { en, LANGUAGES, t, type Lang, type StringId } from "./catalog.ts";

describe("i18n catalog (D14)", () => {
  it("has at least one string and key parity across every language", () => {
    const ids = Object.keys(en) as StringId[];
    expect(ids.length).toBeGreaterThan(0);
    // Compile-time parity is enforced by Record<StringId, string> on each
    // language; this runtime loop makes an empty/missing translation visible.
    for (const lang of LANGUAGES) {
      for (const id of ids) {
        expect(t(id, lang), `missing ${id} for ${lang}`).not.toBe("");
      }
    }
  });

  it("contains no untranslated placeholder text", () => {
    for (const lang of LANGUAGES satisfies readonly Lang[]) {
      for (const id of Object.keys(en) as StringId[]) {
        const value = t(id, lang);
        expect(value.startsWith("TODO"), `${id} (${lang})`).toBe(false);
        expect(value.startsWith("["), `${id} (${lang})`).toBe(false);
      }
    }
  });

  it("defaults to Spanish (pilot market)", () => {
    expect(t("guest.ai_disclosure")).not.toBe(t("guest.ai_disclosure", "en"));
  });
});
