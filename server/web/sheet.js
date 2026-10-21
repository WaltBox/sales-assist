// Reading a call sheet (CSV, or Excel through SheetJS when needed), shared by the guest page and the web app (10/21).
// Gives back rows of { company, phone, askFor, what, city, state, email, notes, outcome } from whatever headers it has.
(function () {
function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}
// Close's own export works too (10/21): display_name is the company, url the website; its summary and count
// columns ("contacts_summary", "num_calls", "custom.Lead owner.name") aren't a contact or a phone.
const FIELDS = [["company", /company|account|business|display_name|lead ?name|^name$/i], ["phone", /phone|^tel|telephone/i], ["askFor", /ask|contact|buyer|person|who/i], ["what", /what|description|about|they do/i],
  ["city", /city|town/i], ["state", /^state$|^state\b|province|^st$/i], ["email", /email/i], ["notes", /note/i], ["outcome", /outcome|result/i], ["website", /^url$|website|web site|domain/i]];
const SKIP = /summary|count|num_|^custom\.|\.id$|status_label|last_call|date/i;
function toRows(table) {
  const head = table[0].map((x) => String(x).trim());
  const col = {};
  for (const [k, re] of FIELDS) { const at = head.findIndex((x, j) => re.test(x) && !SKIP.test(x) && !Object.values(col).includes(j)); if (at >= 0) col[k] = at; }
  return table.slice(1).map((r) => Object.fromEntries(Object.entries(col).map(([k, j]) => [k, r[j] ?? ""])));
}
async function readFile(file) {
  if (/\.xlsx?$/i.test(file.name)) {
    if (!window.XLSX) await new Promise((ok, no) => { const s = document.createElement("script"); s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"; s.onload = ok; s.onerror = () => no(new Error("Couldn't open Excel files right now. Save it as CSV and try again.")); document.head.append(s); });
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    return toRows(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "" }));
  }
  return toRows(parseCsv(await file.text()));
}


  window.readSheet = readFile;
})();
