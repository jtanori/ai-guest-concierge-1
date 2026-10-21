exec(open("econ.py").read().split("# ---- projection")[0])  # reuse unit() and constants

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
gp_unit = {a[0]: unit(a)['gp'] for a in ARCH}
cogs_unit = {a[0]: unit(a)['cogs'] for a in ARCH}
price_unit = {a[0]: a[8] for a in ARCH}

for name, s in SCEN.items():
    base = {a[0]: 0.0 for a in ARCH}; groups = 0.0
    cash = s['start'] - s['build']; rows=[]; o = s['opex']
    for m in range(1, 25):
        q = (m-1)//3 + 1
        adds = [x*s['mult'] for x in BASE_ADDS[q]]
        for a, ad in zip(ARCH, adds): base[a[0]] = base[a[0]]*(1-CHURN) + ad/3
        g_add = s['groups'].get(q, 0)
        groups = groups*(1-CHURN) + g_add/3
        rev = sum(base[k]*price_unit[k] for k in base) + groups*group_price
        cogs = sum(base[k]*cogs_unit[k] for k in base) + groups*group_cogs
        gp = rev - cogs
        opex = o['f1']+o['f2']+o['dev']+o['tools']+o['mkt']
        if m >= o['dev2_from']: opex += o['dev2']
        if m >= o['sup_from']: opex += o['sup']
        ebitda = gp - opex; cash += ebitda
        rows.append((m, sum(base.values()), groups, rev, gp, opex, ebitda, cash))
    be = next((r[0] for r in rows if r[6] > 0), None)
    low = min(r[7] for r in rows)
    print(f"\n=== {name} ===  start ${s['start']:,}  build ${s['build']:,}  adds x{s['mult']}")
    print(f"  breakeven month: {be}   peak funding need: ${s['start']-low:,.0f}   lowest cash: ${low:,.0f}")
    print(f"  M24: {rows[-1][1]:.1f} props + {rows[-1][2]:.2f} groups | MRR ${rows[-1][3]:,.0f} | ARR ${rows[-1][3]*12:,.0f} | EBITDA ${rows[-1][6]:,.0f} | cash ${rows[-1][7]:,.0f}")
    print("  " + " ".join(f"{r[3]:,.0f}" for r in rows[::3]))

print("\n\nBreakeven properties vs price (Independent tier), steady opex $12,000")
for price in (249, 299, 349, 399, 449, 499, 599):
    u = unit(ARCH[1]); cogs_wo_pay = u['cogs'] - u['price']*PAY_FEE
    gp = price - cogs_wo_pay - price*PAY_FEE
    print(f"  ${price}: GP ${gp:.0f}  GM {(price-cogs_wo_pay-price*PAY_FEE)/price*100:.1f}%  breakeven props {12000/gp:.1f}")

print("\nBreakeven properties vs steady opex, blended GP/property")
blend = sum(gp_unit.values())/4
for opex in (3800, 6000, 8000, 10000, 12000, 15000):
    print(f"  opex ${opex:,}: {opex/blend:.1f} props (blended GP ${blend:.0f})")

print("\nCost share of COGS by tier")
for a in ARCH:
    u = unit(a)
    tot = u['cogs']
    print(f"  {u['name']:12s} support {u['support']/tot*100:4.1f}%  llm {u['llm']/tot*100:4.1f}%  whatsapp {u['wa']/tot*100:4.1f}%  infra {u['infra']/tot*100:4.1f}%  payment {u['pay']/tot*100:4.1f}%")
