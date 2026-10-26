"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { apiBase, readSession, UUID } from "@/lib/session";

/**
 * S09-02 — close a knowledge gap.
 *
 * A server action for the same two reasons as every other staff mutation here:
 * the form works before hydration (this screen is read standing up, like the
 * inbox), and the bearer token never leaves the HttpOnly cookie.
 *
 * The API is the only thing that decides — `knowledge: write`, one 404 for
 * "no such gap" and "not yours", an audit row, the `knowledge_gap_closed` event.
 * This forwards and turns the status into a word the page can render.
 *
 * `redirect()` throws `NEXT_REDIRECT`, so it is called only OUTSIDE the try
 * block: S08-04's first cut had one inside, and the catch turned a successful
 * save into "that didn't save".
 */
export async function closeGapAction(formData: FormData): Promise<void> {
  const session = await readSession();
  if (session === null) redirect("/session");

  const gapId = String(formData.get("gapId") ?? "");
  const cursor = String(formData.get("cursor") ?? "");
  // Where to land afterwards: the queue is paged, and dropping the reader back on
  // page one after closing something on page three is how a queue gets worked
  // twice.
  const back = cursor === "" ? "/gaps" : `/gaps?cursor=${encodeURIComponent(cursor)}`;

  if (!UUID.test(gapId)) redirect(`${back}?problem=missing`);

  let status = 0;
  try {
    const response = await fetch(`${apiBase()}/api/gaps/${gapId}/close`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "x-org-id": session.orgId,
        "x-property-id": session.propertyId,
        "content-type": "application/json",
      },
      body: "{}",
      cache: "no-store",
    });
    status = response.status;
  } catch {
    redirect(`${back}?problem=error`);
  }

  revalidatePath("/gaps");
  if (status === 200) redirect(back);
  const problem =
    status === 400 ? "invalid" : status === 403 ? "forbidden" : status === 404 ? "missing" : "error";
  redirect(`${back}?problem=${problem}`);
}
