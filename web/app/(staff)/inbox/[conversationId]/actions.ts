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

/** S09-01 — the lifecycle edges, which are addressed by *request*, not conversation. */
type RequestAction = "acknowledge" | "cancel";

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

/**
 * S09-01 — the same forwarding, against the request-scoped route.
 *
 * A second function rather than a flag on `call()`: the two resources are
 * addressed differently (`/requests/:id/:edge` vs `/conversations/:id/:action`),
 * and an `action` union wide enough to hold both would let a caller pass
 * "acknowledge" to the conversation route and get a 404 that looks like a
 * missing conversation.
 */
async function callRequest(
  conversationId: string,
  requestId: string,
  action: RequestAction,
  body: Record<string, unknown>,
): Promise<string | null> {
  const session = await readSession();
  if (session === null) redirect("/session");
  if (!UUID.test(conversationId) || !UUID.test(requestId)) return "missing";

  let status = 0;
  try {
    const response = await fetch(`${apiBase()}/api/inbox/requests/${requestId}/${action}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "x-org-id": session.orgId,
        "x-property-id": session.propertyId,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
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

/**
 * S09-01 — acknowledge a request.
 *
 * The one edge that has no other way in: `new → acknowledged` cannot be reached
 * by assigning or resolving any more, so a request nobody acknowledges is a
 * request that can never move. The button is therefore not a nicety on top of
 * the state machine; it is the state machine's entry point.
 */
export async function acknowledgeAction(formData: FormData): Promise<void> {
  const conversationId = String(formData.get("conversationId") ?? "");
  const requestId = String(formData.get("requestId") ?? "");
  refresh(conversationId, await callRequest(conversationId, requestId, "acknowledge", {}));
}

/**
 * S09-01 — cancel a request that will not be worked.
 *
 * Reachable only from `assigned`, like `resolved`: by the time a request can be
 * cancelled a person owns it, and the person who owns it is the person who
 * decides it is not happening.
 */
export async function cancelRequestAction(formData: FormData): Promise<void> {
  const conversationId = String(formData.get("conversationId") ?? "");
  const requestId = String(formData.get("requestId") ?? "");
  refresh(conversationId, await callRequest(conversationId, requestId, "cancel", {}));
}
