"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { apiBase, readSession, UUID } from "@/lib/session";

/**
 * S08-03 — the four staff actions, called from the inbox.
 *
 * These are Next server actions rather than a client-side fetch for two reasons
 * that both matter on a phone in a lobby: the buttons work before hydration, and
 * the bearer token never leaves the HttpOnly cookie (the browser cannot read it,
 * and `web/lib/session.ts` deliberately does not expose it).
 *
 * The API is the only place that decides; these functions forward and translate
 * the status code into a query parameter the page can render. Anything clever
 * here would be a second implementation of the role matrix.
 */
type Action = "takeover" | "reply" | "assign" | "resolve";

/** API error → the one thing the page needs to say. */
function problemFor(status: number): string {
  if (status === 400 || status === 422) return "invalid";
  if (status === 403) return "forbidden";
  if (status === 404) return "missing";
  if (status === 409) return "conflict";
  return "error";
}

async function call(
  conversationId: string,
  action: Action,
  body: Record<string, unknown>,
): Promise<string | null> {
  const session = await readSession();
  if (session === null) redirect("/session");
  if (!UUID.test(conversationId)) return "missing";

  let status = 0;
  try {
    const response = await fetch(
      `${apiBase()}/api/inbox/conversations/${conversationId}/${action}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.token}`,
          "x-org-id": session.orgId,
          "x-property-id": session.propertyId,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        cache: "no-store",
      },
    );
    status = response.status;
  } catch {
    return "error";
  }
  return status === 200 ? null : problemFor(status);
}

/** Refresh the transcript for everyone looking at this conversation. */
function refresh(conversationId: string, problem: string | null): never {
  revalidatePath(`/inbox/${conversationId}`);
  revalidatePath("/inbox");
  redirect(
    problem === null
      ? `/inbox/${conversationId}`
      : `/inbox/${conversationId}?problem=${problem}`,
  );
}

export async function takeOverAction(formData: FormData): Promise<void> {
  const conversationId = String(formData.get("conversationId") ?? "");
  refresh(conversationId, await call(conversationId, "takeover", {}));
}

export async function replyAction(formData: FormData): Promise<void> {
  const conversationId = String(formData.get("conversationId") ?? "");
  const body = String(formData.get("body") ?? "").trim();
  if (body === "") refresh(conversationId, "invalid");
  refresh(conversationId, await call(conversationId, "reply", { body }));
}

export async function resolveAction(formData: FormData): Promise<void> {
  const conversationId = String(formData.get("conversationId") ?? "");
  refresh(conversationId, await call(conversationId, "resolve", {}));
}

/**
 * Assign to the caller.
 *
 * "Assign to me" is the only assignment this screen offers, and that is a scope
 * decision rather than an oversight: choosing a colleague needs a staff picker
 * (who is on shift? who is on the property?), which is a settings surface, not an
 * inbox button. The API already accepts any `assigneeUserId`, so the picker can
 * arrive without touching this contract.
 */
export async function assignToMeAction(formData: FormData): Promise<void> {
  const conversationId = String(formData.get("conversationId") ?? "");
  const requestId = String(formData.get("requestId") ?? "");
  refresh(
    conversationId,
    await call(conversationId, "assign", requestId === "" ? {} : { requestId }),
  );
}
