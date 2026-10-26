import type { StringId } from "./i18n";

/**
 * S09-01 — the request vocabulary, in exactly one place.
 *
 * The inbox list already localised these five words; the conversation detail
 * rendered `request.status` raw. So the same request read "Request:
 * acknowledged" on one screen and "acknowledged" on the one you click through
 * to — and, worse, the raw rendering had no ceiling: a sixth status would have
 * appeared in English on the Spanish screen with nothing failing. Both screens
 * read this module now, and `REQUEST_LABEL` is typed `Record<RequestStatus, …>`,
 * so adding a status to the union is a compile error until it is translated.
 */
export const REQUEST_STATUSES = [
  "new",
  "acknowledged",
  "assigned",
  "resolved",
  "cancelled",
] as const;

export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const REQUEST_LABEL: Record<RequestStatus, StringId> = {
  new: "staff.inbox.request_status_new",
  acknowledged: "staff.inbox.request_status_acknowledged",
  assigned: "staff.inbox.request_status_assigned",
  resolved: "staff.inbox.request_status_resolved",
  cancelled: "staff.inbox.request_status_cancelled",
};

/**
 * "Open" means a person can still move it.
 *
 * 0024 makes `resolved` and `cancelled` terminal, so a closed request must not
 * offer a button at all: the API would answer 409, and a button that always
 * fails is worse than no button because it teaches staff that the screen lies.
 */
export const OPEN_REQUEST_STATUSES: ReadonlySet<RequestStatus> = new Set<RequestStatus>([
  "new",
  "acknowledged",
  "assigned",
]);
