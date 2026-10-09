// CSV import (address, price, link) and export.

const ALIASES = {
  address: ["address", "כתובת"],
  price: ["price", "מחיר"],
  link: ["link", "url", "קישור"],
};

/** Bytes -> text: UTF-8 (with or without BOM), falling back to Windows-1255 (Hebrew Excel). */
export function decodeBytes(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/^﻿/, "");
  } catch (e) {
    return new TextDecoder("windows-1255").decode(buffer);
  }
}

/** RFC 4180 parser: quoted fields, escaped quotes, commas/newlines inside quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** -> {rows: [{address, price, link}]} or {error} */
export function readApartments(text) {
  const [header, ...body] = parseCsv(text);
  if (!header) return { error: "הקובץ ריק." };
  const names = header.map((h) => h.trim().toLowerCase());
  const col = {};
  for (const [field, aliases] of Object.entries(ALIASES)) {
    col[field] = names.findIndex((n) => aliases.includes(n));
  }
  if (col.address < 0) return { error: "בקובץ חייבת להיות עמודה בשם address (וגם price, link)." };
  const rows = body
    .map((r) => Object.fromEntries(Object.entries(col).map(([f, i]) => [f, i >= 0 ? (r[i] || "").trim() : ""])))
    .filter((r) => r.address);
  if (!rows.length) return { error: "לא נמצאו כתובות בקובץ." };
  return { rows };
}

const cell = (v) => {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Results -> CSV text with BOM (so Excel shows Hebrew correctly). */
export function exportCsv(rows) {
  const header = ["address", "price", "link", "suitable", "best_minutes", "best_entrance",
    "walk_minutes", "direct_lines", "verdict"];
  const mark = (s) => (s === true ? "מתאימה" : s === false ? "לא מתאימה" : "שגיאה");
  const lines = [header.join(",")].concat(rows.map((r) => [
    r.address, r.price, r.link, mark(r.suitable), r.best_minutes, r.best_entrance,
    r.walk_minutes, r.direct_lines, r.verdict,
  ].map(cell).join(",")));
  return "﻿" + lines.join("\r\n") + "\r\n";
}
