# Master Sprint Backlog v2

**Single source of truth for the build** · 80 items · 14 sprints · 21 October 2026

| | |
|---|---|
| **Lean pilot path** | **69.75 dev-days** across 14 sprints |
| **WhatsApp track** | 7.75 dev-days, built W14–16 after the pilot |
| **Deferred to MVP-1.5** | 1.50 dev-days |
| **Total backlog** | **79.00 dev-days** / 80 items |
| **Capacity** | 14 sprints × 5 productive days = 70 days |
| **Unallocated** | **0.25 days** — W13 carries 3 days of carry-forward room |
| **Pilot live** | Monday **W14** · readout **W17** · WhatsApp **W18** |

---

## What changed in v2

v1 had a backlog, but it was not safe to build from. Three defects:

1. **Fourteen ID collisions.** `S0-02` meant *"Repo + CI + 3 environments"* in the backlog and *"Sign D1, D5, D11, D14"* in the kickoff pack. Two documents, one ID, different meanings. **IDs are now `<sprint>-<nn>`**, so the ID tells you the sprint and can never collide.
2. **S13 was empty.** The launch sprint had no work items — staff training, content corrections and the GM go/no-go were described in prose but never costed. They are now three items totalling 2.0 days.
3. **No acceptance criteria.** "Definition of done" entries were vague. Every item now has a **testable** acceptance criterion: *"Pool hours answered by lookup, not generation"* rather than *"facts table works"*.

The day count rose from 67.75 to **69.75** as a direct result — the missing launch work is now visible rather than assumed to be free.

---

## Sprint ladder

| Sprint | Week | Name | Items | Days | Cum. weeks | Slack | Gate |
|---|---|---|---|---|---|---|---|
| **W00** | W0 | Foundation lock | 20 | 8.00 | 1.60 | -3.00 | G0 |
| **S01** | W1 | Schema and tenancy | 3 | 5.75 | 2.75 | -0.75 | — |
| **S02** | W2 | Identity, settings, audit | 5 | 5.50 | 3.85 | -0.50 | — |
| **S03** | W3 | Knowledge | 3 | 5.00 | 4.85 | +0.00 | G1 |
| **S04** | W4 | Retrieval and review | 3 | 5.00 | 5.85 | +0.00 | — |
| **S05** | W5 | AI core and evaluation | 3 | 5.50 | 6.95 | -0.50 | G2 |
| **S06** | W6 | Guest chat and evaluation | 3 | 5.00 | 7.95 | +0.00 | — |
| **S07** | W7 | Chat hardening | 6 | 4.00 | 8.75 | +1.00 | — |
| **S08** | W8 | Staff inbox | 4 | 5.50 | 9.85 | -0.50 | — |
| **S09** | W9 | Requests and notifications | 5 | 4.50 | 10.75 | +0.50 | — |
| **S10** | W10 | Analytics | 3 | 4.50 | 11.65 | +0.50 | — |
| **S11** | W11 | Reliability | 5 | 5.00 | 12.65 | +0.00 | — |
| **S12** | W12 | Pilot readiness | 4 | 4.50 | 13.55 | +0.50 | G3 |
| **S13** | W13 | Launch | 3 | 2.00 | 13.95 | +3.00 | — |
| | | **Total** | **70** | **69.75** | **13.95** | **+0.25** | |

> Work completes at **13.95 weeks**. W14 is launch; W13 carries the launch work and roughly three days of carry-forward room.

---

## The backlog, sprint by sprint

### W00 · W0 — Foundation lock

**Goal:** Close G0: decisions signed, approval clocks started, pilot secured  
**Days:** 8.00 · **Gate:** G0  
**Exit:** All 14 ADRs signed · Meta verification submitted · pilot content owner named with dates · repo, CI and three environments live · fixture hotel seeded

| ID | Track | Item | Days | Depends | Acceptance criteria |
|---|---|---|---|---|---|
| `W00-01` | Founder | ADR review meeting, D1–D14 | 0.25 | — | All fourteen have an owner and a decision date |
| `W00-02` | Founder | Sign the irreversible set: D1, D5, D11, D14 | 0.25 | W00-01 | Four ADRs marked Accepted with a name and date |
| `W00-03` | Founder | Sign remaining ten ADRs | 0.25 | W00-02 | Fourteen of fourteen Accepted |
| `W00-04` | Founder | Funding path decision | 0.50 | — | Recorded in writing; team shape fixed |
| `W00-05` | Founder | Second developer scoped (if funded) | 0.25 | W00-04 | Named individual with a start date |
| `W00-06` | Founder | One-page non-goals document | 0.25 | — | Reviewed with whoever sells |
| `W00-07` | Founder | Assemble and cross-check the verification pack | 0.50 | — | All six documents present and names match across them |
| `W00-08` | Founder | Submit Meta business verification | 0.25 | W00-07 | Case ID recorded |
| `W00-09` | Founder | WhatsApp BSP shortlist to two | 0.25 | W00-08 | Two providers scored; one recommended |
| `W00-10` | Founder | Pilot property kickoff call | 0.50 | — | Content owner named with 4–6 hours dated in weeks 1–3 |
| `W00-11` | Eng | Repo, branch protection, org setup | 0.50 | — | A direct push to main is rejected |
| `W00-12` | Eng | CI skeleton: lint, typecheck, test, preview | 0.75 | W00-11 | A PR produces a preview URL and a green check |
| `W00-13` | Eng | Three environments: local, staging, prod | 0.75 | W00-12 | Staging and prod point at different databases |
| `W00-14` | Eng | Error tracking + structured logging | 0.50 | W00-13 | A staging error carries org_id, property_id, conversation_id |
| `W00-15` | Eng | Golden set v1: format + 20 starter questions | 0.50 | — | File format agreed; 20 questions in the repo |
| `W00-16` | Founder | Baseline question log started with the hotel | 0.25 | W00-10 | Hotel staff logging daily |
| `W00-17` | Eng | Adversarial fixture hotel | 0.50 | W00-13 | Seeded in staging; every messy case reproducible |
| `W00-18` | Founder | Privacy notice + DPA to Mexican counsel | 0.25 | — | Sent; turnaround expected |
| `W00-19` | Eng | Event taxonomy written | 0.50 | — | 18 events merged as a typed module; contract test passes; no dashboard before this exists |
| `W00-20` | Both | G0 review | 0.25 | W00-03, W00-08, W00-10 | Every W00 row ticked; unsigned ADRs block S01 |

### S01 · W1 — Schema and tenancy

**Goal:** The data model everything else sits on  
**Days:** 5.75 · **Gate:** —  
**Exit:** Migration clean from empty · RLS on every tenant table · isolation suite green on every endpoint built

| ID | Track | Item | Days | Depends | Acceptance criteria |
|---|---|---|---|---|---|
| `S01-01` | Eng | Schema and migrations | 3.00 | W00-01 | Runs clean from an empty database; ERD committed |
| `S01-02` | Eng | Row-level security policies | 2.00 | S01-01 | A query without tenant context returns zero rows |
| `S01-03` | Eng | Cross-tenant isolation test harness | 0.75 | S01-02 | Suite runs in CI and fails the build on a leak |

### S02 · W2 — Identity, settings, audit

**Goal:** Who can do what, and who did it  
**Days:** 5.50 · **Gate:** —  
**Exit:** An agent at property A provably cannot read property B · settings drive the AI policy layer · every consequential action audited

| ID | Track | Item | Days | Depends | Acceptance criteria |
|---|---|---|---|---|---|
| `S02-01` | Eng | Auth + four roles | 2.00 | S01-01 | Each role can only reach its own surface |
| `S02-02` | Eng | Property settings | 1.00 | S02-01 | AI policy layer reads settings, does not hardcode |
| `S02-03` | Eng | Audit log | 1.00 | S01-01 | Every consequential action writes an audit row |
| `S02-04` | Eng | Seed fixtures + demo property | 1.00 | S01-01 | `make seed` produces a fully populated property |
| `S02-05` | Eng | is_current retrieval filtering + re-embed job | 0.50 | S02-04 | Editing an article makes its old chunks unretrievable |

### S03 · W3 — Knowledge

**Goal:** The content system  
**Days:** 5.00 · **Gate:** G1  
**Exit:** 25 approved articles · 40 verified facts · zero unresolved contradictions · golden set v2 frozen

| ID | Track | Item | Days | Depends | Acceptance criteria |
|---|---|---|---|---|---|
| `S03-01` | Eng | Article editor + immutable versioning | 2.00 | S01-01 | Editing never alters a historical version |
| `S03-02` | Eng | CSV bulk import with preview | 1.00 | S03-01 | A 100-row CSV imports with a preview step and no silent failures |
| `S03-03` | Eng | property_facts table + UI | 2.00 | S03-01 | Pool hours answered by lookup, not generation |

### S04 · W4 — Retrieval and review

**Goal:** Find the right article, let a human approve it  
**Days:** 5.00 · **Gate:** —  
**Exit:** Retrieval recall ≥90% on the golden set · nothing publishes without approval · contradictions blocked

| ID | Track | Item | Days | Depends | Acceptance criteria |
|---|---|---|---|---|---|
| `S04-01` | Eng | Review-and-approve screen | 2.00 | S03-01 | A contradictory pair is blocked until a human resolves it |
| `S04-02` | Eng | Chunking + embeddings | 1.00 | S03-01 | Every published version is chunked and embedded |
| `S04-03` | Eng | Hybrid retrieval | 2.00 | S04-02 | Recall ≥90% on the golden set's target articles |

### S05 · W5 — AI core and evaluation

**Goal:** The answer pipeline and its guardrails  
**Days:** 5.50 · **Gate:** G2  
**Exit:** False-answer ≤2% · correct-or-correct-escalation ≥95% · every rejection logs a reason_code

| ID | Track | Item | Days | Depends | Acceptance criteria |
|---|---|---|---|---|---|
| `S05-01` | Eng | AI service with structured output contract | 2.00 | S04-03 | Malformed output rejected server-side, never sent |
| `S05-02` | Eng | Guardrail layer | 2.50 | S05-01 | No false answer survives the gate on the golden set |
| `S05-03` | Eng | ai_runs + citations logging | 1.00 | S05-01 | Any historical answer reconstructable from the database |

### S06 · W6 — Guest chat and evaluation

**Goal:** A stranger can hold a full conversation  
**Days:** 5.00 · **Gate:** —  
**Exit:** End-to-end conversation on staging · handoff creates an inbox item · eval harness runs in CI

| ID | Track | Item | Days | Depends | Acceptance criteria |
|---|---|---|---|---|---|
| `S06-01` | Eng | Public property-scoped web chat | 2.00 | S05-01 | A stranger holds a full conversation on staging |
| `S06-02` | Eng | Conversation state machine | 1.50 | S06-01 | Illegal transitions impossible at the database level |
| `S06-03` | Eng | Evaluation harness + CI job | 1.50 | S05-02 | G2 passes on the fixture property; runs on every prompt change |

### S07 · W7 — Chat hardening

**Goal:** Abuse, outages and provider failure  
**Days:** 4.00 · **Gate:** —  
**Exit:** AI killed mid-conversation still yields an honest reply and a ticket · cap trip degrades gracefully

| ID | Track | Item | Days | Depends | Acceptance criteria |
|---|---|---|---|---|---|
| `S07-01` | Eng | QR + embeddable snippet | 0.50 | S06-01 | QR resolves to the right property on a real phone |
| `S07-02` | Eng | AI disclosure + 'talk to a person' | 0.50 | S06-02 | A human is reachable in one tap from any state |
| `S07-03` | Eng | Request capture + honest acknowledgement | 1.00 | S06-02 | No code path can claim a request is fulfilled |
| `S07-04` | Eng | Abuse + cost protection | 1.00 | S06-01 | Cap trip degrades to 'a team member will reply' without an error |
| `S07-05` | Eng | Outage fallback | 0.50 | S07-04 | Kill the AI mid-conversation; guest still gets an honest message |
| `S07-06` | Eng | LLM transport resilience | 0.50 | S05-01 | Both providers killed; product degrades honestly |

### S08 · W8 — Staff inbox

**Goal:** The surface an agent actually uses  
**Days:** 5.50 · **Gate:** —  
**Exit:** An agent triages a queue on a phone in under 60 seconds · takeover is atomic

| ID | Track | Item | Days | Depends | Acceptance criteria |
|---|---|---|---|---|---|
| `S08-01` | Eng | Phone-first shared inbox | 2.00 | S06-02 | An agent triages a queue on a phone in under 60 seconds |
| `S08-02` | Eng | Conversation detail with AI sources | 1.00 | S08-01 | Staff can see the cited text verbatim |
| `S08-03` | Eng | Reply, take over, assign, resolve | 1.50 | S08-01 | No race where AI replies after a takeover |
| `S08-04` | Eng | AI operating modes | 1.00 | S08-03 | Mode change applies to the next message, no deploy |

### S09 · W9 — Requests and notifications

**Goal:** A request nobody sees is not a request  
**Days:** 4.50 · **Gate:** —  
**Exit:** Ack timestamp set by a real staff action · a request with no staff view still reaches a human

| ID | Track | Item | Days | Depends | Acceptance criteria |
|---|---|---|---|---|---|
| `S09-01` | Eng | Request lifecycle | 2.00 | S07-03 | request_acknowledged is set by a real staff action |
| `S09-02` | Eng | Knowledge-gap queue | 0.50 | S05-02 | Every no_answer lands in the queue automatically |
| `S09-03` | Eng | One-click 'wrong or outdated' | 0.50 | S08-02 | A flag is attributable to an ai_run |
| `S09-04` | Eng | Non-blocking review queue | 0.50 | S08-03 | Flagging an answer does not delay the guest reply |
| `S09-05` | Eng | Email notifications | 1.00 | S09-01 | A request with no staff view still reaches a human by email |

### S10 · W10 — Analytics

**Goal:** What guests ask, and what we cannot answer  
**Days:** 4.50 · **Gate:** —  
**Exit:** Dashboard numbers reconcile exactly to raw events · every tile traceable to a query

| ID | Track | Item | Days | Depends | Acceptance criteria |
|---|---|---|---|---|---|
| `S10-01` | Eng | Event emission across the product | 1.50 | W00-19 | Dashboard numbers reconcile exactly to raw events |
| `S10-02` | Eng | Daily rollups | 1.00 | S10-01 | A historical date can be recomputed without drift |
| `S10-03` | Eng | Management dashboard | 2.00 | S10-02 | Every tile traceable to a query a manager can explain |

### S11 · W11 — Reliability

**Goal:** Outbox, idempotency, redaction, observability  
**Days:** 5.00 · **Gate:** —  
**Exit:** Provider outage causes delayed sends, not lost messages · no card number reaches logs

| ID | Track | Item | Days | Depends | Acceptance criteria |
|---|---|---|---|---|---|
| `S11-01` | Eng | Transactional outbox + worker + DLQ | 1.50 | S06-01 | Provider outage delays sends, never loses them |
| `S11-02` | Eng | Idempotency + webhook dedupe | 1.00 | S06-01 | Replaying a webhook 10× produces one message |
| `S11-03` | Eng | PII redaction + log hygiene | 1.00 | S10-01 | A synthetic card number never reaches logs |
| `S11-04` | Eng | Observability + alerting | 1.00 | S11-01 | Every alert fires once in staging with a runbook link |
| `S11-05` | Eng | Nightly embedding reconciliation | 0.50 | S02-05 | Job fails loudly on a seeded drift case |

### S12 · W12 — Pilot readiness

**Goal:** Prove it works before a guest sees it  
**Days:** 4.50 · **Gate:** G3  
**Exit:** Restore drilled and timed · three staff complete the flow unaided · runbook signed off

| ID | Track | Item | Days | Depends | Acceptance criteria |
|---|---|---|---|---|---|
| `S12-01` | Eng | Runbook + backup restore drill | 1.00 | S11-04 | Restore completed and timed; runbook signed |
| `S12-02` | Eng | Accessibility + ES/EN audit | 1.00 | S08-01 | Lighthouse a11y ≥90; no untranslated strings |
| `S12-03` | Eng | Load test | 1.00 | S08-01 | p95 first token ≤3.5s at target load |
| `S12-04` | Both | Pilot dry run with real content | 1.50 | S12-01 | Three hotel staff complete the flow unaided |

### S13 · W13 — Launch

**Goal:** Train the staff, fix the content, go/no-go  
**Days:** 2.00 · **Gate:** —  
**Exit:** Pilot property trained · content corrections applied · GM sign-off recorded

| ID | Track | Item | Days | Depends | Acceptance criteria |
|---|---|---|---|---|---|
| `S13-01` | Founder | Staff training | 1.00 | S12-04 | Each staff member completes a live test conversation |
| `S13-02` | Both | Content corrections from the dry run | 0.50 | S12-04 | No known-wrong article in the published set |
| `S13-03` | Founder | Launch checklist + GM go/no-go | 0.50 | S13-01 | Written go/no-go from the GM |

---

## Capacity by sprint

| Sprint | Eng days | Founder days | Total | Status |
|---|---|---|---|---|
| W00 | 4.25 | 3.75 | 8.00 | **Over by 3.00** |
| S01 | 5.75 | 0.00 | 5.75 | **Over by 0.75** |
| S02 | 5.50 | 0.00 | 5.50 | **Over by 0.50** |
| S03 | 5.00 | 0.00 | 5.00 | Fits |
| S04 | 5.00 | 0.00 | 5.00 | Fits |
| S05 | 5.50 | 0.00 | 5.50 | **Over by 0.50** |
| S06 | 5.00 | 0.00 | 5.00 | Fits |
| S07 | 4.00 | 0.00 | 4.00 | Fits |
| S08 | 5.50 | 0.00 | 5.50 | **Over by 0.50** |
| S09 | 4.50 | 0.00 | 4.50 | Fits |
| S10 | 4.50 | 0.00 | 4.50 | Fits |
| S11 | 5.00 | 0.00 | 5.00 | Fits |
| S12 | 4.50 | 0.00 | 4.50 | Fits |
| S13 | 0.50 | 1.50 | 2.00 | Fits |
| **Total** | | | **69.75** | 70 available |

**W00 is the structural problem.** 8.0 days of work in a 5-day week — 4.0 engineering and 4.0 founder/GTM. It fits only if two people work in parallel. **Solo, it runs to mid-W1**, which pushes every downstream date by three days.

---

## Critical path

| # | Step | Sprint | Why it blocks |
|---|---|---|---|
| 1 | Hotel supplies approved content | W00–S03 | Retrieval cannot be tuned against content that has not arrived |
| 2 | Schema and RLS | S01 | Every later table, policy and test depends on it |
| 3 | Article versioning | S03 | Citations and embeddings hang off immutable versions |
| 4 | Chunking and embeddings | S04 | Retrieval, the gate and the guardrail chain sit downstream |
| 5 | Retrieval quality | S04 | Below 90% recall the gate fires constantly |
| 6 | AI contract and guardrails | S05 | Guest chat has nothing to send until it exists |
| 7 | Eval harness | S06 | Without it G2 is an opinion |
| 8 | Guest chat | S06 | The pilot surface |
| 9 | Inbox | S08 | Requests with nobody to receive them are broken promises |
| 10 | Notifications | S09 | The reason a request gets seen |
| 11 | Restore drill and runbook | S12 | G3 cannot pass without it |

---

## Gates

| Gate | Name | Sprint | Week | Pass criteria | If it fails |
|---|---|---|---|---|---|
| G0 | Decisions and approvals | W00 | W0 | 14 ADRs signed · verification submitted · content owner named · fixture seeded | Do not start S01 |
| G1 | Content ready | S03 | W3 | 25 articles · 40 facts · zero contradictions · golden set frozen | Delay the pilot, not the build |
| G2 | AI quality | S05 | W5 | False-answer ≤2% · escalation ≥95% · recall ≥90% | **Hard stop** |
| G3 | Pilot-ready | S12 | W12 | Isolation green · restore drilled · 3 staff unaided | Restricted launch only |
| — | Pilot live | S13 | W14 | Trained · content corrected · GM go/no-go | Postpone a week |
| G4 | Pilot readout | — | W17 | Containment ≥55% · accuracy ≥95% · ack ≤10 min | Do not scale sales |
| G5 | WhatsApp live | WA | W18 | Approved · consent tested · clean shadow run | Stay web-only |
| G6 | Group pilot | — | W19+ | 2–3 properties · inheritance exercised | No PMS-dependent group |

---

## WhatsApp track · 7.75 days

| ID | When | Item | Days |
|---|---|---|---|
| `WA-01` | W0 | Payment method on WABA | 0.25 |
| `WA-02` | W14 | Adapter: webhook ingress | 1.50 |
| `WA-03` | W14 | Adapter: send path + 24h window | 1.50 |
| `WA-04` | W15 | Consent + opt-out store | 1.00 |
| `WA-05` | W15 | Message-efficient reply composition | 1.00 |
| `WA-06` | W4 | Template submission + approval | 1.00 |
| `WA-07` | W5 | Number-migration safeguards | 0.50 |
| `WA-08` | W16 | Shadow run on one property | 1.00 |

> Approvals start W0 because they are calendar time. The build is 7.75 days of attention and lands after the pilot. A `wa.me` link gives the hotel WhatsApp presence on day one without any of this.

---

## Deferred to MVP-1.5

| ID | Item | Days | Comes back when |
|---|---|---|---|
| `DF-01` | Outbound webhook per property | 1.00 | A group needs events piped into their own tools |
| `DF-02` | Opportunity click tracking | 0.50 | After the pilot, against real traffic |
| — | Automated PDF and website extraction | — | After five assisted onboardings |
| — | Self-serve onboarding wizard | — | From hotel four |
| — | Brand-to-property inheritance UI | — | First group pilot |
| — | Guest CSAT thumbs | — | MVP-1.5 |

---

*Totals reconcile: 69.75 + 7.75 + 1.50 = **79.00 dev-days**.*