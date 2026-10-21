# Response to Review — Development Plan v1.0

**Date:** 21 October 2026
**Re:** "Executive Summary — Grade 6.5/10"
**Plan version:** amended to v1.1 in response. Changes listed in §5.

---

## Summary position

**We accept the schedule challenge and three of the technical findings. We reject the proposed remediation, and we think the grade is measuring the wrong document.**

- **Accepted and fixed:** embedding/vector drift · Draft mode as a pilot operating mode · no transport-level LLM resilience · no adversarial test content · Mexico verification document friction.
- **Accepted, and it changed the number:** the schedule. Applying the review's valid points moved the honest estimate from **12 weeks to 14**, because the v1.0 figure relied on a deferral that was described in prose but never marked in the backlog. The plan now commits to 14 weeks and reads its day counts from the backlog rather than from arithmetic done on top of it.
- **Rejected with reasoning:** cutting the outbox and event pipeline to save time. That is the wrong 3.5 days to remove, and removing them exposes the first paying reference customer to lost messages and unreconcilable analytics.
- **Corrected:** the eval-harness sequencing criticism rests on a misreading (content gate closes Week 3; harness lands Week 5 — the content is *ready* before the harness runs, not still arriving).

On the grade: as a critique of **the schedule**, it lands, and it found two defects I should have caught. As a critique of **the plan**, it largely argues against a position the plan already takes. §7.4 publishes the capital requirement and recommends *against* the middle path; §9 states that the person building is also selling and that this "does not reduce velocity by 50%, it silently doubles the schedule." The plan's answer to "a solo developer cannot do this" is that **a solo developer should not** — which is why the funding-path decision is the first question in the review brief and closes in Week 0.

I would take a 6.5 on the execution plan and argue for an 8 on the analysis. Two of the four critical failure points are real; one is real but already priced; one is misdirected. **On the schedule specifically, the review was right, and the plan is now two weeks longer because of it.**

---

## 1. Point-by-point

### 1.1 The solo-developer complexity wall — **accepted as a concern, partly already priced**

The reviewer lists RLS, transactional outbox, idempotency keys, eval CI, event rollups, structured facts and multi-language support as "enterprise-grade primitives" that will consume all twelve weeks.

They are not all the same weight, and lumping them overstates the case:

| Primitive | Actual cost | What it prevents |
|---|---|---|
| Postgres RLS | Policies on 25 tables, ~2 days including the isolation suite | Cross-tenant data leak — existential for a group sale |
| Idempotency | A unique index and a dedupe check, ~1 day | The same guest message delivered three times |
| Transactional outbox | One table and one worker, ~1.5 days | Lost messages during any provider blip |
| Event rollups | One append-only table and nightly SQL, ~1 day | A dashboard whose numbers cannot be reconciled |
| Eval harness | ~1.5 days | Shipping unmeasured quality and never noticing regression |

That is roughly **8 days out of 60** — 13% of the build — and every line prevents a failure mode that is expensive *in a pilot with a reference customer*. Cutting them to save 8 days does not fix a 12-week problem; it produces a 10.5-week problem with a hotel that can lose messages.

**Where the reviewer is right:** the aggregate risk is real and the tail is fat. Estimates for retrieval tuning and guardrail behaviour are uncertain, and a solo developer loses days to operations that never appear on a backlog. The plan's own §9 says this. What was missing was a second, conditional number. It now publishes both:

> **14 weeks to pilot live on web chat** — measured from the backlog, with a two-week buffer already inside it.
> **~18 weeks** to full MVP-1 solo, or **~10 weeks** with a second developer from week 3 scoped to UI and content operations.

The reviewer's 18–20 week figure is right *for a solo developer who is also running sales, onboarding three hotels and handling support.* That is not a plan defect; it is the case for the second person, which the plan already names as the cheapest available compression (full MVP-1 at ~9 weeks with one extra developer from week 3).

### 1.2 Content bottleneck vs. code velocity — **accepted, mitigated**

Correct in principle. The plan acknowledged content as the critical path and then still let retrieval tuning (S4) sit directly behind the content gate at Week 3. If the hotel is late, S4 has nothing to tune against.

Two mitigations now in the plan:

1. **An adversarial fixture hotel built in Sprint 1.** Not a clean demo dataset — a deliberately messy one: a two-column menu that flattens into noise, OCR'd policy text, pool hours that contradict between the website and the directory, a 3,000-word marketing article with the useful fact in paragraph eleven. Retrieval and the gate get developed and stressed against this from Week 1, so hotel content arriving late degrades quality rather than blocking progress.
2. **The G1 slippage is now explicit.** Content is hotel-side and cannot be engineered around. If G1 slips, S4 slips in parallel, and the honest response is to ship the pilot on the fixture-plus-partial-content basis rather than to compress testing.

This was the second-best catch in the review.

### 1.3 The Draft mode trust paradox — **accepted, and the plan was wrong**

This is the best catch in the review, and it is a genuine design error on my part.

Running Draft mode in pilot week one assumed front-desk staff would review every AI message in real time. They will not — they are standing in front of a guest. The result is the worst of both worlds: guests get silence, and the hotel believes it is covered because "a human is checking."

**Changed:**
- Week one of the pilot now runs **Auto with a tight escalation policy**, not Draft.
- Staff get a review queue, but it **never stands between the guest and an answer**.
- Draft is demoted to three legitimate uses: the pre-launch test chat, specific sensitive topics, and the emergency downgrade when G2 or a live sample trips.

The trade is deliberate: Auto-with-escalation carries a higher false-answer risk than Draft, which is why the G2 gate (false-answer ≤ 2%) and the weekly 50-answer audit exist. A 2% error rate with live answers beats a 0% error rate with no answers.

### 1.4 WhatsApp / Meta verification delays — **accepted, recalibrated to 4–6 weeks**

Correct that Mexican business verification rejects on document mismatch far more often than on policy, and that this routinely takes 4–6 weeks rather than 3.

**Added:** a Week-0 document checklist — legal name exactly as on the RFC, the RFC itself, a CFE bill or bank statement in the registered name and matching the address, a live website on a matching domain, the trading name, and a phone that can receive the verification call. A mismatch between RFC, bank statement and website is the classic multi-week loop.

**Not conceded:** this cannot "completely stall the go-to-market timeline," because WhatsApp is not the launch surface. The plan launches on web chat at Week 12 and treats WhatsApp as gate G5 with an explicit fallback (stay web-only). The reviewer's risk is real; its blast radius is contained by design.

---

## 2. Findings from the detailed analysis

### 2.1 Vector / embedding drift — **accepted. This was a real gap.**

The single best technical catch in the review. My plan had immutable article versions and citations to `article_version_id`, but **no rule preventing stale chunks from being retrieved after an edit or delete.** A hotel removes a policy, and its own concierge keeps quoting it. That is the worst failure this product can have, because the hotel is the source of the error.

**Now specified in §3:**
- Retrieval **hard-filters on `is_current`** at query time, not only at write time.
- On publish: chunk and embed in a background job, then flip `is_current` in one transaction.
- On archive/delete: soft-delete, remove from the retrieval index, and keep citation pointers intact for historical `ai_runs`.
- **Nightly reconciliation job** asserting three invariants: every current version has ≥1 chunk; every chunk resolves to a current version; no chunk outlives its parent. Alert on violation.

Cost 0.5 dev-day. Worth more than the entire dashboard.

### 2.2 Prompt-contract fragility — **already mitigated, now instrumented**

Server-side schema validation with reject-and-escalate was already in Appendix B. Two additions close the gap the reviewer describes:

- **Pin model versions.** Never call a floating alias, so an upstream default change cannot silently alter behaviour overnight.
- **Use provider-native structured outputs** (JSON schema) *and* treat parse-failure rate as an alerting metric — format drift shows up there before it shows up in a guest conversation.

### 2.3 Eval harness sequencing — **the criticism rests on a misreading, but it points at a smaller real issue**

The review says the harness arrives in Sprint 5 "while content is still being ingested." The plan closes the content gate (G1) at **end of Week 3** and lands the harness in **Week 5.** Content is ready two weeks before the harness needs it.

There *is* a smaller real issue in the same neighbourhood: **golden set v1 is drafted in Week 0, before any content exists**, so it may not match the final articles. Fixed two ways:

- **Golden set v2 is frozen at G1**, not written once at the start and left to drift.
- **Generation is now split:** answer-expected questions (about two thirds) are LLM-drafted from the approved articles and human-reviewed — cheap and systematic. Escalation-expected questions (about one third) are **written by humans from the front-desk baseline log**, because those are precisely the cases the articles do *not* answer. Generating everything from the articles would bias the test set toward the content and under-sample the false-answer cases the gate exists to catch.

### 2.4 LLM provider outage handling — **accepted, specified**

Now explicit: per-call timeouts, two retries with jitter on 429/5xx only, circuit-break to the secondary model for 60 seconds, pinned versions, structured outputs, parse-failure alerting, and an honest guest-facing degradation ("our team will reply") that still creates a ticket.

---

## 3. Where I disagree: the proposed remediation

### 3.1 "De-scope the outbox and event rollups for the first four weeks" — **rejected**

This removes the cheapest, highest-leverage reliability work and leaves the expensive, uncertain work untouched.

Outbox plus idempotency plus rollups is about **3.5 days out of 60.** What it buys: messages are not lost when a provider blips, duplicate webhooks do not duplicate guest messages, and the management dashboard's numbers reconcile to raw rows. The first hotel is the *worst* possible environment in which to discover that messages were dropped — it is the reference customer for every subsequent group conversation.

If schedule pressure returns, the correct cuts are **surface, not foundations**. The plan now publishes a scope ledger showing exactly that discipline: four new items were added after review (+2.0 days) and four lower-value items were displaced to MVP-1.5 (−2.0 days: click tracking, demand heatmap, inline article-writing from the gap queue, CSV import hardening). The 60-day estimate is held, not inflated.

### 3.2 "Refuse to launch any hotel that has not self-completed the content checklist" — **partially rejected**

Right principle, wrong starting point. The plan budgets 1.5–2 assisted days per property for the first five hotels *deliberately* — that time is where you learn what the checklist should ask, and the content quality is the entire product.

Enforcing a self-serve gate on the first pilot hotel is a good way to have no pilot. The rule is now written precisely: the self-serve readiness checklist becomes the gate **from hotel four onward**, and assisted onboarding must **decline with each property** rather than be zero on day one. Support is 37–56% of COGS, so the target is a falling per-property cost trending toward the modelled 1.0–4.0 hours — not a fantasy of zero for the first customer.

### 3.3 "Automate golden set generation" — **partially adopted**

Adopted as described in §2.3: LLM-drafts the answer cases, humans author the escalation cases. Generating all of them would optimise for coverage of the knowledge base rather than coverage of guest reality.

---

## 4. The follow-up question, answered

> *"Would you prefer to adjust the scope to drop the custom outbox/event-rollup architecture for the pilot, or bring on a fractional developer to hit the 12-week target safely?"*

**Neither, as framed.** The premise is a false choice: the outbox and rollups are not what makes twelve weeks hard.

**Recommendation — in priority order:**

0. **Note that the frame itself was wrong.** "Solo developer" is the floor case, not the plan's recommendation. The plan's funded path is founder + contractor + a second developer from month 7; the bootstrap path is *two founders*. The review grades the cheapest configuration available and concludes it is cheap — which is true, and is why the plan's first question is the funding decision, not the tech stack.

1. **Keep the reliability primitives** (≈8 days of 60). They are load-bearing for a paying reference customer and none of them is novel engineering.
2. **Cut product surface instead** (≈3 days, already done in the v1.1 scope ledger). Lower risk, no correctness regression.
3. **If schedule certainty is the actual goal, add a second person — but for the right work.** Pair the second developer with the **inbox UI, dashboard and content operations**, not the tenancy and reliability layer. Those primitives are single-mind work: splitting them across two people creates coordination cost that cancels the parallel gain. UI surface parallelises cleanly; RLS policy design does not.
4. **Recognise that the bootstrap path already answers this.** The plan's funded path is founder plus contractor plus a second developer from month 7, and the bootstrap path is *two founders*. "One solo developer" is the floor-case assumption, not the recommended org. The reviewer is grading the cheapest configuration and concluding it is cheap.

**Concretely: to hold 12 weeks without heroics, take the second developer from week 3 and scope them to UI and content ops. That is the ~9-week path to full MVP-1 and the version I would actually commit to a hotel.**

---

## 5. What changed in the plan (v1.0 → v1.1)

| # | Change | Section | Source |
|---|---|---|---|
| 1 | Embedding integrity: `is_current` filtering, re-embed job, nightly reconciliation with three invariants | §3 | Review 2.1 |
| 2 | Draft mode demoted from pilot-week-one to test/downgrade use; week one runs Auto with escalation | §3, §10 | Review 1.3 |
| 3 | Transport resilience: timeouts, retry with jitter, circuit breaker, pinned models, structured outputs, parse-failure alerting | §3 | Review 2.4 |
| 4 | Adversarial fixture hotel specified in Sprint 1 | §4 | Review 1.2 |
| 5 | Golden questions: LLM-drafted answer cases, human-authored escalation cases; v2 frozen at G1 | §4 | Review 2.3 |
| 6 | Mexico verification document checklist; expectation reset to 4–6 weeks | §6 | Review 1.4 |
| 7 | Onboarding self-serve gate applies from hotel four, not hotel one | §4 | Review 3.2 |
| 8 | Scope ledger: +3.0 days added, −3.0 days displaced | §6 | Review 1.1 |
| 9 | **Schedule re-based from 12 to 14 weeks**, measured from the backlog rather than asserted | §6 | Review 1.1 |

---

## 6. What we would still like reviewed

Three items, unchanged, and all closing in Week 0:

1. **Funding path** — bootstrap (~$51k peak, breakeven month 23, two founders on minimal draws) versus funded (~$231k, no breakeven inside 24 months without the group path). This is the decision the review's central criticism actually turns on.
2. **Is $299 defensible for a 50-room Mexican independent**, at 0.63× buyer ROI on labour value alone?
3. **Independent-first or resort-first** for the pilot reference story?

A fourth question the review prompts directly: **does anyone have measured participation rates or support-hour data from hotel SaaS?** The reviewer is right that the tail risk in the schedule sits in retrieval tuning and content operations, and the two assumptions that would most change the plan's shape are participation (12–18% of guest-nights) and support load (1.0–4.0 hours per property per month). Both are placeholders.

---

*Companion files: `01-development-plan.md` (v1.1) · `03-financial-model.xlsx` · `02-development-plan-workbook.xlsx` · `00-proposal-evaluation.md` (superseded).*
