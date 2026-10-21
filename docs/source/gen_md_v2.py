from backlog_v2 import SPRINTS, WA, DEFERRED
lean=sum(i[5] for s in SPRINTS for i in s[6]); wa_d=sum(i[5] for i in WA); df_d=sum(i[5] for i in DEFERRED)
n_lean=sum(len(s[6]) for s in SPRINTS); total=lean+wa_d+df_d
cum=0; LAD=[]
for sid,wk,name,goal,gate,exitc,its in SPRINTS:
    d=sum(i[5] for i in its); cum+=d
    LAD.append(dict(sid=sid,wk=wk,name=name,goal=goal,gate=gate,exit=exitc,its=its,n=len(its),days=d,cum=cum,cw=cum/5.0,delta=5.0-d))
def e(s): return str(s).replace("|","\\|")
L=[]
A=L.append
A("# Master Sprint Backlog v2")
A("")
A("**Single source of truth for the build** · 80 items · 14 sprints · 21 October 2026")
A("")
A("| | |")
A("|---|---|")
A(f"| **Lean pilot path** | **{lean:.2f} dev-days** across 14 sprints |")
A(f"| **WhatsApp track** | {wa_d:.2f} dev-days, built W14–16 after the pilot |")
A(f"| **Deferred to MVP-1.5** | {df_d:.2f} dev-days |")
A(f"| **Total backlog** | **{total:.2f} dev-days** / {n_lean+len(WA)+len(DEFERRED)} items |")
A("| **Capacity** | 14 sprints × 5 productive days = 70 days |")
A(f"| **Unallocated** | **{70-lean:.2f} days** — W13 carries 3 days of carry-forward room |")
A("| **Pilot live** | Monday **W14** · readout **W17** · WhatsApp **W18** |")
A("")
A("---")
A("")
A("## What changed in v2")
A("")
A("v1 had a backlog, but it was not safe to build from. Three defects:")
A("")
A("1. **Fourteen ID collisions.** `S0-02` meant *\"Repo + CI + 3 environments\"* in the backlog and *\"Sign D1, D5, D11, D14\"* in the kickoff pack. Two documents, one ID, different meanings. **IDs are now `<sprint>-<nn>`**, so the ID tells you the sprint and can never collide.")
A("2. **S13 was empty.** The launch sprint had no work items — staff training, content corrections and the GM go/no-go were described in prose but never costed. They are now three items totalling 2.0 days.")
A("3. **No acceptance criteria.** \"Definition of done\" entries were vague. Every item now has a **testable** acceptance criterion: *\"Pool hours answered by lookup, not generation\"* rather than *\"facts table works\"*.")
A("")
A("The day count rose from 67.75 to **69.75** as a direct result — the missing launch work is now visible rather than assumed to be free.")
A("")
A("---")
A("")
A("## Sprint ladder")
A("")
A("| Sprint | Week | Name | Items | Days | Cum. weeks | Slack | Gate |")
A("|---|---|---|---|---|---|---|---|")
for d in LAD:
    A(f"| **{d['sid']}** | {d['wk']} | {d['name']} | {d['n']} | {d['days']:.2f} | {d['cw']:.2f} | {d['delta']:+.2f} | {d['gate']} |")
A(f"| | | **Total** | **{n_lean}** | **{lean:.2f}** | **{lean/5:.2f}** | **{70-lean:+.2f}** | |")
A("")
A("> Work completes at **13.95 weeks**. W14 is launch; W13 carries the launch work and roughly three days of carry-forward room.")
A("")
A("---")
A("")
A("## The backlog, sprint by sprint")
A("")
for d in LAD:
    A(f"### {d['sid']} · {d['wk']} — {d['name']}")
    A("")
    A(f"**Goal:** {d['goal']}  ")
    A(f"**Days:** {d['days']:.2f} · **Gate:** {d['gate']}  ")
    A(f"**Exit:** {d['exit']}")
    A("")
    A("| ID | Track | Item | Days | Depends | Acceptance criteria |")
    A("|---|---|---|---|---|---|")
    for x in d["its"]:
        A(f"| `{x[0]}` | {x[1]} | {e(x[3])} | {x[5]:.2f} | {x[7]} | {e(x[8])} |")
    A("")
A("---")
A("")
A("## Capacity by sprint")
A("")
A("| Sprint | Eng days | Founder days | Total | Status |")
A("|---|---|---|---|---|")
for d in LAD:
    eng=sum(i[5] for i in d["its"] if i[1] in ("Eng","Both"))
    fnd=sum(i[5] for i in d["its"] if i[1]=="Founder")
    tot=eng+fnd
    st="Fits" if tot<=5.0 else f"**Over by {tot-5.0:.2f}**"
    A(f"| {d['sid']} | {eng:.2f} | {fnd:.2f} | {tot:.2f} | {st} |")
A(f"| **Total** | | | **{lean:.2f}** | 70 available |")
A("")
A("**W00 is the structural problem.** 8.0 days of work in a 5-day week — 4.0 engineering and 4.0 founder/GTM. It fits only if two people work in parallel. **Solo, it runs to mid-W1**, which pushes every downstream date by three days.")
A("")
A("---")
A("")
A("## Critical path")
A("")
A("| # | Step | Sprint | Why it blocks |")
A("|---|---|---|---|")
CP=[("Hotel supplies approved content","W00–S03","Retrieval cannot be tuned against content that has not arrived"),
("Schema and RLS","S01","Every later table, policy and test depends on it"),
("Article versioning","S03","Citations and embeddings hang off immutable versions"),
("Chunking and embeddings","S04","Retrieval, the gate and the guardrail chain sit downstream"),
("Retrieval quality","S04","Below 90% recall the gate fires constantly"),
("AI contract and guardrails","S05","Guest chat has nothing to send until it exists"),
("Eval harness","S06","Without it G2 is an opinion"),
("Guest chat","S06","The pilot surface"),
("Inbox","S08","Requests with nobody to receive them are broken promises"),
("Notifications","S09","The reason a request gets seen"),
("Restore drill and runbook","S12","G3 cannot pass without it")]
for i,(s,sp,w) in enumerate(CP,1): A(f"| {i} | {s} | {sp} | {w} |")
A("")
A("---")
A("")
A("## Gates")
A("")
A("| Gate | Name | Sprint | Week | Pass criteria | If it fails |")
A("|---|---|---|---|---|---|")
G=[("G0","Decisions and approvals","W00","W0","14 ADRs signed · verification submitted · content owner named · fixture seeded","Do not start S01"),
("G1","Content ready","S03","W3","25 articles · 40 facts · zero contradictions · golden set frozen","Delay the pilot, not the build"),
("G2","AI quality","S05","W5","False-answer ≤2% · escalation ≥95% · recall ≥90%","**Hard stop**"),
("G3","Pilot-ready","S12","W12","Isolation green · restore drilled · 3 staff unaided","Restricted launch only"),
("—","Pilot live","S13","W14","Trained · content corrected · GM go/no-go","Postpone a week"),
("G4","Pilot readout","—","W17","Containment ≥55% · accuracy ≥95% · ack ≤10 min","Do not scale sales"),
("G5","WhatsApp live","WA","W18","Approved · consent tested · clean shadow run","Stay web-only"),
("G6","Group pilot","—","W19+","2–3 properties · inheritance exercised","No PMS-dependent group")]
for g in G: A("| "+" | ".join(g)+" |")
A("")
A("---")
A("")
A("## WhatsApp track · 7.75 days")
A("")
A("| ID | When | Item | Days |")
A("|---|---|---|---|")
WHEN={"WA-01":"W0","WA-06":"W4","WA-07":"W5","WA-02":"W14","WA-03":"W14","WA-04":"W15","WA-05":"W15","WA-08":"W16"}
for x in WA: A(f"| `{x[0]}` | {WHEN[x[0]]} | {e(x[3])} | {x[5]:.2f} |")
A("")
A("> Approvals start W0 because they are calendar time. The build is 7.75 days of attention and lands after the pilot. A `wa.me` link gives the hotel WhatsApp presence on day one without any of this.")
A("")
A("---")
A("")
A("## Deferred to MVP-1.5")
A("")
A("| ID | Item | Days | Comes back when |")
A("|---|---|---|---|")
for x in DEFERRED: A(f"| `{x[0]}` | {e(x[3])} | {x[5]:.2f} | {e(x[8])} |")
for n,it,d,when in [("—","Automated PDF and website extraction",0,"After five assisted onboardings"),
("—","Self-serve onboarding wizard",0,"From hotel four"),
("—","Brand-to-property inheritance UI",0,"First group pilot"),
("—","Guest CSAT thumbs",0,"MVP-1.5")]:
    A(f"| {n} | {it} | — | {when} |")
A("")
A("---")
A("")
A(f"*Totals reconcile: {lean:.2f} + {wa_d:.2f} + {df_d:.2f} = **{total:.2f} dev-days**.*")
open("07-master-backlog.md","w",encoding="utf-8").write("\n".join(L))
print(f"md written · {len(L)} lines")
