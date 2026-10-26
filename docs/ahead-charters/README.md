# Ahead — draft charters for every remaining backlog item

> **Status: DRAFT / NOT APPROVED.** `docs/charters/README.md` (on `main`) says *"No item starts until its charter is approved"*. These files are **proposed contracts** for review, not permission to start. They were generated from `docs/07-master-backlog.md`/`.xlsx`, `docs/01-development-plan.md`, the existing charters, and the code at `main` + PR #32 head `81b19bb`. No code, description or branch was changed.

**67 draft charters** in [`items/`](items/) — one for each of the 66 not-yet-Done backlog items, **plus `S02-06`** (the follow-up that backlog v2 never costed). Each carries the backlog AC verbatim, numbered ACs, scope, **calculated changes** (files, migrations, signatures, tests, evidence), tenancy, a pickup status and a definition of done.

---

## 1. Do we have full epic + items for all planned items? — **No**

| Layer | Coverage | Gap |
|---|---|---|
| Master backlog (`07-master-backlog.md` + `.xlsx`) | **80/80 items** have ID, sprint, track, epic, description, days, priority, `depends_on`, a testable AC and a Status cell; 14 sprints have goals/exits; gates, critical path, capacity, WhatsApp and deferred lists exist | Complete at one-line level; **no** implementation detail |
| Approved item charters (`docs/charters/`) | **7 of 80** — `S02-02/03/04/05`, `S03-01/02/03` (+ `README.md`) | **73 items have no charter**; S02-01 was shipped PARTIAL and explicitly not retro-chartered |
| GitHub milestones | **2 of 14** — `S02`, `S03` | 12 sprint milestones missing |
| GitHub epic issues | **2 of 14** — #9 (S02), #27 (S03) | 12 sprint epics missing |
| GitHub story issues | **7** story issues + 1 follow-up (#14 S02-06) | ~73 story issues missing; no issue for any S04–S13, WA or DF item |
| Workbook status | **14 Done / 66 not Done** on `main` | `S02-01` still reads *Not started* despite PR #7; `W00-13/14/17` have runbook evidence but no tick; `W00-15` is in progress pending founder sign-off |

**So:** the backlog is fully decomposed into sprints → items → ACs, but the **charter layer and the GitHub epic/story layer stop at S03**. The `docs/charters/README.md` rule is that the remaining sprints are chartered sprint-by-sprint in one PR — this directory front-runs that with drafts so a coding agent can be handed any item now. Converting these into approved charters + GitHub issues/milestones still needs a human approval pass (see §6).

---

## 2. Decision register — what must close before some calculations become exact

### DEC-1 — UI / frontend framework
- **Why it is open:** Repo has **no frontend framework**: `src/server.ts` is `node:http`, `api/health.ts` is a Vercel node handler, and `docs/charters/README.md` made S03 service-first with UI deferred to S08. `src/i18n/catalog.ts` (ES+EN) is the only UI primitive.
- **Proposed default:** **server-rendered HTML from the existing `node:http` server, zero new dependency.** Any framework (Next/Remix/SvelteKit) is a new runtime dependency and needs explicit approval.
- **Blocks / affects:** S04-01, S06-01, S07-01, S07-02, S08-01, S08-02, S08-03, S10-03, S12-02, S12-03

### DEC-2 — LLM provider + pinned models (D12)
- **Why it is open:** No provider SDK is in `package.json`. Plan §3 mandates one primary + one fallback behind an internal interface, pinned model versions, 8s/3s timeouts and structured outputs.
- **Proposed default:** native `fetch` adapters (no SDK), pinned model ids in `src/config/env.ts`, `ConfigError` on floating aliases in prod; CI uses a deterministic fake provider.
- **Blocks / affects:** S05-01, S05-02, S05-03, S06-01, S06-03, S07-04, S07-06, S12-03

### DEC-3 — Embedding provider + dimension (D3)
- **Why it is open:** 0001 fixes `vector(1536)`; `src/knowledge/embedding.ts` validates that dimension and `src/knowledge/retrieval.ts` already has vector SQL.
- **Proposed default:** a 1536-dimension model behind `EmbeddingProvider`/`Embedder`, key in `EMBEDDING_API_KEY`; every response validated before Postgres.
- **Blocks / affects:** S04-02, S04-03, S11-05, S13-02

### DEC-4 — Email provider
- **Why it is open:** `outbox(kind='email')` already exists in 0001 and escalation contacts are in `src/settings/schema.ts`.
- **Proposed default:** `fetch`-based adapter + `EMAIL_ESCALATION_FALLBACK` so an empty contact list still reaches a human.
- **Blocks / affects:** S09-05, S11-01

### DEC-5 — WhatsApp provider / BSP (D11) + Meta verification
- **Why it is open:** W00-08/09 are founder items; the webhook signature scheme, template ids and endpoints differ per provider. D11 is hard to reverse.
- **Proposed default:** direct Cloud API with Embedded Signup; record the ruling in `docs/decisions/WHATSAPP-BSP.md`. **Start W00-08/WA-06 now — they are calendar time.**
- **Blocks / affects:** WA-01..WA-08 (and W00-08/09)

### DEC-6 — G1 content pack — the real critical path
- **Why it is open:** G1 needs ≥25 approved articles, ≥40 verified facts, zero contradictions and golden set v2 (≥40 questions). The repo has **7 article versions, 5 facts (2 deliberately contradictory) and a 20-question v1 golden set**.
- **Proposed default:** hotel content owner (W00-10) + front-desk baseline (W00-16); import via S03-02 CSV; verify via S03-03 `verifyFact`. Gate says 'delay the pilot, not the build'.
- **Blocks / affects:** S04-03 exit, S05-02 G2 proof, S06-03 harness, S12-04 dry run

### DEC-7 — Bot-check vendor (Turnstile) and third-party processors
- **Why it is open:** Plan §5 requires Turnstile on the first message; every third party must appear in the privacy notice/DPA (W00-18).
- **Proposed default:** implement the port with a no-op verifier in `local` and require the secret in `staging`/`prod`; list the vendor in the DPA.
- **Blocks / affects:** S07-04, S11-03

### DEC-8 — Second developer / capacity
- **Why it is open:** 0.25 days unallocated across 69.75; W00 over by 3.0d, S01/S02/S05/S08 each over by 0.5d. S02-06 (1.0d) is **not in the 80-item backlog estimate** and lands inside S04-01.
- **Proposed default:** record it as a follow-up row and charge it to S04's 5.0d or to W13's ~3 days of carry-forward; do not silently absorb it.
- **Blocks / affects:** W00-05, S04-01, S02-06, W13

### DEC-9 — Legal: privacy notice, DPA, retention
- **Why it is open:** LFPDPPP (21 Mar 2025) makes us a processor; retention default 90 days; the data-flow map must name DB region, LLM provider, Meta, email and error tracking.
- **Proposed default:** 90-day `messages.body` retention with a documented deletion path; aggregates only in `events`/`rollups`.
- **Blocks / affects:** W00-18, S07-04, S11-03

> Items marked `decision` or `blocked` in the index below still have calculations wherever they are decision-independent; only the named part is deferred. Items marked `deferred` (DF-01/DF-02) have **no** changes calculated, as requested.

---

## 3. Gates and the real critical path

| Gate | When | Pass criteria | If it fails | Note |
|---|---|---|---|---|
| G0 | W00 | 14 ADRs signed · verification submitted · content owner named · fixture seeded | Do not start S01 | Retrospective: S01–S03 already shipped; file a G0 review with waivers. |
| G1 | S03 / W3 | 25 approved articles · 40 facts · zero contradictions · golden set v2 frozen | Delay the pilot, not the build | **Biggest gap**: 7 articles / 5 facts / 20 questions today. Content is critical path #1. |
| G2 | S05 / W5 | False-answer ≤2% · correct-or-escalation ≥95% · recall ≥90% | **Hard stop** | `npm run eval` (S06-03) + nightly canary; needs G1 content. |
| G3 | S12 / W12 | Isolation green · restore drilled · 3 staff unaided | Restricted launch only | S12-01/04 evidence. |
| — | S13 / W14 | Pilot live: trained · content corrected · GM go/no-go | Postpone a week | S13-01/02/03. |
| G4 | W17 | Containment ≥55% · accuracy ≥95% · ack ≤10 min | Do not scale sales | S10-01/02/03 rollups. |
| G5 | WA / W18 | Approved · consent tested · clean shadow run | Stay web-only | WA-04/06/08. |
| G6 | W19+ | 2–3 properties · inheritance exercised | No PMS-dependent group | Content inheritance (plan §2). |

**Critical path (plan §Critical path):** hotel content (W00–S03) → schema/RLS (S01, done) → article versioning (S03, done) → chunk+embed (S04-02) → retrieval ≥90% (S04-03) → AI contract + guardrails (S05) → eval harness (S06-03) → guest chat (S06-01) → inbox (S08) → notifications (S09) → restore drill (S12-01). **Step 1 is not engineering and is the one item currently furthest behind.**

---

## 4. Pickup status legend

| Status | Meaning | Count |
|---|---|---|
| `ready` | READY — changes calculated below; can be picked up once its charter is approved and its dependencies merge. | 20 |
| `decision` | NEEDS DECISION — see §8. Calculations are complete where possible; the named decision must close first. | 23 |
| `blocked` | BLOCKED — depends on in-flight work (PR #32 / S04-01). Calculations deferred; contract stated instead. | 2 |
| `inflight` | IN FLIGHT — already implemented in an open PR; no new calculations, only the review findings to fix. | 1 |
| `external` | EXTERNAL / NON-CODE — no code change calculated; deliverables are documents, approvals or calendar time. | 19 |
| `deferred` | DEFERRED — explicitly out of MVP; no changes calculated (per user instruction to skip where not possible). | 2 |

A coding agent can pick up any `ready` item the moment its charter is **approved** and its `depends_on` items have merged. `decision` items have a fully calculated service/SQL layer and only a named adapter or markup waiting; `blocked` items state the expected contract instead of line-by-line calculations.

---

## 5. Full index — every item ahead

| ID | Sprint / week | Days | Depends on | Pickup | Charter |
|---|---|---|---|---|---|
| `W00-01` | W00 / W0 | 0.25 | — | `external` | [ADR review meeting, D1-D14](items/W00-01-adr-review-meeting-d1-d14.md) |
| `W00-04` | W00 / W0 | 0.50 | — | `external` | [Funding path decision](items/W00-04-funding-path-decision.md) |
| `W00-05` | W00 / W0 | 0.25 | W00-04 | `external` | [Second developer scoped (if funded)](items/W00-05-second-developer-scoped-if-funded.md) |
| `W00-06` | W00 / W0 | 0.25 | — | `external` | [One-page non-goals document](items/W00-06-one-page-non-goals-document.md) |
| `W00-07` | W00 / W0 | 0.50 | — | `external` | [Assemble and cross-check the verification pack](items/W00-07-assemble-and-cross-check-the-verification-pack.md) |
| `W00-08` | W00 / W0 | 0.25 | W00-07 | `external` | [Submit Meta business verification](items/W00-08-submit-meta-business-verification.md) |
| `W00-09` | W00 / W0 | 0.25 | W00-08 | `external` | [WhatsApp BSP shortlist to two](items/W00-09-whatsapp-bsp-shortlist-to-two.md) |
| `W00-10` | W00 / W0 | 0.50 | — | `external` | [Pilot property kickoff call](items/W00-10-pilot-property-kickoff-call.md) |
| `W00-13` | W00 / W0 | 0.75 | W00-12 | `ready` | [Three environments: local, staging, prod](items/W00-13-three-environments-local-staging-prod.md) |
| `W00-14` | W00 / W0 | 0.50 | W00-13 | `ready` | [Error tracking + structured logging](items/W00-14-error-tracking-structured-logging.md) |
| `W00-15` | W00 / W0 | 0.50 | — | `external` | [Golden set v1: format + 20 starter questions](items/W00-15-golden-set-v1-format-20-starter-questions.md) |
| `W00-16` | W00 / W0 | 0.25 | W00-10 | `external` | [Baseline question log started with the hotel](items/W00-16-baseline-question-log-started-with-the-hotel.md) |
| `W00-17` | W00 / W0 | 0.50 | W00-13 | `ready` | [Adversarial fixture hotel](items/W00-17-adversarial-fixture-hotel.md) |
| `W00-18` | W00 / W0 | 0.25 | — | `external` | [Privacy notice + DPA to Mexican counsel](items/W00-18-privacy-notice-dpa-to-mexican-counsel.md) |
| `W00-20` | W00 / W0 | 0.25 | W00-03, W00-08, W00-10 | `external` | [G0 review](items/W00-20-g0-review.md) |
| `S02-01` | S02 / W2 | 2.00 | S01-01, S04-01 | `blocked` | [Auth + four roles (PARTIAL close-out)](items/S02-01-auth-four-roles-partial-close-out.md) |
| `S02-06` | S02 / W2 | 1.00 | S04-01 | `blocked` | [Wire requireRole into the first staff surface + live denial test](items/S02-06-wire-requirerole-into-the-first-staff-surface-live-d.md) |
| `S03-03` | S03 / W3 | 2.00 | S03-01 | `inflight` | [property_facts table + UI](items/S03-03-property-facts-table-ui.md) |
| `S04-01` | S04 / W4 | 2.00 | S03-01, S03-03 | `decision` | [Review-and-approve screen](items/S04-01-review-and-approve-screen.md) |
| `S04-02` | S04 / W4 | 1.00 | S03-01 | `decision` | [Chunking + embeddings](items/S04-02-chunking-embeddings.md) |
| `S04-03` | S04 / W4 | 2.00 | S04-02 | `decision` | [Hybrid retrieval](items/S04-03-hybrid-retrieval.md) |
| `S05-01` | S05 / W5 | 2.00 | S04-03 | `decision` | [AI service with structured output contract](items/S05-01-ai-service-with-structured-output-contract.md) |
| `S05-02` | S05 / W5 | 2.50 | S05-01 | `decision` | [Guardrail layer](items/S05-02-guardrail-layer.md) |
| `S05-03` | S05 / W5 | 1.00 | S05-01 | `ready` | [ai_runs + citations logging](items/S05-03-ai-runs-citations-logging.md) |
| `S06-01` | S06 / W6 | 2.00 | S05-01 | `decision` | [Public property-scoped web chat](items/S06-01-public-property-scoped-web-chat.md) |
| `S06-02` | S06 / W6 | 1.50 | S06-01 | `ready` | [Conversation state machine](items/S06-02-conversation-state-machine.md) |
| `S06-03` | S06 / W6 | 1.50 | S05-02 | `decision` | [Evaluation harness + CI job](items/S06-03-evaluation-harness-ci-job.md) |
| `S07-01` | S07 / W7 | 0.50 | S06-01 | `decision` | [QR + embeddable snippet](items/S07-01-qr-embeddable-snippet.md) |
| `S07-02` | S07 / W7 | 0.50 | S06-02 | `decision` | [AI disclosure + 'talk to a person'](items/S07-02-ai-disclosure-talk-to-a-person.md) |
| `S07-03` | S07 / W7 | 1.00 | S06-02 | `ready` | [Request capture + honest acknowledgement](items/S07-03-request-capture-honest-acknowledgement.md) |
| `S07-04` | S07 / W7 | 1.00 | S06-01 | `decision` | [Abuse + cost protection](items/S07-04-abuse-cost-protection.md) |
| `S07-05` | S07 / W7 | 0.50 | S07-04 | `ready` | [Outage fallback](items/S07-05-outage-fallback.md) |
| `S07-06` | S07 / W7 | 0.50 | S05-01 | `decision` | [LLM transport resilience](items/S07-06-llm-transport-resilience.md) |
| `S08-01` | S08 / W8 | 2.00 | S06-02 | `decision` | [Phone-first shared inbox](items/S08-01-phone-first-shared-inbox.md) |
| `S08-02` | S08 / W8 | 1.00 | S08-01, S05-03 | `decision` | [Conversation detail with AI sources](items/S08-02-conversation-detail-with-ai-sources.md) |
| `S08-03` | S08 / W8 | 1.50 | S08-01 | `decision` | [Reply, take over, assign, resolve](items/S08-03-reply-take-over-assign-resolve.md) |
| `S08-04` | S08 / W8 | 1.00 | S08-03 | `ready` | [AI operating modes](items/S08-04-ai-operating-modes.md) |
| `S09-01` | S09 / W9 | 2.00 | S07-03 | `ready` | [Request lifecycle](items/S09-01-request-lifecycle.md) |
| `S09-02` | S09 / W9 | 0.50 | S05-02 | `ready` | [Knowledge-gap queue](items/S09-02-knowledge-gap-queue.md) |
| `S09-03` | S09 / W9 | 0.50 | S08-02, S05-03 | `ready` | [One-click 'wrong or outdated'](items/S09-03-one-click-wrong-or-outdated.md) |
| `S09-04` | S09 / W9 | 0.50 | S08-03 | `ready` | [Non-blocking review queue](items/S09-04-non-blocking-review-queue.md) |
| `S09-05` | S09 / W9 | 1.00 | S09-01 | `decision` | [Email notifications](items/S09-05-email-notifications.md) |
| `S10-01` | S10 / W10 | 1.50 | W00-19 | `ready` | [Event emission across the product](items/S10-01-event-emission-across-the-product.md) |
| `S10-02` | S10 / W10 | 1.00 | S10-01 | `ready` | [Daily rollups](items/S10-02-daily-rollups.md) |
| `S10-03` | S10 / W10 | 2.00 | S10-02 | `decision` | [Management dashboard](items/S10-03-management-dashboard.md) |
| `S11-01` | S11 / W11 | 1.50 | S06-01 | `ready` | [Transactional outbox + worker + DLQ](items/S11-01-transactional-outbox-worker-dlq.md) |
| `S11-02` | S11 / W11 | 1.00 | S06-01 | `ready` | [Idempotency + webhook dedupe](items/S11-02-idempotency-webhook-dedupe.md) |
| `S11-03` | S11 / W11 | 1.00 | S10-01, W00-18 | `decision` | [PII redaction + log hygiene](items/S11-03-pii-redaction-log-hygiene.md) |
| `S11-04` | S11 / W11 | 1.00 | S11-01 | `ready` | [Observability + alerting](items/S11-04-observability-alerting.md) |
| `S11-05` | S11 / W11 | 0.50 | S02-05, S04-02 | `ready` | [Nightly embedding reconciliation](items/S11-05-nightly-embedding-reconciliation.md) |
| `S12-01` | S12 / W12 | 1.00 | S11-04 | `ready` | [Runbook + backup restore drill](items/S12-01-runbook-backup-restore-drill.md) |
| `S12-02` | S12 / W12 | 1.00 | S08-01 | `decision` | [Accessibility + ES/EN audit](items/S12-02-accessibility-es-en-audit.md) |
| `S12-03` | S12 / W12 | 1.00 | S08-01 | `decision` | [Load test](items/S12-03-load-test.md) |
| `S12-04` | S12 / W12 | 1.50 | S12-01 | `external` | [Pilot dry run with real content](items/S12-04-pilot-dry-run-with-real-content.md) |
| `S13-01` | S13 / W13 | 1.00 | S12-04 | `external` | [Staff training](items/S13-01-staff-training.md) |
| `S13-02` | S13 / W13 | 0.50 | S12-04 | `external` | [Content corrections from the dry run](items/S13-02-content-corrections-from-the-dry-run.md) |
| `S13-03` | S13 / W13 | 0.50 | S13-01 | `external` | [Launch checklist + GM go/no-go](items/S13-03-launch-checklist-gm-go-no-go.md) |
| `WA-01` | WA / W14-16 | 0.25 | W00-08 | `external` | [Payment method on WABA](items/WA-01-payment-method-on-waba.md) |
| `WA-02` | WA / W14-16 | 1.50 | W00-09, S11-02 | `decision` | [Adapter: webhook ingress](items/WA-02-adapter-webhook-ingress.md) |
| `WA-03` | WA / W14-16 | 1.50 | WA-02, S11-01 | `decision` | [Adapter: send path + 24h window](items/WA-03-adapter-send-path-24h-window.md) |
| `WA-04` | WA / W14-16 | 1.00 | WA-03 | `decision` | [Consent + opt-out store](items/WA-04-consent-opt-out-store.md) |
| `WA-05` | WA / W14-16 | 1.00 | S05-02, WA-03 | `ready` | [Message-efficient reply composition](items/WA-05-message-efficient-reply-composition.md) |
| `WA-06` | WA / W14-16 | 1.00 | W00-09 | `external` | [Template submission + approval](items/WA-06-template-submission-approval.md) |
| `WA-07` | WA / W14-16 | 0.50 | W00-04 | `external` | [Number-migration safeguards](items/WA-07-number-migration-safeguards.md) |
| `WA-08` | WA / W14-16 | 1.00 | WA-03, WA-04, WA-06 | `decision` | [Shadow run on one property](items/WA-08-shadow-run-on-one-property.md) |
| `DF-01` | DF / MVP-1.5 | 1.00 | S09-05 | `deferred` | [Outbound webhook per property](items/DF-01-outbound-webhook-per-property.md) |
| `DF-02` | DF / MVP-1.5 | 0.50 | S10-01 | `deferred` | [Opportunity click tracking](items/DF-02-opportunity-click-tracking.md) |

**Sprint distribution:** W00=15 · S02=2 · S03=1 · S04=3 · S05=3 · S06=3 · S07=6 · S08=4 · S09=5 · S10=3 · S11=5 · S12=4 · S13=3 · WA=8 · DF=2.

---

## 6. How to turn these into work

1. **Approve sprint-by-sprint.** Move the relevant `items/*.md` into `docs/charters/` (or approve in place) via one docs PR per sprint, exactly like PR #23 (`docs: S03 item charters (draft, approval requested)`). Resolve the decisions in §2 that the sprint touches.
2. **Create the GitHub layer.** One milestone per sprint, one `Epic: Sxx — …` issue per sprint carrying the gate AC, one story issue per item whose body is its charter, `blocked by` links from `depends_on`, labels `sprint:Sxx`, `track:foundation`, `prio:P0/P1`. `docs/charters/README.md` §'GitHub equivalent' describes the mapping and says the import is scriptable with `gh`.
3. **Hand off.** Point the coding agent at one `items/<ID>-*.md`; it contains the AC, the calculated files/SQL/signatures, named tests, evidence commands and DoD. Rebase migration numbers (`0010`…`0026` here) on whatever merges first and update `tests/db/schema.db.test.ts` + `tests/db/non-superuser.db.test.ts` counts.
4. **Close out.** Resolve review threads, add a runbook entry with real numbers, tick the workbook with `node scripts/update-workbook-status.mjs <ID> "✅ Done (<evidence>)"`, and **regenerate the progress report with `npm run progress`** — the report is derived from the workbook, so it is stale until it is re-run, and the close-out commit is the only place it belongs.

### Notes and caveats

- **Migration numbers are indicative.** 0009 is `property_facts` on PR #32; the sequence `0010`–`0026` assumes serial merges. Rebase on merge order and update the migration-count assertion in `tests/db/non-superuser.db.test.ts` (currently 9).
- **S02-06 is an extra row.** Issue #14 carries S02-01's unmet AC, but backlog v2 has no `S02-06` estimate. Its charter proposes adding ~1.0d to the board rather than hiding it inside S04-01 (DEC-8).
- **Estimates are inherited** from `07-master-backlog.md`; they are not re-estimated here. Total lean path remains 69.75d with 0.25d slack.
- **No new runtime dependency is assumed.** Every provider is behind a `fetch`-based adapter; any SDK needs explicit approval per the charter approval checklist.
- **PR #32 dependency.** `S03-03`'s `lookupFact` / `listContradictions` / `verifyFact` are in flight with 9 open review findings. S04-01 and S05-01/02 state the expected contract; re-check when it merges.
- **This directory is new and standalone** so it cannot conflict with the approved charters on `main`. After merge, add one pointer line to `docs/charters/README.md`.


---

## 7. GitHub sync (2026-10-25) — partial completion

GitHub now has 16 milestones, 16 epics, and 81 stories (the 80 backlog items + S02-06). All 73 newly created stories embed calculated changes or an explicit skip. Native sub-issues and dependency links are populated.

**Issue updates were denied with HTTP 403.** Existing story additions, epic checklists and eight Done-item closures are still pending. The earlier coverage table describes the pre-sync snapshot, not current GitHub coverage. See [`GITHUB-SYNC.md`](GITHUB-SYNC.md) for verified results, live issue links and the pending-edit checklist. Each draft charter also has an `issue:` field.

## 8. Limited owner approval — parallel work

The owner authorized two bounded packages: **S04-02-A (pure chunker)** and
**S10-01-A (event writer only)**. Approval becomes effective when the documentation
PR carrying [the exact scope](approvals/parallel-work.md) merges. Full parent
stories #71 and #94 remain draft; no other item is approved by this decision.
