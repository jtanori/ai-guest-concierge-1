# Kickoff Pack — Week 0

**Status:** ready for sign-off · 21 October 2026
**Purpose:** close gate **G0** by end of Week 0. Nothing in the S01 plan starts until the fourteen decisions below are signed and the external clocks are running.

> Item IDs here match `07-master-backlog.xlsx` exactly. If the two ever disagree, the backlog wins.

| G0 exit criterion | Evidence |
|---|---|
| ADRs D1–D14 recorded and signed | §2 of this document, signed column completed |
| Meta business verification submitted | Receipt / case ID in §4 |
| Pilot property recruited, content owner named with dates | §4 checklist signed by the hotel |
| Demo property seeded | Fixture hotel merged to `main`, seeds run in staging |
| Funding path decided | §3 — the one decision that is not technical |

---

## 1. The Week 0 calendar

| Day | Track A — decisions & docs | Track B — external | Track C — engineering |
|---|---|---|---|
| **Mon** | ADR review meeting D1–D14 (90 min). Assign approver for each | Assemble verification document pack (§4.1) | Create org, repo, branch protection |
| **Tue** | Sign D1, D5, D11, D14 first — these are the irreversible ones | Cross-check RFC name against bank statement and website domain | CI skeleton: lint, typecheck, test, preview deploy |
| **Wed** | Sign remaining ADRs. Write the one-page non-goals doc | **Submit Meta business verification** | Three environments: local, staging, prod (no shared DB) |
| **Thu** | Funding path decision (§3). Scope the second developer if funded | Pilot property kickoff call; content owner names their 4–6 hours | Error tracking + structured logging with tenant context |
| **Fri** | **G0 review.** Anything unsigned blocks Sprint 1 | WhatsApp BSP shortlist narrowed to two | Seed the adversarial fixture hotel; first isolation test written |

Two rules for the week. **No code before D1 and D5 are signed** — tenancy and citation granularity are the two that are expensive to reverse. And **the verification pack is submitted Wednesday even if incomplete**, because a rejection is information and waiting is not.

---

## 2. ADR sign-offs

Status legend: **Proposed** → **Accepted** → **Superseded**. Only Accepted ADRs are binding. Each line needs a name and a date; an unsigned ADR is a wish.

### D1 — Tenancy enforcement

| | |
|---|---|
| **Status** | ✅ **Accepted** · Rejected · Deferred |
| **Decision** | Postgres row-level security on every tenant table, **and** an application-layer guard, **and** a CI suite that enumerates every endpoint and asserts 403/404 on foreign IDs. All three, not a choice between them. |
| **Context** | One leak is existential for a group sale. The pilot's value as a reference depends on the first group's security review passing. |
| **Alternatives rejected** | *App-layer guards only* — one forgotten `WHERE` is a leak. *RLS only* — a misconfigured policy is invisible until it is a breach. *Separate schema per tenant* — operational overhead with no benefit at this scale. |
| **Consequences** | ~2 days. Every query must run in a request-scoped tenant context; a background job must set it explicitly or it reads nothing. That failure mode is deliberate. |
| **Revisit if** | A group requires physical data separation. Then: schema-per-tenant, same policy design. |
| **Reversibility** | Hard. |
| **Approved by / date** | **Jaime Tanori · 21 October 2026** |

### D2 — Retrieval strategy

| | |
|---|---|
| **Status** | ✅ **Accepted** · Rejected · Deferred |
| **Decision** | Postgres full-text + trigram **+ a pgvector column populated from day one**. Ranking starts simple; hybrid weighting is tuned after the eval harness exists. |
| **Context** | Guests will ask in Spanish against English content. Pure FTS fails this: *¿a qué hora cierra la alberca?* does not match "pool hours". |
| **Alternatives rejected** | *FTS only* — breaks on the multilingual case the product promises. *Separate vector database* — a second system to operate for a corpus of a few hundred chunks. |
| **Consequences** | One column, one embedding job, no second database. Re-embedding later would mean reprocessing the whole corpus. |
| **Revisit if** | The corpus exceeds ~50k chunks per property, which is not a realistic hotel. |
| **Reversibility** | Easy. |
| **Approved by / date** | **Jaime Tanori · 21 October 2026** |

### D3 — Embeddings stored from day one

| | |
|---|---|
| **Status** | ✅ **Accepted** · Rejected · Deferred |
| **Decision** | Generate and store embeddings for every published article version, even if early ranking ignores them. |
| **Context** | The data only exists if it was captured. Retro-fitting means re-ingesting every hotel's content. |
| **Alternatives rejected** | *Add later* — costs a full re-ingest per property. |
| **Consequences** | Small storage cost; embedding spend appears before it is used. |
| **Revisit if** | Never. |
| **Reversibility** | Easy. |
| **Approved by / date** | **Jaime Tanori · 21 October 2026** |

### D4 — AI output contract

| | |
|---|---|
| **Status** | ✅ **Accepted** · Rejected · Deferred |
| **Decision** | Every model call returns structured JSON: `decision`, `answer`, `language`, `citations[]`, `reason_code`, `topic_keys_used`, `confidence`. Free-text output is not accepted anywhere in the system. |
| **Context** | Free text cannot be gated, scored, audited or escalated on. The whole safety layer depends on a parseable decision. |
| **Alternatives rejected** | *Natural language with post-hoc parsing* — brittle, and fails silently in production. |
| **Consequences** | Slightly higher prompt complexity; a parse-failure rate that must be monitored. Schema validation rejects and escalates rather than sending. |
| **Revisit if** | A model supports native structured output such that parsing disappears. It strengthens the decision, not reverses it. |
| **Reversibility** | Hard. |
| **Approved by / date** | **Jaime Tanori · 21 October 2026** |

### D5 — Citation granularity

| | |
|---|---|
| **Status** | ✅ **Accepted** · Rejected · Deferred |
| **Decision** | Citations reference `article_version_id`, never `article_id`. |
| **Context** | When a hotel edits a policy, every historical answer must still resolve to the exact text the model read. Otherwise "show me the source" is unanswerable during an audit — precisely when it matters. |
| **Alternatives rejected** | *Cite the article* — the source silently changes under the citation. |
| **Consequences** | Article versions are immutable; edits create rows. Cheap now, impossible to reconstruct later. |
| **Revisit if** | Never. |
| **Reversibility** | Hard. |
| **Approved by / date** | **Jaime Tanori · 21 October 2026** |

### D6 — AI operating modes

| | |
|---|---|
| **Status** | ✅ **Accepted** · Rejected · Deferred |
| **Decision** | Four modes per property: **Auto** (answers approved topics, escalates the rest), **Draft** (AI drafts, human approves), **Human-only**, **After-hours**. Default for a new property is Auto with a tight escalation policy. |
| **Context** | Draft looks safer but is worse in practice: understaffed front desks do not review in real time, so guests get silence while the hotel believes it is covered. Draft is for the test chat, sensitive topics, and the emergency downgrade path. |
| **Alternatives rejected** | *Draft-by-default* — measured failure: no answers. *Auto-only* — no downgrade path when quality trips. |
| **Consequences** | A settings surface; a support conversation about which mode a hotel should be in. |
| **Revisit if** | A hotel's review queue is demonstrably worked (measure it). |
| **Reversibility** | Easy. |
| **Approved by / date** | **Jaime Tanori · 21 October 2026** |

### D7 — Message sending

| | |
|---|---|
| **Status** | ✅ **Accepted** · Rejected · Deferred |
| **Decision** | Transactional outbox table plus a worker with exponential backoff and a dead-letter queue. Never send inside a request handler. |
| **Context** | Provider blips are normal, not exceptional. A dropped guest message during the pilot is visible to the reference customer. |
| **Alternatives rejected** | *Inline send* — a provider timeout becomes a lost message or a duplicate. *Managed queue service* — an extra system for a few thousand messages a month. |
| **Consequences** | ~1.5 days. Sends are asynchronous; the UI must show pending state. |
| **Revisit if** | Volume justifies a managed queue. |
| **Reversibility** | Easy. |
| **Approved by / date** | **Jaime Tanori · 21 October 2026** |

### D8 — Webhook handling

| | |
|---|---|
| **Status** | ✅ **Accepted** · Rejected · Deferred |
| **Decision** | Verify signature; dedupe on provider message ID via a unique constraint; acknowledge in under 3 seconds; process asynchronously. |
| **Context** | Providers replay. Duplicate guest messages destroy trust in the first hour of the pilot. |
| **Alternatives rejected** | *Process inline then ack* — provider timeouts cause replays, which cause duplicates. |
| **Consequences** | Requires an inbound table and a worker. |
| **Revisit if** | Never. |
| **Reversibility** | Easy. |
| **Approved by / date** | **Jaime Tanori · 21 October 2026** |

### D9 — Staff notifications

| | |
|---|---|
| **Status** | ✅ **Accepted** · Rejected · Deferred |
| **Decision** | Email on every request and handoff (on by default), a phone-first inbox as the primary surface, and a signed outbound webhook for hotel groups into their own tools. |
| **Context** | A shared inbox nobody checks is worse than no inbox: it creates broken promises to guests. Front-desk staff are rarely at a desk. |
| **Alternatives rejected** | *In-app only* — no push channel on a desktop-only build. *SMS* — cost and no rich context. |
| **Consequences** | Email deliverability becomes an operational concern. |
| **Revisit if** | Hotels consistently live in Teams or Slack — the webhook covers it. |
| **Reversibility** | Easy. |
| **Approved by / date** | **Jaime Tanori · 21 October 2026** |

### D10 — Analytics

| | |
|---|---|
| **Status** | ✅ **Accepted** · Rejected · Deferred |
| **Decision** | One append-only `events` table with a documented taxonomy, plus nightly SQL rollups. No separate analytics pipeline and no analytics vendor. |
| **Context** | Every dashboard number must be traceable to rows. This keeps it that way and avoids lock-in on day one. |
| **Alternatives rejected** | *Event pipeline* — operational weight for a product with a few hundred conversations a week. *Warehouse* — a second system before there is a second customer. |
| **Consequences** | Rollups are our code to maintain; the job must be idempotent and re-runnable for a historical date. |
| **Revisit if** | Query load on the events table affects the product, which is unlikely below ~50 properties. |
| **Reversibility** | Easy. |
| **Approved by / date** | **Jaime Tanori · 21 October 2026** |

### D11 — WhatsApp provider

| | |
|---|---|
| **Status** | ✅ **Accepted** · Rejected · Deferred |
| **Decision** | Direct Cloud API as a Tech Provider, **or** a BSP offering Embedded Signup. Hard requirement either way: **the hotel owns and retains its number and its WhatsApp Business Account.** |
| **Context** | Locking a group into our provider's number is a procurement objection that cannot be argued away. The hotel's number is their asset. |
| **Alternatives rejected** | *BSP with number ownership retained by us* — unsellable to a group. *Direct-only* — more onboarding work per hotel. |
| **Consequences** | Determines the entire Week 4–5 adapter build and the onboarding flow. |
| **Revisit if** | A BSP offers materially better Embedded Signup without taking number ownership. |
| **Reversibility** | Hard. |
| **Approved by / date** | **Jaime Tanori · 21 October 2026** |

### D12 — LLM provider

| | |
|---|---|
| **Status** | ✅ **Accepted** · Rejected · Deferred |
| **Decision** | One primary and one fallback provider behind an internal interface. **Models are pinned by version, never a floating alias.** Per-property model config. |
| **Context** | Model prices and capabilities move monthly; an upstream default change must not silently alter behaviour overnight. |
| **Alternatives rejected** | *Single provider* — an outage takes the product down. *Floating aliases* — silent behaviour change. |
| **Consequences** | Two integrations to maintain; a routing layer that needs its own tests. |
| **Revisit if** | A provider's structured-output guarantees make the abstraction unnecessary. Not soon. |
| **Reversibility** | Easy. |
| **Approved by / date** | **Jaime Tanori · 21 October 2026** |

### D13 — File storage

| | |
|---|---|
| **Status** | ✅ **Accepted** · Rejected · Deferred |
| **Decision** | Managed object storage, signed URLs, virus scan on upload, no public buckets. |
| **Context** | Hotel-uploaded PDFs are the least trustworthy inbound content we will accept. |
| **Alternatives rejected** | *Store in Postgres* — backups and access control get worse. |
| **Consequences** | An upload pipeline and a scanning dependency. |
| **Revisit if** | Never. |
| **Reversibility** | Easy. |
| **Approved by / date** | **Jaime Tanori · 21 October 2026** |

### D14 — Staff interface languages

| | |
|---|---|
| **Status** | ✅ **Accepted** · Rejected · Deferred |
| **Decision** | A string catalogue from the first commit; Spanish and English at launch. |
| **Context** | An English-only back office in Mexico gets half-adopted and quietly resented. Retrofitting i18n into a built UI is miserable. |
| **Alternatives rejected** | *English only at launch* — the pilot staff are the users; they will not adopt it. |
| **Consequences** | Slightly slower UI work; every string goes through a lookup. |
| **Revisit if** | Never. |
| **Approved by / date** | **Jaime Tanori · 21 October 2026** |

---

## 3. The one decision that is not technical

**Bootstrap or funded?** Everything downstream — team shape, schedule, sales motion — follows from this, and it cannot be deferred past Friday.

| | **Bootstrap** | **Funded** | **Group-led** |
|---|---|---|---|
| Team | 2 founders, both build | Founder + contractor dev, +support ops M4, +dev2 M7 | Same, faster pipeline |
| Peak funding | **$50,926** | $230,512 | $188,452 |
| Breakeven | **month 23** | not within 24 | month 24 |
| Schedule to pilot | 14 weeks | 14 weeks | 14 weeks |
| Main risk | Founders at a $1,500/month draw for 23 months | $150k is not enough — needs ~$231k | Depends on closing two group logos |

**Recommendation on the evidence:** bootstrap with two founders, or raise ~$200k deliberately for the group path. Do not drift into the middle — it carries venture-scale burn without venture-scale growth.

> Decision: ☐ Bootstrap · ☐ Funded · ☐ Group-led
> Approved by / date: ______________________

---

## 4. External track — the two clocks

### 4.1 Meta business verification pack (submit Wednesday)

| Document | Check before submitting | ✓ |
|---|---|---|
| Legal entity name | Exactly as printed on the RFC — no trading name, no abbreviation | ☐ |
| RFC document | Current, legible, entity matches | ☐ |
| Utility bill (CFE) or bank statement | In the registered business name, address matching the record | ☐ |
| Website | Live, on a domain matching the business, with a real contact page | ☐ |
| Display name | The name the hotel actually trades under; must not read as generic | ☐ |
| Phone number | Can receive the verification call during business hours | ☐ |

> A mismatch between the RFC, the bank statement and the website is the single most common cause of a multi-week rejection loop. Assume 4–6 weeks. Web chat is the launch surface precisely because this clock is unreliable.

Case ID / submission receipt: ______________________

### 4.2 Pilot property recruitment (close by Friday)

| Item | Requirement | ✓ |
|---|---|---|
| Rooms | 40+ (or strong F&B / spa mix) | ☐ |
| Content owner | **Named individual**, 4–6 hours in weeks 1–3, dates on the calendar | ☐ |
| GM / front-office owner | Will own the inbox and the weekly review | ☐ |
| Guest directory | Exists and is roughly current | ☐ |
| Channel agreement | Web-first for the pilot; WhatsApp later | ☐ |
| Baseline | Agrees to one week of manual question logging before launch | ☐ |
| Notification contact | Named on-call person and business hours | ☐ |

> If any of rows 1–5 cannot be met, this is not the pilot property. Do not start the build against a hotel that cannot supply content; that is the one dependency engineering cannot absorb.

---

## 5. Week 0 task board (W00)

| ID | Task | Owner | Day | Depends on | Done when | Status |
|---|---|---|---|---|---|---|
| W00-01 | ADR review meeting, D1–D14 | Founder + tech lead | Mon | — | All fourteen discussed; approvers assigned | ☐ |
| W00-02 | Sign D1, D5, D11, D14 (irreversible set) | Founder | Tue | W00-01 | Signed and committed to repo | ☐ |
| W00-03 | Sign D2–D4, D6–D10, D12–D13 | Founder | Wed | W00-02 | Signed | ☐ |
| W00-04 | Funding path decision | Founder | Thu | — | §3 completed | ☐ |
| W00-05 | Second developer scoped (if funded) | Founder | Thu | W00-04 | Named, start date, scoped to UI + content ops | ☐ |
| W00-06 | One-page non-goals doc | Founder | Wed | — | Reviewed with whoever sells; PMS absent from roadmap | ☐ |
| W00-07 | Verification pack assembled and cross-checked | Founder | Tue | — | §4.1 complete | ☐ |
| W00-08 | **Submit Meta business verification** | Founder | **Wed** | W00-07 | Case ID recorded | ☐ |
| W00-09 | WhatsApp BSP shortlist to two | Tech lead | Fri | W00-08 | Two scored on Embedded Signup + number ownership | ☐ |
| W00-10 | Pilot property kickoff call | Founder | Thu | — | §4.2 signed off | ☐ |
| W00-11 | Repo, branch protection, org setup | Tech lead | Mon | — | `main` protected; PR template | ☐ |
| W00-12 | CI skeleton: lint, typecheck, test, preview deploy | Tech lead | Tue | W00-11 | A PR produces a preview URL | ☐ |
| W00-13 | Three environments (local, staging, prod) | Tech lead | Wed | W00-12 | No shared database between staging and prod | ☐ |
| W00-14 | Error tracking + structured logging with tenant context | Tech lead | Thu | W00-13 | A staging error shows `org_id`, `property_id`, `conversation_id` | ☐ |
| W00-15 | Golden set v1 — format plus 20 starter questions | Tech lead + founder | Tue | — | Format agreed; escalation cases written by hand | ☐ |
| W00-16 | Baseline question log started with the hotel | Founder | Fri | W00-10 | Front desk logging real questions | ☐ |
| W00-17 | Adversarial fixture hotel built | Tech lead | Fri | W00-13 | Messy content merged to `main`; seeds run in staging | ☐ |
| W00-18 | Privacy notice + DPA to Mexican counsel | Founder | Wed | — | Sent; turnaround expected | ☐ |
| W00-19 | Event taxonomy written | Tech lead | Fri | — | 18 events, each with tenant context fields | ☐ |
| W00-20 | **G0 review** | Founder + tech lead | **Fri** | All | Every row above ticked; unsigned ADRs block Sprint 1 | ☐ |

### Load check

| Owner | Tasks | Realistic? |
|---|---|---|
| Founder | 11 of 20 (decisions, external, hotel) | Yes — this is a full week and it is the right use of it |
| Tech lead | 8 of 20 (infra, CI, fixture, taxonomy) | Yes — deliberately no product code this week |

**If there is only one person doing both roles**, the week still works, but S0-04 and S0-05 land on the same day as the verification submission and something will slip. Sequence it: verification Wednesday, funding decision Friday, and accept that the fixture hotel moves to Monday of W1.

---

## 6. What blocks Sprint 1

Unsigned: **D1** (tenancy) and **D5** (citation granularity). Both are expensive to reverse and cheap to decide. Everything else can proceed on a provisional basis; these two cannot.

Recommended order for Monday's meeting: D1, D5, D11, D14 in the first thirty minutes — the four hard-to-reverse calls — then the rest in one pass.
