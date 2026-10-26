import Link from "next/link";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { currentLang, translator, type StringId } from "@/lib/i18n";
import { REQUEST_LABEL } from "@/lib/request-status";
import { apiBase, readSession, type StaffCookieSession } from "@/lib/session";
import type { ApiFailure, InboxPageWire } from "@/lib/types";
import { signOut } from "../session/actions";

/**
 * S08-01 — the shared inbox, phone first.
 *
 * AC (verbatim): *"An agent triages a queue on a phone in under 60 seconds."*
 *
 * ## Why this is a server component with links, not a client app
 *
 * The whole screen is one GET and a list. A client-side inbox would need a
 * loading state, an error state, a retry, and a cache — four things that can be
 * wrong while an agent is standing in a lobby — to save a round trip that the
 * server is already making next to the database. DEC-1 says React; it does not
 * say `"use client"`.
 *
 * The filters are `<Link>`s, so they are also the browser's back button: an
 * agent who taps "Mine" and then their phone's back gesture returns to the
 * needs-attention list, which is not true of `useState`.
 *
 * ## What a row shows, and what it deliberately does not
 *
 * Who is waiting (state), for how long (server clock, not the phone's), and the
 * last message so the agent can decide without opening anything. The message
 * body is clamped to two lines: the inbox is a triage list, and a full
 * transcript on a 390px screen pushes the next conversation off the fold.
 *
 * ## Paging
 *
 * `nextCursor` is opaque and comes from the API. "Load more" fetches the next
 * page rather than appending to this one — the smallest honest thing at this
 * size (20 rows is already more than a phone screen), and it keeps the page a
 * pure function of its URL. Accumulating pages is what S08-03 will need when
 * rows grow actions; doing it now would be a cache with no invalidation.
 */
interface Loaded {
  status: number;
  body: InboxPageWire | ApiFailure;
}

async function load(
  session: StaffCookieSession,
  filter: string,
  cursor: string | null,
): Promise<Loaded> {
  const query = new URLSearchParams({ filter, limit: "20" });
  if (cursor !== null) query.set("cursor", cursor);
  try {
    const response = await fetch(`${apiBase()}/api/inbox?${query.toString()}`, {
      headers: {
        authorization: `Bearer ${session.token}`,
        "x-org-id": session.orgId,
        "x-property-id": session.propertyId,
      },
      cache: "no-store",
    });
    const parsed = (await response.json().catch(() => ({
      error: "invalid_response",
    }))) as InboxPageWire | ApiFailure;
    return { status: response.status, body: parsed };
  } catch {
    return { status: 502, body: { error: "upstream_unreachable" } };
  }
}

const FILTERS = ["needs_attention", "mine", "unresolved"] as const;
type Filter = (typeof FILTERS)[number];

const FILTER_LABEL = {
  needs_attention: "staff.inbox.needs_attention",
  mine: "staff.inbox.mine",
  unresolved: "staff.inbox.unresolved",
} as const;

const STATE_LABEL = {
  awaiting_staff: "staff.inbox.state_awaiting_staff",
  awaiting_ai: "staff.inbox.state_awaiting_ai",
  idle: "staff.inbox.state_idle",
  resolved: "staff.inbox.state_resolved",
} as const;

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactElement> {
  const session = await readSession();
  if (session === null) redirect("/session");

  const params = await searchParams;
  const rawFilter = params["filter"];
  const candidate = typeof rawFilter === "string" ? rawFilter : "";
  // An unknown filter falls back to the default rather than 400ing the screen:
  // the URL is user-editable and a typed `?filter=foo` should show the queue
  // they most likely meant, not an error page. The API still refuses it — this
  // is the screen being forgiving, not the service being lax.
  const filter: Filter = (FILTERS as readonly string[]).includes(candidate)
    ? (candidate as Filter)
    : "needs_attention";
  const cursor = typeof params["cursor"] === "string" ? params["cursor"] : null;

  const lang = await currentLang();
  const tr = translator(lang);
  const loaded = await load(session, filter, cursor);

  if (loaded.status !== 200) {
    const forbidden = loaded.status === 403;
    return (
      <div className="rounded-lg border border-destructive/40 p-6">
        <p className="text-sm font-medium text-destructive">
          {forbidden ? tr("staff.inbox.forbidden") : tr("staff.inbox.error")}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {(loaded.body as ApiFailure).error} · HTTP {loaded.status}
        </p>
        <form action={signOut} className="mt-4">
          <Button type="submit" variant="outline" size="sm">
            {tr("staff.common.signout")}
          </Button>
        </form>
      </div>
    );
  }

  const page = loaded.body as InboxPageWire;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold tracking-tight">{tr("staff.inbox.title")}</h1>
        <form action={signOut}>
          <Button type="submit" variant="ghost" size="sm">
            {tr("staff.common.signout")}
          </Button>
        </form>
      </div>

      {/* Filters first: the agent's first decision is "which queue". */}
      <nav className="flex gap-2 overflow-x-auto pb-1">
        {FILTERS.map((option) => (
          <Link
            key={option}
            href={`/inbox?filter=${option}`}
            aria-current={option === filter ? "page" : undefined}
            className={
              option === filter
                ? "rounded-full bg-foreground px-3 py-1.5 text-xs font-medium text-background"
                : "rounded-full border px-3 py-1.5 text-xs font-medium text-muted-foreground"
            }
          >
            {tr(FILTER_LABEL[option])}
          </Link>
        ))}
      </nav>

      {page.items.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          {tr("staff.inbox.empty")}
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {page.items.map((item) => (
            <li key={item.conversationId}>
              {/* S08-02: the row is the door to the conversation. */}
              <Link
                href={`/inbox/${item.conversationId}`}
                className="block space-y-1.5 p-4 hover:bg-muted/50"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="rounded bg-muted px-2 py-0.5 text-[11px] font-medium">
                    {tr(STATE_LABEL[item.aiState])}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {waitLabel(item.waitSeconds, tr)}
                  </span>
                </div>
                <p className="line-clamp-2 text-sm">
                  {item.lastMessage === null
                    ? tr("staff.inbox.no_messages")
                    : item.lastMessage.body}
                </p>
                {item.request !== null ? (
                  <p className="text-[11px] text-muted-foreground">
                    {tr(REQUEST_LABEL[item.request.status])}
                  </p>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}

      {page.nextCursor !== null ? (
        <Link
          href={`/inbox?filter=${filter}&cursor=${encodeURIComponent(page.nextCursor)}`}
          className="block rounded-lg border p-3 text-center text-sm font-medium"
        >
          {tr("staff.inbox.load_more")}
        </Link>
      ) : null}
    </div>
  );
}

/**
 * "4 min waiting" — the one place this screen does arithmetic on copy.
 *
 * The catalogue holds the template with a `{count}` hole (the same convention
 * `guest.chat.rate_limited_seconds` uses) because `t()` takes an id and a
 * language, not parameters: the hole is filled here, where the number is.
 */
function waitLabel(seconds: number, tr: (id: StringId) => string): string {
  const fill = (template: string, count: number): string =>
    template.replace("{count}", String(count));
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return tr("staff.inbox.wait_now");
  if (minutes < 60) return fill(tr("staff.inbox.wait_minutes"), minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return fill(tr("staff.inbox.wait_hours"), hours);
  return fill(tr("staff.inbox.wait_days"), Math.floor(hours / 24));
}
