"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "");

// ---- remember last hospital -------------------------------------------
const HOSPITAL_KEY = "nurse-commute:hospital";
try { $("hospital").value = localStorage.getItem(HOSPITAL_KEY) || ""; } catch (e) {}
$("hospital").addEventListener("change", () => {
  try { localStorage.setItem(HOSPITAL_KEY, $("hospital").value.trim()); } catch (e) {}
});

// ---- tabs ---------------------------------------------------------------
document.querySelectorAll(".tab").forEach((btn) => btn.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
  $("tab-single").hidden = btn.dataset.tab !== "single";
  $("tab-csv").hidden = btn.dataset.tab !== "csv";
}));

function hospitalOrError(target) {
  const h = $("hospital").value.trim();
  if (!h) { target.innerHTML = `<div class="error">יש לבחור בית חולים.</div>`; $("hospital").focus(); }
  else { try { localStorage.setItem(HOSPITAL_KEY, h); } catch (e) {} }
  return h;
}

async function checkAddress(address, hospital) {
  let res;
  try {
    res = await fetch("/api/check", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, hospital }),
    });
  } catch (e) {
    return { error: "אין חיבור לשרת של האפליקציה." };
  }
  try { return await res.json(); } catch (e) { return { error: "שגיאה לא צפויה בשרת." }; }
}

// ---- single address -------------------------------------------------------
$("single-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const out = $("single-result");
  const hospital = hospitalOrError(out);
  if (!hospital) return;
  const btn = ev.submitter || ev.target.querySelector("button");
  btn.disabled = true; btn.textContent = "בבדיקה… (יכול לקחת כחצי דקה)";
  out.innerHTML = "";
  const r = await checkAddress($("address").value.trim(), hospital);
  btn.disabled = false; btn.textContent = "בדיקה";
  out.innerHTML = r.error ? `<div class="error">${esc(r.error)}</div>` : renderResult(r);
});

function renderResult(r) {
  const w = r.walk;
  let html = `<div class="card verdict ${r.suitable ? "ok" : "bad"}">${esc(r.verdict)}</div>`;
  html += `<div class="card">
    <h2>🚶 הליכה</h2>
    <div class="big">${w.minutes} דק' <span class="muted">· ${(w.distance_m / 1000).toFixed(2)} ק"מ</span></div>
    ${w.ok ? `<span class="badge ok">מתאים להליכה</span>` : `<span class="badge bad">יותר מ-${esc(r.max_walk_minutes)} דק' הליכה</span>`}
  </div>`;
  html += `<div class="card"><h2>🚌 תחבורה ציבורית (קווים ישירים)</h2>`;
  if (!r.options.length) {
    html += `<div class="error">${esc(r.transit_message)}</div>`;
  } else {
    html += r.options.map((o) => renderOption(o, r)).join("");
  }
  html += `</div>`;
  html += `<p class="muted">קריאות API: ${r.api_calls} · מהמטמון: ${r.cache_hits}</p>`;
  return html;
}

function renderOption(o, r) {
  const leg = o.legs[0];
  const legsTitle = o.legs.map((l) => `<span class="line-num">${esc(l.line)}</span>`).join(" ← ");
  let html = `<div class="card">
    <div class="line-title">${legsTitle}
      <span>${esc(leg.vehicle)} · ${esc(o.legs.map((l) => l.operator).join(", "))}</span>
      <span class="badge ${o.meets_criteria ? "ok" : "bad"}">${o.meets_criteria ? "עומד בקריטריונים" : "לא עומד בקריטריונים"}</span>
    </div>
    ${leg.headsign ? `<div class="muted">לכיוון ${esc(leg.headsign)}</div>` : ""}
    <dl class="facts">
      <dt>עלייה</dt><dd>${esc(leg.board_stop)}</dd>
      <dt>ירידה</dt><dd>${esc(o.legs[o.legs.length - 1].alight_stop)}</dd>
      <dt>הליכה לתחנה</dt><dd>${o.walk_to_stop_min} דק'</dd>
      <dt>נסיעה</dt><dd>${o.in_vehicle_min} דק'</dd>
      <dt>הליכה מהתחנה</dt><dd>${o.walk_from_stop_min} דק'</dd>
      <dt>סה"כ</dt><dd><b>${o.total_min} דק'</b></dd>
    </dl>
    <div class="table-wrap"><table>
      <thead><tr><th>חלון</th>${Object.keys(o.frequency).map((d) =>
        `<th>${esc(r.day_labels[d])} ${esc(r.dates[d])}</th>`).join("")}</tr></thead>
      <tbody>`;
  for (const win of r.windows) {
    html += `<tr><td>${esc(win.label)}<br><span class="muted">${esc(win.time)}</span></td>`;
    for (const d of Object.keys(o.frequency)) {
      const f = o.frequency[d][win.key];
      html += `<td class="${f.ok ? "ok" : "bad"}">${f.ok ? "✓" : "✗"}
        ${f.count ? `<div class="times">${f.departures.map(esc).join(" · ")}</div>` : ""}
        ${f.avg_gap != null ? `<div>כל ~${f.avg_gap} דק'</div>` : ""}
        ${f.problems.length ? `<div class="muted">${f.problems.map(esc).join(", ")}</div>` : ""}
      </td>`;
    }
    html += `</tr>`;
  }
  return html + `</tbody></table></div></div>`;
}

// ---- CSV mode -------------------------------------------------------------
let csvResults = [];

$("csv-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const out = $("csv-result"), prog = $("csv-progress");
  const hospital = hospitalOrError(out);
  if (!hospital) return;
  const file = $("csv-file").files[0];
  if (!file) return;
  out.innerHTML = ""; prog.innerHTML = "";

  const fd = new FormData(); fd.append("file", file);
  let parsed;
  try { parsed = await (await fetch("/api/csv/parse", { method: "POST", body: fd })).json(); }
  catch (e) { parsed = { error: "שגיאה בהעלאת הקובץ." }; }
  if (parsed.error) { out.innerHTML = `<div class="error">${esc(parsed.error)}</div>`; return; }

  const btn = ev.submitter || ev.target.querySelector("button");
  btn.disabled = true;
  csvResults = [];
  const rows = parsed.rows;
  for (let i = 0; i < rows.length; i++) {
    prog.innerHTML = `<div class="progress"><div style="width:${(i / rows.length) * 100}%"></div></div>
      <div class="muted">בבדיקה ${i + 1} מתוך ${rows.length}: ${esc(rows[i].address)}</div>`;
    const r = await checkAddress(rows[i].address, hospital);
    csvResults.push(toCsvRow(rows[i], r));
    renderCsvTable();
  }
  prog.innerHTML = `<div class="muted">הסתיים: נבדקו ${rows.length} כתובות.</div>`;
  btn.disabled = false;
});

function toCsvRow(row, r) {
  if (r.error) return { ...row, suitable: null, verdict: r.error, best_minutes: "", walk_minutes: "", direct_lines: "" };
  return {
    ...row,
    suitable: r.suitable,
    verdict: r.verdict,
    best_minutes: r.best_minutes,
    walk_minutes: r.walk.minutes,
    direct_lines: r.options.length
      ? r.options.map((o) => `${o.legs.map((l) => l.line).join("→")} (${o.total_min} דק'${o.meets_criteria ? ", ✓" : ""})`).join("; ")
      : r.transit_message,
  };
}

function sortedResults() {
  // by travel time; rows with errors last
  return [...csvResults].sort((a, b) =>
    (a.suitable === null) - (b.suitable === null) || (a.best_minutes || 1e9) - (b.best_minutes || 1e9));
}

function renderCsvTable() {
  const rows = sortedResults();
  $("csv-result").innerHTML = `<div class="card">
    <div class="row-actions"><h2>תוצאות (${rows.filter((r) => r.suitable).length} מתאימות מתוך ${rows.length})</h2>
      <button class="secondary" id="csv-download">⬇️ הורדת CSV</button></div>
    <div class="table-wrap"><table>
      <thead><tr><th>כתובת</th><th>מחיר</th><th>הליכה</th><th>קו ישיר</th><th>זמן מיטבי</th><th>התאמה</th></tr></thead>
      <tbody>${rows.map((r) => {
        const url = safeUrl(r.link);
        const addr = url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(r.address)}</a>` : esc(r.address);
        const mark = r.suitable === null ? `<span class="badge bad">שגיאה</span>`
          : `<span class="badge ${r.suitable ? "ok" : "bad"}">${r.suitable ? "מתאימה" : "לא מתאימה"}</span>`;
        return `<tr><td>${addr}</td><td>${esc(r.price)}</td>
          <td>${r.walk_minutes !== "" ? esc(r.walk_minutes) + " דק'" : ""}</td>
          <td>${esc(r.direct_lines)}</td>
          <td>${r.best_minutes !== "" ? esc(r.best_minutes) + " דק'" : ""}</td>
          <td title="${esc(r.verdict)}">${mark}${r.suitable === null ? `<div class="muted">${esc(r.verdict)}</div>` : ""}</td></tr>`;
      }).join("")}</tbody>
    </table></div></div>`;
  $("csv-download").addEventListener("click", downloadCsv);
}

async function downloadCsv() {
  const res = await fetch("/api/csv/export", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rows: sortedResults() }),
  });
  const blob = await res.blob();
  const a = Object.assign(document.createElement("a"),
    { href: URL.createObjectURL(blob), download: "apartments_results.csv" });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
