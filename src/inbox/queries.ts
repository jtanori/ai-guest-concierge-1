/**
 * S08-01 — the staff inbox queries.
 *
 * AC (verbatim): *"An agent triages a queue on a phone in under 60 seconds."*
 *
 * That sentence is about the screen, but it is decided here: a phone shows four
 * rows, so the page has to arrive in one round trip, already sorted by who has
 * been waiting longest, with the thing the agent needs to decide (the last
 * message) attached to each row. Three separate queries — conversations, then
 * messages per conversation, then requests per conversation — is how an inbox
 * takes four seconds on a phone and stops being used.
 *
 * ## The three filters, and what each one actually means
 *
 *  - `needs_attention` — `ai_state = 'awaiting_staff'`: the guest said something
 *    a person must answer. This is the default, because it is the only filter
 *    where doing nothing has a cost.
 *  - `mine` — a `service_requests` row assigned to the caller (S08-03 owns the
 *    assignment action; this filter reads what it will write).
 *  - `unresolved` — any request still in `new | acknowledged | assigned`.
 *    Deliberately not "ai_state != resolved": a conversation can be answered and
 *    finished while a request it opened is still outstanding, and that is
 *    exactly the row a hotel loses track of.
 *
 * ## Tenancy
 *
 * Every statement carries `org_id = $1 AND property_id = $2` explicitly, in
 * addition to RLS and in addition to `withStaffSession`'s GUCs. The charter asks
 * for that belt-and-braces because the inbox is the first read that joins four
 * tenant tables at once: one join condition missing a tenant column would leak
 * another property's conversation into a queue, and a queue is a list a human
 * reads and acts on.
 *
 * ## Paging
 *
 * Keyset, not OFFSET. A guest message between page 1 and page 2 re-sorts an
 * OFFSET query, which means the agent silently sees a row twice or never sees
 * one at all. The cursor is `(last_activity_at, conversation_id)` encoded as
 * opaque base64url so it cannot be hand-edited into a different tenant's range —
 * and it cannot reach one anyway, because the tenant predicate is applied first.
 */
import type pg from "pg";
import { assertTenantShape, type TenantContext } from "../db/tenant.ts";
import type { StaffSession } from "../auth/context.ts";

/** The closed filter set. Anything else is a 400, not a silent default. */
export const INBOX_FILTERS = ["needs_attention", "mine", "unresolved"] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number];
export const DEFAULT_INBOX_FILTER: InboxFilter = "needs_attention";

export const INBOX_PAGE_DEFAULT = 20;
/** A phone shows ~5 rows; 50 is the ceiling so one request cannot ask for the property. */
export const INBOX_PAGE_MAX = 50;

export type InboxAiState = "idle" | "awaiting_ai" | "awaiting_staff" | "resolved";
export type InboxRequestStatus = "new" | "acknowledged" | "assigned" | "resolved" | "cancelled";

export interface InboxItem {
  conversationId: string;
  aiState: InboxAiState;
  language: string | null;
  /** ISO-8601, UTC. The screen formats it in the property's time zone. */
  lastActivityAt: string;
  /** Whole seconds since the last activity. Computed in SQL, from the same clock. */
  waitSeconds: number;
  lastMessage: {
    body: string;
    authorRole: "guest" | "ai" | "staff";
    createdAt: string;
  } | null;
  request: {
    requestId: string;
    status: InboxRequestStatus;
    topic: string | null;
    assignedTo: string | null;
  } | null;
}

export interface InboxPage {
  items: InboxItem[];
  /** `null` means the last page. Opaque; the client must not parse it. */
  nextCursor: string | null;
}

export interface InboxPageInput {
  filter?: string | null;
  limit?: number | string | null;
  cursor?: string | null;
}

export class InboxInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboxInputError";
  }
}

export function parseFilter(value: string | null | undefined): InboxFilter {
  if (value === null || value === undefined || value === "") return DEFAULT_INBOX_FILTER;
  // Not `includes` on a widened string: an unknown filter must be refused, not
  // quietly served as needs_attention. An agent who asks for the wrong queue and
  // gets a different one has no way to notice.
  if ((INBOX_FILTERS as readonly string[]).includes(value)) return value as InboxFilter;
  throw new InboxInputError(
    `unknown filter "${value}"; expected one of ${INBOX_FILTERS.join(", ")}`,
  );
}

export function parseLimit(value: number | string | null | undefined): number {
  if (value === null || value === undefined || value === "") return INBOX_PAGE_DEFAULT;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InboxInputError("limit must be a positive integer");
  }
  // Clamped, not refused: asking for 500 is a client being greedy, not a client
  // being wrong, and the answer to greed is a smaller page.
  return Math.min(parsed, INBOX_PAGE_MAX);
}

interface Cursor {
  at: string;
  id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(value: string | null | undefined): Cursor | null {
  if (value === null || value === undefined || value === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new InboxInputError("cursor is not valid base64url JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InboxInputError("cursor must be an object");
  }
  const { at, id } = parsed as Record<string, unknown>;
  if (typeof at !== "string" || !ISO_RE.test(at) || Number.isNaN(Date.parse(at))) {
    throw new InboxInputError("cursor.at must be an ISO-8601 timestamp");
  }
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    throw new InboxInputError("cursor.id must be a UUID");
  }
  return { at, id };
}

/**
 * The page query.
 *
 * One statement, because the inbox cannot afford a round trip per row and
 * because "the last message" and "the open request" are display fields, not
 * decisions: a `LEFT JOIN LATERAL ... LIMIT 1` keeps them attached to the row
 * that was already chosen by the ordered scan.
 *
 * Kept as an exported constant so `tests/inbox/queries.test.ts` can assert the
 * shape (no write clause, tenant predicate present, index-friendly ordering)
 * without a database.
 */
export const INBOX_PAGE_SQL = `
SELECT c.conversation_id,
       c.ai_state,
       c.language,
       c.last_activity_at,
       EXTRACT(EPOCH FROM (now() - c.last_activity_at))::bigint AS wait_seconds,
       m.body AS last_message_body,
       m.author_role AS last_message_author,
       m.created_at AS last_message_at,
       r.request_id,
       r.status AS request_status,
       r.topic AS request_topic,
       a.assigned_to
  FROM conversations c
  LEFT JOIN LATERAL (
         SELECT body, author_role, created_at
           FROM messages
          WHERE org_id = c.org_id
            AND property_id = c.property_id
            AND conversation_id = c.conversation_id
          ORDER BY created_at DESC, message_id DESC
          LIMIT 1
       ) m ON true
  LEFT JOIN LATERAL (
         SELECT request_id, status, topic
           FROM service_requests
          WHERE org_id = c.org_id
            AND property_id = c.property_id
            AND conversation_id = c.conversation_id
          ORDER BY created_at DESC, request_id DESC
          LIMIT 1
       ) r ON true
  LEFT JOIN LATERAL (
         SELECT assigned_to
           FROM assignments
          WHERE org_id = c.org_id
            AND property_id = c.property_id
            AND request_id = r.request_id
          ORDER BY created_at DESC, assignment_id DESC
          LIMIT 1
       ) a ON true
 WHERE c.org_id = $1
   AND c.property_id = $2
   AND (
        $3 = 'needs_attention' AND c.ai_state = 'awaiting_staff'
     OR $3 = 'unresolved' AND EXISTS (
          SELECT 1 FROM service_requests rs
           WHERE rs.org_id = c.org_id
             AND rs.property_id = c.property_id
             AND rs.conversation_id = c.conversation_id
             AND rs.status IN ('new', 'acknowledged', 'assigned'))
     OR $3 = 'mine' AND EXISTS (
          SELECT 1
            FROM service_requests rs
            JOIN assignments asg
              ON asg.org_id = rs.org_id
             AND asg.property_id = rs.property_id
             AND asg.request_id = rs.request_id
           WHERE rs.org_id = c.org_id
             AND rs.property_id = c.property_id
             AND rs.conversation_id = c.conversation_id
             AND asg.assigned_to = $4)
       )
   AND ($5::timestamptz IS NULL OR (c.last_activity_at, c.conversation_id) < ($5::timestamptz, $6::uuid))
 ORDER BY c.last_activity_at DESC, c.conversation_id DESC
 LIMIT $7
`;

interface Row {
  conversation_id: string;
  ai_state: InboxAiState;
  language: string | null;
  last_activity_at: Date;
  wait_seconds: string | number;
  last_message_body: string | null;
  last_message_author: "guest" | "ai" | "staff" | null;
  last_message_at: Date | null;
  request_id: string | null;
  request_status: InboxRequestStatus | null;
  request_topic: string | null;
  assigned_to: string | null;
}

/**
 * One page of the inbox.
 *
 * `session.requireRole("queue", "read")` is the first statement, so a caller
 * whose role is not allowed never reaches a query — the same rule the review
 * queue follows, and the reason `observer` can read the queue too (the role
 * matrix grants `queue: read` to all four roles; see §10 of the charter).
 */
export async function listInbox(
  client: pg.Client | pg.PoolClient,
  context: TenantContext,
  session: StaffSession,
  input: InboxPageInput = {},
): Promise<InboxPage> {
  session.requireRole("queue", "read");
  assertTenantShape(context);

  const filter = parseFilter(input.filter);
  const limit = parseLimit(input.limit);
  const cursor = decodeCursor(input.cursor);

  const result = await client.query<Row>(INBOX_PAGE_SQL, [
    context.orgId,
    context.propertyId,
    filter,
    session.userUuid,
    cursor === null ? null : cursor.at,
    cursor === null ? null : cursor.id,
    // One extra row: its presence is how we know there is a next page without a
    // COUNT over the whole property.
    limit + 1,
  ]);

  const rows = result.rows.slice(0, limit);
  const hasMore = result.rows.length > limit;
  const last = rows.at(-1);

  return {
    items: rows.map(toItem),
    nextCursor:
      hasMore && last !== undefined
        ? encodeCursor({ at: last.last_activity_at.toISOString(), id: last.conversation_id })
        : null,
  };
}

function toItem(row: Row): InboxItem {
  return {
    conversationId: row.conversation_id,
    aiState: row.ai_state,
    language: row.language,
    lastActivityAt: row.last_activity_at.toISOString(),
    // `bigint` arrives as a string from node-postgres; the screen wants a number
    // and the values here are seconds, nowhere near 2^53.
    waitSeconds: Number(row.wait_seconds),
    lastMessage:
      row.last_message_body === null
        ? null
        : {
            body: row.last_message_body,
            authorRole: row.last_message_author ?? "guest",
            createdAt: (row.last_message_at ?? row.last_activity_at).toISOString(),
          },
    request:
      row.request_id === null
        ? null
        : {
            requestId: row.request_id,
            status: row.request_status ?? "new",
            topic: row.request_topic,
            assignedTo: row.assigned_to,
          },
  };
}
