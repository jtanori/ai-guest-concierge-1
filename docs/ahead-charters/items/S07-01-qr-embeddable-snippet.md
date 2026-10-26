---
id: S07-01
title: QR + embeddable snippet
sprint: S07
epic: S07 - Chat hardening
track: Eng
estimate_days: 0.5
priority: P0
depends_on: [S06-01]
labels: [sprint:S07, track:foundation, prio:P0]
milestone: S07 - Chat hardening
status: done
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/79
pickup: decision
---

# S07-01 — QR + embeddable snippet

> **CLOSED — implemented and verified.** The decisions this charter left open are recorded in §8 and the close-out is §10; the runbook entry (`docs/runbook.md`) carries the exact commands and counts. §4's calculated file paths were rebased on the tree as it stood when work started — where the code ended up somewhere else, §10 says where and why.

| | |
|---|---|
| Sprint | S07 |
| Track / days / priority | Eng · 0.5d · P0 |
| Depends on | S06-01 |
| Pickup | `decision` |

## 1. Why / goal

A guest reaches the right property by scanning a code on a real phone.

## 2. Acceptance criteria (backlog AC verbatim)

> QR resolves to the right property on a real phone.

- **AC-1** `GET /c/:slug/qr.svg` returns a scannable SVG encoding the public chat URL.
- **AC-2** A copy-paste `<script>`/iframe snippet embeds the same chat on the hotel site.

## 3. Scope

**In:** QR endpoint, snippet endpoint, property-slug validation.

**Out:** Print design; WhatsApp entry point (WA track).

## 4. Calculated changes (for the coding agent)

- `src/http/qr.ts`: pure URL builder `chatUrl(base, slug)` + `GET /c/:slug/qr.svg` handler. QR encoding needs a library — **prefer vendoring a tiny QR encoder or use `qrcode` as a devDependency with explicit approval**; do not call an external QR image service (it would leak the URL and add a third party).
- `GET /c/:slug/embed.js` returns a small script that injects an iframe pointing at the same-origin chat; set `Content-Security-Policy: frame-ancestors` allowlist from `properties.settings` (S02-02) so only the hotel's domain can embed.
- Add `tests/http/qr.test.ts` for slug validation (reject `../`, unicode lookalikes, >120 chars) and a phone-scan evidence screenshot in the runbook.

## 5. Tenancy & security

Slug → tenant resolution is the same `resolvePublicProperty` as S06-01; never accept a tenant id in the QR payload.

## 6. Test plan (named cases)

- `tests/http/qr.test.ts`
- manual: scan on a real phone (evidence photo/URL in runbook)

## 7. Evidence to record in the runbook

- `npm test && npm run typecheck && npm run lint && npm run build`

## 8. Pickup status, blockers and decisions

**NEEDS DECISION — see §8. Calculations are complete where possible; the named decision must close first.**

**CLOSED — decisions.**

- **QR dependency: `qrcode` (+ `@types/qrcode`), operator-approved 2026-10-25.** Rejected: a hand-rolled encoder. A QR that is subtly wrong does not fail a test or a build — it is a laminated card in a lobby that scans to nothing, discovered by a guest. It is the only new runtime dependency this item added.
- **DEC-1 (UI) does not bite here.** The two new surfaces are a file download and a JavaScript file; neither renders a screen, so no Shadcn/Tailwind component was needed. The embed's accessible name is catalogue copy (`guest.chat.heading`), not a literal.
- **Allowlist enforcement is server-side, per property**, in Next middleware (there is no per-page header API in the App Router). See §10 for the `concierge_public` grant problem and how it was solved without widening the guest role.

## 9. Definition of done

- [x] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [x] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [x] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [x] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [x] Review threads resolved; charter §9 decisions recorded in the runbook.

## 10. Close-out

**AC-1 — `GET /c/:slug/qr.svg` returns a scannable SVG of the public chat URL.**
Met. The route 404s for a slug that does not resolve (a QR outlives the deploy that
printed it, so a QR of a 404 is a published 404), then encodes exactly
`<base>/c/<slug>` with error-correction level M, as vector SVG. The payload is the
plain URL — no tenant id, no token, no tracking parameter — so a photographed card
leaks only what a guest could have typed.

The encoded string is pinned by test, and the *served* bytes were compared against
a fresh encode of the expected URL while the stack was running (`served QR encodes
https://…/c/demo exactly: true`). **Still owed: one scan on a real phone**, which
is a human action this environment cannot perform; it is recorded as an open item
in the runbook rather than claimed here.

**AC-2 — a copy-paste `<script>`/iframe snippet embeds the same chat.**
Met. `GET /c/:slug/embed.txt` is the snippet as text (`<div>` + one async `<script>`),
`GET /c/:slug/embed.js` is the script it loads, and both are built by the same
`embedSnippet()` / `embedScript()` the tests exercise — so what is handed to a hotel
is what was verified. The script mounts into `#concierge-chat` when the container
exists and next to its own tag when it does not. Framing is enforced server-side:
`Content-Security-Policy: frame-ancestors 'self' <allowlist>` on `/c/:slug`, from
`settings.embed.allowed_origins` (migration **0020**), default `[]` = nobody.

**Where the code actually lives** (§4 said `src/http/qr.ts`; there is no `src/http/`
in this tree):

| Concern | File |
|---|---|
| URL building, origin matching, snippet/script generation | `src/guest/links.ts` |
| QR encoding | `src/guest/qr.ts` |
| QR route (the web route proxies it) | `src/guest/http.ts` — `GET /api/chat/qr.svg` |
| Allowlist storage + validation | `db/migrations/0020_embed_settings.sql`, `src/settings/schema.ts` |
| Framing header (per property, 60s in-memory cache) | `web/middleware.ts` |
| Routes | `web/app/c/[slug]/qr.svg/`, `.../embed.js/`, `.../embed.txt/` |

**The 0015 grant problem.** `concierge_public` holds a column grant on `properties`
that deliberately excludes `settings` (settings carry staff contact details), so the
guest role cannot read the allowlist. Rather than widen a guest grant for a framing
policy, `src/guest/session.ts` copies `embed.allowed_origins` out **after** switching
up to `concierge_app`, into a separate `frameAncestors` field on the public property
view. A settings value that fails to parse yields `[]` (nobody may embed) rather
than a 500 — embedding is a distribution channel, the chat is the product.
`tests/db/guest-chat.db.test.ts` pins both the value and the fact that the public
view still exposes exactly six fields.

**Two failures that only a running process found.** The web QR route first
imported `src/guest/qr.ts` directly, which builds locally and fails in CI (`web-build`
installs only `web/`'s dependencies, so `qrcode` is missing and a cross-project
import never resolves into `web/node_modules`) — the encoder now runs in the API and
the web route proxies it. And `GuestRawResponse` used TypeScript parameter
properties, which type-check, pass vitest and crash at boot under
`--experimental-strip-types`. Both are recorded in the runbook.

**Bug found by running it, not by testing it.** The first version of the snippet
emitted `/c/demo?lang=es/embed.js` — the query string before the file name, a 404
every time. `embedScriptUrl()` and a named assertion now exist because of it; the
lesson (curl the running stack before believing the unit test) is in the runbook.

**Evidence:** `npm test` 500 passed (38 files); `npm run db:test` 243 passed;
`npm run lint` clean; `npx tsc --noEmit` clean; `npm run web:build` green with the
three new routes; live run of API + web confirming `200 image/svg+xml`,
`200 text/plain` snippet, `200 application/javascript` script, and
`frame-ancestors 'self' https://hotel.example http://localhost:4000` once the
allowlist was set.
