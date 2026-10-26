import { cookies } from "next/headers";
import { LANGUAGES, t, type Lang, type StringId } from "../../src/i18n/catalog.ts";

export type { StringId } from "../../src/i18n/catalog.ts";

export const LANG_COOKIE = "staff_lang";

/** The catalogue is the only source of copy — D14 applies to this app too. */
export function normalizeLang(value: string | undefined): Lang {
  return LANGUAGES.includes(value as Lang) ? (value as Lang) : "es";
}

export async function currentLang(): Promise<Lang> {
  const jar = await cookies();
  return normalizeLang(jar.get(LANG_COOKIE)?.value);
}

export function translator(lang: Lang): (id: StringId) => string {
  return (id: StringId) => t(id, lang);
}
