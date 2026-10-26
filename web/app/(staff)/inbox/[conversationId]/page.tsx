import Link from "next/link";
import { redirect } from "next/navigation";
import { currentLang, translator, type StringId } from "@/lib/i18n";
import { apiBase, readSession, type StaffCookieSession } from "@/lib/session";
import type { ApiFailure, ConversationDetailWire, DetailMessageWire } from "@/lib/types";
import { OPEN_REQUEST_STATUSES, REQUEST_LABEL } from "@/lib/request-status";
import {
  acknowledgeAction,
  assignToMeAction,
  cancelRequestAction,
  replyAction,
  resolveAction,
  takeOverAction,
} from "./actions";

/**
 * S08-02 — the conversation, with the text the AI leaned on.
 *
 * AC-1: every AI message shows its citations, with the quote and the cited
 * `article_version` body, verbatim.
 * AC-2: editing the article later does not change this screen. That is a
 * property of the data (versions are immutable, 0003; citations point at
 * versions, D5), so this page simply refuses to help it break: it renders what
 * the API sends and never re-reads the article.
 *
 * ## Escaping
 *
 * Guest messages are attacker-controlled text. They are rendered as JSX text
 * children only — never `dangerouslySetInnerHTML`, never a template literal sent
 * to `innerHTML`. React escapes at render time, and the API deliberately returns
 * the raw string (escaping in the service would corrupt the transcript for every
 * other consumer). `tests/inbox/detail.test.ts` fails if a
 * `dangerouslySetInnerHTML` ever appears in this file, because that is the one
 * edit that would quietly turn a guest message into script.
 *
 * ## Why `<details>` and not a diff
 *
 * The sources pane answers "where did this come from?". The quote is shown open
 * (it is the answer to the question), the full version body is collapsed (it is
 * 19,000 characters of noticeboard), and a citation whose version is no longer
 * current is labelled — because an answer citing an older version is history
 * working correctly, not an error the staff member should chase.
 */
interface Loaded {
  status: number;
  body: ConversationDetailWire | ApiFailure;
}

async function load(session: StaffCookieSession, conversationId: string): Promise<Loaded> {
  try {
    const response = await fetch(
      `${apiBase()}/api/inbox/conversations/${encodeURIComponent(conversationId)}`,
      {
        headers: {
          authorization: `Bearer ${session.token}`,
          "x-org-id": session.orgId,
          "x-property-id": session.propertyId,
        },
        cache: "no-store",
      },
    );
    const parsed = (await response.json().catch(() => ({
      error: "invalid_response",
    }))) as ConversationDetailWire | ApiFailure;
    return { status: response.status, body: parsed };
  } catch {
    return { status: 502, body: { error: "upstream_unreachable" } };
  }
}

const AUTHOR_LABEL = {
  guest: "staff.inbox.author_guest",
  ai: "staff.inbox.author_ai",
  staff: "staff.inbox.author_staff",
} as const;

const DECISION_LABEL = {
  answer: "staff.inbox.decision_answer",
  escalate: "staff.inbox.decision_escalate",
  no_answer: "staff.inbox.decision_no_answer",
} as const;

/**
 * S08-03 — the action bar is three plain forms.
 *
 * Not a client component and not a fetch: a form posting to a server action works
 * before hydration, cannot leak the bearer token to the browser, and leaves the
 * "which actions exist" decision in the role matrix (an observer's POST is a 403
 * from the API, rendered as a sentence). The buttons shown are a courtesy, not the
 * authorisation.
 */
const PROBLEM_IDS = {
  invalid: "staff.inbox.problem_invalid",
  forbidden: "staff.inbox.problem_forbidden",
  missing: "staff.inbox.problem_missing",
  conflict: "staff.inbox.problem_conflict",
  error: "staff.inbox.problem_error",
} as const;

const OPEN_REQUEST = OPEN_REQUEST_STATUSES;

export default async function ConversationDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ conversationId: string }>;
  searchParams: Promise<{ problem?: string }>;
}): Promise<React.ReactElement> {
  const session = await readSession();
  if (session === null) redirect("/session");

  const { conversationId } = await params;
  const { problem } = await searchParams;
  const lang = await currentLang();
  const tr = translator(lang);
  const loaded = await load(session, conversationId);

  if (loaded.status !== 200) {
    const missing = loaded.status === 404;
    return (
      <div className="space-y-4">
        <BackLink label={tr("staff.inbox.back")} />
        <div className="rounded-lg border border-destructive/40 p-6">
          <p className="text-sm font-medium text-destructive">
            {missing ? tr("staff.inbox.not_found") : tr("staff.inbox.error")}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {(loaded.body as ApiFailure).error} · HTTP {loaded.status}
          </p>
        </div>
      </div>
    );
  }

  const detail = loaded.body as ConversationDetailWire;
  const formatTime = (iso: string): string =>
    new Intl.DateTimeFormat(lang === "es" ? "es-MX" : "en-US", {
      timeZone: detail.timeZone,
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));

  const openRequest = detail.requests.find((request) => OPEN_REQUEST.has(request.status));

  return (
    <div className="space-y-4">
      <BackLink label={tr("staff.inbox.back")} />

      {problem === undefined ? null : (
        <p className="rounded border border-destructive/40 p-2 text-xs text-destructive">
          {tr(PROBLEM_IDS[problem as keyof typeof PROBLEM_IDS] ?? "staff.inbox.problem_error")}
        </p>
      )}

      <section className="space-y-2 rounded-lg border p-3">
        <h2 className="text-sm font-semibold">{tr("staff.inbox.actions")}</h2>
        <form action={replyAction} className="space-y-1">
          <input type="hidden" name="conversationId" value={detail.conversationId} />
          <label className="block text-[11px] font-medium" htmlFor="reply-body">
            {tr("staff.inbox.reply")}
          </label>
          <textarea
            id="reply-body"
            name="body"
            required
            maxLength={2000}
            rows={3}
            className="w-full rounded border bg-background p-2 text-sm"
          />
          <p className="text-[11px] text-muted-foreground">{tr("staff.inbox.reply_hint")}</p>
          <button
            type="submit"
            className="rounded bg-foreground px-3 py-1.5 text-xs font-medium text-background"
          >
            {tr("staff.inbox.send")}
          </button>
        </form>

        <div className="flex flex-wrap gap-2 border-t pt-2">
          {detail.aiState === "awaiting_staff" ? null : (
            <form action={takeOverAction}>
              <input type="hidden" name="conversationId" value={detail.conversationId} />
              <button
                type="submit"
                className="rounded border px-3 py-1.5 text-xs font-medium"
                title={tr("staff.inbox.take_over_hint")}
              >
                {tr("staff.inbox.take_over")}
              </button>
            </form>
          )}
          {/*
            S09-01 — the lifecycle, one button per edge the caller can legally
            walk from where this request currently is. Showing all four always
            would put a button on screen that the database is about to refuse:
            the guard in 0024 answers 409 to `new → resolved`, and a button that
            reliably fails teaches staff to ignore the screen.
          */}
          {openRequest === undefined || openRequest.status !== "new" ? null : (
            <form action={acknowledgeAction}>
              <input type="hidden" name="conversationId" value={detail.conversationId} />
              <input type="hidden" name="requestId" value={openRequest.requestId} />
              <button
                type="submit"
                className="rounded border px-3 py-1.5 text-xs font-medium"
                title={tr("staff.inbox.acknowledge_hint")}
              >
                {tr("staff.inbox.acknowledge")}
              </button>
            </form>
          )}
          {openRequest === undefined || openRequest.status === "assigned" ||
          openRequest.status === "resolved" || openRequest.status === "cancelled" ? null : (
            <form action={assignToMeAction}>
              <input type="hidden" name="conversationId" value={detail.conversationId} />
              <input type="hidden" name="requestId" value={openRequest.requestId} />
              <button type="submit" className="rounded border px-3 py-1.5 text-xs font-medium">
                {tr("staff.inbox.assign_me")}
              </button>
            </form>
          )}
          {openRequest === undefined || openRequest.status !== "assigned" ? null : (
            <form action={cancelRequestAction}>
              <input type="hidden" name="conversationId" value={detail.conversationId} />
              <input type="hidden" name="requestId" value={openRequest.requestId} />
              <button type="submit" className="rounded border px-3 py-1.5 text-xs font-medium">
                {tr("staff.inbox.cancel_request")}
              </button>
            </form>
          )}
          {detail.aiState === "resolved" ? null : (
            <form action={resolveAction}>
              <input type="hidden" name="conversationId" value={detail.conversationId} />
              <button
                type="submit"
                className="rounded border px-3 py-1.5 text-xs font-medium"
                title={tr("staff.inbox.resolve_hint")}
              >
                {tr("staff.inbox.resolve")}
              </button>
            </form>
          )}
        </div>
      </section>

      <header className="space-y-1">
        <h1 className="text-lg font-semibold tracking-tight">{tr("staff.inbox.transcript")}</h1>
        <p className="text-[11px] text-muted-foreground">
          {tr(`staff.inbox.state_${detail.aiState}` as StringId)} · {detail.timeZone}
        </p>
      </header>

      <ol className="space-y-3">
        {detail.messages.map((message) => (
          <li key={message.messageId}>
            <MessageBubble message={message} tr={tr} formatTime={formatTime} />
          </li>
        ))}
      </ol>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">{tr("staff.inbox.requests")}</h2>
        {detail.requests.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">{tr("staff.inbox.no_requests")}</p>
        ) : (
          <ul className="space-y-1">
            {detail.requests.map((request) => (
              <li key={request.requestId} className="text-[11px] text-muted-foreground">
                {request.topic ?? "—"} · {tr(REQUEST_LABEL[request.status])} ·{" "}
                {formatTime(request.createdAt)}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function BackLink({ label }: { label: string }): React.ReactElement {
  return (
    <Link href="/inbox" className="text-xs text-muted-foreground hover:text-foreground">
      ← {label}
    </Link>
  );
}

function MessageBubble({
  message,
  tr,
  formatTime,
}: {
  message: DetailMessageWire;
  tr: (id: StringId) => string;
  formatTime: (iso: string) => string;
}): React.ReactElement {
  const fromGuest = message.authorRole === "guest";
  return (
    <div
      // S09-03 hooks the one-click "wrong or outdated" flag onto this attribute;
      // adding it now means that item needs no markup archaeology.
      {...(message.aiRun === null ? {} : { "data-ai-run-id": message.aiRun.aiRunId })}
      className={
        fromGuest
          ? "rounded-lg border bg-muted/40 p-3"
          : "rounded-lg border border-dashed p-3"
      }
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[11px] font-medium">{tr(AUTHOR_LABEL[message.authorRole])}</span>
        <span className="text-[11px] text-muted-foreground">{formatTime(message.createdAt)}</span>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-sm">{message.body}</p>

      {message.aiRun === null ? null : (
        <section className="mt-3 space-y-2 border-t pt-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <h3 className="text-[11px] font-semibold text-foreground">
              {tr("staff.inbox.sources")}
            </h3>
            <span>
              {tr("staff.inbox.decision")}: {tr(DECISION_LABEL[message.aiRun.decision])}
            </span>
            <span>
              {tr("staff.inbox.model")}: {message.aiRun.modelId}
            </span>
            <span>
              {tr("staff.inbox.prompt_version")}: {message.aiRun.promptVersion}
            </span>
            {message.aiRun.reasonCode === null ? null : (
              <span>
                {tr("staff.inbox.reason")}: {message.aiRun.reasonCode}
              </span>
            )}
            {message.aiRun.confidence === null ? null : (
              <span>
                {tr("staff.inbox.confidence")}: {message.aiRun.confidence}
              </span>
            )}
          </div>

          {message.aiRun.citations.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">{tr("staff.inbox.no_sources")}</p>
          ) : (
            <ul className="space-y-2">
              {message.aiRun.citations.map((citation) => (
                <li
                  key={citation.articleVersionId}
                  className="rounded border bg-background p-2 text-xs"
                >
                  <p className="font-medium">
                    {tr("staff.inbox.article_version")
                      .replace("{number}", String(citation.versionNo))
                      .replace("{title}", citation.title)}
                  </p>
                  {citation.isCurrent ? null : (
                    <p className="mt-0.5 text-[11px] text-amber-700">
                      {tr("staff.inbox.not_current")}
                    </p>
                  )}
                  {citation.quote === null ? null : (
                    <blockquote className="mt-1 border-l-2 pl-2 italic">
                      <span className="text-[11px] not-italic text-muted-foreground">
                        {tr("staff.inbox.quote")}:{" "}
                      </span>
                      {citation.quote}
                    </blockquote>
                  )}
                  <details className="mt-1">
                    <summary className="cursor-pointer text-[11px] text-muted-foreground">
                      {tr("staff.inbox.article_version")
                        .replace("{number}", String(citation.versionNo))
                        .replace("{title}", citation.title)}
                    </summary>
                    <p className="mt-1 whitespace-pre-wrap text-[11px] text-muted-foreground">
                      {citation.body}
                    </p>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
