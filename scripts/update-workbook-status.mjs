#!/usr/bin/env node
/**
 * Workbook status updater — flips the Status cell for a given backlog ID on
 * the "03 · Master backlog" sheet of 07-master-backlog.xlsx.
 *
 * Usage: node scripts/update-workbook-status.mjs <ID> "<status text>"
 * Statuses used this week:
 *   ✅ Done    — AC objectively met, verified
 *   🚧 ...     — evidence exists but AC has a pending external half
 */
import process from "node:process";
import exceljsPkg from "exceljs";

const { Workbook } = exceljsPkg.default ?? exceljsPkg;

const [id, status] = process.argv.slice(2);
if (!id || !status) {
  console.error("usage: update-workbook-status.mjs <ID> <status>");
  process.exit(1);
}

// Column layout of `03 · Master backlog` (verified by inspection):
// A=ID, B=Sprint, C=Track, D=Epic, E=Item, F=Description, G=Days,
// H=Pri, I=Depends on, J=Acceptance criteria, K=Status.
const COL_ID = 1;
const COL_STATUS = 11;

const FILE = "docs/07-master-backlog.xlsx";
const wb = new Workbook();
await wb.xlsx.readFile(FILE);
const ws = wb.getWorksheet("03 · Master backlog");
if (!ws) {
  console.error("sheet not found");
  process.exit(1);
}

let updated = 0;
for (let r = 5; r <= ws.rowCount; r++) {
  const row = ws.getRow(r);
  if (row.getCell(COL_ID).value === id) {
    row.getCell(COL_STATUS).value = status;
    row.commit();
    updated++;
  }
}
if (updated !== 1) {
  console.error(`expected exactly 1 row for ${id}, touched ${updated}`);
  process.exit(1);
}
await wb.xlsx.writeFile(FILE);
console.log(`${id} -> "${status}"`);
