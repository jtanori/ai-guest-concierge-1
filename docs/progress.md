<!-- progress-snapshot: {"generatedAt":"2026-10-26 06:40","items":{"done":24,"partial":5,"todo":51,"total":80},"days":{"done":27,"partial":8.5,"todo":43.5,"total":79},"remainingDays":52,"perSprint":{"W00":{"doneItems":5,"items":20,"doneDays":2.25,"totalDays":8},"S01":{"doneItems":3,"items":3,"doneDays":5.75,"totalDays":5.75},"S02":{"doneItems":5,"items":5,"doneDays":5.5,"totalDays":5.5},"S03":{"doneItems":2,"items":3,"doneDays":3,"totalDays":5},"S04":{"doneItems":2,"items":3,"doneDays":3,"totalDays":5},"S05":{"doneItems":2,"items":3,"doneDays":3,"totalDays":5.5},"S06":{"doneItems":1,"items":3,"doneDays":1.5,"totalDays":5},"S07":{"doneItems":4,"items":6,"doneDays":3,"totalDays":4},"S08":{"doneItems":0,"items":4,"doneDays":0,"totalDays":5.5},"S09":{"doneItems":0,"items":5,"doneDays":0,"totalDays":4.5},"S10":{"doneItems":0,"items":3,"doneDays":0,"totalDays":4.5},"S11":{"doneItems":0,"items":5,"doneDays":0,"totalDays":5},"S12":{"doneItems":0,"items":4,"doneDays":0,"totalDays":4.5},"S13":{"doneItems":0,"items":3,"doneDays":0,"totalDays":2},"WA":{"doneItems":0,"items":8,"doneDays":0,"totalDays":7.75},"DEF":{"doneItems":0,"items":2,"doneDays":0,"totalDays":1.5}}} -->
# Build progress

<!-- GENERATED FILE — do not edit by hand.
     Regenerate with `npm run progress` (scripts/progress.mjs).
     Source of truth for status: docs/07-master-backlog.xlsx, column K.
     Re-run this as part of every item's close-out (see the charter DoD). -->

_Generated 2026-10-26 06:40 UTC from the master backlog._

## Overall

| Measure | Done | Of total | % |
| --- | --- | --- | --- |
| Items | 24 | 80 | 30% |
| Days | 27 | 79 | 34.18% |

```
done            ████████░░░░░░░░░░░░░░░░  34.2%
+ half of 🚧    █████████░░░░░░░░░░░░░░░  39.6%
```

**5 items in flight** (8.5 d), **51 not started** (43.5 d), **52 d remaining** in total.

> The second bar counts an in-flight item at half its days. It is a scheduling estimate, not a status: an item with an unmet acceptance criterion is not done, however much of its work exists.

## By sprint

| Sprint | Items done | Days done | Days total | Progress |
| --- | --- | --- | --- | --- |
| W00 | 5/20 | 2.25 | 8 | `█████░░░░░░░░░░░` 31.25% |
| S01 | 3/3 | 5.75 | 5.75 | `████████████████` 100% |
| S02 | 5/5 | 5.5 | 5.5 | `████████████████` 100% |
| S03 | 2/3 | 3 | 5 | `██████████░░░░░░` 60% |
| S04 | 2/3 | 3 | 5 | `█████████████░░░` 80% |
| S05 | 2/3 | 3 | 5.5 | `████████████░░░░` 77.27% |
| S06 | 1/3 | 1.5 | 5 | `██████████░░░░░░` 65% |
| S07 | 4/6 | 3 | 4 | `████████████░░░░` 75% |
| S08 | 0/4 | 0 | 5.5 | `░░░░░░░░░░░░░░░░` 0% |
| S09 | 0/5 | 0 | 4.5 | `░░░░░░░░░░░░░░░░` 0% |
| S10 | 0/3 | 0 | 4.5 | `░░░░░░░░░░░░░░░░` 0% |
| S11 | 0/5 | 0 | 5 | `░░░░░░░░░░░░░░░░` 0% |
| S12 | 0/4 | 0 | 4.5 | `░░░░░░░░░░░░░░░░` 0% |
| S13 | 0/3 | 0 | 2 | `░░░░░░░░░░░░░░░░` 0% |
| WA | 0/8 | 0 | 7.75 | `░░░░░░░░░░░░░░░░` 0% |
| DEF | 0/2 | 0 | 1.5 | `░░░░░░░░░░░░░░░░` 0% |

## In flight

Every item whose cell starts with 🚧, with the reason recorded there.

| ID | Sprint | Item | Days | Status note |
| --- | --- | --- | --- | --- |
| W00-15 | W00 | Golden set v1: format + 20 starter questions | 0.5 | Local evidence verified — pending founder sign-off that the format is agreed |
| S04-03 | S04 | Hybrid retrieval | 2 | AC-1/AC-2 done; AC-3 blocked on golden v2 (G1) |
| S05-02 | S05 | Guardrail layer | 2.5 | AC-1/AC-2 done (citation+quote verification, banned content, sensitive/policy gate, reason codes; 356 unit + 184 db green). AC-3 (G2 ≤2% false answers) UNPROVEN — needs G1 golden set v2 + S06-03 harness. |
| S06-01 | S06 | Public property-scoped web chat | 2 | AC-1/AC-2/AC-3 met as a working surface (real HTTP round trip, signed cookie, slug-only tenant, disclosure + handoff-as-message; 374 unit + 195 db green, web:build green). AC-1's 'on staging' half UNVERIFIED here — deploy is the operator step. |
| S06-03 | S06 | Evaluation harness + CI job | 1.5 | Harness + CI done (2026-10-25) — npm run eval scores four ways on golden v1 through the real pipeline; regression gate armed on a recorded baseline; canary job in eval.yml. G2 itself is RED (25% false answers on the demo fixture) and stays red until G1: 1/13 answerable questions have their target topic in the corpus. |

## Remaining work by block

| Block | Remaining items | Remaining days | Days total |
| --- | --- | --- | --- |
| Foundation (W00) | 15/20 | 5.75 | 8 |
| Answer surface (S01–S07) | 7/26 | 11 | 35.75 |
| Staff + ops (S08–S10) | 12/12 | 14.5 | 14.5 |
| Hardening + launch (S11–S13) | 12/12 | 11.5 | 11.5 |
| WhatsApp track | 8/8 | 7.75 | 7.75 |
| Deferred to MVP-1.5 | 2/2 | 1.5 | 1.5 |

## Since the last report

| Measure | Now | Change |
| --- | --- | --- |
| Items done | 24 | +1 |
| Days done | 27 | +0.5 |
| Items in flight | 5 | — |
| Days remaining | 52 | -0.5 |

Previous report generated 2026-10-26 06:30.

## How to read this

- Statuses come from the workbook's Status column and nowhere else. `✅` = done,
  `🚧` = partially delivered with a named blocker, `☐` = not started.
- Days are the plan's estimates, not effort spent. A percentage here answers
  "how much of the plan is closed", never "how much time was used".
- The report is a snapshot of one commit. If it looks wrong, the workbook is
  wrong — fix the workbook and re-run, do not edit this file.

