"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { LANG_COOKIE, normalizeLang } from "@/lib/i18n";
import { ORG_COOKIE, PROPERTY_COOKIE, TOKEN_COOKIE, UUID } from "@/lib/session";

const ONE_DAY = 60 * 60 * 24;

/**
 * Stores the staff token server-side. The token never reaches the client: it
 * is set as an HttpOnly cookie by this action and read back only by the proxy
 * route, which attaches it to the API call.
 */
export async function saveSession(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "").trim();
  const orgId = String(formData.get("orgId") ?? "").trim();
  const propertyId = String(formData.get("propertyId") ?? "").trim();
  const lang = normalizeLang(String(formData.get("lang") ?? ""));

  const jar = await cookies();
  jar.set(LANG_COOKIE, lang, { httpOnly: false, sameSite: "lax", path: "/", maxAge: ONE_DAY });

  if (token === "" || !UUID.test(orgId) || !UUID.test(propertyId)) {
    redirect("/session?problem=invalid");
  }

  const options = { httpOnly: true, sameSite: "lax" as const, path: "/", maxAge: ONE_DAY };
  jar.set(TOKEN_COOKIE, token, options);
  jar.set(ORG_COOKIE, orgId, options);
  jar.set(PROPERTY_COOKIE, propertyId, options);
  redirect("/review");
}

export async function signOut(): Promise<void> {
  const jar = await cookies();
  jar.delete(TOKEN_COOKIE);
  jar.delete(ORG_COOKIE);
  jar.delete(PROPERTY_COOKIE);
  redirect("/session");
}
