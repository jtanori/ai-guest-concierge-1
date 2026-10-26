"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { apiBase, readSession } from "@/lib/session";

/**
 * S08-04 — change the operating mode.
 *
 * A server action, like the inbox's four: the token stays in the HttpOnly cookie
 * and the form works before hydration. The API is the only thing that decides
 * (role `settings: write`, closed mode set, audit row); this forwards and turns
 * the status into a word the page can show.
 *
 * `redirect()` throws (`NEXT_REDIRECT`), so every redirect here happens OUTSIDE
 * the try block — the first version of this file had one inside it and the catch
 * turned a successful save into "that didn't save".
 */
export async function saveModeAction(formData: FormData): Promise<void> {
  const session = await readSession();
  if (session === null) redirect("/session");

  const mode = String(formData.get("mode") ?? "");
  let status = 0;
  let changed = true;

  try {
    const response = await fetch(`${apiBase()}/api/settings/ai-mode`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "x-org-id": session.orgId,
        "x-property-id": session.propertyId,
        "content-type": "application/json",
      },
      body: JSON.stringify({ mode }),
      cache: "no-store",
    });
    status = response.status;
    if (status === 200) {
      const body = (await response.json()) as { changed?: boolean };
      changed = body.changed !== false;
    }
  } catch {
    redirect("/settings?problem=error");
  }

  if (status === 200) {
    revalidatePath("/settings");
    redirect(changed ? "/settings?problem=saved" : "/settings?problem=unchanged");
  }
  redirect(`/settings?problem=${status === 400 ? "invalid" : status === 403 ? "forbidden" : "error"}`);
}
