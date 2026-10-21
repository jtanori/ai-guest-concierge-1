import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

wb = openpyxl.Workbook()

NAVY   = "1F3864"
TEAL   = "2E6E6A"
LIGHT  = "EAF1F8"
BAND   = "F5F7FA"
AMBER  = "FFF2CC"
RED    = "F8D7DA"
GREEN  = "E2EFDA"
GREY   = "808080"

H = Font(name="Calibri", size=10, bold=True, color="FFFFFF")
B = Font(name="Calibri", size=10, bold=True)
N = Font(name="Calibri", size=10)
SM = Font(name="Calibri", size=9, color=GREY)
THIN = Side(style="thin", color="D0D7DE")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
WRAP = Alignment(wrap_text=True, vertical="top")

def sheet(title, headers, widths, rows, freeze="A2", header_color=NAVY, row_h=None, tab=None):
    ws = wb.create_sheet(title)
    ws.sheet_properties.tabColor = tab or header_color
    ws.append(headers)
    for c in range(1, len(headers)+1):
        cell = ws.cell(row=1, column=c)
        cell.font = H
        cell.fill = PatternFill("solid", fgColor=header_color)
        cell.alignment = Alignment(wrap_text=True, vertical="center")
        cell.border = BORDER
    ws.row_dimensions[1].height = 30
    for i, r in enumerate(rows, start=2):
        ws.append(list(r))
        for c in range(1, len(headers)+1):
            cell = ws.cell(row=i, column=c)
            cell.font = N
            cell.alignment = WRAP
            cell.border = BORDER
            if i % 2 == 0:
                cell.fill = PatternFill("solid", fgColor=BAND)
        if row_h:
            ws.row_dimensions[i].height = row_h
    for idx, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(idx)].width = w
    ws.freeze_panes = freeze
    ws.auto_filter.ref = f"A1:{get_column_letter(len(headers))}{len(rows)+1}"
    return ws

# ---------------- 1. README ----------------
ws = wb.active
ws.title = "README"
ws.sheet_properties.tabColor = NAVY
ws.column_dimensions["A"].width = 3
ws.column_dimensions["B"].width = 34
ws.column_dimensions["C"].width = 100

title = ws.cell(row=2, column=2, value="AI Guest Concierge — MVP Development Plan Workbook")
title.font = Font(name="Calibri", size=18, bold=True, color=NAVY)
sub = ws.cell(row=3, column=2, value="Companion to 01-development-plan.md  ·  Plan of record: pilot live Week 14, readout Week 17  ·  Prepared 21 Oct 2026")
sub.font = Font(name="Calibri", size=10, italic=True, color=GREY)

readme = [
    ("Plan at a glance", ""),
    ("Verdict", "Strategy is green-lit. Re-sequence the delivery. Add an AI evaluation harness and an engineering/ops layer — both are load-bearing. The proposal's 4–6 week schedule is the one claim that does not survive costing."),
    ("Scope of build", "14 weeks to a pilot live on web chat with one experienced full-stack developer (68 dev-days measured from the backlog, plus a 2-week buffer inside the 14). Full MVP-1 including WhatsApp: ~18 weeks solo, or ~10 weeks with a second developer from Week 3 scoped to UI and content ops."),
    ("Launch surface", "Web chat + QR, live in Week 14. WhatsApp approvals start Week 0 but the adapter is 8 dev-days of work that lands after the pilot (W12–13) with one developer. Approvals are parallel; work is not."),
    ("Biggest corrections", "1) Eval harness in Phase 2, not later. 2) Hours/prices as structured facts, not prose. 3) 'I don't know' as a designed state. 4) Cut automated PDF/web extraction from MVP. 5) Re-baseline WhatsApp cost — service messages became billable on 1 Oct 2026."),
    ("The critical path", "Not code. It is getting approved content out of a hotel. Recruit the pilot property before Sprint 1 with a named content owner and 4–6 hours in weeks 1–2."),
    ("", ""),
    ("How to use this workbook", ""),
    ("02 · Backlog", "Superseded as the working board by 07-master-backlog.xlsx v2 (80 items, IDs <sprint>-<nn>). This sheet is kept for gates, risks, metrics, content playbook, ADR log and build cost."),
    ("03 · Gates", "Seven go/no-go gates with objective criteria, dates, owners and failure actions. Do not pass a gate on vibes."),
    ("04 · Metrics", "Metric dictionary + pilot targets + the numeric go/no-go thresholds. Instrument from day one."),
    ("05 · Risks", "Twelve risks with likelihood, impact, mitigation, early-warning signal and owner."),
    ("06 · Roadmap", "19-week Gantt from kickoff to pilot readout (pilot live W14, readout W17), with the external approval track and WhatsApp build shown separately."),
    ("07 · Content", "The content-readiness playbook and the article template. This is the work that determines containment."),
    ("08 · Decisions", "Fourteen ADRs to lock in Week 0. Reversibility noted for each."),
    ("09 · Budget", "Build effort and one-time cost. Edit the yellow cells; the totals follow. Per-property unit economics now live in 03-financial-model.xlsx."),
    ("10 · Non-goals", "The written 'no' list. Put it in the sales deck."),
    ("", ""),
    ("Guiding rule", "A concierge that says 'I don't know, let me get a colleague' is a good concierge. One that invents the pool hours is a liability."),
]
r = 5
for k, v in readme:
    ws.cell(row=r, column=2, value=k).font = B if v == "" else B
    ws.cell(row=r, column=2).alignment = Alignment(vertical="top", wrap_text=True)
    c = ws.cell(row=r, column=3, value=v)
    c.font = N
    c.alignment = Alignment(wrap_text=True, vertical="top")
    if v == "" and k:
        for col in (2, 3):
            ws.cell(row=r, column=col).fill = PatternFill("solid", fgColor=LIGHT)
    ws.row_dimensions[r].height = 30 if v else 20
    r += 1

# ---------------- 2. BACKLOG ----------------
headers = ["ID","Epic","Work item","Description / notes","Estimate (dev-days)","Priority","Sprint","Definition of done","Status"]
widths  = [8, 20, 34, 62, 12, 10, 8, 52, 14]

rows = [
 # S0
 ("S0-01","Foundation","Lock architecture decisions D1–D14","ADR doc, one page each: decision, context, alternatives, reversibility. See '08 · Decisions'.",1,"P0","S0","ADRs merged to repo; D1–D14 have an owner and a date","Not started"),
 ("S0-02","Foundation","Repo + CI + 3 environments","local / staging / prod. Preview deploy per PR. No shared DB between staging and prod.",1,"P0","S0","A PR produces a preview URL and runs lint, typecheck, tests","Not started"),
 ("S0-03","Foundation","Error tracking + structured logging","org_id / property_id / conversation_id on every log line. PII redaction enabled from commit 1.",0.5,"P0","S0","A production-shaped error appears in the tracker with tenant context","Not started"),
 ("S0-04","Foundation","Recruit pilot property + content owner","Signed letter or email; named person; 4–6 hours committed in weeks 1–2. Content readiness is a sales gate.",1,"P0","S0","Named content owner with dates on the calendar","Not started"),
 ("S0-05","Foundation","Submit Meta business verification","Start the waiting clock on day 1–5. Legal entity docs, display name, business website.",0.5,"P0","S0","Submission confirmed; review SLA noted","Not started"),
 ("S0-06","Foundation","Select WhatsApp provider (BSP or direct)","Score on: Embedded Signup, number ownership/portability, MX coverage, webhook quality, per-message cost, onboarding support.",1,"P0","S0","Signed decision record D11; account opened","Not started"),
 ("S0-07","Knowledge","Define content model + article template","Article = title, topic_key, languages, owner, verified_at, review_due, chunkable body.",0.5,"P0","S0","Template agreed; one sample article per section written by the hotel","Not started"),
 ("S0-08","AI","Draft golden-question set v1","40–50 real questions per property in its actual languages. Expected behaviour, not expected string.",0.5,"P0","S0","≥ 40 questions covering answer / escalate / refuse","Not started"),
 ("S0-09","Analytics","Design event taxonomy","18 events, every one carrying org_id, property_id, conversation_id, channel, language, topic.",0.5,"P0","S0","Taxonomy doc; no dashboard built before this exists","Not started"),
 ("S0-10","Compliance","Privacy notice + DPA draft to counsel","LFPDPPP 2025 compliant. Enumerated purposes (no 'similar purposes' catch-all). Processor obligations explicit.",1,"P0","S0","Draft to a Mexican lawyer; DPA template ready before first pilot","Not started"),
 ("S0-11","Foundation","One-page non-goals doc for sales","The written 'no' list. Pre-empts the PMS-integration wishlist in every sales conversation.",0.25,"P0","S0","Reviewed with whoever runs sales","Not started"),
 # S1
 ("S1-01","Foundation","Schema + migrations","organizations, properties, users, memberships, roles, channel_connections, channel_identities, conversations, messages, message_delivery_events, service_requests, assignments, internal_notes, knowledge_sources, knowledge_articles, article_versions, property_facts, ai_runs, citations, handoff_reasons, knowledge_gaps, events, rollups, audit_log, outbox.",3,"P0","S1","Migration runs clean from empty; ERD committed","Not started"),
 ("S1-02","Foundation","Row-level security policies","RLS on every tenant table, keyed by org/property membership. Plus app-layer guard. Both, not either.",2,"P0","S1","Cross-tenant test suite green on all endpoints","Not started"),
 ("S1-03","Foundation","Auth + roles","Magic-link auth. Four roles: platform admin, org admin, property manager, agent. Org-scoped and property-scoped memberships.",2,"P0","S1","An agent at property A gets 403/404 on every property B resource","Not started"),
 ("S1-04","Foundation","Property settings","Languages, tone/register, operating hours, escalation contacts, enabled topics, AI mode, spend caps.",1,"P0","S1","Settings persist and are read by the AI policy layer","Not started"),
 ("S1-05","Foundation","Audit log","Who changed an answer, who took over, who sent a message, who accessed as support, when.",1,"P0","S1","Every consequential action writes an audit row","Not started"),
 ("S1-06","Foundation","Seed fixtures + demo property","So engineering is never blocked waiting on hotel content.",1,"P1","S1","`make seed` produces a fully populated demo property","Not started"),
 # S2
 ("S2-01","Knowledge","Article editor + versioning","Rich text → chunks. Immutable article_versions. Every edit creates a version.",2,"P0","S2","Editing an article never mutates a historical version","Not started"),
 ("S2-02","Knowledge","CSV bulk import (basic)","Guest directory / menu import, with preview. Hardened validation deferred; assisted import covers the first five hotels.",1.0,"P0","S2","A 100-row CSV imports with a preview step and zero silent failures","Not started"),
 ("S2-03","Knowledge","property_facts table + UI","Hours, prices, distances, capacities as structured values with verified_at and source version.",2,"P0","S2","Pool hours are answered by lookup, not generation","Not started"),
 ("S2-04","Knowledge","Review-and-approve screen","Nothing publishes silently. Flags missing fields and contradictions (e.g. website 21:00 vs PDF 20:00).",2,"P0","S2","A contradictory pair is caught and blocked until resolved","Not started"),
 ("S2-05","AI","Chunking + embeddings","Store embeddings from day one. Do not gate retrieval quality on them yet.",1,"P0","S2","Every published article version is chunked and embedded","Not started"),
 ("S2-06","AI","Hybrid retrieval","Postgres FTS + trigram + pgvector, property-scoped. Returns scored chunks.",2,"P0","S2","Retrieval recall ≥ 90% on the golden set's target articles","Not started"),
 ("S2-07","AI","AI service with structured output contract","JSON: decision, answer, citations, reason_code, topic_keys_used, confidence. Temperature 0. No tools.",2,"P0","S2","Malformed output is rejected server-side, never sent","Not started"),
 ("S2-08","AI","Guardrail layer","Retrieve-gate, citation check, banned-content check ('confirmed', 'on the way', prices, availability), entailment pass.",2.5,"P0","S2","Every rejection logs a reason_code; no false answer survives the gate","Not started"),
 ("S2-09","AI","ai_runs + citations logging","prompt_version, model_id, retrieved chunk ids, decision, latency, token cost.",1,"P0","S2","Any historical answer can be reconstructed from the DB","Not started"),
 ("S2-10","AI","Evaluation harness + CI job","Scores correct answer / correct escalation / false answer / needless escalation. Runs on every prompt, model, or KB change.",1.5,"P0","S2","G2 gate passes on demo property; harness runs in CI","Not started"),
 # S3
 ("S3-01","Chat","Public property-scoped web chat","/c/{slug}. Streaming. Mobile-first. No login.",2,"P0","S3","A stranger can hold a full conversation on staging","Not started"),
 ("S3-02","Chat","QR + embeddable snippet","Generated QR per property; one-line iframe/script snippet; logo + colour theming only.",0.5,"P1","S3","QR scans to the right property chat on a real phone","Not started"),
 ("S3-03","Chat","Conversation state machine","ai_active → needs_staff → staff_active → resolved, with guest reopen.",1.5,"P0","S3","Illegal transitions are impossible at the DB level","Not started"),
 ("S3-04","Chat","AI disclosure + 'talk to a person'","Persistent, obvious, translated. Disclosure on first message, not buried.",0.5,"P0","S3","A guest can reach a human in one tap from any state","Not started"),
 ("S3-05","Chat","Request capture + honest acknowledgement","'I've sent your request to the team' — never 'on the way'. Creates a service_request.",1,"P0","S3","No code path can claim a request is fulfilled","Not started"),
 ("S3-06","Chat","Abuse + cost protection","Turnstile on first message, per-IP/per-conversation/per-property rate limits, daily AI spend cap with graceful degradation.",1,"P0","S3","Cap trip degrades to 'a team member will reply' without an error","Not started"),
 ("S3-07","Chat","Outage fallback","If AI or provider is down, guest is told plainly and a request/ticket is still captured.",0.5,"P0","S3","Kill the AI service mid-conversation; guest still gets an honest message","Not started"),
 # S4
 ("S4-01","Inbox","Phone-first shared inbox","Responsive/PWA. Filters: needs attention, mine, unresolved, unassigned.",2,"P0","S4","An agent can triage a queue on a phone in under 60 seconds","Not started"),
 ("S4-02","Inbox","Conversation detail with AI sources","Show the cited article version behind every AI answer, verbatim.",1,"P0","S4","Staff can see exactly what the model read","Not started"),
 ("S4-03","Inbox","Reply / take over / assign / resolve","Taking over stops AI guest-facing replies immediately. AI may still draft privately.",1.5,"P0","S4","Takeover is atomic; no race where AI replies after takeover","Not started"),
 ("S4-04","Inbox","AI operating modes","Auto / Draft / Human-only / After-hours, per property, feature-flagged.",1,"P0","S4","Switching mode takes effect on the next message, no deploy","Not started"),
 ("S4-05","Inbox","Knowledge-gap queue","Unanswered + flagged questions with verbatim text, language and property. Inline write-an-article deferred.",0.5,"P0","S4","Every no_answer lands in the queue automatically","Not started"),
 ("S4-06","Inbox","One-click 'wrong or outdated'","On any AI answer → creates/updates a knowledge gap with context. Highest-value feedback loop in the product.",0.5,"P0","S4","A flag is attributable to an ai_run and visible to the manager","Not started"),
 ("S4-07","Inbox","Request lifecycle","Status, owner, timestamps, internal notes, priority, reopen.",2,"P0","S4","request_acknowledged timestamp is set by a real staff action","Not started"),
 # S5
 ("S5-01","Ops","Email notifications","New request, new handoff, unassigned for > 15 min. On by default.",1,"P0","S5","A request with no staff view still reaches a human by email","Not started"),
 ("S5-02","Ops","Outbound webhook per property","Events to Teams/Slack/hotel ops tool. Signed, retried. Cheap, and it answers the integration question honestly.",1,"P1","S5","A webhook is delivered, retried on failure, and logged","Deferred to 1.5"),
 ("S5-03","Analytics","Event emission across product","All 18 taxonomy events wired with the required context fields.",1.5,"P0","S5","Dashboard numbers reconcile exactly to raw events","Not started"),
 ("S5-04","Analytics","Daily rollups","Nightly SQL job over events. No second pipeline, no vendor.",1,"P0","S5","Rollup job is idempotent and re-runnable for a historical date","Not started"),
 ("S5-05","Analytics","Management dashboard","Top questions/topics by property and language, unanswered, request volume + resolution time, handoff rate. Hourly-demand heatmap deferred.",2.0,"P0","S5","Every tile is traceable to a query that a manager can explain","Not started"),
 ("S5-06","Analytics","Opportunity click tracking","Booking / dining / spa link clicks. Labelled 'opportunities', never revenue.",0.5,"P1","S5","No UI element or email claims revenue attribution","Deferred to 1.5"),
 # S6
 ("S6-01","Hardening","Transactional outbox + worker + DLQ","Send outside the request handler. Exponential backoff. Failures visible.",1.5,"P0","S6","Provider outage causes delayed sends, not lost messages","Not started"),
 ("S6-02","Hardening","Idempotency + webhook dedupe","Unique (channel_connection_id, channel_message_id). Process async, ack fast.",1,"P0","S6","Replaying a webhook 10x produces 1 message","Not started"),
 ("S6-03","Hardening","PII redaction + log hygiene","Mask card-like (Luhn), long digit runs, emails, phones. No full message bodies to third-party observability.",1,"P0","S6","A synthetic card number never appears in logs or the tracker","Not started"),
 ("S6-04","Hardening","Observability + alerting","Webhook failure rate, outbox backlog, LLM error rate, spend cap breaches, p95 latency, eval-regression.",1,"P0","S6","Every alert fires once in staging, with a linked runbook step","Not started"),
 ("S6-05","Hardening","Runbook + backup restore drill","LLM down, WhatsApp down, DB failover, duplicate storm, spend-cap trip, deletion request.",1,"P0","S6","Restore completed and timed; runbook signed off","Not started"),
 ("S6-06","Hardening","Accessibility + ES/EN audit","Guest chat and staff UI. Reachability on a mid-range Android on hotel wifi.",1,"P1","S6","Lighthouse a11y ≥ 90; no untranslated strings","Not started"),
 ("S6-07","Hardening","Load test","300 concurrent guests on one property; 50 staff sessions.",1,"P1","S6","p95 first token ≤ 3.5s at target load","Not started"),
 ("S6-08","Hardening","Pilot dry run with real content","Full scripted flow with the hotel's actual staff, on their real content.",1.5,"P0","S6","3 hotel staff complete the flow unaided (G3)","Not started"),
 # WhatsApp parallel track
 ("WA-01","WhatsApp","Payment method on WABA","Without it, service messages beyond the 1,000 free/month simply do not deliver (since 1 Oct 2026).",0.25,"P0","W0","Billing active; spend alert configured","Not started"),
 ("WA-02","WhatsApp","Adapter: webhook ingress","Verify signature, dedupe, normalize to the internal message model, ack < 3s.",1.5,"P0","W4","A replayed webhook produces exactly one message","Not started"),
 ("WA-03","WhatsApp","Adapter: send path + 24h window logic","Window tracking per conversation. Templates outside the window, free-form inside.",1.5,"P0","W4","Sending outside the window is impossible without a template","Not started"),
 ("WA-04","WhatsApp","Consent + opt-out store","Explicit consent records, STOP handling, per-channel rules isolated in the adapter.",1,"P0","W5","Opt-out is honoured across every send path","Not started"),
 ("WA-05","WhatsApp","Message-efficient reply composition","One complete reply per turn. No token streaming into WhatsApp — every bubble is billable.",1,"P0","W5","A typical exchange stays within the modelled message budget","Not started"),
 ("WA-06","WhatsApp","Template submission + approval","Utility templates for outside-window replies. Submit early; approval is calendar time.",1,"P0","W6","Templates approved and sendable","Not started"),
 ("WA-07","WhatsApp","Number-migration safeguards","Warn hotels that migrating a number to the API deletes consumer WhatsApp history. Recommend a dedicated number.",0.5,"P0","W5","Written acknowledgement captured in onboarding","Not started"),
 ("WA-08","WhatsApp","Shadow run on one property","Run alongside web chat for one week before switching any traffic.",1,"P1","W7","Zero delivery failures across 7 days","Not started"),
 # --- added in v1.1 after external review ---
 ("S1-07","Foundation","is_current retrieval filtering + re-embed job","Retrieval hard-filters on current article version at query time. Publish flips is_current in one transaction after embedding.",0.5,"P0","S3","Editing or deleting an article makes its old chunks unretrievable","Not started"),
 ("S2-11","AI","Nightly embedding reconciliation job","Asserts: every current version has >=1 chunk; every chunk resolves to a current version; no chunk outlives its parent. Alerts on violation.",0.5,"P0","S5","Job fails loudly on a seeded drift case","Not started"),
 ("S3-08","Chat","LLM transport resilience","Per-call timeouts, retry with jitter on 429/5xx, circuit breaker to secondary model, pinned model versions, parse-failure alerting.",0.5,"P0","S5","Both providers killed mid-conversation; guest gets an honest reply and a ticket","Not started"),
 ("S0-12","Knowledge","Adversarial fixture hotel","Messy on purpose: flattened two-column menu, OCR noise, contradictory pool hours, cross-language price list, 3,000-word article, photo-only notice.",0.5,"P0","S1","Ingestion and retrieval are tested against it from S3 onward","Not started"),
 ("S0-13","AI","Golden set: LLM-drafted answer cases, human escalation cases","LLM drafts answer-expected questions from articles; humans author escalation cases from the front-desk baseline log. Freeze v2 at G1.",0.25,"P0","S0","Golden set v2 frozen and versioned at G1","Not started"),
 ("S4-08","Inbox","Non-blocking review queue","Review queue never gates guest delivery. Replaces Draft mode as the week-one pilot mechanism.",0.5,"P0","S7","Flagging an answer does not delay the guest reply","Not started"),
 ("S0-14","WhatsApp","Mexico verification document pack","RFC name match, RFC doc, CFE/bank statement in registered name, matching domain, trading name, callable phone.",0.25,"P0","S0","Pack assembled and cross-checked before submission","Not started"),
]

ws = sheet("02 · Backlog", headers, widths, rows, row_h=44, tab=TEAL)
total_row = len(rows) + 2
ws.cell(row=total_row, column=4, value="total dev-days").font = B
ws.cell(row=total_row, column=5, value=f"=SUM(E2:E{len(rows)+1})").font = B
ws.cell(row=total_row, column=5).fill = PatternFill("solid", fgColor=AMBER)
ws.cell(row=total_row+1, column=4, value="P0 subtotal (must-ship)").font = B
ws.cell(row=total_row+1, column=5, value=f'=SUMIF(F2:F{len(rows)+1},"P0",E2:E{len(rows)+1})').font = B

# ---------------- 3. GATES ----------------
headers = ["ID","Gate","When","Owner","Pass criteria","If it fails","Status"]
widths  = [7, 24, 12, 16, 68, 44, 14]
rows = [
 ("G0","Decisions locked, approvals started","End W0","Founder / tech lead","ADRs D1–D14 recorded. Meta business verification submitted. Pilot content owner named with dates. Demo property seeded.","Do not start Sprint 1. Starting without D1/D5/D11 is the expensive mistake.","Open"),
 ("G1","Content ready (pilot property)","End W3","Content owner + PM","≥ 25 approved articles. ≥ 40 verified facts. Zero unresolved contradictions above severity threshold. Golden set v1 ≥ 40 questions.","Delay pilot, not the build. Switch pilot to the standby property.","Open"),
 ("G2","AI quality","End W5","Tech lead","False-answer ≤ 2%. Correct-answer-or-correct-escalation ≥ 95%. Retrieval recall ≥ 90%. p95 first token ≤ 3.5 s.","Hard stop on Phase 3 feature work. Improve retrieval and content, not prompt wording.","Open"),
 ("G3","Pilot-ready","End W11","Tech lead + founder","Tenant-isolation suite green. Restore drill signed off. 3 hotel staff complete a scripted flow unaided. Outage fallback verified. Runbook written.","Ship in Draft mode only. Autonomy requires G3.","Open"),
 ("G4","Pilot readout","W17","Founder","Containment ≥ 55%. Audited accuracy ≥ 95%. Request ack median ≤ 10 min in hours. Knowledge-gap median age ≤ 7 days.","Do not scale sales. Fix content or notification routing first — the two causes that account for most failures.","Open"),
 ("G5","WhatsApp live","W18","Tech lead","Verification approved. Templates approved. Consent/opt-out tested. Cost per conversation within model. Shadow run clean for 7 days.","Keep web-only. WhatsApp is a channel, not the product.","Open"),
 ("G6","Group pilot","Post-G4 (W19+)","Founder","2–3 properties signed on the same product. Brand→property inheritance exercised. Group reporting live. Security questionnaire answered without bespoke work.","Do not take a group pilot that requires PMS integration or custom build.","Open"),
]
ws = sheet("03 · Gates", headers, widths, rows, row_h=62, header_color="7A2E2E", tab="7A2E2E")
for r in range(2, len(rows)+2):
    ws.cell(row=r, column=7).fill = PatternFill("solid", fgColor=AMBER)

# ---------------- 4. METRICS ----------------
headers = ["Metric","Definition","Type","Pilot target","Source","Why it matters"]
widths  = [26, 58, 12, 20, 22, 56]
rows = [
 ("Containment","Conversations resolved with zero staff messages ÷ total conversations","Outcome","≥ 55% by pilot week 3","events","The commercial promise: repetitive work removed."),
 ("Audited accuracy","Weekly random sample of 50 AI answers, human-scored for correctness","Outcome (audited)","≥ 95%","Manual sample","The only honest measure of answer quality. Sample it; don't instrument it."),
 ("False-answer rate","Confidently wrong answers ÷ sampled answers","Diagnostic — HARD GATE","≤ 2%","Manual sample","One confident wrong answer costs more trust than 20 honest 'I don't know's."),
 ("Correct escalation","Escalated when it should have ÷ should-have-escalated","Diagnostic","≥ 90%","Golden set + sample","Catches over-confidence in sensitive topics."),
 ("Needless escalation","Escalated when a good answer existed ÷ answerable","Diagnostic","≤ 20% initially, falling","Golden set","The main driver of low containment. Trust it more as it falls."),
 ("Request acknowledgement","request_created → first staff action, within operating hours, median","Outcome","≤ 10 min","events","Healthiest single signal that the ops loop works."),
 ("Request resolution","created → resolved, median and p90","Outcome","Measure, don't target yet","events","Set the target after 4 weeks of real data."),
 ("Knowledge gap median age","Median days a gap sits unresolved","Diagnostic","≤ 7 days","knowledge_gaps","Tells the hotel exactly what content to write next."),
 ("Guest re-ask rate","Same question repeated within 10 minutes ÷ conversations","Diagnostic (proxy)","≤ 5%","events","Proxy for unsatisfying answers, no survey needed."),
 ("Staff override rate","AI replies edited or contradicted by staff ÷ AI replies","Diagnostic","Trend flat or falling","events","Rising = quality drift, often right after a KB edit."),
 ("Human handoff rate","Conversations reaching needs_staff ÷ conversations","Diagnostic","Inverse of containment","events","Reported by topic and by language."),
 ("Cost per resolved conversation","(LLM + WhatsApp + infra) ÷ resolved conversations","Unit economics","≤ $0.15","Billing + events","Decides whether the price point survives a high-volume property."),
 ("First response time (guest view)","Guest message → first visible reply, p95","Experience","≤ 5 s AI / ≤ 10 min human","events","AI speed is a real differentiator; don't waste it."),
 ("Guest usage by language","Conversations by detected language ÷ total","Distribution","Measure","events","Tells you which content languages actually earn their keep."),
 ("Opportunity clicks","Booking / dining / spa link clicks","Outcome (labelled)","Measure","events","Call them opportunities. Never revenue without attribution."),
]
ws = sheet("04 · Metrics", headers, widths, rows, row_h=42, header_color=TEAL, tab=TEAL)
for r in range(2, len(rows)+2):
    if "GATE" in str(ws.cell(row=r, column=3).value):
        for c in range(1, 7):
            ws.cell(row=r, column=c).fill = PatternFill("solid", fgColor=RED)
        ws.cell(row=r, column=1).font = B

# ---------------- 5. RISKS ----------------
headers = ["#","Risk","L","I","Mitigation","Early-warning signal","Owner"]
widths  = [5, 36, 7, 10, 68, 40, 14]
rows = [
 ("R1","Confident wrong answer damages a hotel's reputation","M","Critical","Eval harness with a hard false-answer gate. Structured facts for hours/prices. Draft mode. Staff see the source. Guardrail layer rejects uncited factual claims.","False-answer rate rising; staff override rate rising","Tech lead"),
 ("R2","Hotel content incomplete or stale → low containment","H","High","Content readiness as a sales gate. Knowledge-gap queue. 90-day fact re-verification. Assisted onboarding for the first five hotels.","Containment plateauing while audited accuracy is fine","Founder"),
 ("R3","Staff don't adopt the inbox → broken guest promises","H","High","Phone-first inbox, email default on, request-ack SLA metric, 3 staff trained before go-live, named on-call contact per property.","Request ack median climbing; unassigned queue growing","Founder"),
 ("R4","Scope creep into PMS integration","H","High","Written non-goals in the sales deck and the contract. Revisit only after G4 with evidence.","A prospect asks for 'just read-only room status'","Founder"),
 ("R5","WhatsApp approval delays push the launch date","M","Med","Start Week 0. wa.me bridge for immediate presence. Web chat is the launch surface.","Verification not submitted by day 5","Tech lead"),
 ("R6","WhatsApp per-message cost exceeds pricing tolerance","M","Med","Message-efficient replies. Per-property spend caps. Pass-through billing clause.","Cost per resolved conversation > $0.15","Founder"),
 ("R7","Tenant data leak across properties or orgs","Low","Critical","RLS + app guards. CI isolation suite on every endpoint. Audited support access.","Any unexpected 403/404 in staging","Tech lead"),
 ("R8","Public chat abused: cost blowout or prompt injection","M","Med","Turnstile, rate limits, per-property AI spend caps, no tools/write access for the model.","Spend-cap alerts; anomalous conversation volume","Tech lead"),
 ("R9","Multilingual quality drift","M","Med","Eval by language. Flag properties with sparse content in an enabled language. Unofficial 'best effort' labelling.","Accuracy gap > 10 points between languages","Tech lead"),
 ("R10","Solo developer bus factor / schedule slip","M","High","Docs-first, infra as code, a briefed backup contractor, no hero culture in S6 hardening.","'I'll write the docs later'","Founder"),
 ("R11","Group procurement / security review drags","M","Med","Answer the security questionnaire now, before it is asked. DPA template. Data-flow diagram. Support-access audit log.","Questionnaire exceeds two rounds","Founder"),
 ("R12","Regulatory exposure: guest data, AI disclosure, processor duties","M","High","LFPDPPP 2025 privacy notice + DPA. AI disclosure on first message. Retention defaults. Documented cross-border flows.","Any guest data leaving Mexico without a documented basis","Founder"),
]
ws = sheet("05 · Risks", headers, widths, rows, row_h=48, header_color="7A2E2E", tab="7A2E2E")
for r in range(2, len(rows)+2):
    imp = ws.cell(row=r, column=4).value
    ws.cell(row=r, column=4).fill = PatternFill("solid", fgColor=RED if imp=="Critical" else (AMBER if imp=="High" else GREEN))
    ws.cell(row=r, column=2).font = B

# ---------------- 6. ROADMAP ----------------
ws = wb.create_sheet("06 · Roadmap")
ws.sheet_properties.tabColor = "5A6B8C"
weeks = ["W0","W1","W2","W3","W4","W5","W6","W7","W8","W9","W10","W11","W12","W13","W14","W15","W16","W17","W18"]
tracks = [
 ("S0 · Decisions, approvals, recruiting", {0:1}),
 ("S1 · Schema + RLS", {1:1}),
 ("S2 · Auth, roles, settings, audit", {2:1}),
 ("S3 · Knowledge: editor, CSV, facts", {3:1}),
 ("S4 · Retrieval + review screen", {4:1}),
 ("S5 · AI core + eval harness", {5:1}),
 ("S6 · Guest web chat", {6:1}),
 ("S7 · Staff inbox + AI modes", {7:1}),
 ("S8 · Requests + notifications", {8:1}),
 ("S9 · Events, rollups, dashboard", {9:1}),
 ("S10 · Hardening + dry run", {10:1}),
 ("Buffer (W12–13) — absorbs retrieval + content slippage", {11:1, 12:1}),
 ("Pilot live + weekly audits", {13:1, 14:1, 15:1, 16:1}),
 ("\u2500 WhatsApp: approvals (external wait)", {0:1, 1:1, 2:1, 3:1}),
 ("\u2500 WhatsApp: template submission", {4:1}),
 ("\u2500 WhatsApp: adapter build", {13:1, 14:1}),
 ("\u2500 WhatsApp: shadow run + live", {15:1, 16:1, 17:1, 18:1}),
]
ws.cell(row=1, column=1, value="19-week plan · S = sprint (1 week) · plan of record: pilot live W14, readout W17").font = Font(name="Calibri", size=12, bold=True, color=NAVY)
ws.cell(row=1, column=1).alignment = Alignment(vertical="center")
ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=4)
ws.row_dimensions[1].height = 26

start_col = 5
for i, w in enumerate(weeks):
    c = ws.cell(row=2, column=start_col+i, value=w)
    c.font = H; c.fill = PatternFill("solid", fgColor=NAVY)
    c.alignment = Alignment(horizontal="center")
    c.border = BORDER
ws.cell(row=2, column=1, value="Track").font = H
ws.cell(row=2, column=1).fill = PatternFill("solid", fgColor=NAVY)
ws.merge_cells(start_row=2, start_column=1, end_row=2, end_column=4)

palette = ["8EA9DB","8EA9DB","9BC2E6","A9D08E","A9D08E","A9D08E","FFD966",
           "F4B183","F4B183","B4A7D6","C9C9C9","E2EFDA","E2EFDA"]
for r, (label, spans) in enumerate(tracks, start=3):
    lc = ws.cell(row=r, column=1, value=label)
    lc.font = B if not label.startswith("\u2500") else Font(name="Calibri", size=10, italic=True, color="6E5B9A")
    lc.alignment = Alignment(vertical="center")
    ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=4)
    if label.startswith("\u2500"):
        fill = "D9D2E9"
    else:
        fill = palette[r-3] if r-3 < len(palette) else "DDDDDD"
    for wk in spans:
        c = ws.cell(row=r, column=start_col+wk)
        c.fill = PatternFill("solid", fgColor=fill)
        c.border = BORDER
    ws.row_dimensions[r].height = 20

mrow = len(tracks) + 4
ms = [("G0",0),("G1",3),("G2",5),("G3",10),("Pilot live",14),("G4",17),("G5",18)]
ws.cell(row=mrow, column=1, value="Milestones").font = B
ws.merge_cells(start_row=mrow, start_column=1, end_row=mrow, end_column=4)
for label, wk in ms:
    c = ws.cell(row=mrow, column=start_col+wk)
    c.value = label
    c.font = Font(name="Calibri", size=9, bold=True, color="FFFFFF")
    c.fill = PatternFill("solid", fgColor="C00000")
    c.alignment = Alignment(horizontal="center")
    c.border = BORDER
ws.row_dimensions[mrow].height = 26

ws.cell(row=mrow+2, column=1, value="Note").font = B
ws.cell(row=mrow+2, column=5, value="G2 (AI quality) at end of W5 is a hard stop: if it fails, feature work does not proceed. W11 is a real buffer week, not slack — plans without one slip instead of absorbing. The WhatsApp lane is drawn separately because its approval waits cost calendar time, not development time; the 8-day adapter build still lands after the web pilot for a single developer.").alignment = WRAP
ws.merge_cells(start_row=mrow+2, start_column=5, end_row=mrow+2, end_column=start_col+len(weeks)-1)
ws.row_dimensions[mrow+2].height = 48

ws.column_dimensions["A"].width = 40
for i in range(1, 5):
    ws.column_dimensions[get_column_letter(i)].width = 9
for i in range(len(weeks)):
    ws.column_dimensions[get_column_letter(start_col+i)].width = 6.0

# ---------------- 7. CONTENT PLAYBOOK ----------------
headers = ["Section","What goes in it","Min. articles","Notes","Owner"]
widths  = [26, 62, 12, 52, 18]
rows = [
 ("Property basics","Name, address, how to get here, parking, check-in and check-out times","3","Definitely structured facts, not prose. These are your highest-volume questions.","Hotel"),
 ("Amenities & hours","Pool, gym, spa, beach club, business centre, laundry — with hours and any seasonal variation","5","Hours as property_facts with verified_at. Seasonal variants modelled explicitly.","Hotel"),
 ("Policies","Cancellation, pets, children, smoking, visitors, extra beds, late checkout, deposit","6","Raw policies, not marketing versions. Route anything ambiguous to staff.","Hotel"),
 ("Dining","Restaurants and bars: hours, dress code, reservations, menus, allergens","4","Allergen handling always escalates — never let AI answer allergen questions alone.","Hotel"),
 ("Spa & wellness","Services, durations, prices, booking process","3","Prices as facts. Booking always hands off until you have a real booking integration.","Hotel"),
 ("Local recommendations","Beaches, restaurants, transport, tours, safety, day trips","6","Opt-in with a clear boundary: hotel-approved recommendations only, no autonomous web browsing.","Hotel"),
 ("Getting around","Airport transfer, taxi, car rental, ride apps, parking, shuttles","3","A top-10 real-world question set. Verify prices or omit them.","Hotel"),
 ("Troubleshooting","Wifi, TV, AC, safe, hot water, key cards","4","Answer with self-serve steps, but always offer a request if it doesn't resolve.","Hotel"),
 ("Accessibility","Step-free routes, accessible rooms, equipment, service animals","2","Any specific accessibility need escalates to a human. Always.","Hotel"),
 ("Sensitive / escalate","Medical, safety, security, billing disputes, refunds, complaints","0","Do NOT write articles here. Add them to the handoff_reasons taxonomy instead.","Product"),
]
ws = sheet("07 · Content", headers, widths, rows, row_h=44, header_color="2E6E6A", tab="2E6E6A")
end = len(rows) + 3
ws.cell(row=end, column=1, value="Target for pilot").font = B
ws.cell(row=end, column=3, value=f"=SUM(C2:C{len(rows)+1})").font = B
ws.cell(row=end, column=3).fill = PatternFill("solid", fgColor=AMBER)
ws.cell(row=end, column=4, value="Minimum 25 approved articles + 40 verified facts before the pilot opens (G1).").font = N

guide = [
 ("",
  ""),
 ("How to run content collection", ""),
 ("1. Baseline week", "Before writing anything, log one week of real guest questions at the front desk. This is your golden set and your priority order. Do not guess what guests ask."),
 ("2. Write to the template", "One article per topic_key. Owner, languages, verified_at, review_due. Short paragraphs. No marketing copy — the model will quote it."),
 ("3. Extract the facts", "Pull hours, prices, distances and capacities into property_facts. If the source and the fact disagree, the review screen blocks publication until a human resolves it."),
 ("4. Approve explicitly", "Nothing publishes silently. A named hotel employee signs off on hours, prices and policies. That sign-off is your responsibility boundary when something is wrong."),
 ("5. Test before publishing", "Run the golden set against the draft KB. Fix content, not prompts, for any miss. Then use the in-product test chat."),
 ("6. Schedule review", "Facts re-verified every 90 days. Articles reviewed seasonally. A stale hours fact is the most common cause of a bad answer in month three."),
]
r = end + 3
for k, v in guide:
    ws.cell(row=r, column=1, value=k).font = B
    c = ws.cell(row=r, column=2, value=v)
    c.font = N; c.alignment = WRAP
    ws.merge_cells(start_row=r, start_column=2, end_row=r, end_column=5)
    ws.row_dimensions[r].height = 34 if v else 14
    r += 1

# ---------------- 8. DECISIONS ----------------
headers = ["ID","Decision","Recommendation","Reversibility","Why it matters now"]
widths  = [7, 30, 62, 18, 54]
rows = [
 ("D1","Tenancy enforcement","Postgres RLS on every tenant table AND app-layer guards. Both, with a CI isolation suite.","Hard to add later","A leak is existential for a group sale. Retrofitting RLS across 25 tables after launch is a week of risk."),
 ("D2","Retrieval strategy","Postgres FTS + trigram + pgvector column populated from day one. Ranking starts simple.","Easy to tune","Multilingual guests against single-language content break pure FTS. Adding the column costs nothing; adding it later means re-embedding everything."),
 ("D3","Embeddings","Store from day one even if ranking ignores them initially.","Easy","The data is only available if you captured it."),
 ("D4","AI output contract","Structured JSON: decision, answer, citations, reason_code, confidence.","Hard","Free-text output cannot be gated, scored, or audited."),
 ("D5","Citation granularity","Cite article_version_id, not article_id.","Hard","Historical answers must resolve to the exact text the model saw, or 'show me the source' is unanswerable during an audit."),
 ("D6","AI operating modes","Four modes per property: Auto, Draft, Human-only, After-hours.","Easy","Sells to nervous buyers, and gives you a graceful production downgrade path."),
 ("D7","Message sending","Transactional outbox + worker + exponential backoff + DLQ.","Easy","Never send inside a request handler. Provider outages are normal, not exceptional."),
 ("D8","Webhook handling","Dedupe on provider message ID, ack fast (<3s), process async.","Easy","Providers replay. Duplicated guest messages destroy trust in the first hour."),
 ("D9","Staff notifications","Email + phone-first inbox + signed outbound webhook.","Easy","A shared inbox nobody checks is worse than no inbox."),
 ("D10","Analytics","Append-only events table + nightly SQL rollups. No second pipeline.","Easy","Every dashboard number must be traceable to rows. This keeps it that way."),
 ("D11","WhatsApp provider","Direct Cloud API or a BSP with Embedded Signup. Hotel must own its number.","Hard","Locking a group into your BSP's number is a procurement objection you cannot argue away."),
 ("D12","LLM provider","One primary + one fallback behind an internal interface. Per-property model config.","Easy","Model prices and capabilities move monthly. Never let one SDK shape the codebase."),
 ("D13","File storage","Object storage + signed URLs + virus scan on upload.","Easy","Hotel-uploaded PDFs are the least trustworthy inbound content you will accept."),
 ("D14","Staff i18n","String catalogue from commit #1. Spanish + English at launch.","Expensive later","An English-only back office in Mexico gets half-adopted and quietly resented."),
]
ws = sheet("08 · Decisions", headers, widths, rows, row_h=54, header_color=NAVY, tab=NAVY)
for r in range(2, len(rows)+2):
    rev = ws.cell(row=r, column=4).value
    ws.cell(row=r, column=4).fill = PatternFill("solid", fgColor=RED if "Hard" in rev else GREEN)
    ws.cell(row=r, column=2).font = B

# ---------------- 9. BUDGET ----------------
ws = wb.create_sheet("09 · Budget")
ws.sheet_properties.tabColor = "7F6000"
ws.column_dimensions["A"].width = 46
for col in "BCDEF":
    ws.column_dimensions[col].width = 16

ws["A1"] = "Effort, cost and unit economics"
ws["A1"].font = Font(name="Calibri", size=14, bold=True, color=NAVY)
ws["A2"] = "Yellow cells are inputs — edit them and the totals recalculate."
ws["A2"].font = SM

def block_header(row, text):
    c = ws.cell(row=row, column=1, value=text)
    c.font = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
    c.fill = PatternFill("solid", fgColor=TEAL)
    ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=5)
    c.alignment = Alignment(vertical="center")
    ws.row_dimensions[row].height = 22

# Effort — read from the consolidated sprint ladder (07-master-backlog)
block_header(4, "A. Build effort — measured from the master backlog")
eff = [
 ("W00 Foundation lock", 8.00),
 ("S01 Schema + RLS", 5.75),
 ("S02 Identity, settings, audit", 5.50),
 ("S03 Knowledge", 5.00),
 ("S04 Retrieval + review", 5.00),
 ("S05 AI core", 5.50),
 ("S06 Guest chat + eval harness", 5.00),
 ("S07 Chat hardening", 4.00),
 ("S08 Staff inbox", 5.50),
 ("S09 Requests + notifications", 4.50),
 ("S10 Analytics", 4.50),
 ("S11 Reliability", 5.00),
 ("S12 Pilot readiness", 4.50),
 ("S13 Launch", 2.00),
]
r = 5
for i, t in enumerate(["Workstream", "Dev-days", "Calendar weeks", "Note"], start=1):
    c = ws.cell(row=r, column=i, value=t)
    c.font = H; c.fill = PatternFill("solid", fgColor=NAVY); c.border = BORDER
r += 1
start = r
for name, d in eff:
    ws.cell(row=r, column=1, value=name).font = N
    c = ws.cell(row=r, column=2, value=d)
    c.font = N; c.fill = PatternFill("solid", fgColor=AMBER); c.border = BORDER
    c.number_format = "0.00"
    c2 = ws.cell(row=r, column=3, value=(round(d/5, 2) if d else 0))
    c2.font = N; c2.border = BORDER; c2.number_format = "0.00"
    if name.startswith("W00"):
        ws.cell(row=r, column=4, value="Over-subscribed: 8.0 days in a 5-day week. Fits only with two people in parallel").font = SM
    if name.startswith("S13"):
        ws.cell(row=r, column=4, value="Launch: training, content fixes, go/no-go. ~3 days of carry-forward room remains").font = SM
    r += 1
ws.cell(row=r, column=1, value="Total — lean pilot path").font = B
tc = ws.cell(row=r, column=2, value=f"=SUM(B{start}:B{r-1})")
tc.font = B; tc.fill = PatternFill("solid", fgColor="D9E1F2"); tc.border = BORDER; tc.number_format = "0.00"
ws.cell(row=r, column=3, value="13.95 weeks of work across 14 sprints").font = B
lean_row = r
r += 1
ws.cell(row=r, column=1, value="  plus: WhatsApp track (post-pilot)").font = Font(name="Calibri", size=10, italic=True)
c = ws.cell(row=r, column=2, value=7.75); c.font = Font(name="Calibri", size=10, italic=True); c.number_format = "0.00"
ws.cell(row=r, column=4, value="Built in W14–16; cannot run in parallel for one developer").font = SM
wa_row = r
r += 1
ws.cell(row=r, column=1, value="  plus: deferred to MVP-1.5").font = Font(name="Calibri", size=10, italic=True)
c = ws.cell(row=r, column=2, value=1.50); c.font = Font(name="Calibri", size=10, italic=True); c.number_format = "0.00"
ws.cell(row=r, column=4, value="Outbound webhook, opportunity click tracking").font = SM
def_row = r
r += 1
ws.cell(row=r, column=1, value="Total backlog (80 items)").font = B
c = ws.cell(row=r, column=2, value=f"=B{lean_row}+B{wa_row}+B{def_row}")
c.font = B; c.fill = PatternFill("solid", fgColor=GREEN); c.border = BORDER; c.number_format = "0.00"
effort_total_row = r
r += 1
ws.cell(row=r, column=1, value="Capacity: 14 sprints × 5 productive days").font = N
ws.cell(row=r, column=2, value=70).font = N
ws.cell(row=r, column=4, value="Unallocated 0.25 days. W13 holds ~3 days of carry-forward room").font = SM
r += 1

# Rates
r += 2
block_header(r, "B. Rates and non-build costs")
r += 1
inputs = [
 ("Developer day rate (USD)", 550, "Blended; adjust to your market. Solo founder = opportunity cost, not cash."),
 ("Design (days)", 6, "Guest chat + staff inbox. Contract it; don't improvise."),
 ("Legal / compliance review (USD)", 1800, "LFPDPPP 2025 privacy notice + DPA + WhatsApp terms review."),
 ("Managed services, build months (USD/mo)", 120, "Postgres, hosting, storage, error tracking, CI."),
]
rate_rows = {}
for label, val, note in inputs:
    ws.cell(row=r, column=1, value=label).font = N
    c = ws.cell(row=r, column=2, value=val)
    c.font = N; c.fill = PatternFill("solid", fgColor=AMBER); c.border = BORDER
    c3 = ws.cell(row=r, column=3, value=note)
    c3.font = SM; c3.alignment = WRAP
    ws.merge_cells(start_row=r, start_column=3, end_row=r, end_column=5)
    ws.row_dimensions[r].height = 26
    rate_rows[label.split(" (")[0]] = r
    r += 1

r += 1
block_header(r, "C. One-time build cost")
r += 1
dev_row = rate_rows["Developer day rate"]
design_row = rate_rows["Design"]
legal_row = rate_rows["Legal / compliance review"]
svc_row = rate_rows["Managed services, build months"]
calc = [
 ("Development", f"=B{effort_total_row}*B{dev_row}"),
 ("Design", f"=B{design_row}*B{dev_row}"),
 ("Legal / compliance", f"=B{legal_row}"),
 ("Managed services (2 months)", f"=B{svc_row}*2"),
]
for label, formula in calc:
    ws.cell(row=r, column=1, value=label).font = N
    c = ws.cell(row=r, column=2, value=formula)
    c.font = N; c.number_format = '"$"#,##0'; c.border = BORDER
    r += 1
ws.cell(row=r, column=1, value="Total one-time").font = B
c = ws.cell(row=r, column=2, value=f"=SUM(B{r-4}:B{r-1})")
c.font = B; c.number_format = '"$"#,##0'; c.fill = PatternFill("solid", fgColor="D9E1F2"); c.border = BORDER
one_time_row = r

# Pointer to the dedicated financial model (single source of truth)
r += 2
block_header(r, "D. Per-property unit economics — moved")
r += 1
note = [
 ("Where it lives now", "03-financial-model.xlsx — a live model with editable inputs, four property archetypes, pricing, a 24-month projection, three funding scenarios, sensitivity and buyer-side ROI."),
 ("Why it moved", "The earlier rough version in this sheet assumed a flat LLM cost, ignored support labour, and used a different conversation volume. It disagreed with the real model. Keeping two sets of numbers in one deck is how plans lose credibility in review."),
 ("In one line", "Gross margin is 78–85% at every property size. Support labour is 37–56% of COGS; LLM is 5–15%. That is the whole cost story."),
 ("The number that decides the sale", "Buyer-side ROI: 0.39–1.14× at Mexican labour rates, 1.05–3.09× at US resort rates. Only the 250-room resort tier clears 1× in Mexico. See the Buyer ROI sheet."),
]
for k, v in note:
    ws.cell(row=r, column=1, value=k).font = B
    c = ws.cell(row=r, column=2, value=v)
    c.font = N; c.alignment = WRAP
    ws.merge_cells(start_row=r, start_column=2, end_row=r, end_column=5)
    ws.row_dimensions[r].height = 40
    r += 1

# ---------------- 10. NON-GOALS ----------------
headers = ["Not in MVP","Why not","Revisit when","Risk if built anyway"]
widths  = [34, 58, 34, 50]
rows = [
 ("Native guest mobile app","Install friction kills adoption for a 2–4 day stay. The web link and QR do the same job.","Never as the primary surface; consider a PWA wrapper post-pilot.","Months of build, near-zero installs."),
 ("Any PMS integration (read or write)","It converts a 1-day deployment into a 6-month enterprise project and makes every hotel a custom build.","After G4, with evidence that request routing alone is not enough, and only for a signed group.","The single fastest way to fail as a company."),
 ("Payment capture in chat","PCI scope, fraud, refunds. Redirect to the approved booking flow.","Rarely, and only via a hosted payment provider.","Compliance burden out of all proportion to value."),
 ("Room-service order placement","Requires PMS/POS integration and real fulfilment guarantees.","Post-PMS-integration, if ever.","Broken promises to hungry guests."),
 ("Housekeeping / task-management integration","Hotels already have a system for this; replacing it is a different company.","When a group asks for it as a paid integration.","Scope explosion into workforce management."),
 ("AI issuing refunds, discounts, or binding promises","No authority, no accountability structure, immediate financial exposure.","Never. Escalate.","A single unauthorised refund becomes a contract dispute."),
 ("Telegram, Instagram, Messenger, SMS","Each channel has its own rules, approvals, and cost profile.","After WhatsApp is proven and profitable.","Channel sprawl with no incremental revenue."),
 ("Predictive personalisation / guest profiling","Requires data volume you will not have for a year, and raises privacy obligations.","Once you have 12+ months of multi-property data.","Privacy risk now, no benefit yet."),
 ("Voice / telephony","Different latency, cost, and failure modes entirely.","As a separate product line.","Dilutes the entire build."),
 ("Custom per-property theming beyond logo and colour","Design debt with no commercial upside at this stage.","On a paid enterprise agreement.","Endless small requests, no revenue."),
 ("Autonomous web browsing for hotel facts","You cannot verify what it read, and the hotel cannot approve it. This is the opposite of the trust model.","Never as an answer source.","Hallucinated facts attributed to the hotel."),
 ("Revenue attribution claims","You cannot prove a booking without PMS or booking-engine data.","When you have booking-engine callbacks.","Losing a customer's trust on the first business review."),
]
ws = sheet("10 · Non-goals", headers, widths, rows, row_h=48, header_color="7A2E2E", tab="7A2E2E")
for r in range(2, len(rows)+2):
    ws.cell(row=r, column=1).font = B

wb.save("/home/user/hotel-concierge-plan/02-development-plan-workbook.xlsx")
print("saved")
