"""Unit economics + projection engine. Mirrors the Excel formulas exactly."""

ARCH = [
    # name, rooms, occ, participation, replies_per_conv, wa_share, support_hrs, infra, price
    ("Boutique",     24, 0.72, 0.12,  9, 0.35, 1.0,  8, 199),
    ("Independent",  50, 0.68, 0.15, 10, 0.45, 1.5, 10, 299),
    ("Midscale",    120, 0.70, 0.17, 11, 0.55, 2.5, 15, 599),
    ("Resort",      250, 0.75, 0.18, 12, 0.60, 4.0, 20, 1099),
]

DAYS = 30.4
TOK_IN, TOK_OUT = 45_000, 3_000
PRICE_IN, PRICE_OUT = 0.60, 2.40        # USD per 1M tokens, mid-tier model
WA_RATE = 0.0085
WA_FREE = 1000
SUPPORT_RATE = 22.0
PAY_FEE = 0.036

def unit(a):
    name, rooms, occ, part, replies, wa_share, hrs, infra, price = a
    gn = rooms * DAYS * occ
    conv = gn * part
    llm = conv * (TOK_IN/1e6*PRICE_IN + TOK_OUT/1e6*PRICE_OUT)
    wa_msgs = conv * wa_share * replies
    wa = max(0, wa_msgs - WA_FREE) * WA_RATE
    sup = hrs * SUPPORT_RATE
    pay = price * PAY_FEE
    cogs = llm + wa + sup + infra + pay
    gp = price - cogs
    return dict(name=name, rooms=rooms, gn=gn, conv=conv, llm=llm, wa_msgs=wa_msgs,
                wa=wa, support=sup, infra=infra, pay=pay, cogs=cogs,
                price=price, gp=gp, gm=gp/price,
                per_room=price/rooms, cost_per_conv=cogs/conv)

print(f"{'archetype':12s} {'gn/mo':>7s} {'conv':>6s} {'LLM$':>7s} {'WA$':>6s} {'sup$':>6s} {'COGS':>7s} {'price':>6s} {'GP':>7s} {'GM%':>6s} {'$/room':>7s} {'$/conv':>7s}")
for a in ARCH:
    u = unit(a)
    print(f"{u['name']:12s} {u['gn']:7.0f} {u['conv']:6.0f} {u['llm']:7.2f} {u['wa']:6.2f} "
          f"{u['support']:6.2f} {u['cogs']:7.2f} {u['price']:6.0f} {u['gp']:7.2f} "
          f"{u['gm']*100:5.1f}% {u['per_room']:7.2f} {u['cost_per_conv']:7.3f}")

# ---- group deal ----
group_price = 2777.45
group_cogs = 408.88
print(f"\nGroup (3x Independent + platform): price ${group_price:.0f}, cogs ${group_cogs:.0f}, GM {(group_price-group_cogs)/group_price*100:.1f}%")

# ---- projection (base case) ----
QUARTER_ADDS = {   # per quarter: Boutique, Independent, Midscale, Resort
    1: (0, 1, 0, 0),
    2: (1, 2, 0, 0),
    3: (1, 2, 0, 0),
    4: (1, 3, 0, 0),
    5: (1, 2, 1, 0),
    6: (1, 2, 1, 0),
    7: (1, 2, 1, 0),
    8: (1, 2, 1, 1),
}
GROUP_ADDS = {q: (1 if q == 6 else 0) for q in range(1, 9)}
CHURN = 0.025
OPEX = dict(founder=2500, dev=3500, dev2_from=7, dev2=3500,
            support_from=4, support=1300, tools=400, marketing=800)
BUILD_COST = 46865
START_CASH = 150000

base = {a[0]: 0.0 for a in ARCH}
groups = 0.0
cash = START_CASH - BUILD_COST
rows = []
for m in range(1, 25):
    q = (m - 1)//3 + 1
    adds = QUARTER_ADDS[q]
    churn_n = 0
    for i, (a, add) in enumerate(zip(ARCH, adds)):
        base[a[0]] = base[a[0]] * (1 - CHURN) + add/3
    groups = groups * (1 - CHURN) + GROUP_ADDS[q]/3
    rev = sum(base[a[0]] * a[8] for a in ARCH) + groups * group_price
    cogs = sum(base[a[0]] * unit(a)['cogs'] for a in ARCH) + groups * group_cogs
    gp = rev - cogs
    opex = OPEX['founder'] + OPEX['dev'] + OPEX['tools'] + OPEX['marketing']
    if m >= OPEX['dev2_from']: opex += OPEX['dev2']
    if m >= OPEX['support_from']: opex += OPEX['support']
    ebitda = gp - opex
    cash += ebitda
    rows.append((m, q, sum(base.values()), groups, rev, cogs, gp, opex, ebitda, cash))

print(f"\n{'mo':>3s} {'props':>6s} {'grp':>5s} {'MRR':>9s} {'COGS':>8s} {'GP':>9s} {'GM%':>6s} {'opex':>8s} {'EBITDA':>9s} {'cash':>10s}")
for r in rows:
    m, q, p, g, rev, cogs, gp, opex, ebitda, cash = r
    print(f"{m:3d} {p:6.1f} {g:5.2f} {rev:9.0f} {cogs:8.0f} {gp:9.0f} {gp/rev*100 if rev else 0:5.1f}% {opex:8.0f} {ebitda:9.0f} {cash:10.0f}")

be = next((r[0] for r in rows if r[8] > 0), None)
print(f"\nBreakeven month (EBITDA>0): {be}")
print(f"Lowest cash point: {min(r[9] for r in rows):.0f} in month {min(rows, key=lambda r: r[9])[0]}")
print(f"Cumulative funding need above ${START_CASH:,.0f} start: {max(0, START_CASH - min(r[9] for r in rows)):.0f}")
print(f"MRR at month 24: {rows[-1][4]:,.0f}   ARR: {rows[-1][4]*12:,.0f}")
print(f"Properties month 24: {rows[-1][2]:.1f} + {rows[-1][3]:.2f} groups")

# ---- breakeven property count at steady opex ----
steady_opex = OPEX['founder']+OPEX['dev']+OPEX['dev2']+OPEX['support']+OPEX['tools']+OPEX['marketing']
blend_gp = sum(unit(a)['gp'] for a in ARCH)/len(ARCH)
print(f"\nSteady-state opex ${steady_opex:,}/mo; avg GP/property ${blend_gp:.0f} -> breakeven at {steady_opex/blend_gp:.1f} properties")
ind_gp = unit(ARCH[1])['gp']
print(f"If all were Independents: {steady_opex/ind_gp:.1f} properties")

# ---- CAC / LTV ----
for a in ARCH:
    u = unit(a)
    for cac in (1200, 1750, 2500):
        pass
cac = 1750
print(f"\nCAC ${cac}: payback months by tier: " + ", ".join(f"{u['name']} {cac/u['gp']:.1f}" for u in map(unit, ARCH)))
life = 1/CHURN
print(f"LTV/CAC at {CHURN*100:.1f}%/mo churn ({life:.0f} mo life): " + ", ".join(f"{u['name']} {(u['gp']*life)/cac:.1f}x" for u in map(unit, ARCH)))

# ---- sensitivity: LLM model tier ----
print("\nLLM model tier impact on cost/conversation and Independent-tier GM:")
for label, pin, pout in [("cheap (0.15/0.60)", 0.15, 0.60), ("mid (0.60/2.40)", 0.60, 2.40), ("premium (3.00/15.00)", 3.00, 15.00)]:
    PRICE_IN, PRICE_OUT = pin, pout
    u = unit(ARCH[1])
    print(f"  {label:22s} ${u['cost_per_conv']:.3f}/conv  COGS ${u['cogs']:.0f}  GM {u['gm']*100:.1f}%")
PRICE_IN, PRICE_OUT = 0.60, 2.40

# ---- sensitivity grid: Independent GM vs conv multiple x WA share ----
print("\nIndependent-tier GM% — rows: conversation volume vs base; cols: WhatsApp share")
shares = [0.0, 0.25, 0.45, 0.65, 0.85]
print("        " + "".join(f"{s*100:6.0f}%" for s in shares))
for mult in (0.5, 1.0, 1.5, 2.0, 3.0):
    line = f"{mult:4.1f}x  "
    for sh in shares:
        name, rooms, occ, part, replies, wa_share, hrs, infra, price = ARCH[1]
        gn = rooms*DAYS*occ; conv = gn*part*mult
        llm = conv*(TOK_IN/1e6*PRICE_IN + TOK_OUT/1e6*PRICE_OUT)
        wa = max(0, conv*sh*replies - WA_FREE)*WA_RATE
        cogs = llm + wa + hrs*SUPPORT_RATE + infra + price*PAY_FEE
        line += f"{(price-cogs)/price*100:6.1f}%"
    print(line)
