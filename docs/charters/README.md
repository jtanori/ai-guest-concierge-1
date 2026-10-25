# Item charters

A charter is the working contract for one backlog item. The master backlog
(`docs/07-master-backlog.md`) carries one line per item; a charter carries the
decisions that would otherwise be improvised in the PR — schema, interfaces,
validation rules, tenancy, tests, evidence and open questions. S02-01 was
delivered without one and review found three gaps that a charter would have
caught; this directory closes that gap.

Status: **Approved (2026-10-24)**. No item starts until its charter is
approved. The remaining sprints are chartered sprint-by-sprint (each sprint's
charters land as one PR) rather than all 80 items at once.

S02-01 shipped as **PARTIAL** (PR #7): its primitives are merged, but the
verbatim AC ("each role can only reach its own surface") has no production
caller of `requireRole` yet. Follow-up **S02-06** carries that AC; it is
tracked on the sprint board rather than retro-chartered here.

## Files

| Charter | Item | Days |
|---|---|---|
| `S02-02-property-settings.md` | Property settings | 1.00 |
| `S02-03-audit-log.md` | Audit log | 1.00 |
| `S02-04-seed-fixtures.md` | Seed fixtures + demo property | 1.00 |
| `S02-05-is-current-retrieval.md` | is_current retrieval filtering + re-embed job | 0.50 |

S02-01 is already implemented (PR #7) and its decisions are recorded in
`docs/runbook.md`; it is not retro-chartered.

## Charter format

Every charter opens with machine-readable front matter so GitHub conversion is
mechanical:

```yaml
---
id: S02-02
title: Property settings
sprint: S02
epic: S02 — Identity, settings, audit
track: Foundation
estimate_days: 1.0
priority: P0
depends_on: [S02-01]
labels: [sprint:S02, track:foundation, prio:P0]
milestone: S02 — Identity, settings, audit
---
```

Then, in order:

1. **Why** — the problem, with plan/backlog references.
2. **Goal** — one paragraph, what is true when this is done.
3. **Acceptance criteria** — the backlog AC verbatim, then numbered testable
   interpretations (`AC-1`…). A charter may not weaken the backlog AC.
4. **Scope** — in / explicitly out.
5. **Design** — migrations, modules, signatures, data shapes, validation and
   behavior rules. Decisions are stated, not left to the implementer.
6. **Tenancy and security** — RLS, roles/surfaces, secrets, PII.
7. **Test plan** — named unit and db cases, including the negative cases the
   reviewer will ask for.
8. **Evidence** — exact commands and the numbers the runbook entry will quote.
9. **Risks and open questions** — anything needing approval, with a default.
10. **Definition of done** — CI, runbook, workbook, review threads, deps.

## GitHub equivalent (no native epics)

GitHub's closest equivalent to epic → story is **milestone + epic issue +
sub-issues**:

- **Milestone** = sprint (`S02 — Identity, settings, audit`). Milestone due
  date = sprint end.
- **Epic issue** = one per sprint, titled `Epic: S02 — Identity, settings,
  audit`, body links the sprint's charters and carries a task list. The sprint
  gate AC lives here.
- **Story issue** = one per backlog item, titled `<ID> <title>` (e.g.
  `S02-02 Property settings`), attached as a **sub-issue** of the epic. Body =
  the charter (front matter kept as a fenced block; AC as a task list).
- **Dependencies** = native issue "blocked by" links from `depends_on`.
- **Labels** = `sprint:S02`, `track:foundation`, `prio:P0` (from front matter).
- **Board** = GitHub Project with fields `Sprint`, `Track`, `Status`
  (Not started / In progress / Done / Blocked), `Estimate (days)`.
- **PR** = title `S02-02: …`, body starts `Closes #<story>`, and carries the
  runbook evidence. The story closes on merge; the epic closes when all
  sub-issues are Done and the sprint gate is met.

Import is scriptable with `gh` once charters are approved; no manual typing.

## Approval checklist

- [x] Decisions in §5 are acceptable as written (or amended in review).
- [x] Open questions in §9 have answers or an accepted default.
- [x] Out-of-scope list is right — nothing silently deferred.
- [x] Evidence commands match how CI and local runs actually work.
- [x] No new runtime dependency without explicit approval.
