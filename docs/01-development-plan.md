# AI Guest Concierge — Development Plan v1.0

**Plan of record · 21 October 2026**
**Owner:** Founder / technical lead
**Basis:** The proposal reviewed in `00-proposal-evaluation.md`, with all agreed amendments incorporated. Nothing here is still "under discussion" — the decisions are stated as decisions.

| | |
|---|---|
| **What we are building** | A multi-tenant AI guest concierge: answers guest questions accurately from hotel-approved content, captures service requests, routes them to staff, and shows management what guests ask for. No PMS integration. |
| **First customer** | One independent hotel, 40+ rooms, engaged front-office manager, content owner available in weeks 1–3. |
| **Plan of record** | **14 weeks to a pilot live on web chat** (69.75 dev-days across 80 backlog items). Full MVP-1 including WhatsApp at ~17 weeks solo, or ~10 with a second developer from week 3. |
| **Build cost** | 69.75 dev-days to pilot path; 79 dev-days for full MVP-1. ~$48.6k one-time at $550/day blended, including design and legal. |
| **Capital** | Bootstrap path consumes ~$51k peak. Funded path needs ~$231k. This is the single most consequential decision in the plan — see §7.4. |
| **The constraint that decides the outcome** | Not code. It is (a) getting approved content out of a hotel, and (b) the buyer's ROI at their local labour rate. Both are addressed in §4 and §7. |

---

## 0. Scope, stated once

### MVP-1 — the pilot product

**Guest (web first, Spanish + English)**
Property-scoped chat at `/c/{slug}`, reachable from the hotel website, a QR code, or a one-line embed. Streaming answers, language auto-detect, AI disclosure on the first message, and an obvious "Talk to a person" at every step. Service requests are captured with status and acknowledged honestly — *"I've sent your request to the team"*, never *"your towels are on the way."*

**Staff (phone-first)**
A shared inbox that works on the phone an agent actually carries. Filters for needs-attention / mine / unresolved. Conversation detail shows the exact article version the AI used. Take over, assign, resolve. One-click **"wrong or outdated"** on any AI answer, which lands in a **Knowledge Gap** queue — the highest-leverage 40 lines in the product. Email notification on every request and handoff. Four AI operating modes per property (Auto / Draft / Human-only / After-hours).

**Management**
Top questions and topics by property and language; unanswered questions; request volume and resolution time; handoff rate; hourly demand; outbound clicks labelled **opportunities**, never revenue. All computed from one append-only event table.

**Platform**
Four roles, Postgres row-level security, audit log, per-property settings (languages, tone, hours, enabled topics, spend caps), and a test-chat screen staff can use before publishing.

### MVP-1.5 — first 60 days after the pilot
WhatsApp adapter if approvals land · assisted website/PDF extraction · guest CSAT thumbs · scheduled weekly manager email · group brand-content inheritance UI · SSO for group pilots · hardened CSV import · outbound webhooks.

### Not building. Written down, in the sales deck.
Native guest app · **any PMS integration** · payment capture in chat · room-service order placement · housekeeping task management · AI issuing refunds, discounts, or binding promises · Telegram/Instagram/Messenger · predictive personalisation · voice/telephony · per-property theming beyond logo and colour · white-label domains.

> **The one to defend.** The first group prospect will ask for read-only PMS access because it sounds small. It is not small — it converts a one-day deployment into a six-month integration project and makes every customer a bespoke build. It is answered after the pilot, with evidence, or not at all.

---

## 1. Goals and success criteria

### Three product goals, ranked

1. **A hotel can answer its guests accurately, in their language, within one day of providing content — without touching its PMS.**
2. **Every guest request becomes a tracked, owned, resolved item, and the guest is told the truth about what happened.**
3. **Management can see, on one screen, what guests are asking for and where the knowledge is missing.**

### North star

> **Verified-resolved guest interactions per property per week** = (AI-resolved conversations × audited accuracy) + (staff-resolved requests).

Containment alone rewards recklessness; volume alone rewards noise. Multiplying by audited accuracy forces the product to be both useful and correct — the only version a hotel renews.

### Anti-goals
Highest containment percentage · answering every question · replacing front-desk staff · claiming revenue attribution before we can prove a booking.

### The seven gates

| Gate | When | Pass criteria | If it fails |
|---|---|---|---|
| **G0** Decisions & approvals | End W0 | ADRs D1–D14 recorded; Meta verification submitted; pilot content owner named with dates; demo property seeded | Do not start Sprint 1 |
| **G1** Content ready | End W3 | ≥25 approved articles, ≥40 verified facts, zero unresolved contradictions, golden set ≥40 questions | Delay the pilot, not the build |
| **G2** AI quality | End W5 | False-answer ≤2%; correct-or-correct-escalation ≥95%; retrieval recall ≥90%; p95 first token ≤3.5s | **Hard stop.** Fix retrieval and content, not prompt wording |
| **G3** Pilot-ready | End W11 | Tenant-isolation suite green; restore drill signed off; 3 hotel staff complete a scripted flow unaided; outage fallback verified | Ship in Draft mode only |
| **G4** Pilot readout | W17 | Containment ≥55%; audited accuracy ≥95%; request ack median ≤10 min; gap age ≤7 days | Do not scale sales |
| **G5** WhatsApp live | W18 | Verification and templates approved; consent/opt-out tested; cost per conversation within model; 7-day clean shadow run | Stay web-only |
| **G6** Group pilot | Post-G4 | 2–3 properties on the same product; inheritance exercised; group reporting live; security questionnaire answered without bespoke work | Do not take a group that requires PMS integration |

---

## 2. Architecture

Unchanged in shape from the proposal, because the shape was right. What is added is the reliability layer.

```
Guest web chat / QR ──┐
                      ├─► Channel adapters ──► Conversation service ──► Postgres (RLS)
WhatsApp (W12+) ──────┘        │                    │                    │
                               │                    ├─► AI answer service ─► FTS + pgvector
                               │                    │        └─► ai_runs (prompt_version, model_id, citations)
                               │                    ├─► Staff inbox ──► outbox ──► provider send
                               │                    └─► events ──► nightly rollups
                               └─► inbound dedupe
```

### Decisions locked in Week 0

| # | Decision | Ruling | Reversibility |
|---|---|---|---|
| D1 | Tenancy | Postgres RLS on every tenant table **and** app-layer guard, with a cross-tenant CI suite | Hard |
| D2 | Retrieval | FTS + trigram + pgvector, populated from day one; ranking starts simple | Easy |
| D3 | Embeddings | Stored from day one even if ranking ignores them initially | Easy |
| D4 | AI output | Structured JSON contract: decision, answer, citations, reason_code, confidence | Hard |
| D5 | Citations | `article_version_id`, not `article_id` | Hard |
| D6 | AI modes | Auto / Draft / Human-only / After-hours, per property | Easy |
| D7 | Sending | Transactional outbox + worker + backoff + DLQ | Easy |
| D8 | Webhooks | Dedupe on provider message ID; ack <3s; process async | Easy |
| D9 | Notifications | Email + phone-first inbox + signed outbound webhook | Easy |
| D10 | Analytics | Append-only `events` + nightly SQL rollups; no second pipeline | Easy |
| D11 | WhatsApp provider | Direct Cloud API or BSP with Embedded Signup; hotel owns its number | Hard |
| D12 | LLM provider | One primary + one fallback behind an internal interface; per-property model config | Easy |
| D13 | File storage | Object storage + signed URLs + virus scan | Easy |
| D14 | Staff i18n | String catalogue from commit #1; ES + EN at launch | Expensive later |

Two of these are worth restating because they are commonly skipped and expensive to fix:

- **D5, cite the version, not the article.** When a hotel edits a policy, every historical answer must still resolve to the exact text the model saw. Otherwise *"show me the source for that answer"* is unanswerable during an audit — precisely when it matters.
- **D2, add the vector column now.** Pure full-text search works for English-only. It breaks when a guest asks *¿a qué hora cierra la alberca?* against English content. The column costs nothing today and means re-embedding everything later if skipped.

### Data model

`organizations` · `properties` · `users` · `memberships` · `roles` · `channel_connections` · `channel_identities` · `conversations` · `messages` · `message_delivery_events` · `service_requests` · `assignments` · `internal_notes` · `knowledge_sources` · `knowledge_articles` · `article_versions` · `property_facts` · `ai_runs` · `citations` · `handoff_reasons` · `knowledge_gaps` · `events` · `rollups` · `audit_log` · `outbox`

Every property-owned row carries `property_id`. Enforced by RLS **and** application guards, tested by a suite that enumerates every endpoint and asserts 403/404 on foreign IDs.

### Content inheritance, decided now

`knowledge_articles` carries `scope ∈ {brand, property}`. Resolution: property content overrides brand content on the same `topic_key`; brand fills gaps. Ten lines of code in Sprint 1, and impossible to retrofit cleanly once groups are live.

---

## 3. AI system design

### The answer pipeline

```
message
  → classify (info | recommendation | request | booking | complaint | sensitive)
  → policy check (topic enabled? language enabled? mode? hours?)
  → retrieve: structured facts for topic + top-k chunks (hybrid)
  → retrieve-gate: if top score < threshold → NO_ANSWER, escalate
  → generate with strict contract, temperature 0, no tools
  → verify:  a) every citation ∈ retrieved set, non-empty for factual claims
             b) banned-content check: prices, availability, "confirmed", "on the way"
             c) entailment pass on cited chunks
  → any check fails → escalate, log reason_code
  → send · log ai_run · emit event
```

**The retrieve-gate is the most effective guardrail and the cheapest.** Weak retrieval is a legitimate reason to say *"I don't know"*, not an exception to log and ignore.

### Provider resilience at the transport layer

The fallback in D12 is a model choice, not a mechanism. Specified:

- **Per-call timeout** (8s generation, 3s classification), retry twice with jitter on 429/5xx only, then **circuit-break to the secondary model** for 60 seconds and log it.
- **Pin model versions** explicitly; never call a floating alias, so an upstream default change cannot silently alter behaviour overnight.
- **Use provider-native structured outputs** (JSON schema) alongside server-side schema validation. Malformed or schema-invalid output is rejected and escalated, never sent — the existing rule — but the parse-failure rate is now an alerting metric, because upstream format drift shows up there first.
- **Degrade honestly:** if both providers fail, the guest gets *"our team will reply"* and a request/ticket is still created. The outage path is a product state, not an exception.

Cost: 0.5 dev-day, folded into S5 and S10.

### "I don't know" is a designed state, not an error path

- Guest sees: *"I don't want to guess on that one — I've asked the front desk to reply directly."*
- Staff sees it in a **Knowledge Gap** queue with the verbatim question, language and property.
- Management sees gap count and median age — the most actionable number in the product, because it says exactly what content to write next.

### Evaluation harness (build in Sprint 5, keep forever)

A `golden_questions` table per property: 40–50 real guest questions in the property's actual languages, each with an **expected behaviour**, never an expected string.

| question | lang | expected | topic |
|---|---|---|---|
| ¿A qué hora cierra la alberca? | es | answer | pool.hours |
| Can I check in early? | en | answer | checkin.policy |
| Do you have a room for tonight? | en | escalate | — |
| I want a refund for last night | en | escalate | — |

Score four ways on every run: **correct answer · correct escalation · false answer · needless escalation**. The gate is the third. Run in CI on every prompt change, model change, or knowledge publish; nightly canary against the live property.

Cost: ~1.5 dev-days. Value: it is the only mechanism that lets you sell "we can turn autonomy up" as a roadmap rather than a hope, and the only way to detect a regression after a hotel edits its own content badly.

### Hours and prices are data, not prose

`property_facts(property_id, topic_key, value, unit, language, effective_from, source_article_version_id, verified_by, verified_at)`.

This buys deterministic answers for the highest-risk questions, contradiction detection at onboarding (website says 21:00, PDF says 20:00 → blocked until a human resolves it), staleness control (re-verify at 90 days), and cheap multilingual answers for the things that must be exactly right.

### Embedding integrity — the failure mode that reaches guests

Article versions are immutable, so retrieval must filter to the **current** version of each article (`article_versions.is_current`). Without an explicit rule, editing an article leaves the old chunks searchable and the concierge quotes a policy the hotel deleted — the most damaging failure this product can have, because the hotel's own assistant is the source of the error.

The mechanism, specified now:
- **On publish:** chunk and embed the new version in a background job, then flip `is_current` in a single transaction.
- **On archive or delete:** soft-delete, remove the chunks from the retrieval index, and preserve citation pointers for historical `ai_runs` (they reference `article_version_id`, so history stays intact while retrieval stops seeing it).
- **Nightly reconciliation job,** asserting three invariants: every current article version has ≥1 chunk; every chunk resolves to a current version; no chunk outlives its parent. Alert on any violation.
- **Retrieval hard-filters** on `is_current` at query time, not just at write time — belt and braces, because a background job that silently fails must not become a wrong answer to a guest.

Cost: 0.5 dev-day. This is a correctness defect, not a scaling concern.

### Four operating modes, per property

**Auto** (answers approved topics, escalates the rest) · **Draft** (AI drafts privately, human approves every outbound message) · **Human-only** (AI off, still suggests) · **After-hours** (Auto outside business hours).

This lets a nervous hotel start in Draft and earn trust, lets you sell to a risk-averse group without arguing about autonomy, and gives you a graceful production downgrade when the eval harness trips.

> **Draft mode is not a pilot operating mode.** A draft nobody reviews is worse than no answer: the guest gets silence while the hotel believes it is covered. Understaffed front desks do not review messages in real time — they are standing in front of a guest. Draft belongs in three places: the pre-launch test chat, specific sensitive topics, and the emergency downgrade path when G2 or a live sample trips. Week one of the pilot runs **Auto with a tight escalation policy**, not Draft. Staff still get a review queue, but it never stands between the guest and an answer.

---

## 4. Knowledge and onboarding

### For the first five hotels: assisted, not automated

Automated PDF and website extraction is a quality rabbit hole disguised as a feature. Multi-column menus, scanned documents and 40 pages of marketing copy will each eat a week and still produce content a manager has to rewrite. Ship instead: a paste-in article editor and a CSV import. Sit with the hotel's content owner for 2–3 hours. That is also your best discovery research, and it removes 5–8 dev-days from the critical path while *improving* launch quality.

Automated extraction becomes an MVP-1.5 feature once you have seen what five real hotels actually send you — which will be a 2019 PDF, a Canva menu, and a WhatsApp screenshot.

**Be precise about where the no-support boundary applies.** A self-serve content readiness checklist — every required section present, every fact verified, no unresolved contradictions, test chat passed — becomes the *gate to onboarding* from hotel four onward. It does not apply to hotels one to three, and applying it to the first pilot would be a good way to have no pilot: the first hotels are where you learn what the checklist should even ask, and the assisted time is already budgeted at 1.5–2 days per property. The rule is that assisted onboarding must *decline* with each property, not that it must be zero on day one. Support is 37–56% of COGS; the target is a per-property support cost that falls toward the modelled 1.0–4.0 hours, not a fantasy of zero for the first customer.

### The fixture hotel is adversarial on purpose

A clean demo dataset tests nothing. The fixture property built in Sprint 1 must be deliberately messy, because the failure modes we care about are all content-shaped:

- a two-column menu exported as a PDF table that flattens into unreadable text
- a scanned policy document with OCR noise
- pool hours that disagree between the website and the guest directory (contradiction detection must catch it)
- a spa price list in a language different from the article body
- one article that is 3,000 words of marketing copy with the useful fact in paragraph eleven
- an article whose only content is a picture of a noticeboard

Building this takes half a day in Sprint 1 and is worth more than any clean test data. If chunking and the retrieval gate survive this fixture, they will survive a real hotel.

### Golden questions: generated, then authored

Forty to fifty hand-written questions is real work. Split it by what each half is for:

- **Answer-expected questions** (roughly two thirds) are drafted by an LLM directly from the approved articles, then reviewed and corrected by a human. Cheap, fast, and it covers the content systematically.
- **Escalation-expected questions** (roughly one third) are written by humans, from the front-desk baseline log. These are the cases that matter most — booking intent, refunds, medical, accessibility, anything ambiguous — and they cannot be generated from the articles, because they are precisely the questions the articles do not answer.

Generating everything would produce a test set biased toward what is in the knowledge base, which is the opposite of what the false-answer gate needs to catch.

### Content plan

| Section | Min. articles | Notes |
|---|---|---|
| Property basics | 3 | Address, parking, check-in/out — as structured facts |
| Amenities & hours | 5 | Hours as `property_facts` with seasonal variants |
| Policies | 6 | Raw policies, not marketing versions |
| Dining | 4 | Allergens always escalate — never AI-only |
| Spa & wellness | 3 | Prices as facts; booking always hands off |
| Local recommendations | 6 | Hotel-approved only. No autonomous browsing, ever. |
| Getting around | 3 | Transfers, taxis, rides, shuttles |
| Troubleshooting | 4 | Self-serve steps, then a request |
| Accessibility | 2 | Any specific need escalates to a human |
| **Total** | **~36** | **G1 requires ≥25 approved + ≥40 verified facts** |

### Onboarding, in order
1. **Baseline week** — log real guest questions at the front desk before writing anything. This is the golden set and the priority order.
2. Property setup: languages, tone, hours, escalation contacts.
3. Content in, via editor or CSV.
4. **Review-and-approve screen.** Nothing publishes silently. Flags missing fields and contradictions.
5. Test chat with the golden questions.
6. Staff invitations, notification preferences, published link and QR.
7. WhatsApp when the business account is ready.

**Target: a usable web concierge within one day of receiving complete content.** That is the commercial promise; it is why the PMS is out of scope.

---

## 5. Security, privacy and compliance

These are MVP features, not an enterprise polish pass.

- **Privacy notice + DPA.** Mexico's LFPDPPP took effect 21 March 2025. Enforcement moved from the dissolved INAI to the Secretariat of Anti-Corruption and Good Governance, and **data processors are now directly subject to the law**. We are a processor; the hotel is the controller. The DPA is not paperwork, it is the legal basis for processing. The "similar or analogous purposes" flexibility is gone, so the guest notice must enumerate purposes explicitly.
- **AI disclosure** on the first message, with a visible route to a human.
- **Data flow map** covering DB region, LLM provider, Meta, email and error tracking. Know the cross-border answer before a group asks.
- **Retention:** 90-day default for message bodies, configurable per property, documented deletion path. Analytics store aggregates, not message text.
- **No payment data in chat:** detect card-like input (Luhn), refuse, redirect to the booking engine.
- **Support access:** any platform-admin impersonation is logged and visible to the hotel. This one line wins procurement conversations.
- **Abuse and cost controls:** Turnstile on first message, rate limits per IP/conversation/property, daily AI spend cap with graceful degradation.
- **Webhook integrity:** signature verification, dedupe, idempotent sends.

---

## 6. Delivery plan

### Weeks, sprints and gates

One-week sprints. Every sprint ends with a demo on staging against the demo property.

| Sprint | Week | Goal | Key outputs | Days | Exit |
|---|---|---|---|---|---|
| **W00** | W0 | Foundation lock | 14 ADRs signed · repo, CI, 3 environments · error tracking · pilot content owner secured · fixture hotel · golden set v1 · Meta verification **submitted** · BSP shortlist · privacy notice to counsel | 8.0 | **G0** |
| **S01** | W1 | Schema and tenancy | 25-table schema · RLS policies · isolation test harness | 5.75 | Migration clean from empty; suite fails the build on a leak |
| **S02** | W2 | Identity, settings, audit | Auth, four roles, property settings, audit log, seed/demo, `is_current` filtering | 5.50 | Property A provably cannot read property B |
| **S03** | W3 | Knowledge | Article editor + versioning · CSV import · `property_facts` | 5.00 | **G1.** Facts answered by lookup; contradictions blocked |
| **S04** | W4 | Retrieval and review | Review-and-approve · chunk + embed · hybrid retrieval | 5.00 | Retrieval recall ≥90% on the golden set |
| **S05** | W5 | AI core | Structured contract · guardrails · `ai_runs` · citations | 5.50 | **G2. Hard stop.** False-answer ≤2% |
| **S06** | W6 | Guest chat + eval | Public chat · state machine · **eval harness + CI** | 5.00 | A stranger completes a conversation end to end |
| **S07** | W7 | Chat hardening | QR/embed · disclosure · request capture · abuse protection · outage fallback · transport resilience | 4.00 | Kill the AI mid-conversation; guest still gets an honest reply |
| **S08** | W8 | Staff inbox | Phone-first inbox · sources · takeover · AI modes | 5.50 | Agent triages a queue on a phone in under 60s |
| **S09** | W9 | Requests and notifications | Request lifecycle · gap queue · flag-wrong · review queue · email | 4.50 | Ack measurable from a real staff action |
| **S10** | W10 | Analytics | Event emission · rollups · dashboard | 4.50 | Dashboard reconciles exactly to raw events |
| **S11** | W11 | Reliability | Outbox · idempotency · PII redaction · observability · embedding reconciliation | 5.00 | Provider outage delays sends, never loses them |
| **S12** | W12 | Pilot readiness | Runbook + restore drill · a11y · load test · **dry run with real content** | 4.50 | **G3.** Three staff complete the flow unaided |
| **S13** | W13 | Launch | Staff training · content corrections · GM go/no-go | 2.00 | Pilot property trained; written go/no-go |
| **W14** | — | **Pilot live on web chat** | Daily monitoring, weekly accuracy audit | — | **G4** at W17 |

*W13 carries 2.0 days of launch work in a 5-day week, leaving roughly three days of carry-forward room. Full item-level detail, dependencies and acceptance criteria: `07-master-backlog`.*

### The arithmetic behind the 14 weeks

| Block | Dev-days | Solo weeks |
|---|---|---|
| Week 0 (decisions, approvals, CI, recruiting) | 8.00 | 1.60 |
| Web MVP build (S01–S13) | 61.75 | 12.35 |
| **Pilot live on web chat** | **69.75** | **13.95 → 14** |
| WhatsApp adapter (W14–16) | 7.75 | 1.55 |
| **Full MVP-1** | **77.50** | **~17** |

**v1.0 said 60 days and 12 weeks. That was wrong, and external review was right to challenge it.** The 60 came from subtracting a notional 8-day deferral never marked in the backlog. Rebuilding the backlog at item level (§`07-master-backlog` v2) surfaced a further gap: the launch sprint held no costed items at all — staff training, content corrections and the go/no-go were described in prose and costed nowhere. They now carry 2.0 days. **Every figure in this table is computed from the 80-item backlog, not asserted.**

For comparison, **one developer plus a contractor or strong second from week 3 gets full MVP-1 to about week 9.** That is the cheapest schedule compression available — cheaper than any tooling choice.

### Scope ledger — what review added, and what it displaced

Review surfaced four pieces of work that are genuinely worth doing. Rather than let the estimate inflate silently, the same days came out of lower-value surface. Every future addition has to name what it displaces.

| Added (v1.1) | Days | Displaced to MVP-1.5 | Days |
|---|---|---|---|
| Embedding integrity: `is_current` filtering, re-embed job, nightly reconciliation | +1.0 | Outbound click tracking ("opportunities") | −0.5 |
| Transport resilience: timeouts, circuit breaker, pinned models, parse-failure alerting | +0.5 | Outbound webhook per property | −1.0 |
| Adversarial fixture hotel | +0.5 | Hourly-demand heatmap (dashboard cut 2.5 → 2.0) | −0.5 |
| Non-blocking review queue (replaces Draft as the week-one mechanism) | +0.5 | Knowledge-gap inline "write an article" | −0.5 |
| Mexico verification document pack + LLM-assisted golden questions | +0.5 | CSV import validation hardening (1.5 → 1.0) | −0.5 |
| **Total added** | **+3.0** | **Total displaced** | **−3.0** |

**Net zero on scope surface, but the honest day count still rose** — because the v1.0 figure of 60 was itself understated by roughly five days of deferral that was described in prose but never marked in the backlog. Correcting that is the substance of the review's central criticism, and it is now fixed at the source: the backlog is the single source of truth and the plan's numbers are read from it.

**What was *not* cut, and must not be, if pressure returns:** the eval harness, the outbox, idempotency, RLS plus its isolation suite, and the restore drill. Together roughly 8 days, and each prevents a failure that would destroy the pilot reference. If more schedule is needed, cut surface — fewer dashboard tiles, fewer AI modes, no CSV, no webhooks — before cutting any of them. That is the direction of the trade review had backwards.

### One number, stated plainly

**14 weeks to a pilot live on web chat.** Not 12.

v1.0 published 12. The review was right that it was optimistic, and applying its valid points made the honest estimate *longer*, not shorter — 3 days of new work on top of 5 days of previously-unmarked deferral. W13 carries 2.0 days of launch work with roughly three days of carry-forward room; if unused by retrieval tuning and late content, it goes to launch quality.

**~10 weeks with a second developer from week 3**, scoped to UI and content operations — not to tenancy and reliability work, which does not split cleanly across two people.

Anyone who needs a single date: **W14, with the buffer already inside it.**

### The critical path is not code

The longest-lead item is **getting approved content out of a hotel**, entirely outside our control, and it usually takes as long as the whole build.

1. Recruit the pilot property **before Sprint 1**, on the explicit condition that a named content owner gives us 4–6 hours in weeks 1–3.
2. Make content readiness a **sales gate**, not an onboarding surprise. If they cannot produce a guest directory, menus and policies, they are not a pilot — they are a future customer.
3. Run the demo property in parallel so engineering is never blocked.
4. Note the ordering constraint: **retrieval cannot be tuned against content that has not arrived.** If G1 slips, S4 and S5 slip with it, and no engineering effort recovers that.

### WhatsApp: approvals are parallel, work is not

Business verification and template approval are calendar time — start them in Week 0 and they cost nothing but waiting. The adapter is 8 dev-days of attention and, for a solo developer, lands after the web pilot. Say this out loud in planning; "parallel" is the most common way solo plans fail.

**Mexico-specific verification friction.** Business verification rejects on document mismatches far more often than on policy. Assemble these in Week 0 and check consistency *before* submitting: legal entity name exactly as on the RFC; the RFC document itself; a utility bill (CFE) or bank statement in the registered business name and matching the address; a live website on a domain that matches the business; the display name the hotel actually trades under; and a phone number that can receive the verification call. A name mismatch between the RFC, the bank statement and the website is the single most common cause of a multi-week rejection loop. Assume 4–6 weeks, not 3 — which is exactly why web chat, not WhatsApp, is the launch surface.

**The number trap nobody mentions:** a phone number cannot be on the WhatsApp Business Platform and the consumer app at once. Migration **deletes the number's consumer WhatsApp history and usage**. Hotels often run reservations on consumer WhatsApp. Recommend a dedicated number, or get written acknowledgement. Never migrate the number the booking flow depends on, mid-season.

**Interim tactic worth selling:** a `wa.me` click-to-chat link needs no approval and gives the hotel WhatsApp presence with a human answering on day one, while the API path is approved.

---

## 7. Economics and the financial run

Full model: **`03-financial-model.xlsx`** — editable inputs, live formulas, 24-month projection, three funding scenarios, sensitivity. This section states the results.

### 7.1 Cost to serve, by property size

Monthly, USD. Volume driver: guest-nights → conversations at a participation rate of 12–18% of guest-nights.

| | **Boutique** | **Independent** | **Midscale** | **Resort** | **Group (3×Mid)** |
|---|---|---|---|---|---|
| Rooms | 24 | 50 | 120 | 250 | 360 |
| Guest-nights / month | 525 | 1,034 | 2,554 | 5,700 | 7,661 |
| Conversations / month | 63 | 155 | 434 | 1,026 | 1,149 |
| LLM | $2.16 | $5.30 | $14.85 | $35.09 | $39.30 |
| WhatsApp | $0.00 | $0.00 | $13.82 | $54.29 | $50.59 |
| Support | $22.00 | $33.00 | $55.00 | $88.00 | $99.00 |
| Infrastructure | $8.00 | $10.00 | $15.00 | $20.00 | $120.00 |
| Payment fees | $7.16 | $10.76 | $21.56 | $39.56 | $99.99 |
| **Total COGS** | **$39.32** | **$59.07** | **$120.23** | **$236.94** | **$408.88** |
| **Price / month** | **$199** | **$299** | **$599** | **$1,099** | **$2,777** |
| **Gross profit** | **$159.68** | **$239.93** | **$478.77** | **$862.06** | **$2,368.57** |
| **Gross margin** | **80.2%** | **80.2%** | **79.9%** | **78.4%** | **85.3%** |
| Price per room | $8.29 | $5.98 | $4.99 | $4.40 | $3.09 |
| Cost per conversation | $0.62 | $0.38 | $0.28 | $0.23 | $0.36 |

**Three things this says:**

1. **Margin is not the constraint.** 78–85% everywhere. There is no AI-cost crisis to solve, and no reason to spend engineering effort shaving LLM spend.
2. **Support is the largest cost line — 37–56% of COGS.** LLM is 5–15%. The margin lever is onboarding and knowledge-base quality, not model choice.
3. **WhatsApp is smaller than the proposal feared.** At Mexican rates, Boutique and Independent never exceed the 1,000 free service messages per month, so WhatsApp costs **$0**. It only becomes material at 120+ rooms (23% of COGS at Resort). Model tiers barely move the needle: premium vs mid-tier LLM shifts Independent gross margin from 80% to 76%.

### 7.2 What the hotel gets — the buyer's ROI

This is the number that decides whether the product sells, and it is the one the proposal never computed.

| | Boutique | Independent | Midscale | Resort |
|---|---|---|---|---|
| Conversations / month | 63 | 155 | 434 | 1,026 |
| **Hard value at Mexican wages ($6/hr)** | **$76.72** | **$188.68** | **$528.31** | **$1,248.64** |
| Price | $199 | $299 | $599 | $1,099 |
| **ROI multiple** | **0.39×** | **0.63×** | **0.88×** | **1.14×** |
| **Hard value at US resort wages ($19/hr)** | **$208** | **$513** | **$1,436** | **$3,394** |
| **ROI multiple** | **1.05×** | **1.72×** | **2.40×** | **3.09×** |

Hard value = staff time freed (containment × 8 min × loaded rate) + after-hours coverage (35% of conversations × 15 min) + opportunity clicks (conservative: 8% click, 15% convert, $60 ticket, 35% margin).

**The participation rate each price needs in order to pay for itself on labour value alone** (base assumption is 12% / 15% / 17% / 18%):

| Price | Boutique | Independent | Midscale | Resort |
|---|---|---|---|---|
| $199 | 31.1% | 15.8% | 6.4% | 2.9% |
| $299 | 46.8% | 23.8% | 9.6% | 4.3% |
| $599 | 93.7% | 47.6% | 19.3% | 8.6% |
| $1,099 | 171.9% | 87.4% | 35.4% | 15.8% |

**The conclusion this forces is uncomfortable and important:**

> At Mexican labour rates, only the Resort tier clears 1× buyer ROI on hard value. At US resort rates, every tier clears comfortably. **The same product is a hard sell to a small Mexican independent and an easy one to a 250-room resort.** The business is not primarily a labour-arbitrage product in this market — it is a *coverage, language and quality* product, and it must be sold as one.

Three consequences:

1. **Sell up-market.** Midscale, Resort and Group have defensible buyer ROI. Concentrate sales effort there.
2. **Self-serve down-market.** Boutique and Independent at $199/$299 must be onboarded with near-zero human cost. Support is already 56% of the Boutique COGS; add an assisted onboarding and that tier loses money.
3. **Do not lead with hours saved at small properties.** Lead with 24/7 coverage, guest-language answers, response speed, and review quality — things the hotel cannot buy with existing staff.

### 7.3 Pricing

| Tier | Launch price | Per room | Gross margin | Rationale |
|---|---|---|---|---|
| Boutique (≤30 rooms) | **$199** | $8.29 | 80.2% | Land-grab, self-serve only |
| Independent (31–80) | **$299** | $5.98 | 80.2% | Highest price the labour story supports in Mexico; move to $349 post-pilot |
| Midscale (81–150) | **$599** | $4.99 | 79.9% | Multi-outlet; WhatsApp and F&B routing matter |
| Resort (151–400) | **$1,099** | $4.40 | 78.4% | Clearly justified on buyer value even in Mexico |
| Group | **$1,250 platform + 85% of list per property ($2,777 for 3×Mid)** | $3.09 | 85.3% | Governance, brand inheritance, group reporting, SSO |

**Price sensitivity, Independent tier at $12,000/month steady opex:**

| Price | Gross profit | GM | Properties to break even |
|---|---|---|---|
| $199 | $143.53 | 72.1% | 83.6 |
| $249 | $191.73 | 77.0% | 62.6 |
| **$299** | **$239.93** | **80.2%** | **50.0** |
| $349 | $288.13 | 82.6% | 41.6 |
| $449 | $384.53 | 85.6% | 31.2 |
| $599 | $529.13 | 88.3% | 22.7 |

Price has more leverage on breakeven than any cost line, because support is fixed per property and price is pure contribution. **Do not discount below $299.** Use two months free on annual prepay instead — cash today, same ARR, no precedent for discounting.

### 7.4 The 24-month run — three funding paths

| | **Bootstrap** | **Funded** | **Group-led** |
|---|---|---|---|
| Team | 2 founders build; founders absorb support | Founder + contractor dev; +support ops m4; +dev2 m7 | Same as Funded; faster pipeline |
| Starting capital | $60,000 | $150,000 | $150,000 |
| One-time build cost | $2,280 | $46,865 | $46,865 |
| **Peak funding requirement** | **$50,926** | **$230,512** | **$188,452** |
| **Breakeven month (EBITDA > 0)** | **23** | **not within 24** | **24** |
| Properties at M24 | 15.6 | 22.3 | 31.2 |
| Group deals at M24 | 0 | 0.84 | 1.57 |
| MRR at M24 | $5,553 | $10,260 | $15,469 |
| ARR at M24 | $66,637 | $123,119 | $185,633 |
| Gross margin at M24 | 80% | 81% | 81% |
| Cash at M24 | **+$9,989** | **−$80,512** | **−$38,256** |

**Read this honestly.**

- **The middle path is the worst path.** $150k is not enough for the contractor-led build at base-case sales velocity: it needs ~$231k and still does not break even inside 24 months. That is venture-scale burn without venture-scale growth.
- **Bootstrap works, if the founders work for $1,500/month each.** Breakeven month 23 with cash intact. That is a runway decision, not a business decision — but it is a real path.
- **Group-led is the best funded path.** Breakeven month 24 at ~$188k consumed. Group revenue per deal is ~9× an independent property, so the same sales effort buys far more gross profit. **Two group logos beat forty independents on capital efficiency.**

### 7.5 Breakeven is an opex question, not a growth question

| Steady monthly opex | Properties needed (blended GP $435/property) |
|---|---|
| $3,800 (two founders only) | 8.7 |
| $6,000 (+ support ops) | 13.8 |
| $8,000 (+ one developer) | 18.4 |
| $12,000 (+ support + two devs) | 27.6 |

**Team size sets the target.** Every hire made before the pipeline exists pushes breakeven out by roughly two to three properties.

### 7.6 Acquisition economics

At an assumed CAC of $1,750 and 2.5% monthly churn (≈40-month life):

| | Boutique | Independent | Midscale | Resort |
|---|---|---|---|---|
| Gross profit / month | $159.68 | $239.93 | $478.77 | $862.06 |
| CAC payback | 11.0 months | 7.3 months | 3.7 months | 2.0 months |
| LTV / CAC | 3.6× | 5.5× | 10.9× | 19.7× |

Boutique payback at 11 months is too long for a self-serve tier — which is another argument for keeping its acquisition cost near zero and treating it as a reference-logo product, not a profit centre.

### 7.7 What would have to be true

| Assumption | Modelled | Replace with | If wrong |
|---|---|---|---|
| Participation rate | 12–18% of guest-nights | Pilot data, weeks 1–4 | 5% makes the product a curiosity; 30% doubles volume and still holds ~77% margin |
| Support hours / property | 1.0–4.0 / month | Measure in pilot | The largest single cost assumption; 3 h/month at Independent drops GM to ~74% |
| Churn | 2.5% / month | Pilot + renewal data | A hotel that stops maintaining content will churn — the gap loop is a retention feature |
| Containment | 55% | G2/G4 | Below 40%, buyer ROI collapses at every tier |
| CAC | $1,750 | First 20 deals | Founder-led sales at events will be cheaper; paid acquisition will be higher |

---

## 8. What the economics change about strategy

Three findings, three decisions.

| Finding | Decision |
|---|---|
| Buyer ROI is 0.39–1.14× in Mexico, 1.05–3.09× at US wages | **Lead with resorts, groups and international-facing properties.** These are the only segments where labour value alone justifies the price. Puerto Peñasco-type destinations — Mexican wages, US guest expectations — are the best fit: the coverage and language value carries a sale the hours arithmetic cannot. |
| Group revenue per deal is ~9× an independent | **Run two sales tracks from one product**, exactly as the proposal argued — but resource the group track earlier than planned, because it is the capital-efficient path. The independent pilot still comes first: it is the reference a group will ask for. |
| Support is 37–56% of COGS | **Invest in self-serve onboarding and the knowledge-gap loop as margin features**, not nice-to-haves. Every hour of onboarding we remove from the first 90 days is worth more than any model optimisation. |

---

## 9. Staffing and budget

| Item | Estimate |
|---|---|
| Lean web MVP (W00–S13) | 69.75 dev-days ≈ **14 weeks** solo |
| Full MVP-1 (+ WhatsApp) | 79 dev-days ≈ **17 weeks** solo |
| With one extra developer from week 3 (UI + content ops) | full MVP-1 ≈ **10 weeks** |
| Design (guest chat + staff inbox) | 6 days — contract it |
| Assisted onboarding per property (first five) | 1.5–2 days each |
| Pilot support + weekly accuracy audits | ~0.5 day/week per property |

**One-time cost at $550/day blended:** development $43,450 (79 days) + design $3,300 + legal/compliance $1,800 + services $240 ≈ **$48,790**.

**The constraint nobody prices.** The build estimates assume the developer does nothing else. In a company this small the same person also sells, onboards and supports — which does not reduce velocity by 50%, it silently doubles the schedule. Two structural responses: separate the build role from the sell/onboard role by week 4, and **cap concurrent pilots at one.** A second pilot in the same month costs 3×, not 2×.

---

## 10. Pilot plan

### Selection criteria
Guest directory or equivalent that exists and is current · engaged GM or front-office manager who will own the inbox · 40+ rooms (or strong F&B/spa) · willing to run web-first · **a named content owner with 4–6 hours in weeks 1–3**.

### Runbook

| Phase | Focus |
|---|---|
| Baseline (1 week before launch) | Manual logging of real guest questions — the ground truth and the golden set |
| W1 live | Web chat on in **Auto with a tight escalation policy** — not Draft, which would leave guests waiting on a review queue nobody works. A non-blocking review queue catches anything the escalation policy misses. Daily check-in |
| W2 | **Early-signal checkpoint (see below).** Auto for approved topics only. First weekly accuracy audit (50 sampled answers). Gap-queue discipline starts |
| W3 | Auto for all info topics. **G4 readout prep** |
| W4+ | Steady state: weekly audit, monthly business review on containment, ack time, gap closure |

### The week-2 checkpoint

Participation rate is the assumption the entire model rests on, and twelve weeks is a long time to discover it is wrong. So check it early, on live traffic, before the rest of the plan is committed:

| Metric at end of pilot week 2 | Reading | Action |
|---|---|---|
| Participation ≥ 8% of guest-nights | On track | Continue |
| Participation 4–8% | Marginal | Push QR/room-card placement, add the chat link to confirmation emails, and re-read at week 4 before concluding |
| Participation < 4% | The channel is not being found | Stop feature work. The problem is distribution inside the hotel, not the product |
| Containment < 35% with accuracy ≥ 95% | Content problem | Rewrite the top-ten articles; do not touch prompts |
| False answers > 5% | Quality problem | Drop to Draft mode the same day |

This checkpoint is deliberately cheap and deliberately early. It is the one place where stopping is cheaper than continuing.

### Success criteria
Containment ≥55% with audited accuracy ≥95% · request ack median ≤10 minutes in hours · at least one hotel says, unprompted, that they would pay and names a number · at least one group prospect asks about multi-property governance after seeing the independent pilot.

### Stop-and-rethink triggers
Staff stop checking the inbox after week 2 → wrong person's problem · containment <35% while accuracy is high → content problem, fix content · false-answer >5% in live traffic → Draft mode immediately · hotels love the demo and never deploy → distribution problem.

---

## 11. The next 10 working days

**Days 1–2**
- [ ] Lock ADRs D1–D14 in writing
- [ ] Recruit the pilot property; named content owner with dates on the calendar
- [ ] Submit Meta business verification; shortlist two BSPs on Embedded Signup + number portability
- [ ] Repo, CI, three environments, error tracking

**Days 3–5**
- [ ] Schema review against tenancy and inheritance requirements
- [ ] Golden-question set format + 20 starter questions
- [ ] Sit with the content owner; capture the real 30 questions guests ask
- [ ] Stand up the demo property

**Days 6–10**
- [ ] Sprint 1: schema, RLS, auth, org/property/roles, audit log
- [ ] Tenant-isolation test suite started on the first endpoint, not the last
- [ ] Privacy notice + DPA to a Mexican lawyer
- [ ] One-page non-goals document for the sales conversation
- [ ] **Decide the funding path** (§7.4): bootstrap or raise. Everything downstream depends on it.

---

## 12. Review brief

This is the bit to read if you are reviewing rather than building.

### What changed from the original proposal

| Area | Proposal | This plan | Effect |
|---|---|---|---|
| Schedule | 4–6 weeks to pilot | **14 weeks to pilot**, ~17 to full MVP-1 solo | Worked bottom-up from an 80-item backlog, then re-based after review |
| WhatsApp | Phase 4, 1–3+ weeks | Approvals from **Week 0**; adapter built W12–13 | Approval latency runs in parallel; the build does not |
| Content ingestion | Automated extraction implied in Phase 3 | **Manual + CSV in MVP**; extraction deferred to 1.5 | −5 to 8 dev-days, better launch quality |
| AI quality | "Check whether the answer is sufficiently supported" | **Eval harness with a 2% false-answer gate** (G2) | Quality becomes measurable and regressions detectable |
| Hours and prices | Prose in the knowledge base | **Structured `property_facts`** | Deterministic answers, contradiction detection, staleness control |
| "I don't know" | Fallback path | **Designed state** with a Knowledge Gap queue | Becomes the product's most actionable management metric |
| Engineering ops | Implied | Outbox, idempotency, RLS, observability, runbook, restore drill | The reliability layer the proposal omitted |
| Economics | Not addressed | **Full model**: unit economics, buyer ROI, three funding scenarios, CAC/LTV | Revealed the buyer-ROI problem and the capital requirement |
| Pricing | Not set | $199 / $299 / $599 / $1,099 + group platform fee | Derived from cost and buyer value, not intuition |
| Gates | None | 7 gates, each with explicit failure actions | Go/no-go is objective |

**Amended after external review (v1.1).** The schedule was also re-based: v1.0 claimed 12 weeks from a 60-day estimate that subtracted a deferral never marked in the backlog. Measured honestly at item level, the pilot path is **69.75 days / 14 weeks**, and that is what the plan now commits to. Four defects were found and fixed: an **embedding-integrity gap** (editing an article left stale chunks retrievable — now `is_current` filtering, a re-embed job and a nightly reconciliation); **Draft mode was being used as the week-one pilot mode** (it would have left guests waiting on a queue nobody works — now Auto with escalation, Draft demoted to test/downgrade use); **no transport-level LLM resilience** (now timeouts, circuit breaker, pinned model versions, parse-failure alerting); and **no adversarial fixture content** (now a deliberately messy fixture hotel from Sprint 1). Golden-question generation is now LLM-drafted for answer cases and human-authored for escalation cases. Three days were added and three days displaced to hold scope flat — see the scope ledger in §6. The net day count rose because the v1.0 baseline was itself understated.

### Seven questions we want answered in review

| # | Question | Why it blocks something | Needed by |
|---|---|---|---|
| 1 | **Bootstrap or raise?** ~$51k peak and breakeven at month 23 with two founders on $1,500/month, versus ~$200k and a group-led path | Determines team shape, which determines the schedule. Nothing downstream is safe until this is set | End of W0 |
| 2 | **Is $299 defensible for a 50-room Mexican independent**, given buyer ROI of 0.63× on labour value alone? | If no, the Independent tier needs a different value story or a lower price, and the breakeven property count rises sharply | Before the first sales conversation |
| 3 | **Independent-first or resort-first?** The plan keeps the independent pilot for the reference story but resources the group track earlier | Changes allocation and the pilot selection criteria | End of W0 |
| 4 | **Does anyone have real participation or support-load data** from a hotel chatbot, front-desk study, or hotel SaaS? Our 12–18% and 1.5 h/month are assumptions | These two numbers drive the entire model | Before G2 |
| 5 | **Is one developer realistic, or do we commit to two from week 3?** | One developer gives 14 weeks; two gives ~10 to full MVP-1. The difference is the cost of a hire versus four months of calendar | End of W0 |
| 6 | **WhatsApp in the pilot, or after it?** | If a pilot hotel insists on WhatsApp on day one, the plan changes materially and the launch date is set by Meta | Before G1 |
| 7 | **Does anyone have a route into a hotel group?** | One warm group relationship changes the funding path more than any product decision in this document | Before G4 |

### Already decided — please do not re-open without new information

- **No PMS integration in MVP.** This is the commercial thesis, not an omission.
- **The eval harness ships in Sprint 5**, not "later". Without it the quality claims are unfalsifiable.
- **No revenue attribution.** We report opportunities and clicks, never revenue, until a booking engine tells us otherwise.
- **No autonomous web browsing** for hotel facts. It cannot be approved by the hotel, which is the whole trust model.
- **Room number ≠ identity.** Staff verify before disclosing stay details or acting on sensitive instructions.
- **The 2% false-answer rate is a hard gate.** It is not a target to negotiate against a launch date.

### Known simplifications in the financial model

Group churn is modelled at the same 2.5%/month as single properties (likely conservative) · all pricing is monthly, annual prepay is not modelled · no IVA, FX or local card rates beyond the 3.6% fee · participation, support load and churn are pre-pilot assumptions and are the first things to replace with measured data.

### What is still genuinely unresolved

The funding path, the pricing of the Independent tier, and the independent-versus-resort sequencing. Everything else in this document is a decision, not a question — and all three of those close in Week 0.

---

## Appendix A — Golden question format

```csv
property_id,language,question,expected_behaviour,target_topic,notes
demo,es,¿A qué hora cierra la alberca?,answer,pool.hours,from fact table
demo,en,Can I bring my dog?,answer,policy.pets,exists in directory
demo,en,Do you have rooms tonight?,escalate,,must not invent availability
demo,es,Quiero cancelar y que me devuelvan el dinero,escalate,,refund = sensitive
demo,en,My wife needs a wheelchair-accessible room,escalate,,accessibility = human
```

`expected_behaviour ∈ {answer, escalate, refuse}` — never an exact string. String matching measures phrasing; behaviour matching measures the product.

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

Rejected server-side if `decision=answer` has empty citations, any citation falls outside the retrieved set, the answer matches banned-content patterns, or the property's AI mode forbids auto-send.

## Appendix C — Event taxonomy

**18 events.**

`conversation_started` · `message_received` · `ai_run_completed` · `ai_answer_sent` · `ai_escalated` · `no_answer_emitted` · `human_takeover` · **`staff_message_sent`** · `request_created` · `request_acknowledged` · `request_assigned` · `request_resolved` · `answer_flagged_wrong` · `knowledge_gap_created` · `knowledge_gap_closed` · `booking_link_clicked` · `outbound_webhook_delivered` · `message_failed`

> **Ruling on the 18th (v1.2.1).** Earlier revisions said "18 events" while listing 17. The missing event is **`staff_message_sent`**, and it is not optional: containment — the headline metric — is defined as conversations with zero staff messages. `human_takeover` records the formal handoff, but a staff member can reply without taking over, and can reply many times. Without this event, containment and first-response-time are both uncomputable. Every other metric survives on the existing 17.
>
> Deliberately **not** added: `answer_overridden` (staff override rate). It is derivable later from edit actions on AI answers and is not needed for any pilot gate. Adding it now would make it 19.

Every event carries `org_id`, `property_id`, `conversation_id`, `channel`, `language`, `topic`, `created_at`. Rollups are SQL over this table — no second pipeline, and every dashboard number is traceable to a row.

## Appendix D — Metric dictionary

| Metric | Target | Source |
|---|---|---|
| Containment | ≥55% by pilot week 3 | events |
| Audited accuracy (50/week sample) | ≥95% | manual sample |
| **False-answer rate** | **≤2% — hard gate** | manual sample |
| Correct escalation | ≥90% | golden set |
| Needless escalation | ≤20%, falling | golden set |
| Request acknowledgement (in hours) | ≤10 min median | events |
| Knowledge-gap median age | ≤7 days | knowledge_gaps |
| Guest re-ask rate | ≤5% | events |
| Staff override rate | flat or falling | events |
| Cost per resolved conversation | ≤$0.15 | billing + events |
| First response p95 | ≤5s AI / ≤10 min human | events |

---

*Companion files: `00-proposal-evaluation.md` (the review this plan answers) · `02-development-plan-workbook.xlsx` (63-item backlog, gates, risks, roadmap, memory aid for delivery) · `03-financial-model.xlsx` (live model behind §7).*
