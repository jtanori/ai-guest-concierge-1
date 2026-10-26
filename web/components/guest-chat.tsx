"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  handoffPath,
  messagesPath,
  type ApiFailure,
  type GuestHandoffWire,
  type GuestMessageWire,
  type GuestTranscriptWire,
  type GuestTurnWire,
} from "@/lib/guest";

/**
 * S06-01 — the guest chat, as a stranger actually meets it.
 *
 * Three things this component refuses to do, each for a reason:
 *
 *  - **It never decides what the bot says.** The reply text is rendered exactly
 *    as the API returned it. There is no local fallback copy, no "typing…"
 *    placeholder that pretends to be an answer, and no client-side composition.
 *  - **It shows the AI disclosure before the first answer** (AC-3) and offers a
 *    route to a human at all times. Since S07-02 the button is its own request
 *    (`POST /api/chat/handoff`), not a message: it works from every state the
 *    conversation can be in — including `awaiting_staff`, where a message would
 *    only be queued behind the human, and `resolved`, where a message would go
 *    back to the model. The server records the handoff, opens a request for the
 *    inbox to notify on, and answers with catalogue copy. Nothing about this
 *    path touches the model, so it keeps working when the provider is down.
 *  - **It never sends a tenant.** Requests carry the slug and the text only; the
 *    signed cookie carries the identity. A compromised page can therefore only
 *    say what a guest could say.
 */
export interface GuestChatLabels {
  heading: string;
  empty: string;
  placeholder: string;
  send: string;
  error: string;
  disclosure: string;
  talkToPerson: string;
}

interface Props {
  slug: string;
  lang: "es" | "en";
  propertyName: string;
  labels: GuestChatLabels;
}

export function GuestChat({
  slug,
  lang,
  propertyName,
  labels,
}: Props): React.ReactElement {
  const [messages, setMessages] = React.useState<GuestMessageWire[]>([]);
  const [draft, setDraft] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  /** S07-02: the guest asked for a person; the button becomes a status. */
  const [handedOff, setHandedOff] = React.useState(false);
  const endRef = React.useRef<HTMLDivElement | null>(null);

  const load = React.useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(messagesPath(slug, lang), { cache: "no-store" });
      if (!response.ok) return;
      const body = (await response.json()) as GuestTranscriptWire | ApiFailure;
      if ("messages" in body) setMessages(body.messages);
    } catch {
      // A failed transcript read is not worth a banner: the guest has not typed
      // anything yet, and the composer below still works.
    }
  }, [slug, lang]);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, busy]);

  async function send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === "" || busy) return;
    setBusy(true);
    setProblem(null);
    // The guest's own words appear immediately; the assistant bubble appears
    // only when the server has a persisted answer to show.
    setMessages((current) => [
      ...current,
      {
        messageId: `local-${String(Date.now())}`,
        direction: "inbound",
        authorRole: "guest",
        body: trimmed,
        createdAt: new Date().toISOString(),
      },
    ]);
    setDraft("");
    try {
      const response = await fetch(messagesPath(slug, lang), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: trimmed }),
      });
      const body = (await response.json()) as GuestTurnWire | ApiFailure;
      if (!response.ok || !("messages" in body)) {
        setProblem(labels.error);
        return;
      }
      setMessages((current) => [
        // Drop the optimistic bubble: the server's row is the record.
        ...current.filter((message) => !message.messageId.startsWith("local-")),
        ...body.messages,
      ]);
    } catch {
      setProblem(labels.error);
    } finally {
      setBusy(false);
    }
  }

  /**
   * S07-02 — the one tap. Not `send(...)`: this is a different request with a
   * different meaning, and routing it through the composer would make it
   * depend on the model path the button exists to bypass.
   */
  async function requestHandoff(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const response = await fetch(handoffPath(slug, lang), { method: "POST" });
      const body = (await response.json()) as GuestHandoffWire | ApiFailure;
      if (!response.ok || !("message" in body)) {
        setProblem(labels.error);
        return;
      }
      setMessages((current) => [...current, body.message]);
      setHandedOff(true);
    } catch {
      setProblem(labels.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mx-auto flex min-h-dvh max-w-2xl flex-col px-4 py-6">
      <header className="mb-4 border-b pb-3">
        <h1 className="text-lg font-semibold tracking-tight">{propertyName}</h1>
        <p className="text-xs text-muted-foreground">{labels.heading}</p>
      </header>

      {/* AC-3: the disclosure is visible before the first answer, not buried
          behind a menu. */}
      <p className="mb-4 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        {labels.disclosure}
      </p>

      <div className="flex-1 space-y-3 overflow-y-auto" aria-live="polite">
        {messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">{labels.empty}</p>
        ) : (
          messages.map((message) => (
            <div
              key={message.messageId}
              className={
                message.direction === "inbound"
                  ? "ml-auto max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground"
                  : "mr-auto max-w-[85%] rounded-lg bg-muted px-3 py-2 text-sm"
              }
            >
              {message.body}
            </div>
          ))
        )}
        {busy ? <p className="text-xs text-muted-foreground">…</p> : null}
        <div ref={endRef} />
      </div>

      {problem !== null ? (
        <p className="mt-3 rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">
          {problem}
        </p>
      ) : null}

      <form
        className="mt-4 flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send(draft);
        }}
      >
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={labels.placeholder}
          aria-label={labels.placeholder}
          maxLength={2000}
          disabled={busy}
        />
        <Button type="submit" disabled={busy || draft.trim() === ""}>
          {labels.send}
        </Button>
      </form>

      <div className="mt-2">
        {/* After a handoff the copy stays (it is what the guest asked for), but
            the control stops being an action: the server has the request and a
            second tap would only re-state it. */}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy || handedOff}
          aria-live="polite"
          onClick={() => void requestHandoff()}
        >
          {labels.talkToPerson}
        </Button>
      </div>
    </section>
  );
}
