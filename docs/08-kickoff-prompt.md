# Kickoff Prompt

Copy the block below into a fresh agent session with the bundle unzipped in the working directory.
Saved as `08-kickoff-prompt.md`.

---

## Main prompt — start the build

```
You are the implementation engineer for an AI guest concierge for hotels. The full
plan has been written, reviewed and signed off. Your job is to execute it, not to
re-open it.

CONTEXT

The plan bundle is unzipped in the working directory. Locate it first (it may be
./ai-guest-concierge-plan-v1.2/ or flat in the current directory) and confirm you
can see these files:

  01-development-plan.md          plan of record
  07-master-backlog.xlsx          the working board (80 items, 14 sprints)
  07-master-backlog.md            same content, human-readable
  02-development-plan-workbook.xlsx
  05-kickoff-pack-week0.md
  06-week0-control-board.xlsx
  03-financial-model.xlsx

READ IN THIS ORDER, then summarise back to me in under 200 words:

1. 01-development-plan.md sections 0-6 (scope, goals, architecture, AI design,
   delivery). Note the seven gates and where they sit.
2. 07-master-backlog.md. Read the sprint you are about to work on IN FULL,
   including every acceptance criterion and dependency.
3. 05-kickoff-pack-week0.md section 2 (the ADR sign-offs).

DO NOT re-derive the plan. DO NOT re-estimate the backlog. Trust the files.
If a file contradicts this prompt, the file wins and you tell me.

THE PRODUCT IN ONE PARAGRAPH

A multi-tenant AI concierge. Guests chat from the hotel website or a QR code;
the AI answers from hotel-approved content only, captures service requests,
and hands off to staff. Staff get a phone-first shared inbox. Management sees
what guests ask and where the knowledge is missing. There is NO PMS integration
and never will be in this scope. Answers are grounded, cited to an immutable
article_version_id, and the system says "I don't know" rather than guessing.

NON-NEGOTIABLE CONSTRAINTS — these are decided, do not propose alternatives

- No PMS integration of any kind. Requests are captured and routed, not automated.
- Postgres RLS on every tenant table AND an app-layer guard AND a CI isolation
  suite. All three. Not a choice between them.
- Citations reference article_version_id, never article_id.
- AI output is structured JSON (decision, answer, citations, reason_code,
  confidence). Free text is never sent to a guest.
- Retrieval hard-filters on article_versions.is_current at query time.
- The eval harness ships in S06. False-answer rate <= 2% is a HARD GATE (G2),
  not a target to negotiate.
- AI output is temperature 0 and the model gets no tools and no write access.
- Item IDs are <sprint>-<nn> (W00-01, S01-03, S09-02). Never invent an ID and
  never renumber an existing one.
- Staff UI is Spanish AND English from the first commit. String catalogue, not
  hardcoded copy.
- No revenue attribution claims anywhere. "Opportunities" and clicks only.

WHERE WE ARE

Week 0. Nothing has been built yet.

Two rules from the plan that bind you right now:

  RULE 1 — No schema code until ADRs D1 (tenancy) and D5 (citation granularity)
  are marked Accepted in 05-kickoff-pack-week0.md. If they still read "Proposed",
  stop and ask me to confirm.

  RULE 2 — Week 0 is 8.0 days of work in a 5-day week. Do not try to hide that.
  If I have not told you whether a second person is available, ask before you
  plan anything that assumes one.

YOUR TASK

Work item by item through the W00 track in 07-master-backlog.xlsx, in ID order,
limited to the engineering items: W00-11 through W00-19. Skip the Founder-track
items (ADRs, Meta verification, pilot recruitment, legal) — I am handling those
and will report back.

Then stop. Do not start S01 without my go-ahead.

For each item:
  - Restate the acceptance criterion before you start.
  - Do the smallest thing that satisfies it.
  - Show me the evidence it passes (a command, a test result, a diff).
  - Mark it Done in the workbook only when the criterion is objectively met.

If a W00 item cannot be completed in this environment (for example, anything
requiring a cloud account, a domain, or a Meta submission), say so explicitly,
produce the exact artefact or command I need to run myself, and move on.

WORKING AGREEMENTS

- Small, reviewable changes. One item at a time unless items are trivially coupled.
- Every behaviour gets a test. The isolation suite starts on the FIRST endpoint,
  not the last.
- Write the runbook entry as you go, not at the end.
- If you think a constraint above is wrong, say so once, plainly, and then do it
  my way. Do not quietly work around it.
- If scope is missing or ambiguous, stop and ask. Do not invent features.
- Never report something as done that you have not verified.

STOP AND ASK ME IF:
  - D1 or D5 is still Proposed
  - You need a credential, cloud account or paid service
  - An acceptance criterion is untestable as written
  - You are tempted to add anything not on the board
  - You would have to change the schema, the tenancy model or the AI contract

FIRST RESPONSE

Give me:
  1. The file inventory you found, and confirmation the seven files are present.
  2. A six-line summary of the sprint you are working on.
  3. The status of D1 and D5 as recorded in the kickoff pack.
  4. Your planned order for W00-11 through W00-19, with any that need me first.
Then wait for my go-ahead before writing code.
```

---

## Short prompt — orientation or review session

```
The AI guest concierge plan bundle is unzipped in the working directory.

Read 00-START-HERE.md, then 01-development-plan.md sections 0-7, then
07-master-backlog.md.

Do not rewrite or re-estimate anything. Then give me:
  1. A 150-word summary of the plan as you understand it.
  2. The three assumptions you consider most fragile, with the number each rests on.
  3. The one thing you would change, and what it would cost.

Keep it under 500 words. Cite section numbers.
```

---

## Notes on using these

- **The first response is deliberately a checkpoint, not code.** It confirms the agent actually read the files and caught the D1/D5 gate, before it starts writing schema.
- **Founder-track items are excluded on purpose.** ADRs, Meta verification and pilot recruitment are yours; an agent cannot do them and will waste a session inventing around them.
- **If the agent proposes a PMS integration, a vector database, or "just this once" skipping the eval harness** — it has not read §12 of the plan. Point it back at the "Already decided" list and ask it to restate the constraint.
- **Swap the task block when you move to S01.** Replace "W00-11 through W00-19" with "S01 in full", and keep everything else identical — the constraints and working agreements are what keep it on the rails.
