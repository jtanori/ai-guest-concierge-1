import Link from "next/link";
import { redirect } from "next/navigation";
import { ReviewQueue } from "@/components/review-queue";
import { Button } from "@/components/ui/button";
import { currentLang, translator } from "@/lib/i18n";
import { apiBase, readSession, type StaffCookieSession } from "@/lib/session";
import type { ApiFailure, ContradictionWire, ReviewQueueItemWire } from "@/lib/types";
import { signOut } from "../session/actions";

interface Loaded<T> {
  status: number;
  body: T | ApiFailure;
}

async function load<T>(session: StaffCookieSession, path: string): Promise<Loaded<T>> {
  const response = await fetch(`${apiBase()}${path}`, {
    headers: {
      authorization: `Bearer ${session.token}`,
      "x-org-id": session.orgId,
      "x-property-id": session.propertyId,
    },
    cache: "no-store",
  });
  const parsed = (await response.json().catch(() => ({ error: "invalid_response" }))) as T | ApiFailure;
  return { status: response.status, body: parsed };
}

export default async function ReviewPage(): Promise<React.ReactElement> {
  const session = await readSession();
  if (session === null) redirect("/session");

  const lang = await currentLang();
  const tr = translator(lang);

  const [queue, contradictions] = await Promise.all([
    load<ReviewQueueItemWire[]>(session, "/api/review/queue"),
    load<ContradictionWire[]>(session, "/api/review/contradictions"),
  ]);

  const failed = queue.status !== 200 ? queue : contradictions.status !== 200 ? contradictions : null;
  if (failed !== null) {
    const forbidden = failed.status === 403;
    return (
      <div className="rounded-lg border border-destructive/40 p-6">
        <p className="text-sm font-medium text-destructive">
          {forbidden ? tr("staff.review.forbidden") : tr("staff.review.error")}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {(failed.body as ApiFailure).error} · HTTP {failed.status}
        </p>
        <form action={signOut} className="mt-4">
          <Button type="submit" variant="outline" size="sm">
            {tr("staff.review.signout")}
          </Button>
        </form>
      </div>
    );
  }

  const labels = {
    title: tr("staff.review.title"),
    pending: tr("staff.review.pending"),
    approve: tr("staff.review.approve"),
    reject: tr("staff.review.reject"),
    approved: tr("staff.review.approved"),
    rejected: tr("staff.review.rejected"),
    contradictions: tr("staff.review.contradictions"),
    resolve: tr("staff.review.resolve"),
    resolved: tr("staff.review.resolved"),
    empty: tr("staff.review.empty"),
    article: tr("staff.review.article"),
    version: tr("staff.review.version"),
    value: tr("staff.review.value"),
    winner: tr("staff.review.winner"),
    error: tr("staff.review.error"),
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">{tr("staff.review.title")}</h1>
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link href="/session">{tr("staff.session.language")}</Link>
          </Button>
          <form action={signOut}>
            <Button type="submit" variant="outline" size="sm">
              {tr("staff.review.signout")}
            </Button>
          </form>
        </div>
      </div>
      <ReviewQueue
        labels={labels}
        pending={queue.body as ReviewQueueItemWire[]}
        contradictions={contradictions.body as ContradictionWire[]}
      />
    </div>
  );
}
