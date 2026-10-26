import { apiBase } from "@/lib/api-base";
import type { ApiFailure, PublicPropertyWire } from "@/lib/guest";

/**
 * S07-01 — the one place the Next server resolves a slug into a property.
 *
 * Extracted from the chat page because the QR and embed routes need the same
 * answer, and three copies of "fetch the property, 404 if it is not there" is
 * how one of them ends up publishing a QR for a slug that does not exist. The
 * API is the only thing that can turn a slug into a tenant (it holds the
 * `concierge_public` lookup), so this is a thin fetch — no logic duplicated.
 *
 * Returns null for "no such property" AND for "the API is unreachable": both are
 * a 404 to the person holding the URL, and telling a stranger which one it was
 * is free reconnaissance.
 */
export async function loadPropertyWire(
  slug: string,
  lang: string,
): Promise<PublicPropertyWire | null> {
  try {
    const response = await fetch(
      `${apiBase()}/api/chat/property?property=${encodeURIComponent(slug)}&lang=${encodeURIComponent(lang)}`,
      { cache: "no-store" },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as PublicPropertyWire | ApiFailure;
    return "slug" in body ? body : null;
  } catch {
    return null;
  }
}
