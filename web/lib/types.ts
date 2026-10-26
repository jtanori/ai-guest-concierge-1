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
