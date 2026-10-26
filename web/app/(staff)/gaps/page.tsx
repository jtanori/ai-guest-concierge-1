import Link from "next/link";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { currentLang, translator, type StringId } from "@/lib/i18n";
import { apiBase, readSession, type StaffCookieSession } from "@/lib/session";
import type { ApiFailure, GapPageWire } from "@/lib/types";
import { signOut } from "../session/actions";
import { closeGapAction } from "./actions";

/**
 * S09-02 — the knowledge-gap queue.
 *
 * AC (verbatim): *"Every no_answer lands in the queue automatically."* The
 * landing is the API's job and is proven in `tests/db/gaps.db.test.ts`; this
 * screen is the other half of the item, because a queue nobody can open is a
 * table nobody reads.
 *
 * ## What the screen is for
 *
 * One decision: *what should we write next?* So the two numbers that answer it
 * are on every row — how many guests hit this miss (`hits`), and how long it has
 * been sitting — and the median sits above the list rather than on a dashboard,
 * because the person who can fix the median is the person reading the queue.
 *
 * Appendix D's target is ≤7 days, so the median is coloured against it. A number
 * with no target is a number nobody acts on.
 *
 * ## Why the question is rendered verbatim
 *
 * It is guest text, so it is a JSX child and never markup — the same rule the
 * conversation detail screen is tested against. It is also *not* translated,
 * truncated to a summary, or "cleaned up": the content owner is reading the
 * sentence the assistant could not answer, and a paraphrase of it is not evidence
 * of what is missing from the articles.
 *
 * A server component with links and forms, like the inbox: one GET, no client
 * cache, no loading state to get wrong while somebody is standing in a lobby.
 */
interface Loaded {
  status: number;
  body: GapPageWire | ApiFailure;
}

async function load(session: StaffCookieSession, cursor: string | null): Promise<Loaded> {
  const query = new URLSearchParams({ limit: "20" });
  if (cursor !== null) query.set("cursor", cursor);
  try {
    const response = await fetch(`${apiBase()}/api/gaps?${query.toString()}`, {
      headers: {
        authorization: `Bearer ${session.token}`,
        "x-org-id": session.orgId,
        "x-property-id": session.propertyId,
      },
      cache: "no-store",
    });
    const parsed = (await response.json().catch(() => ({
      error: "invalid_response",
    }))) as GapPageWire | ApiFailure;
    return { status: response.status, body: parsed };
  } catch {
    return { status: 502, body: { error: "upstream_unreachable" } };
  }
}

/** Appendix D: gaps should not stay open longer than this. */
const TARGET_DAYS = 7;

/**
 * "open 3 d" rather than a timestamp.
 *
 * The same convention the inbox uses for wait time: the reader wants the
 * duration, and a duration is comparable across rows while an absolute time is
 * not. Bucketed to the coarsest unit that is still honest — minutes under an
 * hour, hours under a day — because "open 0 d" says nothing and "open 1440 min"
 * says too much.
 */
function ageLabel(seconds: number, tr: (id: StringId) => string): string {
  const fill = (template: string, count: number): string =>
    template.replace("{count}", String(count));
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return tr("staff.inbox.wait_now");
  if (minutes < 60) return fill(tr("staff.gaps.age_minutes"), minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return fill(tr("staff.gaps.age_hours"), hours);
  return fill(tr("staff.gaps.age_days"), Math.floor(hours / 24));
}

function hitsLabel(hits: number, tr: (id: StringId) => string): string {
  return hits === 1
    ? tr("staff.gaps.hits_one")
    : tr("staff.gaps.hits").replace("{count}", String(hits));
}

export default async function GapsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactElement> {
  const session = await readSession();
  if (session === null) redirect("/session");

  const params = await searchParams;
  const cursor = typeof params["cursor"] === "string" ? params["cursor"] : null;
  const problem = typeof params["problem"] === "string" ? params["problem"] : null;

  const lang = await currentLang();
  const tr = translator(lang);
  const loaded = await load(session, cursor);

  if (loaded.status !== 200) {
    const forbidden = loaded.status === 403;
    return (
      <div className="rounded-lg border border-destructive/40 p-6">
        <p className="text-sm font-medium text-destructive">
          {forbidden ? tr("staff.gaps.forbidden") : tr("staff.gaps.error")}
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

  const page = loaded.body as GapPageWire;
  const median = page.medianOpenAgeDays;
  const overTarget = median !== null && median > TARGET_DAYS;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold tracking-tight">{tr("staff.gaps.title")}</h1>
        <form action={signOut}>
          <Button type="submit" variant="ghost" size="sm">
            {tr("staff.common.signout")}
          </Button>
        </form>
      </div>
      <p className="text-xs text-muted-foreground">{tr("staff.gaps.intro")}</p>

      {problem === null ? null : (
        <p className="rounded-lg border border-destructive/40 p-3 text-xs text-destructive">
          {tr(`staff.gaps.problem_${problem}` as StringId)}
        </p>
      )}

      {/* The median above the list, not on a dashboard: the person who can move
          this number is the person about to read the queue. */}
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-lg border p-4">
        <span className="text-xs text-muted-foreground">{tr("staff.gaps.median")}</span>
        <span
          className={
            overTarget ? "text-lg font-semibold text-destructive" : "text-lg font-semibold"
          }
        >
          {median === null
            ? tr("staff.gaps.median_none")
            : tr("staff.gaps.median_days").replace("{days}", median.toFixed(1))}
        </span>
        <span className="text-xs text-muted-foreground">{tr("staff.gaps.target")}</span>
        <span className="ml-auto text-xs text-muted-foreground">
          {tr("staff.gaps.open_count").replace("{count}", String(page.openCount))}
        </span>
      </div>

      {page.items.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          {tr("staff.gaps.empty")}
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {page.items.map((gap) => (
            <li key={gap.gapId} className="space-y-2 p-4">
              {/* The guest's exact words. JSX child, never markup. */}
              <p className="text-sm">{gap.question}</p>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                {/* Asked N times first: it is the number that says what to write
                    next, and the age is the number that says what has been
                    neglected. */}
                <span className="rounded bg-muted px-2 py-0.5 font-medium">
                  {hitsLabel(gap.hits, tr)}
                </span>
                <span>{ageLabel(gap.openSeconds, tr)}</span>
                {gap.language === null ? null : <span>{gap.language}</span>}
                {gap.topic === null ? null : <span>{gap.topic}</span>}
                {gap.conversationId === null ? null : (
                  <Link href={`/inbox/${gap.conversationId}`} className="underline">
                    {tr("staff.gaps.conversation")}
                  </Link>
                )}
              </div>
              <form action={closeGapAction}>
                <input type="hidden" name="gapId" value={gap.gapId} />
                {cursor === null ? null : <input type="hidden" name="cursor" value={cursor} />}
                <Button
                  type="submit"
                  variant="outline"
                  size="sm"
                  title={tr("staff.gaps.close_hint")}
                >
                  {tr("staff.gaps.close")}
                </Button>
              </form>
            </li>
          ))}
        </ul>
      )}

      {page.nextCursor === null ? null : (
        <Link
          href={`/gaps?cursor=${encodeURIComponent(page.nextCursor)}`}
          className="block rounded-lg border p-3 text-center text-sm font-medium"
        >
          {tr("staff.gaps.load_more")}
        </Link>
      )}
    </div>
  );
}
