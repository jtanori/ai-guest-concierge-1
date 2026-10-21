import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation
from backlog_v2 import SPRINTS, WA, DEFERRED

NAVY,TEAL,AMBER,GREEN,RED,LIGHT,GREY,PURPLE="1F3864","2E6E6A","FFF2CC","E2EFDA","F8D7DA","EAF1F8","808080","EDE7F6"
H=Font(name="Calibri",size=10,bold=True,color="FFFFFF"); B=Font(name="Calibri",size=10,bold=True)
N=Font(name="Calibri",size=10); SM=Font(name="Calibri",size=9,color=GREY)
THIN=Side(style="thin",color="D0D7DE"); BD=Border(left=THIN,right=THIN,top=THIN,bottom=THIN)
WRAP=Alignment(wrap_text=True,vertical="top")

lean=sum(i[5] for s in SPRINTS for i in s[6]); wa_d=sum(i[5] for i in WA); df_d=sum(i[5] for i in DEFERRED)
n_lean=sum(len(s[6]) for s in SPRINTS); total=lean+wa_d+df_d
cum=0; LAD=[]
for sid,wk,name,goal,gate,exitc,its in SPRINTS:
    d=sum(i[5] for i in its); cum+=d
    LAD.append(dict(sid=sid,wk=wk,name=name,goal=goal,gate=gate,exit=exitc,its=its,n=len(its),days=d,cum=cum,cw=cum/5.0,delta=5.0-d))

wb=openpyxl.Workbook()
def hdr(ws,row,labels,color=NAVY):
    for i,t in enumerate(labels,start=1):
        c=ws.cell(row=row,column=i,value=t); c.font=H
        c.fill=PatternFill("solid",fgColor=color); c.border=BD
        c.alignment=Alignment(wrap_text=True,vertical="center",horizontal="center")
    ws.row_dimensions[row].height=32

# README
ws=wb.active; ws.title="README"; ws.sheet_properties.tabColor=NAVY
ws.column_dimensions["A"].width=3; ws.column_dimensions["B"].width=32; ws.column_dimensions["C"].width=94
ws["B2"]="Master Sprint Backlog v2"; ws["B2"].font=Font(name="Calibri",size=18,bold=True,color=NAVY)
ws["B3"]="Single source of truth for the build · 80 items · 14 sprints · 21 Oct 2026"
ws["B3"].font=Font(name="Calibri",size=10,italic=True,color=GREY)
rows=[("",""),
("The numbers",""),
("Lean pilot path",f"{lean:.2f} dev-days across 14 sprints (W00, S01–S13). Pilot live Monday of W14."),
("WhatsApp track",f"{wa_d:.2f} dev-days, built W14–16 after the pilot. Tracked separately so it cannot creep in."),
("Deferred to MVP-1.5",f"{df_d:.2f} dev-days."),
("Total backlog",f"{total:.2f} dev-days across {n_lean+len(WA)+len(DEFERRED)} items."),
("Capacity","14 sprints x 5 productive days = 70 days."),
("Slack",f"{70-lean:.2f} days unallocated. W13 carries {dict((l['sid'],l['days']) for l in LAD)['S13']:.2f} days of launch work, leaving ~3 days of carry-forward room in that week."),
("",""),
("What changed in v2",""),
("One ID scheme","IDs are now <sprint>-<nn>, so the ID tells you the sprint. v1 had 14 ID collisions with the Week 0 kickoff pack — S0-02 meant two different things in two documents."),
("S13 was empty","The launch sprint had no items. It now holds staff training, content corrections and the GM go/no-go."),
("Acceptance criteria","Every item now has a testable acceptance criterion, not a vague definition of done. 'Pool hours answered by lookup, not generation' beats 'facts work'."),
("Week 0 reconciled","The 20 Week 0 tasks now match the kickoff pack exactly, one-to-one."),
("",""),
("How to read it",""),
("02 · Sprint ladder","14 sprints: goal, items, days, cumulative weeks, gate, exit criterion."),
("03 · Master backlog","All 80 items with sprint, track, estimate, dependency and acceptance criteria. The working board."),
("04 · Capacity","Demand vs capacity per sprint, split by owner."),
("05 · Gates","Gates mapped to the sprint that closes them."),
("06 · Critical path","The dependency chain that sets the launch date."),
("07 · WhatsApp","7.75 days, outside the pilot path."),
("08 · Deferred","What is deliberately out of the pilot."),
]
r=5
for k,v in rows:
    ws.cell(row=r,column=2,value=k).font=B
    c=ws.cell(row=r,column=3,value=v); c.font=N; c.alignment=WRAP
    if v=="":
        for col in (2,3): ws.cell(row=r,column=col).fill=PatternFill("solid",fgColor=LIGHT)
        ws.row_dimensions[r].height=18
    else:
        ws.row_dimensions[r].height=32 if len(v)>95 else 16
    r+=1

# Ladder
ws=wb.create_sheet("02 · Sprint ladder"); ws.sheet_properties.tabColor=TEAL
for i,w in enumerate([8,7,26,44,6,10,11,11,10,12,52],start=1): ws.column_dimensions[get_column_letter(i)].width=w
ws["A1"]="Sprint ladder — 14 sprints to pilot"; ws["A1"].font=Font(name="Calibri",size=14,bold=True,color=NAVY)
ws["A2"]="Cumulative weeks is the true elapsed position. Work completes at %.2f weeks; W14 is launch."%(lean/5)
ws["A2"].font=SM
hdr(ws,4,["Sprint","Week","Name","Goal","Items","Dev-days","Cum. days","Cum. weeks","Slack","Gate","Exit criterion"])
r=5
for d in LAD:
    vals=[d["sid"],d["wk"],d["name"],d["goal"],d["n"],d["days"],d["cum"],round(d["cw"],2),round(d["delta"],2),d["gate"],d["exit"]]
    for i,v in enumerate(vals,start=1):
        c=ws.cell(row=r,column=i,value=v); c.font=B if i==1 else N; c.alignment=WRAP; c.border=BD
        if isinstance(v,float): c.number_format='0.00'
    if d["delta"]<0: ws.cell(row=r,column=9).fill=PatternFill("solid",fgColor=RED)
    if d["gate"]!="—":
        ws.cell(row=r,column=10).fill=PatternFill("solid",fgColor=AMBER); ws.cell(row=r,column=10).font=B
    ws.row_dimensions[r].height=44; r+=1
ws.cell(row=r,column=3,value="LEAN PILOT PATH").font=B
ws.cell(row=r,column=5,value=n_lean).font=B
c=ws.cell(row=r,column=6,value=lean); c.font=B; c.number_format='0.00'
ws.cell(row=r,column=8,value=round(lean/5,2)).font=B
ws.cell(row=r,column=9,value=round(70-lean,2)).font=B
for cc in range(1,12):
    ws.cell(row=r,column=cc).fill=PatternFill("solid",fgColor=GREEN); ws.cell(row=r,column=cc).border=BD
ws.cell(row=r+2,column=3,value="Pilot live").font=B
ws.cell(row=r+2,column=4,value="Monday W14").font=N
ws.cell(row=r+3,column=3,value="Pilot readout").font=B
ws.cell(row=r+3,column=4,value="W17 (G4)").font=N
ws.cell(row=r+4,column=3,value="WhatsApp live").font=B
ws.cell(row=r+4,column=4,value="W18 (G5)").font=N
ws.freeze_panes="A5"

# Master backlog
ws=wb.create_sheet("03 · Master backlog"); ws.sheet_properties.tabColor="A9D08E"
for i,w in enumerate([10,8,9,14,32,46,7,6,13,52,14],start=1): ws.column_dimensions[get_column_letter(i)].width=w
ws["A1"]="Master backlog — every item"; ws["A1"].font=Font(name="Calibri",size=14,bold=True,color=NAVY)
ws["A2"]="Filter by Sprint or Track. Acceptance criteria are testable — if you cannot test it, it is not done."; ws["A2"].font=SM
hdr(ws,4,["ID","Sprint","Track","Epic","Item","Description","Days","Pri","Depends on","Acceptance criteria","Status"])
r=5
def write_block(its, sprint, fill=None):
    global r
    for x in its:
        iid,tr,ep,item,desc,days,pri,dep,acc = x
        vals=[iid,sprint,tr,ep,item,desc,days,pri,dep,acc,"☐ Not started"]
        for i,v in enumerate(vals,start=1):
            c=ws.cell(row=r,column=i,value=v); c.font=B if i==1 else N; c.alignment=WRAP; c.border=BD
            if i==7: c.number_format='0.00'
            if i==3:
                c.fill=PatternFill("solid",fgColor={"Eng":"DDEBF7","Founder":"FCE4D6","Both":"E2EFDA"}[v])
                c.alignment=Alignment(horizontal="center")
            if fill and i!=3: c.fill=PatternFill("solid",fgColor=fill)
        ws.row_dimensions[r].height=40; r+=1
for d in LAD: write_block(d["its"], d["sid"])
write_block(WA,"WA",PURPLE)
write_block(DEFERRED,"DEF","EFEFEF")
dv=DataValidation(type="list",formula1='"☐ Not started,◐ In progress,☑ Done,✖ Blocked"',allow_blank=True)
ws.add_data_validation(dv); dv.add(f"K5:K{r-1}")
ws.freeze_panes="C5"

# Capacity
ws=wb.create_sheet("04 · Capacity"); ws.sheet_properties.tabColor="FFD966"
for i,w in enumerate([8,7,26,11,12,11,14,46],start=1): ws.column_dimensions[get_column_letter(i)].width=w
ws["A1"]="Capacity check"; ws["A1"].font=Font(name="Calibri",size=14,bold=True,color=NAVY)
ws["A2"]="One person, 5 productive days per week. Above 5.0 spills forward into W13's carry-forward room."; ws["A2"].font=SM
hdr(ws,4,["Sprint","Week","Name","Eng days","Founder days","Total","Status","Note"])
r=5
for d in LAD:
    eng=sum(i[5] for i in d["its"] if i[1] in ("Eng","Both"))
    fnd=sum(i[5] for i in d["its"] if i[1]=="Founder")
    tot=eng+fnd
    st="Fits" if tot<=5.0 else "Over by %.2f"%(tot-5.0)
    note=""
    if d["sid"]=="W00": note="8.0 days in a 5-day week. Fits only with founder and engineer in parallel; solo it runs to mid-W1."
    elif d["sid"]=="S13": note="Launch work plus ~3 days of carry-forward room."
    elif tot>5.0: note="Spills into the following week."
    vals=[d["sid"],d["wk"],d["name"],eng,fnd,tot,st,note]
    for i,v in enumerate(vals,start=1):
        c=ws.cell(row=r,column=i,value=v); c.font=B if i==1 else N; c.alignment=WRAP; c.border=BD
        if isinstance(v,float): c.number_format='0.00'
    ws.cell(row=r,column=7).fill=PatternFill("solid",fgColor=RED if tot>5.0 else GREEN)
    ws.row_dimensions[r].height=32; r+=1
ws.cell(row=r+1,column=3,value="Total demand").font=B; ws.cell(row=r+1,column=6,value=lean).font=B
ws.cell(row=r+1,column=6).number_format='0.00'
ws.cell(row=r+2,column=3,value="Capacity (14 × 5)").font=N; ws.cell(row=r+2,column=6,value=70).font=N
ws.cell(row=r+3,column=3,value="Unallocated").font=B
c=ws.cell(row=r+3,column=6,value=round(70-lean,2)); c.font=B; c.fill=PatternFill("solid",fgColor=AMBER)
ws.freeze_panes="A5"

# Gates
ws=wb.create_sheet("05 · Gates"); ws.sheet_properties.tabColor="C00000"
for i,w in enumerate([7,26,10,9,64,42],start=1): ws.column_dimensions[get_column_letter(i)].width=w
ws["A1"]="Gates"; ws["A1"].font=Font(name="Calibri",size=14,bold=True,color=NAVY)
hdr(ws,3,["Gate","Name","Sprint","Week","Pass criteria","If it fails"])
G=[("G0","Decisions and approvals","W00","W0","14 ADRs signed · verification submitted · content owner named with dates · fixture seeded","Do not start S01"),
("G1","Content ready","S03","W3","25 approved articles · 40 verified facts · zero unresolved contradictions · golden set v2 frozen","Delay the pilot, not the build"),
("G2","AI quality","S05","W5","False-answer ≤2% · correct-or-escalation ≥95% · recall ≥90% · p95 ≤3.5s","Hard stop. Fix retrieval and content, not prompts"),
("G3","Pilot-ready","S12","W12","Isolation green · restore drilled · 3 staff unaided · outage fallback verified","Restricted launch only"),
("—","Pilot live","S13","W14","Trained · content corrected · GM go/no-go recorded","Postpone a week; do not launch untrained"),
("G4","Pilot readout","—","W17","Containment ≥55% · accuracy ≥95% · ack median ≤10 min · gap age ≤7 days","Do not scale sales"),
("G5","WhatsApp live","WA","W18","Approved · consent tested · 7-day clean shadow run","Stay web-only"),
("G6","Group pilot","—","W19+","2–3 properties · inheritance exercised · group reporting live · questionnaire answered","No PMS-dependent group")]
r=4
for g in G:
    for i,v in enumerate(g,start=1):
        c=ws.cell(row=r,column=i,value=v); c.font=B if i==1 else N; c.alignment=WRAP; c.border=BD
        if i==1: c.fill=PatternFill("solid",fgColor=AMBER)
    ws.row_dimensions[r].height=44; r+=1

# Critical path
ws=wb.create_sheet("06 · Critical path"); ws.sheet_properties.tabColor="8EA9DB"
for i,w in enumerate([6,32,12,62],start=1): ws.column_dimensions[get_column_letter(i)].width=w
ws["A1"]="Critical path"; ws["A1"].font=Font(name="Calibri",size=14,bold=True,color=NAVY)
ws["A2"]="Each step blocks the next. Any slip here moves W14 one-for-one."; ws["A2"].font=SM
hdr(ws,4,["#","Step","Sprint","Why it blocks"])
CP=[("Hotel supplies approved content","W00–S03","Retrieval cannot be tuned against content that has not arrived. Engineering cannot absorb this."),
("Schema and RLS","S01","Every later table, policy and test depends on the tenancy model."),
("Article versioning","S03","Citations and embeddings both hang off immutable versions."),
("Chunking and embeddings","S04","Retrieval, the gate and the whole guardrail chain sit downstream."),
("Retrieval quality","S04","Below 90% recall the gate fires constantly and containment collapses."),
("AI contract and guardrails","S05","Guest chat has nothing to send until the contract exists."),
("Eval harness","S06","Without it G2 is an opinion."),
("Guest chat","S06","The pilot surface."),
("Inbox","S08","Requests with nobody to receive them are broken promises."),
("Notifications","S09","The reason a request gets seen at all."),
("Restore drill and runbook","S12","G3 cannot pass without it, and it cannot be done after an incident.")]
r=5
for i,(s,sp,w) in enumerate(CP,1):
    for j,v in enumerate([i,s,sp,w],start=1):
        c=ws.cell(row=r,column=j,value=v); c.font=B if j==1 else N; c.alignment=WRAP; c.border=BD
    ws.row_dimensions[r].height=32; r+=1
ws.cell(row=r+1,column=2,value="Not on the critical path").font=B
ws.cell(row=r+1,column=3,value="Analytics (S10), reliability (S11), accessibility and load (S12) — each can slip a week without moving W14.").font=N
ws.merge_cells(start_row=r+1,start_column=3,end_row=r+1,end_column=4)

# WhatsApp
ws=wb.create_sheet("07 · WhatsApp"); ws.sheet_properties.tabColor="D9D2E9"
for i,w in enumerate([10,8,20,48,7,44],start=1): ws.column_dimensions[get_column_letter(i)].width=w
ws["A1"]="WhatsApp track"; ws["A1"].font=Font(name="Calibri",size=14,bold=True,color=NAVY)
ws["A2"]="7.75 days. Approvals start W0 (calendar time); build lands W14–16 (developer time)."; ws["A2"].font=SM
hdr(ws,4,["ID","When","Epic","Item","Days","Acceptance"])
WHEN={"WA-01":"W0","WA-06":"W4","WA-07":"W5","WA-02":"W14","WA-03":"W14","WA-04":"W15","WA-05":"W15","WA-08":"W16"}
r=5
for x in WA:
    vals=[x[0],WHEN[x[0]],x[2],x[3],x[5],x[8]]
    for i,v in enumerate(vals,start=1):
        c=ws.cell(row=r,column=i,value=v); c.font=B if i==1 else N; c.alignment=WRAP; c.border=BD
        if i==5: c.number_format='0.00'
    ws.row_dimensions[r].height=38; r+=1

# Deferred
ws=wb.create_sheet("08 · Deferred"); ws.sheet_properties.tabColor=GREY
for i,w in enumerate([10,15,32,48,7,44],start=1): ws.column_dimensions[get_column_letter(i)].width=w
ws["A1"]="Deferred to MVP-1.5"; ws["A1"].font=Font(name="Calibri",size=14,bold=True,color=NAVY)
ws["A2"]="Listed so they are not quietly re-added."; ws["A2"].font=SM
hdr(ws,4,["ID","Epic","Item","Description","Days","Comes back when"])
r=5
for x in DEFERRED:
    for i,v in enumerate([x[0],x[2],x[3],x[4],x[5],x[8]],start=1):
        c=ws.cell(row=r,column=i,value=v); c.font=B if i==1 else N; c.alignment=WRAP; c.border=BD
        if i==5: c.number_format='0.00'
    ws.row_dimensions[r].height=34; r+=1
for extra in [("—","Knowledge","Automated PDF and website extraction","The rabbit hole the first five assisted onboardings exist to avoid.",0,"After five hotels show what actually arrives"),
("—","Platform","Self-serve onboarding wizard","Settings form plus test chat covers 80% of the value at 20% of the cost.",0,"From hotel four"),
("—","Group","Brand-to-property inheritance UI","Schema supports it from S01; UI not needed until a group signs.",0,"First group pilot"),
("—","Inbox","Guest CSAT thumbs","The weekly accuracy audit answers the same question earlier.",0,"MVP-1.5")]:
    for i,v in enumerate(extra,start=1):
        c=ws.cell(row=r,column=i,value=v); c.font=N; c.alignment=WRAP; c.border=BD
        if i==5: c.number_format='0.00'
    ws.row_dimensions[r].height=34; r+=1

wb.save("07-master-backlog.xlsx")
print(f"saved · {n_lean+len(WA)+len(DEFERRED)} items · lean {lean:.2f} · total {total:.2f}")
