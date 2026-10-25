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
status: draft
issue: https://github.com/jtanori/ai-guest-concierge-1/issues/79
pickup: decision
---

# S07-01 — QR + embeddable snippet

> **DRAFT — not approved.** Generated from the master backlog, `docs/01-development-plan.md` and the code at `main` + PR #32 head `81b19bb`. `docs/charters/README.md` says **"No item starts until its charter is approved"** — this file is a proposed contract, not permission to start. File paths, migration numbers and signatures are calculated from the current tree; rebase them on whatever merges first.

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

Open decisions / blockers:

- **DEC-1 (UI) + a QR dependency decision.** Default: implement a minimal QR encoder in-repo (no dependency) or approve one small devDependency. Everything else calculated.

## 9. Definition of done

- [ ] CI green: `lint`, `typecheck`, `test`, `db-test`, `preview` (and `eval` once S06-03 lands).
- [ ] Runbook entry in `docs/runbook.md` with the exact commands and counts.
- [ ] Workbook ticked via `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"` only after the AC is objectively met.
- [ ] Cross-tenant isolation suite extended for any new table or route; no new runtime dependency without explicit approval.
- [ ] Review threads resolved; charter §9 decisions recorded in the runbook.
