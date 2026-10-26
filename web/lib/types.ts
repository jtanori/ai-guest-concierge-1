/**
 * The wire shapes of `src/staff/http.ts`. They mirror `ReviewQueueItem` and
 * `Contradiction` with dates as ISO strings, because that is what JSON does —
 * keeping them here (rather than importing the service's types) stops the
 * screen from quietly assuming a Date object it never receives.
 */
export interface ReviewQueueItemWire {
  articleVersionId: string;
  articleId: string;
  versionNo: number;
  isCurrent: boolean;
  status: "unreviewed" | "pending" | "approved" | "rejected";
  requestedAt: string | null;
  reviewerUserId: string | null;
  decidedAt: string | null;
}

export interface ContradictionEntryWire {
  factId: string;
  value: string;
  verified: boolean;
  sourceArticleVersionId: string | null;
}

export interface ContradictionWire {
  topicKey: string;
  factKey: string;
  language: string;
  effectiveFrom: string | null;
  entries: ContradictionEntryWire[];
}

export interface ApiFailure {
  error: string;
  detail?: string;
}

/**
 * S08-01 — one row of the staff inbox, as `src/inbox/queries.ts` serialises it.
 *
 * `waitSeconds` is a number and not a date because the server computes it from
 * the database clock: a phone with a skewed clock must not show "-3 min
 * waiting", and "who has waited longest" is the only ordering the screen
 * promises.
 */
export interface InboxItemWire {
  conversationId: string;
  aiState: "idle" | "awaiting_ai" | "awaiting_staff" | "resolved";
  language: string | null;
  lastActivityAt: string;
  waitSeconds: number;
  lastMessage: { body: string; authorRole: "guest" | "ai" | "staff"; createdAt: string } | null;
  request: {
    requestId: string;
    status: "new" | "acknowledged" | "assigned" | "resolved" | "cancelled";
    topic: string | null;
    assignedTo: string | null;
  } | null;
}

export interface InboxPageWire {
  items: InboxItemWire[];
  nextCursor: string | null;
}
