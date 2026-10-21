# AI Guest Concierge — Plan Bundle v1.2.1

**Prepared:** 21 October 2026
**Contents:** 9 working documents + 1 reference + regeneration source
**Status:** approved for Week 0 execution

> **v1.2.1** resolves an internal inconsistency in the event taxonomy. See *What changed* below.

---

## Read in this order

| # | File | Read it if you… | Time |
|---|---|---|---|
| 1 | **`01-development-plan.md`** | want the whole plan. Plan of record. §12 is a review brief with seven open questions. | 30 min |
| 2 | **`07-master-backlog.md`** | are building it. 80 items, 14 sprints, dependencies, acceptance criteria. | 25 min |
| 3 | **`08-kickoff-prompt.md`** | are handing this to an agent. Copy the block into a fresh session. | 5 min |
| 4 | **`03-financial-model.xlsx`** | are funding, pricing or arguing with the economics. | 25 min |
| 5 | **`05-kickoff-pack-week0.md`** | are starting Monday. ADR sign-offs and the Week 0 calendar. | 15 min |
| 6 | **`04-review-response.md`** | want to know what changed after external review, and what was pushed back on. | 10 min |
| 7 | `02-development-plan-workbook.xlsx` | want gates, risks, metric dictionary, content playbook, ADR log. | reference |
| 8 | `06-week0-control-board.xlsx` | are running Week 0 from a checklist rather than prose. | working |
| 9 | `07-master-backlog.xlsx` | want the backlog as a filterable board with status fields. | working |

---

## What changed

### v1.2.1 — event taxonomy ruling

The documents said **18 events** in three places and Appendix C listed **17**. The missing event is **`staff_message_sent`**, and it is load-bearing: **containment** — the north-star metric — is defined as *conversations with zero staff messages*. `human_takeover` records the formal handoff, but staff can reply without taking over, and can reply repeatedly. Without this event, containment and first-response time are uncomputable. Appendix C now lists all 18 and records the ruling.

Deliberately **not** added: `answer_overridden`. It is derivable later from edit actions on AI answers and is not needed for any pilot gate.

### v1.2 — backlog rebuild

Auditing the backlog against the Week 0 kickoff pack found three defects:

1. **Fourteen ID collisions.** `S0-02` meant *"Repo + CI + 3 environments"* in the backlog and *"Sign D1, D5, D11, D14"* in the kickoff pack. IDs are now `<sprint>-<nn>`.
2. **S13 was empty.** Launch work (staff training, content corrections, GM go/no-go) existed in prose only. Now 3 items, 2.0 days.
3. **No testable acceptance criteria.** Every item now has one.

Day count rose 67.75 → 69.75 as a direct result. The missing work was never free, only invisible.

---

## The plan in six numbers

| | |
|---|---|
| **14 weeks** | to a pilot live on web chat. Work completes at 13.95 weeks |
| **69.75 dev-days** | lean pilot path across 80 backlog items |
| **0.25 days** | unallocated capacity against 70 — W13 holds ~3 days of carry-forward room |
| **78–85%** | gross margin at every property size. Margin is not the constraint |
| **0.39–1.14×** | buyer ROI at Mexican labour rates. **This is the constraint** |
| **~$231k / ~$51k** | peak funding: the funded path versus the bootstrap path |

---

## The three findings that shape everything

1. **No PMS integration in v1.** Requests captured and routed beat requests automated.
2. **The buyer's ROI is the binding constraint, not our margin.** At Mexican wages only the 250-room resort clears 1× on labour value alone. Sell up-market, self-serve down-market.
3. **The critical path is content, not code.** Getting approved content out of a hotel takes as long as the build and is outside engineering's control.

---

## Seven questions the review needs to answer

Full context in `01-development-plan.md` §12. All close in Week 0.

1. **Bootstrap or raise?** ~$51k peak and breakeven month 23, versus ~$200k and a group-led path.
2. **Is $299 defensible** for a 50-room Mexican independent, at 0.63× buyer ROI?
3. **Independent-first or resort-first** for the pilot reference story?
4. **Measured participation or support-load data** from any hotel SaaS?
5. **One developer or two?** 14 weeks versus ~10.
6. **WhatsApp in the pilot, or after it?**
7. **A route into a hotel group?**

---

## Already decided — don't re-open without new information

- No PMS integration in MVP
- The eval harness ships in S06
- No revenue attribution — opportunities and clicks only
- No autonomous web browsing for hotel facts
- Room number ≠ verified identity
- 2% false-answer rate is a hard gate

---

## Known weaknesses, stated up front

| Weakness | Where |
|---|---|
| **Week 0 is 8.0 days of work in a 5-day week** | `07-master-backlog.xlsx` → Capacity. Fits with two people; solo runs to mid-W1 |
| **0.25 days unallocated** — almost no fat | Same sheet. W13's ~3 days of carry-forward room is the only cushion |
| Participation, support load, churn are pre-pilot assumptions | `03-financial-model.xlsx` → Sources & method |
| Buyer ROI fails at small Mexican independents | `03-financial-model.xlsx` → Buyer ROI |
| The $150k funded path misses breakeven inside 24 months | `03-financial-model.xlsx` → Scenarios |

---

## File notes

- **`.xlsx` files** contain live formulas **and** cached values.
- **`reference/00-proposal-evaluation.md`** is the original review. Superseded.
- **`source/`** holds the generators. The backlog is defined once in `backlog_v2.py`; the workbook and markdown are both generated from it, so they cannot drift.

---

## Reconciliation

```
lean pilot path        69.75  (14 sprints: W00 + S01–S13)
WhatsApp track          7.75  (built W14–16)
deferred to MVP-1.5     1.50
                       ------
total backlog          79.00  dev-days

capacity               70.00  (14 × 5)
unallocated             0.25
```
