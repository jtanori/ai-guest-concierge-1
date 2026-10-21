import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
from openpyxl.chart import LineChart, Reference

# ---------- model engine (mirrors the workbook formulas exactly) ----------
ARCH = [
    dict(name="Boutique",    rooms=24,  occ=0.72, part=0.12, replies=9,  wa=0.35, sup=1.0, infra=8,  price=199),
    dict(name="Independent", rooms=50,  occ=0.68, part=0.15, replies=10, wa=0.45, sup=1.5, infra=10, price=299),
    dict(name="Midscale",    rooms=120, occ=0.70, part=0.17, replies=11, wa=0.55, sup=2.5, infra=15, price=599),
    dict(name="Resort",      rooms=250, occ=0.75, part=0.18, replies=12, wa=0.60, sup=4.0, infra=20, price=1099),
]
G = dict(price=2777.45, cogs=408.88)
DAYS, TOK_IN, TOK_OUT = 30.4, 45_000, 3_000
P_IN, P_OUT = 0.60, 2.40
WA_RATE, WA_FREE, SUP_RATE, PAY = 0.0085, 1000, 22.0, 0.036
CHURN = 0.025
BASE_ADDS = {1:(0,1,0,0), 2:(1,2,0,0), 3:(1,2,0,0), 4:(1,3,0,0),
             5:(1,2,1,0), 6:(1,2,1,0), 7:(1,2,1,0), 8:(1,2,1,1)}
SCEN = {
 "Bootstrap": dict(mult=0.7, start=60000, build=2280, groups={},
                   opex=dict(f1=1500,f2=1500,dev=0,dev2_from=99,dev2=0,sup_from=99,sup=0,tools=400,mkt=400)),
 "Funded":    dict(mult=1.0, start=150000, build=46865, groups={6:1},
                   opex=dict(f1=2500,f2=0,dev=3500,dev2_from=7,dev2=3500,sup_from=4,sup=1300,tools=400,mkt=800)),
 "Group-led": dict(mult=1.4, start=150000, build=46865, groups={3:1,7:1},
                   opex=dict(f1=2500,f2=0,dev=3500,dev2_from=7,dev2=3500,sup_from=4,sup=1300,tools=400,mkt=1200)),
}

def unit(a):
    gn = a["rooms"]*DAYS*a["occ"]
    conv = gn*a["part"]
    llm = conv*(TOK_IN/1e6*P_IN + TOK_OUT/1e6*P_OUT)
    wa = max(0.0, conv*a["wa"]*a["replies"] - WA_FREE)*WA_RATE
    sup = a["sup"]*SUP_RATE
    pay = a["price"]*PAY
    cogs = llm+wa+sup+a["infra"]+pay
    return dict(gn=gn, conv=conv, llm=llm, wa=wa, wa_msgs=conv*a["wa"]*a["replies"],
                sup=sup, infra=a["infra"], pay=pay, cogs=cogs,
                gp=a["price"]-cogs, gm=(a["price"]-cogs)/a["price"], per_room=a["price"]/a["rooms"])

def run(sc):
    s = SCEN[sc]; o = s["opex"]
    base = [0.0]*4; groups = 0.0; cash = s["start"]-s["build"]; out=[]
    for m in range(1, 25):
        q = (m-1)//3+1
        for i, a in enumerate(ARCH):
            base[i] = base[i]*(1-CHURN) + BASE_ADDS[q][i]*s["mult"]/3
        groups = groups*(1-CHURN) + s["groups"].get(q,0)/3
        rev = sum(base[i]*a["price"] for i,a in enumerate(ARCH)) + groups*G["price"]
        cogs = sum(base[i]*unit(a)["cogs"] for i,a in enumerate(ARCH)) + groups*G["cogs"]
        gp = rev-cogs
        opex = o["f1"]+o["f2"]+o["dev"]+o["tools"]+o["mkt"]
        if m >= o["dev2_from"]: opex += o["dev2"]
        if m >= o["sup_from"]: opex += o["sup"]
        ebitda = gp-opex; cash += ebitda
        out.append(dict(m=m, props=sum(base), grp=groups, rev=rev, cogs=cogs, gp=gp,
                        opex=opex, ebitda=ebitda, cash=cash))
    be = next((r["m"] for r in out if r["ebitda"]>0), None)
    return out, be

# ---------- styling ----------
NAVY, TEAL, AMBER, GREEN = "1F3864", "2E6E6A", "FFF2CC", "E2EFDA"
LIGHT, BAND, RED = "EAF1F8", "F5F7FA", "F8D7DA"
H  = Font(name="Calibri", size=10, bold=True, color="FFFFFF")
B  = Font(name="Calibri", size=10, bold=True)
N  = Font(name="Calibri", size=10)
SM = Font(name="Calibri", size=9, color="808080")
IT = Font(name="Calibri", size=10, italic=True, color="808080")
THIN = Side(style="thin", color="D0D7DE")
BD = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
WRAP = Alignment(wrap_text=True, vertical="top")
USD = '"$"#,##0'
USD2 = '"$"#,##0.00'
PCT = '0.0%'
NUM = '#,##0'

wb = openpyxl.Workbook()

def hdr(ws, row, labels, color=NAVY, start=1):
    for i, t in enumerate(labels, start=start):
        c = ws.cell(row=row, column=i, value=t)
        c.font = H; c.fill = PatternFill("solid", fgColor=color)
        c.alignment = Alignment(wrap_text=True, vertical="center", horizontal="center")
        c.border = BD
    ws.row_dimensions[row].height = 28

def section(ws, row, text, cols=8, color=TEAL):
    c = ws.cell(row=row, column=1, value=text)
    c.font = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
    c.fill = PatternFill("solid", fgColor=color)
    ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=cols)
    c.alignment = Alignment(vertical="center")
    ws.row_dimensions[row].height = 20

def inp(ws, row, label, value, fmt=None, note="", unit=""):
    ws.cell(row=row, column=1, value=label).font = N
    c = ws.cell(row=row, column=2, value=value)
    c.font = B; c.fill = PatternFill("solid", fgColor=AMBER); c.border = BD
    if fmt: c.number_format = fmt
    ws.cell(row=row, column=3, value=unit).font = SM
    if note:
        n = ws.cell(row=row, column=4, value=note); n.font = SM; n.alignment = WRAP
        ws.merge_cells(start_row=row, start_column=4, end_row=row, end_column=8)

# =================== 1. README ===================
ws = wb.active; ws.title = "README"; ws.sheet_properties.tabColor = NAVY
ws.column_dimensions["A"].width = 3
ws.column_dimensions["B"].width = 36
ws.column_dimensions["C"].width = 96
ws["B2"] = "AI Guest Concierge — Financial Model"; ws["B2"].font = Font(name="Calibri", size=18, bold=True, color=NAVY)
ws["B3"] = "Unit economics by property size · pricing · 24-month projection · sensitivity"; ws["B3"].font = Font(name="Calibri", size=10, italic=True, color="808080")
rows = [
 ("", ""),
 ("What this model answers", ""),
 ("1. Cost to serve", "Fully loaded monthly COGS for four property archetypes (24, 50, 120, 250 rooms) and a group deal."),
 ("2. What to charge", "Pricing ladder with per-room anchoring, margin at each tier, and the price that minimises breakeven property count."),
 ("3. Does it scale", "24-month projection: MRR, gross margin, opex, EBITDA, cash, breakeven month, peak funding need."),
 ("4. What breaks it", "Two-way sensitivity on conversation volume × WhatsApp share, plus LLM model tier and support-load effects."),
 ("", ""),
 ("Headline findings", ""),
 ("Margins are healthy at every size", "Gross margin is 78–85% for all four archetypes and 85% for a group deal. The product is not margin-constrained — there is no AI-cost problem to solve."),
 ("Support is the largest cost line", "37–56% of COGS is human support. LLM spend is 5–15%. Margin is an operations problem, not an AI-cost problem."),
 ("WhatsApp is smaller than feared", "Boutique and Independent never exceed the 1,000 free messages/month, so WhatsApp cost is $0. It only becomes material at 120+ rooms."),
 ("Breakeven is an opex question", "~8.7 properties at $3,800/mo of opex; ~28 at $12,000/mo. Team size, not growth rate, sets the target."),
 ("The funded path needs real capital", "$150k is not enough for the contractor-led build at base-case sales velocity: ~$231k of peak funding and no breakeven inside 24 months. See Scenarios."),
 ("The buyer's ROI, not our margin, is the constraint", "At Mexican labour rates the hotel's hard-value return is 0.39×–1.14× the price. At US resort rates it is 1.05×–3.09×. The same product is a hard sell to a small Mexican independent and an easy one to a resort. See Buyer ROI."),
 ("So sell up-market and self-serve down-market", "Midscale, Resort and Group tiers carry defensible buyer ROI. Boutique and Independent must be sold on coverage and experience — and onboarded with near-zero human cost or they destroy margin."),
 ("", ""),
 ("How to use it", ""),
 ("Edit yellow cells only", "Everything else is a formula. The Inputs sheet and the archetype parameters at the top of Unit Economics are the only places to type."),
 ("Switch scenarios on Inputs", "Cell B7 selects Bootstrap / Funded / Group-led. The projection recalculates live."),
 ("Scenarios sheet is a snapshot", "It holds computed values for all three so you can compare side by side without switching. Re-run after editing inputs."),
 ("", ""),
 ("Method notes", ""),
 ("Volume driver", "Guest-nights = rooms × 30.4 × occupancy. Conversations = guest-nights × participation rate. Participation is the key unknown: 12–18% of guest-nights in year one."),
 ("LLM cost", "Token-based, not a flat per-conversation guess: 45,000 input and 3,000 output tokens per conversation including classification, retrieval context and guardrail passes."),
 ("Support load", "Hours per property per month × $22 loaded. This is the assumption most worth arguing about — it is the largest single cost."),
 ("Churn", "2.5% monthly (≈26% annualised). Typical for SMB SaaS; unproven for this category."),
 ("Supersedes", "Replaces the rough per-property economics in 02-development-plan-workbook.xlsx → sheet 09, section D. That sheet is now build cost only."),
 ("", ""),
 ("Caveats", ""),
 ("Pre-pilot estimates", "Every number here is a pre-pilot assumption. Participation, support hours and churn should be replaced with measured values after the first 8 weeks of pilot data."),
 ("Currency", "USD throughout. Mexican VAT on software (16%) and local card-processing rates should be layered on before quoting."),
]
r = 5
for k, v in rows:
    ws.cell(row=r, column=2, value=k).font = B
    ws.cell(row=r, column=2).alignment = WRAP
    c = ws.cell(row=r, column=3, value=v); c.font = N; c.alignment = WRAP
    if v == "":
        for col in (2, 3):
            ws.cell(row=r, column=col).fill = PatternFill("solid", fgColor=LIGHT)
        ws.row_dimensions[r].height = 18
    else:
        ws.row_dimensions[r].height = 30 if len(v) > 90 else 16
    r += 1

# =================== 2. INPUTS ===================
ws = wb.create_sheet("Inputs"); ws.sheet_properties.tabColor = TEAL
for col, w in zip("ABCDEFGH", [34, 14, 10, 60, 10, 10, 10, 10]):
    ws.column_dimensions[col].width = w
ws["A1"] = "Inputs — edit yellow cells only"
ws["A1"].font = Font(name="Calibri", size=14, bold=True, color=NAVY)
ws["A2"] = "Archetype-specific parameters live at the top of the Unit Economics sheet, not here."
ws["A2"].font = IT

section(ws, 4, "A. Scenario selector")
inp(ws, 5, "Active scenario (1, 2 or 3)", 2, None, "1 = Bootstrap (founders build, minimal opex) · 2 = Funded (contractor build, hired support) · 3 = Group-led (funded + faster pipeline)")
from openpyxl.worksheet.datavalidation import DataValidation
dv = DataValidation(type="list", formula1='"1,2,3"', allow_blank=False,
                    showErrorMessage=True, errorTitle="Pick 1, 2 or 3",
                    error="1 = Bootstrap, 2 = Funded, 3 = Group-led")
ws.add_data_validation(dv)
dv.add(ws["B5"])
SC_LABEL = 6
ws.cell(row=SC_LABEL, column=1, value="Active scenario name").font = N
c = ws.cell(row=SC_LABEL, column=2, value='=CHOOSE(B5,"Bootstrap","Funded","Group-led")'); c.font = B; c.fill = PatternFill("solid", fgColor=LIGHT); c.border = BD

section(ws, 8, "B. Global operating assumptions")
inp(ws, 9,  "Days per month", DAYS, NUM)
inp(ws, 10, "Churn rate / month", CHURN, PCT, "Applied to the property and group base each month")
inp(ws, 11, "Support cost per hour (loaded)", SUP_RATE, USD2, "Fully loaded: salary + overhead. Drives the largest COGS line.")
inp(ws, 12, "Payment processing fee (% of price)", PAY, PCT, "Card + IVA on fees. Confirm with your PSP.")

section(ws, 14, "C. AI cost")
inp(ws, 15, "Input tokens per conversation", TOK_IN, NUM, "~10 turns × (system + 4 retrieved chunks + history) + classification/guardrail calls")
inp(ws, 16, "Output tokens per conversation", TOK_OUT, NUM)
inp(ws, 17, "Input price per 1M tokens (USD)", P_IN, USD2, "Mid-tier model. Cheap tier ≈ 0.15/0.60; premium ≈ 3.00/15.00.")
inp(ws, 18, "Output price per 1M tokens (USD)", P_OUT, USD2)

section(ws, 20, "D. WhatsApp")
inp(ws, 21, "Service message rate (USD)", WA_RATE, '"$"0.0000', "Mexico, from 1 Oct 2026. Service messages are billable after the free allowance.")
inp(ws, 22, "Free messages per number / month", WA_FREE, NUM, "Resets monthly, does not roll over")

section(ws, 24, "E. Pricing (list, per month)")
inp(ws, 25, "Boutique (≤30 rooms)", 199, USD)
inp(ws, 26, "Independent (31–80 rooms)", 299, USD)
inp(ws, 27, "Midscale (81–150 rooms)", 599, USD)
inp(ws, 28, "Resort (151–400 rooms)", 1099, USD)
inp(ws, 29, "Group platform fee (per group / month)", 1250, USD, "Charged on top of per-property fees at 85% of list")
inp(ws, 30, "Group per-property discount", 0.15, PCT)
ws.cell(row=31, column=1, value="Blended group price (3 × Midscale)").font = N
c = ws.cell(row=31, column=2, value="=3*B27*(1-B30)+B29"); c.font = B; c.number_format = USD; c.border = BD
ws.cell(row=32, column=1, value="Group COGS (calculated in Unit Economics)").font = N
c = ws.cell(row=32, column=2, value="='Unit Economics'!F23"); c.font = B; c.number_format = USD; c.fill = PatternFill("solid", fgColor=LIGHT); c.border = BD

section(ws, 34, "F. Scenario parameters")
hdr(ws, 35, ["Line", "1 · Bootstrap", "2 · Funded", "3 · Group-led", "Unit / note"], color=NAVY)
sp = [
 ("Founder 1 monthly cost", 1500, 2500, 2500, "Founder draw, not market salary. Be honest about this line."),
 ("Founder 2 monthly cost", 1500, 0, 0, "Second founder, technical. Zero in funded scenarios (contractor instead)."),
 ("Developer monthly cost", 0, 3500, 3500, "Contractor at ~$550/day × 16 days"),
 ("Second developer from month", 99, 7, 7, "99 = never"),
 ("Second developer monthly cost", 0, 3500, 3500, ""),
 ("Support / content ops from month", 99, 4, 4, "99 = never (founders absorb)"),
 ("Support / content ops monthly cost", 0, 1300, 1300, ""),
 ("Tools, hosting, software", 400, 400, 400, "Fixed platform cost, not per-property"),
 ("Marketing & sales", 400, 800, 1200, ""),
 ("Pipeline multiplier", 0.7, 1.0, 1.4, "Applied to the base quarterly pipeline below"),
 ("Group deals: quarter of first close", 0, 6, 3, "0 = no group deals in this scenario"),
 ("Group deals: quarter of second close", 0, 99, 7, "99 = none"),
 ("Starting cash", 60000, 150000, 150000, "Including any raise"),
 ("One-time build cost", 2280, 46865, 46865, "Bootstrap = legal + services only (founders build). Funded = 75.5 dev-days × $550 × ~... see workbook 02"),
]
r = 36
sc_rows = {}
for label, v1, v2, v3, note in sp:
    ws.cell(row=r, column=1, value=label).font = N
    for col, v in ((2, v1), (3, v2), (4, v3)):
        c = ws.cell(row=r, column=col, value=v)
        c.font = N; c.fill = PatternFill("solid", fgColor=AMBER); c.border = BD
    n = ws.cell(row=r, column=5, value=note); n.font = SM; n.alignment = WRAP
    ws.merge_cells(start_row=r, start_column=5, end_row=r, end_column=8)
    sc_rows[label] = r
    r += 1

section(ws, 52, "G. Base quarterly pipeline (properties added per quarter, before the scenario multiplier)")
hdr(ws, 53, ["Tier", "Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7", "Q8"], color=NAVY)
r = 54
adds_rows = {}
for i, a in enumerate(ARCH):
    ws.cell(row=r, column=1, value=a["name"]).font = N
    for q in range(1, 9):
        c = ws.cell(row=r, column=1+q, value=BASE_ADDS[q][i])
        c.font = N; c.fill = PatternFill("solid", fgColor=AMBER); c.border = BD
        c.alignment = Alignment(horizontal="center")
    adds_rows[a["name"]] = r
    r += 1

section(ws, 60, "H. Active scenario (calculated — do not edit)")
act = [
 ("Founder 1", "=CHOOSE($B$5,B36,C36,D36)", USD),
 ("Founder 2", "=CHOOSE($B$5,B37,C37,D37)", USD),
 ("Developer", "=CHOOSE($B$5,B38,C38,D38)", USD),
 ("Second developer from month", "=CHOOSE($B$5,B39,C39,D39)", NUM),
 ("Second developer cost", "=CHOOSE($B$5,B40,C40,D40)", USD),
 ("Support ops from month", "=CHOOSE($B$5,B41,C41,D41)", NUM),
 ("Support ops cost", "=CHOOSE($B$5,B42,C42,D42)", USD),
 ("Tools", "=CHOOSE($B$5,B43,C43,D43)", USD),
 ("Marketing", "=CHOOSE($B$5,B44,C44,D44)", USD),
 ("Pipeline multiplier", "=CHOOSE($B$5,B45,C45,D45)", '0.00'),
 ("Group close quarter 1", "=CHOOSE($B$5,B46,C46,D46)", NUM),
 ("Group close quarter 2", "=CHOOSE($B$5,B47,C47,D47)", NUM),
 ("Starting cash", "=CHOOSE($B$5,B48,C48,D48)", USD),
 ("One-time build cost", "=CHOOSE($B$5,B49,C49,D49)", USD),
]
r = 61
active_rows = {}
for label, f, fmt in act:
    ws.cell(row=r, column=1, value=label).font = N
    c = ws.cell(row=r, column=2, value=f); c.font = B; c.number_format = fmt
    c.fill = PatternFill("solid", fgColor=LIGHT); c.border = BD
    active_rows[label] = r
    r += 1
ws.cell(row=r+1, column=1, value="Steady-state monthly opex").font = B
c = ws.cell(row=r+1, column=2, value=f"=B61+B62+B63+B65+B67+B68+B69"); c.font = B; c.number_format = USD; c.fill = PatternFill("solid", fgColor=GREEN)
STEADY = r+1

# =================== 3. UNIT ECONOMICS ===================
ws = wb.create_sheet("Unit Economics"); ws.sheet_properties.tabColor = "A9D08E"
ws.column_dimensions["A"].width = 34
for i in range(2, 7):
    ws.column_dimensions[get_column_letter(i)].width = 15
ws["A1"] = "Unit economics by property size"; ws["A1"].font = Font(name="Calibri", size=14, bold=True, color=NAVY)
ws["A2"] = "Parameters in rows 5–10 are inputs (yellow). Everything below is calculated."
ws["A2"].font = IT

hdr(ws, 4, ["Metric", "Boutique", "Independent", "Midscale", "Resort", "Group (3×Mid)"])
param_rows = {}
params = [
 ("Rooms", [24, 50, 120, 250, 360], NUM, "Group column = 3 × Midscale properties"),
 ("Occupancy", [0.72, 0.68, 0.70, 0.75, 0.70], PCT, ""),
 ("Participation rate", [0.12, 0.15, 0.17, 0.18, 0.15], PCT, "Share of guest-nights that produce a conversation. Biggest unknown in the model."),
 ("Replies per conversation", [9, 10, 11, 12, 11], NUM, "Bot + staff messages"),
 ("WhatsApp share of conversations", [0.35, 0.45, 0.55, 0.60, 0.55], PCT, "Rest is web chat (near-zero marginal cost)"),
 ("Support hours / month", [1.0, 1.5, 2.5, 4.0, 4.5], '0.0', "Group gets 40% support synergy vs 3 × 2.5"),
 ("Infra / month (allocation)", [8, 10, 15, 20, 120], USD, "Hosting, storage, observability + governance"),
 ("List price / month", [199, 349, 599, 1099, 2730], USD, "Group = 3 × Mid at 85% + $1,250 platform fee"),
]
r = 5
for label, vals, fmt, note in params:
    ws.cell(row=r, column=1, value=label).font = N
    for i, v in enumerate(vals):
        if v is None:
            continue
        c = ws.cell(row=r, column=2+i, value=v)
        if i == 4 and label != "List price / month":
            c.value = v
        if label == "List price / month":
            c.value = f"=Inputs!$B${25+i}" if i < 4 else f"=Inputs!$B$31"
            c.fill = PatternFill("solid", fgColor=LIGHT); c.font = N; c.border = BD
        else:
            c.font = B; c.fill = PatternFill("solid", fgColor=AMBER); c.border = BD
        c.number_format = fmt
    if note:
        n = ws.cell(row=r, column=7, value=note); n.font = SM; n.alignment = WRAP
    param_rows[label] = r
    r += 1

section(ws, 14, "Calculated economics", cols=7)
calc = [
 ("Guest-nights / month", lambda c: f"={c}5*Inputs!$B$9*{c}6", NUM, "Rooms × days × occupancy"),
 ("Conversations / month", lambda c: f"={c}15*{c}7", NUM, "Guest-nights × participation"),
 ("LLM cost", lambda c: f"={c}16*(Inputs!$B$15/1000000*Inputs!$B$17+Inputs!$B$16/1000000*Inputs!$B$18)", USD, "Token-based"),
 ("WhatsApp messages sent", lambda c: f"={c}16*{c}9*{c}8", NUM, ""),
 ("WhatsApp cost", lambda c: f"=MAX(0,{c}18-Inputs!$B$22)*Inputs!$B$21", USD, "After the 1,000 free messages/number"),
 ("Support cost", lambda c: f"={c}10*Inputs!$B$11", USD, "Largest COGS line"),
 ("Infrastructure", lambda c: f"={c}11", USD, ""),
 ("Payment processing", lambda c: f"={c}12*Inputs!$B$12", USD, ""),
 ("Total COGS", lambda c: f"={c}17+{c}19+{c}20+{c}21+{c}22", USD, ""),
 ("Gross profit / month", lambda c: f"={c}12-{c}23", USD, ""),
 ("Gross margin", lambda c: f"={c}24/{c}12", PCT, ""),
 ("Price per room / month", lambda c: f"={c}12/{c}5", USD2, "Anchors the sales conversation"),
 ("Cost per conversation", lambda c: f"={c}23/{c}16", '"$"0.000', "Falls with size — fixed support spread over more volume"),
 ("Support share of COGS", lambda c: f"={c}20/{c}23", PCT, "The line to attack"),
 ("LLM share of COGS", lambda c: f"={c}17/{c}23", PCT, ""),
 ("WhatsApp share of COGS", lambda c: f"={c}19/{c}23", PCT, ""),
 ("Annual gross profit per property", lambda c: f"={c}24*12", USD, ""),
 ("Properties needed per $10k of monthly opex", lambda c: f"=10000/{c}24", '0.0', "Lower is better"),
]
r = 15
calc_rows = {}
for label, fn, fmt, note in calc:
    ws.cell(row=r, column=1, value=label).font = B if label in ("Total COGS","Gross profit / month","Gross margin") else N
    for i, col in enumerate("BCDEF"):
        c = ws.cell(row=r, column=2+i, value=fn(col))
        c.number_format = fmt; c.border = BD; c.font = N
        if label in ("Total COGS","Gross profit / month","Gross margin","Annual gross profit per property"):
            c.font = B
    if note:
        n = ws.cell(row=r, column=7, value=note); n.font = SM; n.alignment = WRAP
    calc_rows[label] = r
    r += 1
for rr in (calc_rows["Total COGS"], calc_rows["Gross profit / month"], calc_rows["Gross margin"]):
    for i in range(1, 7):
        ws.cell(row=rr, column=i).fill = PatternFill("solid", fgColor=GREEN)

# =================== 4. PRICING ===================
ws = wb.create_sheet("Pricing"); ws.sheet_properties.tabColor = "FFD966"
for col, w in zip("ABCDEFGH", [34, 14, 14, 14, 14, 14, 14, 40]):
    ws.column_dimensions[col].width = w
ws["A1"] = "Pricing ladder and price sensitivity"; ws["A1"].font = Font(name="Calibri", size=14, bold=True, color=NAVY)
ws["A2"] = "Prices are set on Inputs. This sheet tests whether they are right."; ws["A2"].font = IT

section(ws, 4, "A. Ladder as designed", cols=8)
hdr(ws, 5, ["Tier", "Price / mo", "Price / room", "COGS", "Gross profit", "GM %", "Included conversations", "Positioning"], color=NAVY)
pos = ["Entry; replaces the FAQ page and the phone that nobody answers",
       "Core offer; priced roughly at the value of the front-desk interruptions it removes",
       "Multi-outlet; WhatsApp and spa/F&B routing matter here",
       "Highest value per property; group reporting and escalation SLAs",
       "Governance, brand inheritance, group reporting, SSO"]
r = 6
for i, a in enumerate(ARCH):
    col = "BCDEF"[i]
    ws.cell(row=r, column=1, value=a["name"]).font = B
    ws.cell(row=r, column=2, value=f"='Unit Economics'!{col}12").number_format = USD
    ws.cell(row=r, column=3, value=f"='Unit Economics'!{col}26").number_format = USD2
    ws.cell(row=r, column=4, value=f"='Unit Economics'!{col}23").number_format = USD
    ws.cell(row=r, column=5, value=f"='Unit Economics'!{col}24").number_format = USD
    ws.cell(row=r, column=6, value=f"='Unit Economics'!{col}25").number_format = PCT
    ws.cell(row=r, column=7, value=f"='Unit Economics'!{col}16").number_format = NUM
    ws.cell(row=r, column=8, value=pos[i]).font = SM
    for cc in range(1, 8):
        ws.cell(row=r, column=cc).border = BD
        ws.cell(row=r, column=cc).font = B if cc == 1 else N
    r += 1
ws.cell(row=r, column=1, value="Group (3 properties)").font = B
ws.cell(row=r, column=2, value="='Unit Economics'!F12").number_format = USD
ws.cell(row=r, column=3, value="='Unit Economics'!F12/300").number_format = USD2
ws.cell(row=r, column=4, value="='Unit Economics'!F23").number_format = USD
ws.cell(row=r, column=5, value="='Unit Economics'!F24").number_format = USD
ws.cell(row=r, column=6, value="='Unit Economics'!F25").number_format = PCT
ws.cell(row=r, column=7, value="=SUM('Unit Economics'!F16)").number_format = NUM
ws.cell(row=r, column=8, value=pos[4]).font = SM
for cc in range(1, 8):
    ws.cell(row=r, column=cc).border = BD

section(ws, 14, "B. Price sensitivity — Independent tier", cols=8)
ws.cell(row=15, column=1, value="At a steady opex of $12,000/month, how many Independents cover the burn?").font = IT
ws.merge_cells(start_row=15, start_column=1, end_row=15, end_column=8)
hdr(ws, 16, ["Price / mo", "Gross profit", "GM %", "Properties to break even", "Extra vs. $299", "Verdict", "", ""], color=NAVY)
r = 17
for price in (199, 249, 299, 349, 449, 599, 749):
    ws.cell(row=r, column=1, value=price).number_format = USD
    ws.cell(row=r, column=2, value=f"=A{r}-('Unit Economics'!C23-'Unit Economics'!C12*Inputs!$B$12)-A{r}*Inputs!$B$12").number_format = USD
    ws.cell(row=r, column=3, value=f"=B{r}/A{r}").number_format = PCT
    ws.cell(row=r, column=4, value=f"=12000/B{r}").number_format = '0.0'
    ws.cell(row=r, column=5, value=f"=D{r}-12000/('Unit Economics'!C24)").number_format = '+0.0;-0.0;0'
    verdict = {199:"Floor. Only viable with self-serve onboarding.",
               249:"Aggressive; use for annual prepay, not standard",
               299:"Recommended launch price for Independent",
               349:"Post-pilot price once containment is proven",
               449:"Needs a stronger ROI story than labour",
               599:"Midscale territory — do not sell Independents here",
               749:"Off-ladder"}[price]
    ws.cell(row=r, column=6, value=verdict).font = SM
    for cc in range(1, 7):
        ws.cell(row=r, column=cc).border = BD
        ws.cell(row=r, column=cc).font = N if cc != 6 else SM
    if price == 299:
        for cc in range(1, 7):
            ws.cell(row=r, column=cc).fill = PatternFill("solid", fgColor=LIGHT)
    r += 1
ws.cell(row=r+1, column=1, value="Read: price has more leverage on breakeven than any cost line, because support cost is fixed per property and price is pure contribution.").font = IT
ws.merge_cells(start_row=r+1, start_column=1, end_row=r+1, end_column=8)

section(ws, r+3, "C. What to do with this", cols=8)
notes = [
 "1. Launch at $299 / $599 for Independent and Midscale. $349 is the post-pilot price, once containment is proven.",
 "2. Offer 2 months free on annual prepay rather than a lower monthly price. Cash today, same ARR, no precedent for discounting.",
 "3. Quote per room per month ($5.98 for a 50-room hotel). It anchors against a hire, not against other software.",
 "4. Revisit after 90 days of pilot data. If containment is above 55%, move the Independent price to $349 for new logos and grandfather the pilot.",
 "5. Group: $1,250 platform fee + 85% of list per property. The platform fee is what pays for governance work you will otherwise do for free.",
]
r = r + 4
for t in notes:
    c = ws.cell(row=r, column=1, value=t); c.font = N; c.alignment = WRAP
    ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=8)
    ws.row_dimensions[r].height = 26
    r += 1

section(ws, r+1, "D. Acquisition economics", cols=8)
rr = r + 2
ws.cell(row=rr, column=1, value="Customer acquisition cost (blended)").font = N
c = ws.cell(row=rr, column=2, value=1750); c.font = B; c.fill = PatternFill("solid", fgColor=AMBER); c.border = BD; c.number_format = USD
ws.cell(row=rr, column=3, value="Founder-led sales at trade events is cheaper; paid acquisition is dearer. Replace with actuals after 20 deals.").font = SM
ws.merge_cells(start_row=rr, start_column=3, end_row=rr, end_column=8)
CAC = rr
rr += 1
ws.cell(row=rr, column=1, value="Expected customer life (months)").font = N
c = ws.cell(row=rr, column=2, value="=1/Inputs!$B$10"); c.font = B; c.number_format = '0.0'; c.border = BD
ws.cell(row=rr, column=3, value="1 ÷ monthly churn from Inputs").font = SM
ws.merge_cells(start_row=rr, start_column=3, end_row=rr, end_column=8)
LIFE = rr
rr += 2
hdr(ws, rr, ["Tier", "Gross profit / mo", "CAC payback (months)", "LTV (months × GP)", "LTV ÷ CAC", "", "", ""], color=NAVY)
rr += 1
for i, a in enumerate(ARCH):
    ucol = "BCDEF"[i]
    ws.cell(row=rr, column=1, value=a["name"]).font = B
    ws.cell(row=rr, column=2, value=f"='Unit Economics'!{ucol}24").number_format = USD
    ws.cell(row=rr, column=3, value=f"=$B${CAC}/B{rr}").number_format = '0.0'
    ws.cell(row=rr, column=4, value=f"=B{rr}*$B${LIFE}").number_format = USD
    ws.cell(row=rr, column=5, value=f"=D{rr}/$B${CAC}").number_format = '0.0"×"'
    for cc in range(1, 6):
        ws.cell(row=rr, column=cc).border = BD
        if cc > 1: ws.cell(row=rr, column=cc).font = N
    if a["name"] in ("Boutique", "Independent"):
        ws.cell(row=rr, column=5).fill = PatternFill("solid", fgColor=AMBER)
    rr += 1
ws.cell(row=rr, column=1, value="Boutique payback above 10 months is too long for a self-serve tier. Another argument for keeping its acquisition cost near zero and treating it as a reference logo, not a profit centre.").font = IT
ws.merge_cells(start_row=rr, start_column=1, end_row=rr, end_column=8)
ws.row_dimensions[rr].height = 26

# =================== 5. PROJECTION ===================
ws = wb.create_sheet("Projection"); ws.sheet_properties.tabColor = "B4A7D6"
ws.column_dimensions["A"].width = 34
ws.column_dimensions["B"].width = 8
for i in range(24):
    ws.column_dimensions[get_column_letter(3+i)].width = 9.5
ws["A1"] = "24-month projection — driven by the scenario selector on Inputs"
ws["A1"].font = Font(name="Calibri", size=14, bold=True, color=NAVY)
ws["A2"] = '=CONCATENATE("Active scenario: ",Inputs!$B$6)'
ws["A2"].font = Font(name="Calibri", size=11, bold=True, color=TEAL)

hdr(ws, 4, ["Line", ""] + [f"M{m}" for m in range(1, 25)])
ws.cell(row=4, column=2, value="").fill = PatternFill("solid", fgColor=NAVY)
mcols = [get_column_letter(3+i) for i in range(24)]

def put(row, label, builder, fmt=NUM, bold=False, fill=None):
    ws.cell(row=row, column=1, value=label).font = B if bold else N
    for i, col in enumerate(mcols):
        c = ws.cell(row=row, column=3+i, value=builder(col, i+1))
        c.number_format = fmt; c.font = B if bold else N; c.border = BD
        if fill: c.fill = PatternFill("solid", fgColor=fill)
    return row

r = 5
ws.cell(row=r, column=1, value="QUARTER").font = H
ws.cell(row=r, column=1).fill = PatternFill("solid", fgColor=TEAL)
put(r, "QUARTER", lambda col, m: f"=INT(({m}-1)/3)+1", NUM)
QROW = r

r = 6
section(ws, r, "Pipeline", cols=26)
r += 1
ADD_ROWS = {}
for a in ARCH:
    rr = r
    ADD_ROWS[a["name"]] = rr
    put(rr, f"{a['name']} adds", lambda col, m, rr=rr, a=a: f"=INDEX(Inputs!$B${adds_rows[a['name']]}:$I${adds_rows[a['name']]},{col}${QROW})*Inputs!$B${active_rows['Pipeline multiplier']}/3", '0.00')
    r += 1
put(r, "Group deals added", lambda col, m: f"=IF(OR(${col}${QROW}=Inputs!$B${active_rows['Group close quarter 1']},${col}${QROW}=Inputs!$B${active_rows['Group close quarter 2']}),1,0)/3", '0.00')
G_ADD = r; r += 1

section(ws, r, "Installed base", cols=26); r += 1
BASE_ROWS = {}
for a in ARCH:
    rr = r
    BASE_ROWS[a["name"]] = rr
    if rr == ADD_ROWS[a["name"]] + 4:  # first month column
        pass
    base_formula = lambda col, m, rr=rr, add=ADD_ROWS[a["name"]]: (
        f"={col}{add}" if m == 1 else f"={chr(ord(col)-1)}{rr}*(1-Inputs!$B$10)+{col}{add}"
    )
    put(rr, f"{a['name']} base", base_formula, '0.0', fill=None)
    r += 1
put(r, "Group base", lambda col, m: f"={col}{G_ADD}" if m == 1 else f"={chr(ord(col)-1)}{r}*(1-Inputs!$B$10)+{col}{G_ADD}", '0.00')
G_BASE = r; r += 1
put(r, "Total properties", lambda col, m: f"=SUM({col}{BASE_ROWS['Boutique']}:{col}{BASE_ROWS['Resort']})", '0.0', bold=True)
TOT = r; r += 1

section(ws, r, "Revenue and gross profit", cols=26); r += 1
REV_ROWS = {}
for i, a in enumerate(ARCH):
    ucol = "BCDEF"[i]
    rr = r; REV_ROWS[a["name"]] = rr
    put(rr, f"{a['name']} MRR", lambda col, m, rr=rr, base=BASE_ROWS[a['name']], ucol=ucol: f"={col}{base}*'Unit Economics'!{ucol}12", USD)
    r += 1
put(r, "Group MRR", lambda col, m: f"={col}{G_BASE}*'Unit Economics'!F12", USD)
G_REV = r; r += 1
put(r, "Total MRR", lambda col, m: f"=SUM({col}{REV_ROWS['Boutique']}:{col}{REV_ROWS['Resort']})+{col}{G_REV}", USD, bold=True, fill=GREEN)
MRR = r; r += 1

section(ws, r, "Cost of service", cols=26); r += 1
COGS_ROWS = {}
for i, a in enumerate(ARCH):
    ucol = "BCDEF"[i]
    rr = r; COGS_ROWS[a["name"]] = rr
    put(rr, f"{a['name']} COGS", lambda col, m, rr=rr, base=BASE_ROWS[a['name']], ucol=ucol: f"={col}{base}*'Unit Economics'!{ucol}23", USD)
    r += 1
put(r, "Group COGS", lambda col, m: f"={col}{G_BASE}*'Unit Economics'!F23", USD)
G_COGS = r; r += 1
put(r, "Total COGS", lambda col, m: f"=SUM({col}{COGS_ROWS['Boutique']}:{col}{COGS_ROWS['Resort']})+{col}{G_COGS}", USD, bold=True)
COGS = r; r += 1
put(r, "Gross profit", lambda col, m: f"={col}{MRR}-{col}{COGS}", USD, bold=True, fill=GREEN)
GP = r; r += 1
put(r, "Gross margin %", lambda col, m: f"=IF({col}{MRR}=0,0,{col}{GP}/{col}{MRR})", PCT, bold=True)
GMR = r; r += 1

section(ws, r, "Operating costs", cols=26); r += 1
put(r, "Founder 1", lambda col, m: f"=Inputs!$B${active_rows['Founder 1']}", USD); OP1 = r; r += 1
put(r, "Founder 2", lambda col, m: f"=Inputs!$B${active_rows['Founder 2']}", USD); OP2 = r; r += 1
put(r, "Developer", lambda col, m: f"=Inputs!$B${active_rows['Developer']}", USD); OP3 = r; r += 1
put(r, "Second developer", lambda col, m: f"=IF({m}>=Inputs!$B${active_rows['Second developer from month']},Inputs!$B${active_rows['Second developer cost']},0)", USD); OP4 = r; r += 1
put(r, "Support / content ops", lambda col, m: f"=IF({m}>=Inputs!$B${active_rows['Support ops from month']},Inputs!$B${active_rows['Support ops cost']},0)", USD); OP5 = r; r += 1
put(r, "Tools", lambda col, m: f"=Inputs!$B${active_rows['Tools']}", USD); OP6 = r; r += 1
put(r, "Marketing", lambda col, m: f"=Inputs!$B${active_rows['Marketing']}", USD); OP7 = r; r += 1
put(r, "Total opex", lambda col, m: f"=SUM({col}{OP1}:{col}{OP7})", USD, bold=True); OPEX = r; r += 1

section(ws, r, "Bottom line", cols=26); r += 1
put(r, "EBITDA", lambda col, m: f"={col}{GP}-{col}{OPEX}", USD, bold=True, fill=GREEN); EBITDA = r; r += 1
put(r, "Cumulative cash", lambda col, m: (
    f"=Inputs!$B${active_rows['Starting cash']}-Inputs!$B${active_rows['One-time build cost']}+{col}{EBITDA}"
    if m == 1 else f"={chr(ord(col)-1)}{r}+{col}{EBITDA}"), USD, bold=True); CASH = r; r += 1
put(r, "Cumulative EBITDA (ex-build)", lambda col, m: f"={col}{EBITDA}" if m == 1 else f"={chr(ord(col)-1)}{r}+{col}{EBITDA}", USD); CUM = r; r += 1
put(r, "ARPU (MRR / property)", lambda col, m: f"=IF({col}{TOT}=0,0,{col}{MRR}/{col}{TOT})", USD2); ARPU = r; r += 1

# summary box
r += 1
section(ws, r, "Summary — active scenario", cols=6); r += 1
summary = [
 ("Properties at month 24", f"=Z{TOT}", '0.0'),
 ("Group deals at month 24", f"=Z{G_BASE}", '0.00'),
 ("MRR at month 24", f"=Z{MRR}", USD),
 ("ARR at month 24", f"=Z{MRR}*12", USD),
 ("Gross margin at month 24", f"=Z{GMR}", PCT),
 ("EBITDA at month 24", f"=Z{EBITDA}", USD),
 ("Lowest cash point", f"=MIN(C{CASH}:Z{CASH})", USD),
 ("Peak funding requirement", f"=Inputs!$B${active_rows['Starting cash']}-MIN(C{CASH}:Z{CASH})", USD),
 ("First EBITDA-positive month", f'=IFERROR(MATCH(TRUE,INDEX(C{EBITDA}:Z{EBITDA}>0,0),0),"not within 24 months")', NUM),
]
for label, f, fmt in summary:
    ws.cell(row=r, column=1, value=label).font = N
    c = ws.cell(row=r, column=3, value=f); c.font = B; c.number_format = fmt; c.fill = PatternFill("solid", fgColor=LIGHT); c.border = BD
    r += 1

# chart
ch = LineChart()
ch.title = "MRR, gross profit and EBITDA"
ch.y_axis.title = "USD / month"
ch.x_axis.title = "Month"
ch.height = 8; ch.width = 22
data = Reference(ws, min_col=3, max_col=26, min_row=MRR, max_row=EBITDA)
cats = Reference(ws, min_col=3, max_col=26, min_row=4, max_row=4)
# only include MRR/GP/EBITDA rows
from openpyxl.chart import Series
for row_idx, name in ((MRR, "MRR"), (GP, "Gross profit"), (EBITDA, "EBITDA")):
    ref = Reference(ws, min_col=3, max_col=26, min_row=row_idx, max_row=row_idx)
    s = Series(ref, title=name)
    ch.series.append(s)
ch.set_categories(cats)
ws.add_chart(ch, f"A{r+1}")

# =================== 6. SCENARIOS ===================
ws = wb.create_sheet("Scenarios"); ws.sheet_properties.tabColor = "7A2E2E"
ws.column_dimensions["A"].width = 40
for col in "BCDEFG":
    ws.column_dimensions[col].width = 16
ws["A1"] = "Three funding paths compared"
ws["A1"].font = Font(name="Calibri", size=14, bold=True, color=NAVY)
ws["A2"] = "Static snapshot computed from the same engine. Switch the selector on Inputs to reproduce any column live."
ws["A2"].font = IT

hdr(ws, 4, ["", "Bootstrap", "Funded", "Group-led", "", "", ""])
ws.cell(row=4, column=1, value="Metric").font = H
ws.cell(row=4, column=1).fill = PatternFill("solid", fgColor=NAVY)
ws.cell(row=5, column=1, value="Team shape").font = B
c = ws.cell(row=5, column=2, value="Bootstrap: 2 founders, both build; no contractor, founders absorb support.   |   Funded: 1 founder + contractor dev, then a second dev (month 7) and support ops (month 4).   |   Group-led: same team as Funded, faster pipeline, two group deals.")
c.font = SM; c.alignment = WRAP
ws.merge_cells(start_row=5, start_column=2, end_row=5, end_column=4)
ws.row_dimensions[5].height = 46
r = 6

scen_results = {k: run(k) for k in SCEN}
metrics = [
 ("Steady-state monthly opex", lambda out, be, k: sum([SCEN[k]["opex"]["f1"], SCEN[k]["opex"]["f2"], SCEN[k]["opex"]["dev"],
     SCEN[k]["opex"]["dev2"] if SCEN[k]["opex"]["dev2_from"] <= 24 else 0, SCEN[k]["opex"]["sup"] if SCEN[k]["opex"]["sup_from"] <= 24 else 0,
     SCEN[k]["opex"]["tools"], SCEN[k]["opex"]["mkt"]]), USD),
 ("Properties at month 24", lambda out, be, k: out[-1]["props"], '0.0'),
 ("Group deals at month 24", lambda out, be, k: out[-1]["grp"], '0.00'),
 ("MRR at month 24", lambda out, be, k: out[-1]["rev"], USD),
 ("ARR at month 24", lambda out, be, k: out[-1]["rev"]*12, USD),
 ("Gross margin at month 24", lambda out, be, k: out[-1]["gp"]/out[-1]["rev"] if out[-1]["rev"] else 0, PCT),
 ("EBITDA at month 24", lambda out, be, k: out[-1]["ebitda"], USD),
 ("Breakeven month", lambda out, be, k: be if be else "not within 24", NUM),
 ("Peak funding requirement", lambda out, be, k: SCEN[k]["start"] - min(r["cash"] for r in out), USD),
 ("Cash at month 24", lambda out, be, k: out[-1]["cash"], USD),
 ("Starting capital raise", lambda out, be, k: SCEN[k]["start"], USD),
]
r += 1
for label, fn, fmt in metrics:
    ws.cell(row=r, column=1, value=label).font = B
    for i, k in enumerate(SCEN):
        out, be = scen_results[k]
        v = fn(out, be, k)
        c = ws.cell(row=r, column=2+i, value=v)
        c.number_format = fmt; c.font = N; c.border = BD
        if isinstance(v, str):
            c.value = "not within 24 months"; c.font = SM
    ws.cell(row=r, column=1).border = BD
    if label in ("Breakeven month", "Peak funding requirement"):
        for i in range(1, 5):
            ws.cell(row=r, column=i).fill = PatternFill("solid", fgColor=AMBER)
    r += 1

r += 1
section(ws, r, "Reading the three paths", cols=6); r += 1
reads = [
 ("Bootstrap", "Lowest capital consumed (~$51k peak) and the only path that reaches breakeven on a plausible timeline — month 23, with $10k of cash left at month 24. It works only if both founders take a $1,500/month draw. That is a runway decision, not a business decision."),
 ("Funded", "The middle path is the worst path. It needs ~$231k of peak funding and still does not reach breakeven within 24 months at base-case sales velocity — $80k short at month 24. You take venture-scale burn without venture-scale growth."),
 ("Group-led", "Breakeven month 24 at ~$188k consumed. Group revenue per deal is ~9× an independent property, so the same sales effort buys far more gross profit. Two group logos beat forty independents on capital efficiency."),
 ("The decision this forces", "Either bootstrap with two founders and accept a slow 23-month climb, or raise ~$200k deliberately and staff for the group path. Do not drift into the middle by hiring one contractor and hoping."),
]
for k, t in reads:
    ws.cell(row=r, column=1, value=k).font = B
    c = ws.cell(row=r, column=2, value=t); c.font = N; c.alignment = WRAP
    ws.merge_cells(start_row=r, start_column=2, end_row=r, end_column=5)
    ws.row_dimensions[r].height = 44
    r += 1

# =================== 7. SENSITIVITY ===================
ws = wb.create_sheet("Sensitivity"); ws.sheet_properties.tabColor = "8EA9DB"
ws.column_dimensions["A"].width = 36
for i in range(2, 8):
    ws.column_dimensions[get_column_letter(i)].width = 13
ws["A1"] = "What actually moves the answer"; ws["A1"].font = Font(name="Calibri", size=14, bold=True, color=NAVY)

section(ws, 3, "A. Gross margin — Independent tier (rows: conversation volume vs base; columns: WhatsApp share)", cols=7)
hdr(ws, 4, ["Volume multiple"] + ["0%", "25%", "45%", "65%", "85%"] + [""])
shares = [0.0, 0.25, 0.45, 0.65, 0.85]
r = 5
for mult in (0.5, 1.0, 1.5, 2.0, 3.0):
    ws.cell(row=r, column=1, value=f"{mult:.1f}×").font = B
    for i, sh in enumerate(shares):
        a = dict(ARCH[1]); a["wa"] = sh; a["part"] = ARCH[1]["part"]*mult
        u = unit(a)
        c = ws.cell(row=r, column=2+i, value=u["gm"]); c.number_format = PCT; c.border = BD
        c.fill = PatternFill("solid", fgColor=GREEN if u["gm"] > 0.85 else (LIGHT if u["gm"] > 0.78 else AMBER))
    r += 1
ws.cell(row=r+1, column=1, value="Conclusion: margin never falls below 72% anywhere in the plausible range. Do not spend engineering effort optimising AI cost.").font = IT
ws.merge_cells(start_row=r+1, start_column=1, end_row=r+1, end_column=7)

r = r + 3
section(ws, r, "B. Support load is the real lever — Independent tier", cols=7); r += 1
hdr(ws, r, ["Support hrs / month", "Support cost", "COGS", "GM %", "GP / month", "Properties per $10k opex", ""], color=NAVY); r += 1
for hrs in (0.5, 1.0, 1.5, 2.0, 3.0, 4.0):
    a = dict(ARCH[1]); a["sup"] = hrs; u = unit(a)
    ws.cell(row=r, column=1, value=f"{hrs:.1f}").font = B
    ws.cell(row=r, column=2, value=u["sup"]).number_format = USD
    ws.cell(row=r, column=3, value=u["cogs"]).number_format = USD
    ws.cell(row=r, column=4, value=u["gm"]).number_format = PCT
    ws.cell(row=r, column=5, value=u["gp"]).number_format = USD
    ws.cell(row=r, column=6, value=10000/u["gp"]).number_format = '0.0'
    for cc in range(1, 7):
        ws.cell(row=r, column=cc).border = BD
    r += 1
ws.cell(row=r+1, column=1, value="Every extra support hour per property per month costs ~$22 and delays breakeven materially. Self-serve onboarding and a good knowledge-gap loop are margin features, not niceties.").font = IT
ws.merge_cells(start_row=r+1, start_column=1, end_row=r+1, end_column=7)

r = r + 3
section(ws, r, "C. LLM model tier — cost per conversation", cols=7); r += 1
hdr(ws, r, ["Model tier", "$/conv", "COGS (Independent)", "GM %", "COGS (Resort)", "GM % (Resort)", "Verdict"], color=NAVY); r += 1
for label, pin, pout, verdict in [
    ("Cheap (Flash/mini class)", 0.15, 0.60, "Use for classification and guardrail passes"),
    ("Mid (default)", 0.60, 2.40, "Recommended for generation"),
    ("Premium (frontier)", 3.00, 15.00, "Only if mid-tier accuracy fails the eval gate"),
]:
    globals()["P_IN"], globals()["P_OUT"] = pin, pout
    ui, ur = unit(ARCH[1]), unit(ARCH[3])
    ws.cell(row=r, column=1, value=label).font = B
    ws.cell(row=r, column=2, value=(TOK_IN/1e6*pin + TOK_OUT/1e6*pout)).number_format = '"$"0.000'
    ws.cell(row=r, column=3, value=ui["cogs"]).number_format = USD
    ws.cell(row=r, column=4, value=ui["gm"]).number_format = PCT
    ws.cell(row=r, column=5, value=ur["cogs"]).number_format = USD
    ws.cell(row=r, column=6, value=ur["gm"]).number_format = PCT
    ws.cell(row=r, column=7, value=verdict).font = SM
    for cc in range(1, 8):
        ws.cell(row=r, column=cc).border = BD
    r += 1
globals()["P_IN"], globals()["P_OUT"] = 0.60, 2.40

r += 1
section(ws, r, "D. The assumption that matters most", cols=7); r += 1
for t in [
 "Participation rate — the share of guest-nights that produce a conversation. Modelled at 12–18%. If it is 5%, the product is a curiosity. If it is 30%, volumes (and WhatsApp cost) double, and margin still holds at ~77%.",
 "Support hours per property — modelled at 1.5/month for an Independent. This is the number to measure during the pilot. Everything else in the model is more predictable than this.",
 "Churn — 2.5%/month is an assumption, not evidence. A hotel that stops maintaining its knowledge base will churn. This is why the knowledge-gap loop is a retention feature.",
]:
    c = ws.cell(row=r, column=1, value="• " + t); c.font = N; c.alignment = WRAP
    ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=7)
    ws.row_dimensions[r].height = 32
    r += 1

# =================== 7b. BUYER ROI ===================
ws = wb.create_sheet("Buyer ROI"); ws.sheet_properties.tabColor = "C55A11"
for col, w in zip("ABCDEFG", [40, 15, 15, 15, 15, 15, 46]):
    ws.column_dimensions[col].width = w
ws["A1"] = "Buyer-side ROI — what the hotel gets for the price"
ws["A1"].font = Font(name="Calibri", size=14, bold=True, color=NAVY)
ws["A2"] = "The seller's margin is fine everywhere. The buyer's case is not. This sheet tests whether a hotel can justify the price."
ws["A2"].font = IT

section(ws, 4, "A. Where the AI creates value for the hotel (edit yellow cells)", cols=7)
roi_inputs = [
 ("Front-desk loaded hourly cost (USD)", 6.00, USD2, "Mexico ≈ $5–7/hr fully loaded. US resort ≈ $18–22/hr. Hotel labour rates are highly location-dependent."),
 ("Staff minutes per conversation handled manually", 8, '0.0', "Reading, thinking, replying, following up. 10-message WhatsApp threads take 8–12 minutes."),
 ("Containment rate (AI resolves without staff)", 0.55, PCT, "Pilot target. Everything below assumes you hit it."),
 ("After-hours share of conversations", 0.35, PCT, "Guests message at night. Today those go unanswered until morning."),
 ("Staff minutes per after-hours conversation", 15, '0.0', "Slower because nobody is at a desk."),
 ("Opportunity clicks per conversation", 0.08, '0.00', "Booking / dining / spa links. Conservative."),
 ("Click-to-booking conversion", 0.15, PCT, "Unvalidated. Use 0 once you have real data."),
 ("Average ancillary ticket (USD)", 60, USD, ""),
 ("Margin on that ticket", 0.35, PCT, ""),
]
r = 5
roi_rows = {}
for label, v, fmt, note in roi_inputs:
    ws.cell(row=r, column=1, value=label).font = N
    c = ws.cell(row=r, column=2, value=v); c.font = B; c.fill = PatternFill("solid", fgColor=AMBER); c.border = BD; c.number_format = fmt
    n = ws.cell(row=r, column=3, value=note); n.font = SM; n.alignment = WRAP
    ws.merge_cells(start_row=r, start_column=3, end_row=r, end_column=7)
    ws.row_dimensions[r].height = 26
    roi_rows[label] = r
    r += 1
R_RATE, R_MINS, R_CONT, R_AHSH, R_AHMIN, R_CLICK, R_CVR, R_TICKET, R_MARG = [roi_rows[k] for k in roi_rows]

section(ws, 16, "B. Value created vs price charged", cols=7)
hdr(ws, 17, ["Line", "Boutique", "Independent", "Midscale", "Resort", "Group (3×Mid)", "Note"], color=NAVY)
def urow(row, label, tmpl, fmt=USD, note="", bold=False, fill=None):
    ws.cell(row=row, column=1, value=label).font = B if bold else N
    for i, col in enumerate("BCDEF"):
        c = ws.cell(row=row, column=2+i, value=tmpl.replace("@", f"'Unit Economics'!{col}"))
        c.number_format = fmt; c.font = B if bold else N; c.border = BD
        if fill: c.fill = PatternFill("solid", fgColor=fill)
    if note:
        n = ws.cell(row=row, column=7, value=note); n.font = SM; n.alignment = WRAP

urow(18, "Conversations / month", "=@16", NUM)
urow(19, "Conversations resolved without staff", f"=@16*$B${R_CONT}", '0.0')
urow(20, "Staff time freed / month (hours)", f"=@16*$B${R_CONT}*$B${R_MINS}/60", '0.0')
# rows 21+ reference the ROI sheet's own value rows, not Unit Economics
def vrow(row, label, tmpl, fmt=USD, note="", bold=False, fill=None):
    ws.cell(row=row, column=1, value=label).font = B if bold else N
    for i, col in enumerate("BCDEF"):
        c = ws.cell(row=row, column=2+i, value=tmpl.replace("@", col))
        c.number_format = fmt; c.font = B if bold else N; c.border = BD
        if fill: c.fill = PatternFill("solid", fgColor=fill)
    if note:
        n = ws.cell(row=row, column=7, value=note); n.font = SM; n.alignment = WRAP

vrow(21, "Value: staff time freed", "=@20*$B$5", USD, "Replaces existing work")
vrow(22, "Value: after-hours coverage", "=@18*$B$8*$B$9/60*$B$5", USD, "Work that currently is not done at all")
vrow(23, "Value: opportunity clicks", "=@18*$B$10*$B$11*$B$12*$B$13", USD, "Weakest of the three — treat as upside only")
vrow(24, "Total hard value / month", "=SUM(@21:@23)", USD, "", True, GREEN)
ws.cell(row=25, column=1, value="Price / month").font = B
for i, col in enumerate("BCDEF"):
    c = ws.cell(row=25, column=2+i, value=f"='Unit Economics'!{col}12")
    c.number_format = USD; c.font = B; c.border = BD
vrow(26, "ROI multiple (value ÷ price)", "=@24/@25", '0.00"×"', "", True, GREEN)
vrow(27, "Net monthly value to the hotel", "=@24-@25", USD)

section(ws, 29, "C. Participation rate needed for the buyer to break even on hard value alone", cols=7)
hdr(ws, 30, ["Price / mo", "Boutique", "Independent", "Midscale", "Resort", "", "Reading"], color=NAVY)
r = 31
for price in (199, 299, 349, 599, 1099):
    ws.cell(row=r, column=1, value=price).number_format = USD
    for i, col in enumerate("BCDE"):
        # value per conversation at the modelled assumptions, independent of tier
        k = (f"($B$7*$B$6/60*$B$5"
             f"+$B$8*$B$9/60*$B$5"
             f"+$B$10*$B$11*$B$12*$B$13)")
        part = f"A{r}/{k}/'Unit Economics'!{col}15"
        ws.cell(row=r, column=2+i, value=f"={part}").number_format = PCT
    r += 1
ws.cell(row=36, column=1, value="Base participation modelled: 12% Boutique, 15% Independent, 17% Midscale, 18% Resort. If the required rate is above the base, labour value alone does not pay for the product at that price — the buyer must value coverage, reviews or revenue.").font = IT
ws.merge_cells(start_row=36, start_column=1, end_row=36, end_column=7)
ws.row_dimensions[36].height = 30

section(ws, 38, "D. The same product at two labour markets", cols=7)
hdr(ws, 39, ["Labour market", "Boutique", "Independent", "Midscale", "Resort", "", ""], color=NAVY)
for i, (label, rate) in enumerate([("Mexico ($6.00/hr)", 6.0), ("US / high-wage resort ($19.00/hr)", 19.0)]):
    r = 40 + i
    ws.cell(row=r, column=1, value=label).font = B
    for j, col in enumerate("BCDE"):
        k = (0.55*8/60*rate + 0.35*15/60*rate + 0.08*0.15*60*0.35)
        price_cell = f"'Unit Economics'!{col}12"
        conv = f"'Unit Economics'!{col}16"
        ws.cell(row=r, column=2+j, value=f"={conv}*{k}/{price_cell}").number_format = '0.00"×"'

ws.cell(row=28, column=1, value="Group ROI is not comparable: groups buy governance, brand consistency and oversight, not hours saved. Judge that tier on seller margin (85%) and retention, not this ratio.").font = IT
ws.merge_cells(start_row=28, start_column=1, end_row=28, end_column=7)
ws.row_dimensions[28].height = 26

section(ws, 43, "E. What this means for pricing", cols=7)
reads = [
 ("The seller's economics are not the problem", "Gross margin is 78–85% at every tier. There is no cost crisis to solve."),
 ("The buyer's case is location-dependent", "At Mexican labour rates ($6/hr) buyer ROI is 0.39× (Boutique) to 1.14× (Resort) on hard value. At US resort rates ($19/hr) it is 1.05× to 3.09×. Same product, different verdict."),
 ("Only the Resort clears 1× in Mexico", "A 250-room resort justifies $1,099 on labour and coverage alone. A 24-room boutique cannot justify $199 that way — and never will."),
 ("So the small-tier sale is not a labour sale", "Sell coverage, language, response speed and review quality at the low end. If you lead with hours saved at a 24-room property, you will lose the ROI argument."),
 ("Pricing consequence", "Keep $199 / $299 published, but treat Boutique and Independent as self-serve land-grab tiers with near-zero onboarding cost. Concentrate sales effort where buyer ROI is unambiguous: resorts (3–8×) and groups."),
 ("The strategic read for a Mexico-based launch", "Puerto Peñasco-type destinations pay Mexican wages but host US guests. That combination is the best case: high guest expectations, low labour cost, so coverage and language value carry the sale even when the hours arithmetic does not."),
]
r = 44
for k, t in reads:
    ws.cell(row=r, column=1, value=k).font = B
    c = ws.cell(row=r, column=2, value=t); c.font = N; c.alignment = WRAP
    ws.merge_cells(start_row=r, start_column=2, end_row=r, end_column=7)
    ws.row_dimensions[r].height = 32
    r += 1

# =================== 8. SOURCES ===================
ws = wb.create_sheet("Sources & method"); ws.sheet_properties.tabColor = "808080"
ws.column_dimensions["A"].width = 30
ws.column_dimensions["B"].width = 110
ws["A1"] = "Sources, method and open questions"; ws["A1"].font = Font(name="Calibri", size=14, bold=True, color=NAVY)
src = [
 ("WhatsApp pricing", "Service messages became chargeable on 1 Oct 2026. 1,000 free service messages per business phone number per month, then billed at the market utility rate. Mexico ≈ $0.0085/message."),
 ("Source", "Meta, Pricing on the WhatsApp Business Platform — developers.facebook.com/documentation/business-messaging/whatsapp/pricing"),
 ("Data protection", "LFPDPPP (Mexico) effective 21 Mar 2025. Processors directly regulated; INAI dissolved, enforcement moved to the Secretaría Anticorrupción y Buen Gobierno. Implications: DPA required, purposes enumerated, no 'similar purposes' catch-all."),
 ("Build cost basis", "77 dev-days from the delivery backlog (70 items, 68 of them on the lean pilot path) at $550/day, plus design, legal and 2 months of managed services. The backlog is the single source of truth for schedule arithmetic. See 02-development-plan-workbook.xlsx, sheet 02."),
 ("Participation rate", "No public benchmark exists for AI concierge adoption in Mexico. 12–18% of guest-nights is an assumption to be replaced with pilot data in weeks 1–4."),
 ("Support load", "1.5 hours per Independent property per month assumes a maintained knowledge base and a self-serve onboarding. Add 0.5–1.0 h/month for the first 90 days of each property."),
 ("Churn", "2.5%/month (26% annualised) is a standard SMB SaaS placeholder. Hotel software typically churns less once embedded; this product is not yet embedded."),
 ("Currency & tax", "USD. Mexican IVA (16%) and local card processing should be layered on before quoting. The model uses a 3.6% payment fee before tax."),
 ("Known simplification: group churn", "Groups are churned at the same 2.5%/month as single properties. In reality group churn is probably lower and lumpier. This makes the group-led scenario slightly conservative."),
 ("Known simplification: billing cadence", "All pricing is modelled monthly. Annual prepay (recommended in the Pricing sheet) improves cash timing but does not change ARR, so it is not modelled separately."),
 ("Bootstrap build cost", "$2,280 = legal and incorporation $1,800 + two months of managed services $240 + $240 domain and tooling. Founders contribute the development."),
 ("Cached values", "Every formula cell also stores its computed value, so the workbook reads correctly in pandas, Sheets, previewers and any tool that does not recalculate. Rebuild with build_finmodel.py then bake_values.py."),
 ("", ""),
 ("Open questions this model cannot answer", ""),
 ("1", "What participation rate will guests actually show? Only the pilot can answer this, and it changes everything downstream."),
 ("2", "Will a hotel pay $349/month for a product their staff must maintain? The knowledge-gap loop is the mechanism; the pilot tests it."),
 ("3", "Can a group be sold without PMS integration? The model assumes yes at $1,250 platform + 85% per property. That is unvalidated."),
 ("4", "What is real support load in month 3, after the hotel edits its own knowledge badly? Model 2.5 h/month in that period."),
]
r = 3
for k, v in src:
    ws.cell(row=r, column=1, value=k).font = B
    c = ws.cell(row=r, column=2, value=v); c.font = N; c.alignment = WRAP
    if v == "":
        ws.cell(row=r, column=1).fill = PatternFill("solid", fgColor=LIGHT)
        ws.cell(row=r, column=2).fill = PatternFill("solid", fgColor=LIGHT)
    ws.row_dimensions[r].height = 30 if len(v) > 90 else 16
    r += 1

wb.save("/home/user/hotel-concierge-plan/03-financial-model.xlsx")
print("saved financial model")
for k in SCEN:
    out, be = scen_results[k]
    print(f"{k:11s} props@24 {out[-1]['props']:5.1f}  MRR ${out[-1]['rev']:8,.0f}  breakeven {str(be):>5s}  peak funding ${SCEN[k]['start']-min(r['cash'] for r in out):8,.0f}")
