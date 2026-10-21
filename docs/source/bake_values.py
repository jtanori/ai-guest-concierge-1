"""Inject cached values for every formula cell so the workbook is readable
by pandas, previewers and any tool that does not recalculate formulas."""
import re, shutil, sys, zipfile, warnings
from xml.sax.saxutils import escape
import xml.etree.ElementTree as ET
import formulas

warnings.filterwarnings("ignore")
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
      "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}

def solved(path):
    sol = formulas.ExcelModel().loads(path).finish().calculate()
    out = {}
    for key, val in sol.items():
        m = re.match(r"'\[[^\]]+\](.+?)'!([A-Z]+\d+)$", key)
        if not m:
            continue
        sheet, coord = m.group(1).upper(), m.group(2)
        try:
            v = val.value[0, 0]
        except Exception:
            continue
        if hasattr(v, "tolist"):
            v = v.tolist()
        while isinstance(v, (list, tuple)) and v:
            v = v[0]
        if isinstance(v, (bool, int, float, str)):
            out[(sheet, coord)] = v
    return out

def sheet_map(zin):
    wb = ET.fromstring(zin.read("xl/workbook.xml"))
    rels = ET.fromstring(zin.read("xl/_rels/workbook.xml.rels"))
    rid2tgt = {x.get("Id"): x.get("Target") for x in rels}
    out = {}
    for sh in wb.find("m:sheets", NS):
        name = sh.get("name").upper()
        rid = sh.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
        tgt = rid2tgt[rid].lstrip("/")
        if not tgt.startswith("xl/"):
            tgt = "xl/" + tgt
        out[name] = tgt
    return out

def bake(path):
    vals = solved(path)
    tmp = path + ".tmp"
    count = 0
    with zipfile.ZipFile(path) as zin:
        smap = sheet_map(zin)
        fname2sheet = {v: k for k, v in smap.items()}
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
            for item in zin.infolist():
                data = zin.read(item.filename)
                sheet = fname2sheet.get(item.filename)
                if sheet:
                    root = ET.fromstring(data)
                    for c in root.iter("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}c"):
                        f = c.find("m:f", NS)
                        if f is None:
                            continue
                        v = vals.get((sheet, c.get("r")))
                        if v is None:
                            continue
                        for old in c.findall("m:v", NS):
                            c.remove(old)
                        ve = ET.SubElement(c, "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}v")
                        if isinstance(v, bool):
                            c.set("t", "b"); ve.text = "1" if v else "0"
                        elif isinstance(v, (int, float)):
                            c.attrib.pop("t", None); ve.text = repr(float(v)) if isinstance(v, float) else str(v)
                        else:
                            c.set("t", "str"); ve.text = str(v)
                        count += 1
                    data = ET.tostring(root, encoding="utf-8", xml_declaration=True)
                zout.writestr(item, data)
    shutil.move(tmp, path)
    print(f"{path}: injected {count} cached values")

for p in sys.argv[1:]:
    bake(p)
