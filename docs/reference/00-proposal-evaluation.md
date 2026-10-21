# AI Guest Concierge — MVP Evaluation & Development Plan

> **Status: superseded as the plan of record.** This document is the review that *produced* the current plan; it is kept as the record of what changed and why. The plan to build from is `01-development-plan.md`, and its numbers come from `03-financial-model.xlsx`. Where the two disagree on schedule or economics, the plan wins.

**Reviewed:** 21 October 2026
**Input:** "One multi-tenant product with two sales paths" — self-serve independent hotels, governed deployment for hotel groups.
**Planning assumptions:** one experienced full-stack developer, managed services, web-first launch, no PMS integration.
**Plan of record:** **12 weeks from kickoff to a pilot live on web chat**, built bottom-up from the 63-item backlog (60 dev-days of lean build + a buffer week). Full MVP-1 including WhatsApp lands around week 15–16 solo, or week 9 with a second developer from week 3.

---

## 0. Verdict at a glance

**Green-light the strategy. Re-sequence the delivery plan. Add two things the proposal treats as optional — an AI evaluation harness and an engineering/ops layer — because both are load-bearing.**

| Dimension | Grade | Rationale in one line |
|---|---|---|
| Problem choice & wedge | **A** | Refusing to integrate with the PMS is the single best decision in the document. It converts a 6-month enterprise sales cycle into a 1-day deployment. |
| MVP scope discipline | **A−** | The include/defer table is genuinely disciplined. Only two items are mis-sequenced (ingestion, WhatsApp). |
| Architecture | **B+** | Right instincts, managed services, conventional. Missing the unglamorous reliability primitives: outbox, idempotency, RLS specifics, feature flags. |
| AI safety posture | **B+** | Excellent principles ("do not invent," cite sources, hand off). No *measurement* mechanism, so "sufficiently supported" is an aspiration rather than a testable gate. |
| Multi-tenancy | **A−** | Tenancy modelled correctly from day one. Needs `org → property` content-inheritance resolution defined in the schema now, plus an automated cross-tenant test suite. |
| Onboarding | **B** | Treating onboarding as product is right. But automated extraction from PDFs/websites is a quality rabbit hole disguised as a feature. First five hotels should be human-assisted. |
| Ops, QA, observability | **C** | Essentially absent. As a *product* proposal this is fine; as a *development plan* it is the largest gap. |
| Timeline realism | **C+** | This is the weakest claim in the document. Worked bottom-up from the feature list, the build is roughly twice the stated 4–6 weeks. See §7.1 for the arithmetic. |
| Validation plan | **B+** | Good metric list, no thresholds, no go/no-go gates, no kill criteria. |
| Unit economics | **C+** | Not addressed — and a WhatsApp pricing change 20 days ago materially moves the model. See §9. |

**Bottom line:** this is a well-reasoned proposal that a competent engineer could build. What it lacks is the part that determines whether the *pilot succeeds* rather than whether the *code ships*: a way to prove the AI is accurate, a way to know when it isn't, and a way to run the thing in production for a paying hotel.

**And one correction aimed at the plan rather than the product:** the product scope is right, but the schedule is not. When the features are costed individually with a definition of done, the web MVP is 60 development days before padding — twelve weeks, not four to six. That is not pessimism, it is arithmetic, and it is set out line by line in §7. The good news is that the *hotel's* critical path (getting content) runs in parallel with those twelve weeks, so the calendar impact is smaller than the effort gap suggests.

---

## 1. What the proposal gets right — do not change these

1. **No PMS dependency in v1.** Requests captured and routed beat requests automated. This is the whole commercial thesis and it is correct.
2. **Conversation ≠ service request.** One chat can contain a restaurant question and a towel request. Modelling them separately is the difference between an inbox toy and an operations product.
3. **Room number ≠ verified identity.** Most competitors get this wrong. Keep the rule explicit in code, copy, and staff training.
4. **Grounded answers only, with visible sources.** Non-negotiable, and the reason a hotel will trust it with guests at all.
5. **"I've sent your request" not "your towels are on the way."** Correct epistemic honesty in the product copy. Enforce it in the prompt *and* in a post-generation check.
6. **Onboarding as the product.** The wizard + review-and-approve screen is right, and it creates a clean responsibility boundary when content is wrong.
7. **Channel-specific rules isolated in the WhatsApp adapter.** Right call. Platform rules change constantly; keep that blast radius inside one module.
8. **Multi-tenant schema from day one, independent workflow first.** Correct sequencing of build vs. sell.

---

## 2. Thirteen corrections I would make

Ordered by impact on the pilot succeeding, not by effort.

---

### C1 — Build an AI evaluation harness in Phase 2, not "later"

The proposal says "check whether the answer is sufficiently supported." That is a product requirement with no implementation. Without measurement you cannot: prove quality to a hotel, safely increase autonomy, detect regressions when a hotel edits its knowledge base, or answer a group's security questionnaire.

**Do this instead.** A `golden_questions` table per property — 40–50 real guest questions in the property's actual languages, each with an *expected behaviour*, not an expected string:

| question | lang | expected_behaviour | target_article |
|---|---|---|---|
| ¿A qué hora cierra la alberca? | es | answer | `pool-hours` |
| Can I check in early? | en | answer | `checkin-policy` |
| Do you have a room for tonight? | en | escalate | — |
| I want a refund for last night | en | escalate | — |
| ¿Cuánto cuesta el spa? | es | answer | `spa-pricing` |

Score four ways on every run: **correct answer · correct escalation · false answer (confident wrong) · needless escalation.** The gate is the third one. A concierge that says "I don't know, let me get a colleague" is a good concierge. One that invents the pool hours is a liability.

Run the harness in CI on every prompt change, model change, and knowledge-base publish. Add a nightly canary against the live property KB. Cost: ~1.5 dev-days. Value: it is the only mechanism that lets you sell "we can turn autonomy up" as a roadmap rather than a hope.

---

### C2 — Store hours, prices, and policies as *data*, not only as prose

Everyone in this category embeds PDF text into chunks and lets the model read it. It works until it doesn't, and it fails in exactly the places hotels care about most: hours and prices.

Add a `property_facts` table alongside `knowledge_articles`:

```
property_facts(id, property_id, topic_key, value, unit, language,
               effective_from, source_article_version_id,
               verified_by, verified_at)
-- e.g. ('pool.hours.close', '20:00', 'time', ...)
--      ('spa.massage.60min', '1200', 'MXN', ...)
```

This buys you four things that are otherwise expensive later:

- **Deterministic answers** for the highest-risk questions. "The pool closes at 8:00 pm" is a lookup, not a generation.
- **Contradiction detection at onboarding.** Website says 21:00, PDF says 20:00 → flag the conflict instead of publishing both. This is the review screen made real.
- **Staleness control.** `verified_at` older than 90 days → surface a re-verify prompt. Hotels change hours seasonally; silent staleness is the #1 way these products lose trust.
- **Cheap multilingual answers** — hours and prices don't need translation accuracy to be right.

Cost is small if designed in Sprint 1. Retrofitting it after 5,000 answers means re-ingesting everything.

---

### C3 — Make "I don't know" a designed product state, not an error path

The proposal treats low confidence as a fallback. It should be a **first-class outcome** with its own copy, its own queue, its own metric, and its own staff workflow.

- Guest sees: *"I don't want to guess on that one — I've asked the front desk to reply directly. They usually answer within X minutes."* Then the conversation enters `needs_staff`.
- Staff sees it in a **Knowledge Gap** queue with the verbatim question, language, property, and a one-click "write an article" action.
- Management sees **knowledge-gap count and median age** — the most actionable number in the whole product, because it tells the hotel exactly what content to write next.

Your §10 metric "weekly number of missing or outdated knowledge items" only exists if you instrument this. Instrument it on day one.

---

### C4 — Cut automated content extraction from the MVP; move basic ingestion into Phase 2

The proposal puts "extraction from guest directory / menus / policies PDFs" inside Phase 3 onboarding and Phase 2 has "curated knowledge." Those are in tension, and the extraction half is a trap: PDF table extraction, multi-column menus, scanned documents, and websites with 40 pages of marketing fluff will each eat a week and still produce garbage that a hotel manager has to fix anyway.

**For the first five hotels: manual and assisted.**
- A paste-in article editor (rich text → chunks) and a CSV bulk import. That is it.
- You sit with the hotel's content owner for 2–3 hours. This is *also* your best discovery research.
- Automated website/PDF extraction becomes a Phase 3 feature *after* you've seen what 5 real hotels actually send you — which will be a mix of 2019 PDFs, a Canva menu, and a WhatsApp screenshot.

This removes an estimated 5–8 dev-days from the critical path and *improves* output quality at launch. It is the single biggest schedule win available.

---

### C5 — Re-baseline WhatsApp economics; the pricing changed on 1 October 2026

The proposal assumes the customer-service window is free. **That changed twenty days ago.** As of 1 October 2026 Meta bills service messages — including AI and human free-form replies inside the 24-hour window — per message, after a 1,000 free service messages per business phone number per month allowance [(3)](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing). Mexico's service rate tracks the utility rate, approximately **US$0.0085 per message** [(4)](https://getkanal.com/blog/whatsapp-business-pricing-guide).

A hotel that leaves WhatsApp on auto-pilot can now generate real per-message cost from bot replies that previously cost nothing. Model it:

| | 50-room hotel | 250-room resort |
|---|---|---|
| Guest conversations / month | ~300 | ~1,800 |
| Bot+staff replies / conversation | ~12 | ~12 |
| Total service messages | 3,600 | 21,600 |
| Free allowance | −1,000 | −1,000 |
| Billable × ~$0.0085 | **~$22/mo** | **~$175/mo** |
| LLM cost @ ~$0.02–0.04/conv | ~$9 | ~$54 |
| **Variable cost / property / mo** | **~$31** | **~$229** |

Three consequences for the plan:

1. **Design for message efficiency on WhatsApp specifically.** No token streaming into WhatsApp (it would be multiple messages). Compose one complete reply. Avoid chatty multi-bubble bot personalities. This is a real cost decision, not a style preference.
2. **Per-property spend caps and alerting** are MVP features (see C9), billed or capped as pass-through.
3. **A payment method must exist on the WABA in Meta Billing Hub** or service messages beyond the 1,000 free simply don't deliver. Put this on the onboarding checklist, not in a doc.

Also note the newer **Click-to-WhatsApp free entry point window** (currently up to 7 days from an ad-originated conversation) — worth designing ads around later, irrelevant to MVP.

---

### C6 — Start WhatsApp approvals in Week 0, not Phase 4; and warn about the number trap

The proposal's Phase 4 costing of "1–3+ weeks" conflates **calendar time** (Meta business verification, display-name approval, template review) with **dev time** (webhooks, send path, consent). Only the second is work you can schedule. Approval latency is waiting, and it runs in parallel with everything else.

**Change:** kick off business verification and provider selection in the first five days. Realistic dev effort for the WhatsApp adapter once approved is 3–5 days, not 3 weeks. If you start in Week 0, WhatsApp lands around Week 5–6 *without* extending the plan. If you start in Week 7, the launch date is set by Meta, not by you.

**The trap nobody mentions:** a phone number cannot be on the WhatsApp Business Platform and the consumer WhatsApp app simultaneously. Migrating a number **deletes its consumer WhatsApp history and usage**. Hotels frequently run their reservations line on consumer WhatsApp. So:

- Recommend a **dedicated number** for the API, or get the hotel's explicit written acknowledgement of the migration.
- Never migrate the number the hotel's booking flow depends on, mid-season.

**Bridging tactic worth selling:** `wa.me` click-to-chat links require zero approval and zero integration. It gives the hotel WhatsApp presence with a human answering on day one, while the API path is approved. It is not a product feature — but it removes the main objection to buying the web chat first.

**Provider decision (lock by Week 1):** direct Cloud API as a Tech Provider vs. a BSP with Embedded Signup (360dialog, Twilio, Gupshup, Wati and similar). The selection criteria in the proposal are right; add two: **does the hotel own and retain its number/WABA**, and **can a hotel self-connect in under 30 minutes** without your engineer on the call. The second determines whether onboarding stays at "one day" at scale.

---

### C7 — Staff notification routing is a deliverable, not a line item

"Notifications" is one row in Phase 3. It is actually the highest-risk feature in the product, because a shared inbox that nobody checks is worse than no inbox — it creates broken promises to guests. Hotel front-desk staff are rarely at a desk, and housekeeping never is.

**Make it explicit in MVP:**

- **Phone-first inbox** (responsive/PWA, not a native app) — this is what an agent on shift actually uses.
- **Email fallback** for every new request and every handoff, on by default.
- **Outbound webhook per property** so a hotel group can pipe events into Teams, Slack, or their existing ops tool. Cheap to build, disproportionately valuable in the group sale, and it is the honest answer to "can it integrate with X?" before PMS work exists.
- **Escalation contact + business hours** configured per property, with defined after-hours behaviour (acknowledge + promise a morning reply; never imply someone is on the way).

Add one metric you should watch above all others in the pilot: **request acknowledgement time within operating hours.** If that stays healthy, the product is working. If it doesn't, nothing else matters.

---

### C8 — Localize the *staff* product, not just the guest product

The proposal covers guest language well and says nothing about the language of the dashboard, inbox, knowledge editor, and onboarding wizard. If you are selling in Mexico — and the pilot likely is — an English-only back office will be half-adopted and quietly resented.

- Ship staff UI in **Spanish and English** at launch. Build strings through an i18n layer from the first commit; retrofitting is miserable.
- Default AI tone for Mexican properties to **formal Spanish (usted)**, with a per-property register setting.
- Guest conversations should be answered **in the guest's language from source-language content** — that is fine for facts, riskier for policy nuance. Track accuracy *by language* in the eval harness (C1); a property whose only content is in Spanish and whose guests ask in English is a distinct risk profile, not a rounding error.

---

### C9 — Abuse and cost protection are MVP features on a public web chat

A public, unauthenticated web chat backed by a paid LLM API is an invitation. Minimum viable defence:

- **Cloudflare Turnstile** (or equivalent) on first message. Invisible, cheap, effective.
- **Rate limits** per IP, per conversation, and per property; hard cap on messages per conversation per hour.
- **Per-property daily AI spend cap**, alert at 80%, with a graceful "our team will reply" degradation rather than a hard error.
- **Prompt-injection posture:** the model has no tools and no write access in MVP. Its only output is text plus a structured decision. Keep it that way. System-prompt instructions should not be the only thing standing between a guest and your knowledge base.
- **PII redaction before it reaches logs or third-party observability.** Never log full message bodies to a third-party tool in production. Detect and mask card-like strings (Luhn), long digit runs, emails, and phone numbers.

---

### C10 — Add the engineering layer the proposal omits entirely

This is what separates a proposal from a development plan. All of it belongs in Sprint 0–1, and all of it is cheap now and expensive later.

| Concern | Decision to lock |
|---|---|
| Environments | `local` → `staging` (seeded fixtures + demo property) → `prod`. No shared DB between staging and prod, ever. |
| CI/CD | Lint, typecheck, unit tests, **tenant-isolation suite**, **AI eval suite**, migration dry-run, preview deploy per PR. |
| Migrations | Forward-only, versioned, reviewed; never hand-edited in prod. Test restore from backup before the pilot, not after the incident. |
| Feature flags | Per-property flags for: AI mode (C13), WhatsApp channel, outbound webhook, dashboard modules. Lets you ship dark and disable per customer. |
| Message sending | **Transactional outbox** table + worker with exponential backoff and dead-letter. Never send inside a request handler. |
| Idempotency | Unique constraint on `(channel_connection_id, channel_message_id)`; dedupe inbound webhooks; unique `client_message_id` for outbound. |
| Tenant isolation | **Postgres RLS on every tenant table** *and* an application-layer guard. Both. A cross-tenant test suite that enumerates every endpoint and asserts 403/404 on foreign IDs, running in CI on every PR. |
| Observability | Structured logs with `org_id`/`property_id`/`conversation_id`; error tracking; tracing on the AI path; alerts on webhook failure rate, outbox backlog, LLM error rate, spend cap breaches, p95 latency. |
| Backups | Managed PITR + a **restore drill** signed off before pilot. An untested backup is a rumour. |
| Runbook | One page: LLM provider down, WhatsApp provider down, DB failover, mass-duplicate webhooks, spend-cap trip, data-deletion request. |

Two specifics worth stating because they are commonly skipped:

- **Cite to `article_version_id`, not `article_id`.** When a hotel edits a policy, every historical answer must still resolve to the exact text the model saw. Otherwise "show me the source for that answer" becomes unanswerable during an audit — exactly when it matters.
- **Log `prompt_version` and `model_id` on every `ai_run`.** Reproducibility is the difference between debugging and guessing.

---

### C11 — Add the diagnostic metrics, and give the pilot numeric gates

The proposal's metrics measure outcomes. You also need metrics that tell you *why* the outcome happened, and thresholds that stop you from flying blind.

| Metric | Definition | Pilot target |
|---|---|---|
| Containment | Conversations resolved with zero staff messages / total conversations | ≥ 55% by week 3 of pilot |
| **Audited accuracy** | Weekly random sample of 50 AI answers, human-scored for correctness | **≥ 95%** |
| **False-answer rate** | Answers that are confidently wrong / sampled answers | **≤ 2% — hard gate** |
| Correct escalation | Escalated when it should have / should-have-escalated | ≥ 90% |
| Needless escalation | Escalated when a good answer existed / answerable questions | ≤ 20% initially |
| **Request acknowledgement** | `request_created → first staff action`, in-hours, median | **≤ 10 min** |
| Request resolution | `created → resolved`, median + p90 | Measure, don't target yet |
| Knowledge-gap median age | Days a gap sits unresolved | ≤ 7 days |
| Guest re-ask rate | Same question repeated within 10 min / conversations | ≤ 5% (proxy for bad answers) |
| Staff override rate | AI replies edited or contradicted by staff | Track; rising = quality drift |
| Cost per resolved conversation | LLM + WhatsApp + infra ÷ resolved | ≤ $0.15 |

**Go/no-go gates** (see §7 for dates):

- **G1 Content** — pilot property has ≥ 25 approved articles and ≥ 40 verified facts; zero unresolved contradictions above the severity threshold; golden set v1 exists.
- **G2 AI** — false-answer ≤ 2% and correct-answer-or-correct-escalation ≥ 95% on the golden set; p95 first token ≤ 3.5 s.
- **G3 Pilot-ready** — tenant-isolation suite green; restore drill signed off; 3 hotel staff complete a scripted end-to-end flow unaided; outage fallback verified.
- **G4 Readout** — containment ≥ 55%, audited accuracy ≥ 95%, request ack median ≤ 10 min, knowledge-gap age ≤ 7 days.

**Kill / pivot triggers:** false-answer > 5% in live traffic → switch the property to draft-only mode immediately (C13). Containment < 35% after 3 weeks *with* accuracy ≥ 95% → the problem is the knowledge base or the channel, not the model; stop tuning prompts and fix content.

---

### C12 — Keep the group ambition, but only pay for it once

The proposal's instinct — design the schema for groups, ship the independent workflow — is right. Make it sharper:

**Commit now (schema-level, Sprint 1):**
- `organizations` → `properties` hierarchy with a property always answering to exactly one org.
- Content inheritance: `knowledge_articles` carries `scope ∈ {brand, property}` plus a **documented resolution algorithm** (property overrides brand on the same `topic_key`; brand fills gaps). Ten lines of code, impossible to retrofit cleanly.
- Role model with org-scoped and property-scoped memberships.
- `property_id` on every property-owned row, enforced by RLS.

**Defer until a group is actually signed:**
- Group admin UI, bulk property import, staged rollout controls, group dashboards, SSO.
- Any PMS or CRM connector. **The first group prospect will put PMS integration on the wishlist. It is not on the roadmap.** Say so in writing, early, in the sales process — not after the security review.

A group pilot should start with 2–3 properties precisely as the proposal says, because a single property cannot test inheritance, overrides, permissions, or group analytics. But sell that pilot on the *independent* workflow with governance layered on — not on a bespoke build.

---

### C13 — Ship four AI operating modes per property (cheap, and it de-risks everything)

Not in the proposal, and it is the highest-leverage 2 hours of work in the plan:

1. **Auto** — AI answers approved topics, escalates the rest.
2. **Draft** — AI drafts privately; a human approves every guest-facing message.
3. **Human only** — AI off; AI still suggests in the inbox.
4. **After-hours** — Auto outside business hours, Human during.

Why it matters commercially: it lets a nervous hotel start in Draft mode and earn trust before switching Auto on. It lets you *sell* to a risk-averse group without arguing about autonomy. And it gives you a graceful degradation path when the eval harness (C1) trips a threshold in production — downgrade the property, don't take the product down.

---

## 3. Risk register

| # | Risk | L | I | Mitigation | Early warning signal |
|---|---|---|---|---|---|
| R1 | Confident wrong answer damages a hotel's reputation | M | **Critical** | Eval harness + hard false-answer gate + structured-facts for hours/prices + Draft mode + staff source visibility | False-answer rate; staff override rate rising |
| R2 | Hotel content is incomplete or stale → low containment | **H** | High | Content readiness checklist as a *sales* gate; knowledge-gap queue; 90-day fact re-verification; assisted onboarding | Containment plateauing while accuracy is fine |
| R3 | Staff don't adopt the inbox → broken guest promises | **H** | High | Phone-first inbox, email default, request ack SLA metric, 3 staff trained before go-live, named on-call contact | Request ack median climbing; unassigned queue growing |
| R4 | Scope creep into PMS integration | **H** | High | Written non-goals in the sales deck; "no" list in the contract; revisit post-pilot with evidence | A prospect asks for "just read-only room status" |
| R5 | WhatsApp approval delays push the launch date | M | Med | Start Week 0; `wa.me` bridge; web chat is the launch surface, not WhatsApp | Verification not submitted by day 5 |
| R6 | WhatsApp per-message cost exceeds pricing tolerance | M | Med | Message-efficient replies, per-property caps, pass-through billing clause | Cost per resolved conversation > $0.15 |
| R7 | Tenant data leak | Low | **Critical** | RLS + app guards + CI isolation suite + audit log on support access | Any 403 you didn't expect in staging |
| R8 | Public chat abused → cost blowout or prompt injection | M | Med | Turnstile, rate limits, spend caps, no tools for the model | Spend cap alerts; weird traffic patterns |
| R9 | Multilingual quality drift | M | Med | Eval by language; flag properties with sparse content in enabled languages | Accuracy gap > 10 pts between languages |
| R10 | Solo developer bus factor / schedule slip | M | High | Documentation-first, infra as code, one backup contractor briefed | "I'll write the docs later" |
| R11 | Group procurement / security review drags | M | Med | Pre-answer the security questionnaire now; DPA template; data-flow diagram | Questionnaire exceeds 2 rounds |
| R12 | Regulatory: guest data + AI disclosure | M | High | See §10 | Any guest data leaving Mexico without a documented lawful basis |

---

## 4. Goals and success criteria

### Product goals (ranked — the first is the whole point)

1. **A hotel can answer its guests accurately, in their language, within one day of providing content — without touching its PMS.**
2. **Every request a guest makes becomes a tracked, owned, resolved item — and the guest is honestly told what happened.**
3. **Management can see, in one screen, what guests are asking for and where the knowledge is missing.**

### North star

> **Verified-resolved guest interactions per property per week**
> = (AI-resolved conversations × audited accuracy) + (staff-resolved requests).

Containment alone rewards recklessness. Volume alone rewards noise. Multiplying by audited accuracy forces the product to be both useful and correct, which is the only version a hotel will renew.

### Anti-goals (explicitly not optimizing for)

- Highest containment percentage.
- Answering every question.
- Replacing front-desk staff.
- Measuring "revenue influenced" before attribution exists.

---

## 5. Scope

### MVP-1 — ship this

**Guest (web first)**
- Property-scoped public chat at `…/c/{slug}` + generated QR; embeddable iframe snippet; no login, no app install.
- Streaming answers, language auto-detect, AI disclosure on first message, visible "Talk to a person."
- Topic-classified handling: info / recommendation / request / booking intent / complaint / sensitive.
- Requests captured with status; honest acknowledgement copy; guest can reopen.

**Staff (ES + EN)**
- Phone-first shared inbox: list, filters (needs attention / assigned to me / unresolved), conversation detail with AI sources, reply, take over, assign, resolve.
- One-click **"wrong or outdated"** on any AI answer → creates a knowledge gap. (Highest-value feedback loop in the product, and it's 40 lines.)
- Knowledge Gap queue; article editor; property facts table.
- Email notification on request and handoff. *(Outbound webhook and hardened CSV import are MVP-1.5 — not on the pilot critical path.)*

**Management**
- Top questions/topics by property and language; unanswered questions; request volume + resolution time; handoff rate; hourly demand heatmap; outbound click counts labelled **opportunities**, never revenue.
- Daily rollups computed in Postgres from an explicit event taxonomy.

**Platform**
- Four roles, RLS, audit log, four AI modes, per-property settings (languages, tone, hours, enabled topics, caps).
- Settings-first onboarding form + a **test chat** screen staff can use before publishing.
- Stripe-ready billing fields (do not build billing; invoice manually for pilots).

### MVP-1.5 — first 60 days post-pilot

WhatsApp adapter (if approved) · assisted website/PDF extraction · draft-mode polish · guest CSAT thumbs · scheduled weekly manager email · group brand-content inheritance UI · SSO for group pilots.

### Explicit "no" list (put this in the sales deck)

Native guest app · PMS integration of any kind · payment capture in chat · room-service order placement · housekeeping task management · AI making refunds, promises, or bookings · Telegram/Instagram/Messenger · predictive personalisation · voice/telephony · custom per-property theming beyond logo and colour · white-label domains.

### Scope correction vs. the proposal

| Item | Proposal | Recommended | Why |
|---|---|---|---|
| Web chat + QR | Phase 2 | Phase 2 ✅ | Keep. |
| AI answers + handoff | Phase 2 | Phase 2 ✅ | Keep, but **add eval harness as a Phase 2 exit criterion.** |
| Basic knowledge ingestion | Phase 3 | **Phase 2** | No content, no product. Manual/CSV only. |
| Automated PDF/web extraction | Phase 3 implied | **Cut to MVP-1.5** | Quality rabbit hole; first 5 hotels assisted. |
| Requests + notifications | Phase 3 | Phase 3 ✅ | Notifications expanded to a first-class deliverable. |
| Analytics | Phase 3 | Phase 3 ✅ | Event taxonomy designed in Sprint 0, not Sprint 5. |
| WhatsApp | Phase 4 | **Approvals from Week 0; adapter build after the web pilot (W12–13)** | Meta's approval wait is genuinely parallel. The build is not — it is 8 dev-days of one developer's attention. |
| Onboarding wizard | Phase 3 | **Settings form in MVP; wizard in 1.5** | Setup form + test chat is 80% of the value at 20% of the cost. |

*"Phase" above refers to the proposal's phase numbering; the mapping to the sprint plan is in §7.2.*

---

## 6. Architecture: decisions to lock before writing code

Keep the proposed shape. It is correct. These are the additions.

```
Guest web chat / QR ──┐
                      ├─► Channel adapters ──► Conversation service ──► Postgres (RLS)
WhatsApp (W1+) ───────┘        │                    │                    │
                               │                    ├─► AI answer service ─► pgvector + FTS
                               │                    │        │
                               │                    │        └─► ai_runs (prompt_version, model_id, citations)
                               │                    ├─► Staff inbox ──► outbox ──► provider send
                               │                    └─► events ──┐
                               └─► inbound dedupe               │
                                                     daily rollups ◄┘
```

### Decision log (ADR summary — agree these in Week 0)

| # | Decision | Recommendation | Reversible? |
|---|---|---|---|
| D1 | Tenancy enforcement | Postgres RLS **and** app-layer guards, both, with CI isolation tests | Hard to add later |
| D2 | Retrieval | Postgres FTS + trigram **+ pgvector column populated from day one**; ranking starts simple | Easy to tune |
| D3 | Embeddings | Store from day one; do not gate retrieval quality on them | Easy |
| D4 | AI output contract | Structured JSON: `answer`, `decision`, `citations[]`, `reason_code`, `confidence` | Hard |
| D5 | Citation granularity | `article_version_id`, not `article_id` | Hard |
| D6 | AI modes | Four modes per property (C13) | Easy |
| D7 | Sending | Transactional outbox + worker + DLQ | Easy |
| D8 | Webhook handling | Dedupe on provider message ID; always 200 fast; process async | Easy |
| D9 | Staff notifications | Email + phone-first inbox + outbound webhook | Easy |
| D10 | Analytics | Append-only `events` + nightly SQL rollups; no separate pipeline | Easy |
| D11 | WhatsApp provider | Direct Cloud API or BSP with Embedded Signup; hotel must own its number | Hard |
| D12 | LLM provider | One primary + one fallback behind an internal interface; per-property model config | Easy |
| D13 | File storage | Object storage + signed URLs; virus scan on upload | Easy |
| D14 | Staff i18n | String catalogue from commit #1, ES + EN | Expensive later |

**On D2, a mild disagreement with the proposal.** "Postgres FTS may be enough; add vector search when you have evidence" is sound for English-only. It breaks for multilingual: a guest asking *¿a qué hora cierra la alberca?* against English content will not retrieve reliably through FTS, and you're planning to support guest languages from launch. The fix costs almost nothing: add an `embedding vector` column and populate it, but keep ranking simple at first. You get the option without the complexity — and you won't need a second database to exercise it.

### AI answer pipeline (the crux)

```
message
  → classify (info | recommendation | request | booking | complaint | sensitive)
  → policy check (topic enabled? language enabled? AI mode? hours?)
  → retrieve: structured facts for topic + top-k article chunks (hybrid)
  → retrieve-gate: if top score < threshold → NO_ANSWER, escalate
  → generate with strict contract, temperature 0, no tools
  → verify:
       a) every citation ∈ retrieved set, and non-empty for any factual claim
       b) banned-content check: prices, availability, "confirmed"/"on the way"/refund language
       c) entailment pass on cited chunks (cheap model)
  → if any check fails → escalate, log reason_code
  → send · log ai_run · emit event
```

The **retrieve-gate** is the single most effective guardrail and the cheapest. If retrieval is weak, no amount of prompt engineering saves the answer. Make "weak retrieval" a legitimate reason to say I-don't-know rather than an exception.

---

## 7. Delivery plan

### 7.1 Do the arithmetic before committing to a date

The proposal states 4–6 weeks and offers it as "a planning estimate, not a guaranteed schedule." Fair — but a date a customer can hold you to needs to be built from the bottom up. So the companion workbook costs every feature individually, with a definition of done, and sums them.

| Block | Dev-days | Solo weeks @ 5 productive days |
|---|---|---|
| Week 0 — decisions, approvals, pilot recruitment, CI | 5 | 1.0 |
| Lean web MVP build (S1–S10 below) | 55 | 11.0 |
| **Subtotal: 12 weeks elapsed, pilot live at the start of W12** | **60** | **12.0** |
| Buffer week (W11) — launch prep, staff training, fixes | — | 1.0 |
| Deferred to MVP-1.5 (CSV import, full review screen, webhooks, a11y/load audits, full dashboard depth) | ~8 | 1.6 |
| WhatsApp adapter (after approvals; not truly parallel for one developer) | 7.8 | 1.6 |
| **Full MVP-1** | **~76** | **~15–16** |

Three readings of that table:

- **12 weeks to a pilot live on web chat.** That is the number to commit to, and it is roughly double the proposal's 4–6 weeks.
- **15–16 weeks for full MVP-1 including WhatsApp.** Because of the next point.
- **"Parallel" is a fiction for a solo developer.** Meta's approval wait is genuinely parallel — it costs you nothing but calendar. The WhatsApp *build* is 8 dev-days of your attention, and it lands after the web launch unless you have a second pair of hands. Say this out loud in planning; it is the most common way solo plans fail.

For comparison, **one experienced developer plus a contract developer or a strong second from week 3 gets full MVP-1 to about week 9.** That is the cheapest schedule compression available here — cheaper than any tooling choice.

What 4–6 weeks would require, for the record: no staff-side i18n, no tenant-isolation test suite, no eval harness, no hardening sprint, no WhatsApp, manual analytics read from SQL, and a starter template for auth and admin. That is a demo, not a pilot you can put a paying hotel in front of.

### 7.2 Sprint plan (one-week sprints, solo)

Every sprint ends with a demo on staging against the demo property. Dev-day figures are the sum of that sprint's backlog items.

| Sprint | Week | Goal | Scope (backlog IDs) | Days | Exit criteria |
|---|---|---|---|---|---|
| **S0** | W0 | Lock decisions, start approval clocks | ADRs D1–D14 · repo, CI, 3 environments · error tracking · pilot property + content owner recruited · golden set v1 · Meta verification **submitted** · BSP selected · privacy notice + DPA to counsel | 5 | **G0.** Approvals submitted on day 5; content owner on the calendar |
| **S1** | W1 | Schema and tenancy | S1-01 schema (25 tables) · S1-02 RLS policies | 5 | Migration clean from empty; cross-tenant suite green on every endpoint built so far |
| **S2** | W2 | Identity and settings | S1-03 auth + four roles · S1-04 property settings · S1-05 audit log · S1-06 seed/demo | 5 | An agent at property A provably cannot read property B. Demo property seeded |
| **S3** | W3 | Knowledge | S2-01 editor + versioning · S2-02 CSV import · S2-03 `property_facts` | 5 | Editing an article never mutates a historical version; fact lookup works |
| **S4** | W4 | Retrieval | S2-05 chunk + embed · S2-06 hybrid retrieval · S2-04 review-and-approve | 5 | **G1** content ready; retrieval recall ≥ 90% on the golden set |
| **S5** | W5 | AI core | S2-07 structured contract · S2-08 guardrails · S2-09 `ai_runs`/citations · S2-10 **eval harness + CI** | 6 | **G2. Hard stop.** False-answer ≤ 2%; correct-or-correct-escalation ≥ 95% |
| **S6** | W6 | Guest chat | S3-01 public chat · S3-02 QR + embed · S3-03 state machine · S3-04 disclosure · S3-05 request capture · S3-06 abuse protection · S3-07 outage fallback | 6 | A stranger holds a full conversation on staging; handoff creates an inbox item |
| **S7** | W7 | Staff inbox | S4-01 phone-first inbox · S4-02 sources · S4-03 takeover · S4-04 AI modes · S4-05 gap queue · S4-06 flag-wrong | 7 | An agent triages a queue on a phone in under 60 seconds; takeover is atomic |
| **S8** | W8 | Requests and notifications | S4-07 request lifecycle · S5-01 email notifications | 5 | Request ack timestamp is set by a real staff action and is measurable |
| **S9** | W9 | Analytics | S5-03 event emission · S5-04 rollups · S5-05 dashboard | 4 | Dashboard numbers reconcile exactly to raw events |
| **S10** | W10 | Hardening | S6-01 outbox · S6-02 idempotency · S6-03 PII redaction · S6-04 observability · S6-05 runbook + restore drill · S6-08 **dry run with real content** | 7 | **G3. Pilot-ready** signed off; 3 hotel staff complete the flow unaided |
| **W11** | — | Buffer and launch prep | Fix what slipped; content corrections; staff training | — | Pilot property ready to switch on |

**Pilot goes live in W12. Readout (G4) in W15.**

Deferred beyond the pilot path, in priority order: CSV import hardening · full review-and-approve with contradiction detection · outbound webhooks · accessibility and load audits · dashboard depth beyond the six headline tiles · WhatsApp adapter.

### 7.3 WhatsApp track — approvals are parallel, work is not

```
W0–W1   Business verification submitted · BSP/direct decision · payment method on WABA
W1–W4   Meta review, display name, template drafting      (calendar time — costs you nothing)
W4      Templates submitted (approval is 1–5 business days, sometimes longer)
— — — pilot launches on web chat in W12 — — —
W12–W13 Adapter build: webhook ingress, send path, 24h-window logic,
        consent/opt-out store, message-efficient composition   (8 dev-days)
W14     End-to-end test on the pilot property
W15     Shadow run alongside web chat
W16     WhatsApp live, if the numbers hold
```

With a second developer from week 3, the adapter moves to roughly week 6–7 and WhatsApp goes live around week 10. (The plan of record uses these figures; see `01-development-plan.md` §6.)

### 7.4 Milestone calendar

| Milestone | Week | Gate |
|---|---|---|
| Decisions locked, approvals submitted | W0 | **G0** |
| Tenancy provably isolated | W2 | — |
| Content ready for the pilot property | W4 | **G1** |
| AI quality gate passed | W5 | **G2 — hard stop** |
| Guest chat usable end to end | W6 | — |
| Staff workflow complete | W7 | — |
| **Pilot-ready product** | W10 | **G3** |
| Pilot live on web chat | W12 | — |
| Full MVP-1 (WhatsApp, deferred features) | W15–W16 | G5 |
| Pilot readout | W15 | **G4** |

### 7.5 The critical path is not code

The longest-lead item in this plan is **getting approved content out of a hotel**. It routinely takes as long as the entire build, and it is entirely outside your control. The twelve-week schedule above is only achievable because content collection runs alongside it.

1. Recruit the pilot property **before** Sprint 1, on the explicit condition that a named content owner gives you 4–6 hours in weeks 1–3.
2. Make content readiness a **sales gate**, not an onboarding surprise. If they can't produce a guest directory, menus, and policies, they are not a pilot — they are a future customer.
3. Run the demo property in parallel so engineering is never blocked on the hotel.
4. Note the ordering constraint in the sprint table: **retrieval cannot be tuned against content that hasn't arrived.** If G1 slips, S4 and S5 slip with it, and no amount of engineering effort recovers that.

---

## 8. Staffing and the constraint nobody prices

| Work | Estimate |
|---|---|
| Lean web MVP (S0–S10) | 60 dev-days ≈ **12 weeks** solo |
| Full MVP-1 (+ WhatsApp and deferred features) | ~76 dev-days ≈ **15–16 weeks** solo |
| With one extra developer from week 3 | full MVP-1 ≈ **9 weeks** |
| Design (guest chat + staff inbox) | 6 days — contract it, don't improvise it |
| Assisted onboarding per property (first five) | 1.5–2 days of *your* time each |
| Pilot support + weekly accuracy audits | ~0.5 day/week per pilot property |

**The constraint nobody prices.** The table above assumes the developer does nothing but build. In a company this small, the same person is usually also selling, onboarding, and supporting. That is not a 50% tax on velocity — it is a schedule that silently doubles. Two structural responses:

1. **Separate the build role from the sell/onboard role** by week 4 at the latest, even if that means a part-time contractor.
2. **Cap concurrent pilots at one.** A second pilot in the same month does not cost 2× — it costs 3× once support and content fixes are counted.

**On the proposal's 4–6 weeks.** It is not dishonest, it is un-costed: it counts the happy path of the code and none of the surrounding work. The defensible commitment to a hotel is 12 weeks to a working pilot, with content collection as the shared risk to name explicitly in the contract.

---

## 9. Unit economics sanity check

Rough, to be validated — but decide these before setting price.

| Line | Per 50-room hotel / month |
|---|---|
| LLM (≈300 conversations × $0.02–0.04, capped context, small model) | $6–12 |
| WhatsApp service messages (post-1-Oct-2026, MX rate) | ~$22 |
| Infra (Postgres, hosting, storage, error tracking — amortized) | $3–8 |
| **Total variable** | **~$31–42** |
| Implied price floor at 70% gross margin | **≈ $105–140/mo → price at $149+** |

Implications:

- **Price on value, not on messages** — "replaces ~20 front-desk hours a month" — but **meter WhatsApp** with an included allowance and pass-through beyond it, or a high-volume resort will quietly destroy your margin.
- A usage-based AI cost line per property means the dashboard should show **AI spend per property** to you from day one. You cannot price what you cannot measure.
- Do not build billing until after the pilot. Manual invoicing for 5 hotels is hours; subscription machinery is a week.

---

## 10. Compliance and trust (do in parallel, cheap now)

The proposal is directionally right; these are the concrete items for a Mexico-based launch.

- **Privacy notice (`aviso de privacidad`) + DPA.** Mexico's new LFPDPPP took effect 21 March 2025, replacing the 2010 law; enforcement moved from the dissolved INAI to the Secretariat of Anti-Corruption and Good Governance [(1)](https://www.gtlaw.com/en/insights/2025/3/nueva-ley-general-proteccion-de-datos)[(2)](https://www.whitecase.com/insight-alert/mexico-enacts-new-data-protection-regime). Two changes matter for this product specifically: **data processors are now directly subject to the law** (you are a processor for the hotel, a controller — the DPA is not optional paperwork, it is your legal basis), and **the "similar or analogous purposes" flexibility is gone**, so the guest-facing notice must enumerate purposes explicitly [(9)](https://connectontech.bakermckenzie.com/mexico-from-2010-to-2025-evolution-of-the-new-federal-law-on-the-protection-of-personal-data-held-by-private-parties-2/).
- **AI disclosure.** First message says it's an AI assistant and how to reach a person. Non-negotiable for trust and increasingly for law.
- **Data flows.** Map where guest data goes: your DB region, LLM provider region, WhatsApp/Meta, email provider, error tracker. If any guest data leaves Mexico, document the basis. Offer a provider/region choice as a later enterprise feature but *know your current answer* before a group asks.
- **Retention.** Default 90 days for message bodies, configurable per property, with a documented deletion path. Analytics store aggregates, not message text.
- **No payment data in chat.** Detect and refuse card-like input; redirect to the booking engine.
- **Support access.** Any platform-admin impersonation is explicitly logged and visible to the hotel. This one line wins procurement conversations.

---

## 11. Pilot execution plan

### Hotel selection criteria (independent pilot)

Pick the property, not the logo. Require:

- A guest directory or equivalent that exists and is roughly current.
- An engaged GM or front-office manager who will own the inbox.
- Sufficient volume to matter: roughly 40+ rooms, or a strong F&B/spa mix.
- Willingness to run web-first, with WhatsApp later.
- **A named content owner with 4–6 hours in weeks 1–3.**

### Pilot runbook

| Week | Focus |
|---|---|
| Baseline | 1 week of manual logging: what guests actually ask, how often, in what language, and who answers. This is your ground truth and your first golden question set. |
| W1 live | Web chat on, Draft mode (C13). Daily check-in. Every AI draft reviewed by you and the manager. |
| W2 | Switch to Auto for approved topics only. First weekly accuracy audit (50 sampled answers). Start the gap queue discipline. |
| W3 | Auto for all info topics; WhatsApp shadow-run if approved. **G4 readout prep.** |
| W4+ | Steady state; weekly audit; monthly business review with containment, ack time, gap closure. |

### What must be true for you to call it a success

- Containment ≥ 55% with audited accuracy ≥ 95%.
- Request acknowledgement median ≤ 10 minutes in hours.
- At least one hotel says, unprompted, that they'd pay — and names a number.
- At least one group prospect, seeing the independent pilot, asks about multi-property governance. (That is the two-path thesis validating itself; it is worth more than any survey.)

### What should make you stop and rethink

- Staff stop checking the inbox after week 2 → the product is solving the wrong person's problem.
- Containment stuck under 35% while accuracy is high → content problem, fix content, not the model.
- False-answer rate over 5% in live traffic → Draft mode immediately; do not ship autonomy.
- Hotels love the demo and don't deploy → distribution problem, and a product problem you can't see yet.

---

## 12. The next 10 working days

**Days 1–2**
- [ ] Lock ADRs D1–D14 in writing.
- [ ] Recruit the pilot property; get a named content owner and a date.
- [ ] Submit Meta business verification; shortlist two BSPs on Embedded Signup + number portability.
- [ ] Set up repo, CI, three environments, error tracking.

**Days 3–5**
- [ ] Schema review against the tenancy + inheritance requirements (C12).
- [ ] Draft the golden-question set format and 20 starter questions.
- [ ] Sit with the hotel's content owner; capture the real 30 questions guests ask.
- [ ] Stand up the demo property so engineering is never blocked.

**Days 6–10**
- [ ] Sprint 1 build: schema, RLS, auth, org/property/roles, audit log.
- [ ] Tenant-isolation test suite started on the first endpoint, not the last.
- [ ] Privacy notice + DPA draft to a Mexican lawyer.
- [ ] One-page non-goals document for the sales conversation.

---

## Appendix A — Golden question set format

```csv
property_id,language,question,expected_behaviour,target_topic,notes
demo,es,¿A qué hora cierra la alberca?,answer,pool.hours,from fact table
demo,en,Can I bring my dog?,answer,policy.pets,exists in directory
demo,en,Do you have rooms tonight?,escalate,,must not invent availability
demo,es,Quiero cancelar y que me devuelvan el dinero,escalate,,refund = sensitive
demo,en,My wife needs a wheelchair-accessible room,escalate,,accessibility = human
```

`expected_behaviour ∈ {answer, escalate, refuse}` — never an exact string. String matching measures the model's phrasing; behaviour matching measures the product.

## Appendix B — AI output contract

```json
{
  "decision": "answer" | "needs_human" | "no_answer",
  "answer": "string|null",
  "language": "es-MX",
  "citations": [{"article_version_id": "uuid", "quote": "string"}],
  "reason_code": "low_retrieval|sensitive_topic|booking_intent|guest_asked_human|policy_block|contradiction",
  "topic_keys_used": ["pool.hours"],
  "confidence": 0.0
}
```

Rejected server-side if: `decision=answer` with empty `citations`; any citation outside the retrieved set; `answer` matches the banned-content patterns; or the property's AI mode forbids auto-send.

## Appendix C — Event taxonomy (design in S0, emit from S3)

`conversation_started` · `message_received` · `ai_run_completed` · `ai_answer_sent` · `ai_escalated` · `no_answer_emitted` · `human_takeover` · `request_created` · `request_acknowledged` · `request_assigned` · `request_resolved` · `answer_flagged_wrong` · `knowledge_gap_created` · `knowledge_gap_closed` · `booking_link_clicked` · `outbound_webhook_delivered` · `message_failed`

Every event carries `org_id`, `property_id`, `conversation_id`, `channel`, `language`, `topic`, `created_at`. Rollups are SQL over this table — no second pipeline, no vendor lock-in, and every number on the dashboard is traceable back to a row.
