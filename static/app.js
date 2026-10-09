"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "");
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `e${Date.now()}${Math.random().toString(16).slice(2)}`);
const fmtCoord = (e) => `${Number(e.lat).toFixed(6)}, ${Number(e.lng).toFixed(6)}`;
const mapsLink = (e) => `https://www.google.com/maps/search/?api=1&query=${e.lat},${e.lng}`;

async function postJson(url, body, method = "POST") {
  let res;
  try {
    res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) {
    return { error: "אין חיבור לשרת של האפליקציה." };
  }
  try { return await res.json(); } catch (e) { return { error: "שגיאה לא צפויה בשרת." }; }
}

// =====================================================================
// Entrances: state saved in localStorage AND data/entrances.json (newest wins)
// =====================================================================
const STORE_KEY = "nurse-commute:entrances";
const OLD_HOSPITAL_KEY = "nurse-commute:hospital"; // from the first version of the app
let state = { updated_at: 0, hospital: "", entrances: [] };

function readLocal() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    return s && Array.isArray(s.entrances) ? s : null;
  } catch (e) { return null; }
}
function writeLocal() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
}
function setStatus(text) { $("entrance-status").textContent = text; }

async function pushServer() {
  const r = await postJson("/api/entrances", state, "PUT");
  setStatus(r.error ? "⚠️ השמירה לקובץ נכשלה (נשמר בדפדפן)" : "נשמר ✓");
}

function commit() {
  state.updated_at = Date.now();
  writeLocal();
  renderEntrances();
  pushServer();
}

async function initEntrances() {
  const local = readLocal();
  if (local) state = local;
  renderEntrances();
  try {
    const server = await (await fetch("/api/entrances")).json();
    if ((server.updated_at || 0) > (state.updated_at || 0)) {
      state = server; writeLocal(); renderEntrances();
    } else if ((state.updated_at || 0) > (server.updated_at || 0)) {
      pushServer();
    }
  } catch (e) {
    setStatus("⚠️ לא הצלחתי לטעון מהקובץ, מוצגות הכניסות מהדפדפן");
  }
  if (!state.entrances.length) {
    let old = "";
    try { old = localStorage.getItem(OLD_HOSPITAL_KEY) || ""; } catch (e) {}
    $("hospital").value = state.hospital || old;
  }
}

function renderEntrances() {
  const list = state.entrances;
  $("hospital-setup").hidden = list.length > 0;
  $("entrance-list").innerHTML = list.map((e) => `
    <li class="entrance">
      <div><b>${e.main ? "⭐ " : "🚪 "}${esc(e.label)}</b>${e.main ? ` <span class="muted">(כניסה ראשית)</span>` : ""}</div>
      ${e.address ? `<div class="muted">${esc(e.address)}</div>` : ""}
      <div class="muted coords">${fmtCoord(e)}</div>
      <div class="actions">
        <a class="link-btn" href="${esc(mapsLink(e))}" target="_blank" rel="noopener">פתיחה ב-Google Maps ↗</a>
        <button type="button" class="link-btn" data-edit="${esc(e.id)}">עריכה</button>
        <button type="button" class="link-btn danger" data-del="${esc(e.id)}">מחיקה</button>
      </div>
    </li>`).join("");
}

$("entrance-list").addEventListener("click", (ev) => {
  const edit = ev.target.closest("[data-edit]"), del = ev.target.closest("[data-del]");
  if (edit) openEditor(state.entrances.find((e) => e.id === edit.dataset.edit));
  if (del) {
    const e = state.entrances.find((x) => x.id === del.dataset.del);
    if (e && confirm(`למחוק את "${e.label}"?`)) {
      state.entrances = state.entrances.filter((x) => x.id !== e.id);
      commit();
    }
  }
});

$("hospital-save").addEventListener("click", async () => {
  const text = $("hospital").value.trim();
  const out = $("hospital-error");
  if (!text) { out.innerHTML = `<div class="error">יש להזין שם או כתובת של בית החולים.</div>`; return; }
  const btn = $("hospital-save");
  btn.disabled = true; out.innerHTML = "";
  const r = await postJson("/api/resolve-location", { text });
  btn.disabled = false;
  if (r.error) { out.innerHTML = `<div class="error">${esc(r.error)}</div>`; return; }
  state.hospital = text;
  const main = { id: newId(), label: "כניסה ראשית", main: true, lat: r.lat, lng: r.lng,
                 address: r.address, input: text, source: r.source };
  state.entrances = [main, ...state.entrances];
  try { localStorage.setItem(OLD_HOSPITAL_KEY, text); } catch (e) {}
  commit();
  if (r.approximate) setStatus("⚠️ המיקום משוער. כדאי לבדוק ולדייק בעריכה ← סיכה במפה");
});

$("add-entrance").addEventListener("click", () => openEditor(null));

// =====================================================================
// Entrance editor (dialog): address/description, map pin, coordinates/link
// =====================================================================
let editing = null;   // entrance being edited, or null for a new one
let draft = null;     // {lat, lng, address, source, input, approximate}
let mode = "address";

function openEditor(entrance) {
  editing = entrance;
  draft = entrance ? { lat: entrance.lat, lng: entrance.lng, address: entrance.address,
                       source: entrance.source, input: entrance.input } : null;
  $("editor-title").textContent = entrance ? `עריכת ${entrance.label}` : "כניסה חדשה";
  $("ent-label").value = entrance ? entrance.label : "";
  $("ent-address").value = entrance && entrance.source === "address" ? entrance.input : "";
  $("ent-paste").value = entrance && ["coords", "link"].includes(entrance.source) ? entrance.input : "";
  $("ent-error").innerHTML = "";
  setMode(entrance ? ({ map: "map", coords: "paste", link: "paste" }[entrance.source] || "address") : "address");
  renderDraft();
  $("entrance-dialog").showModal();
  if (!entrance) $("ent-label").focus();
}

function setMode(m) {
  mode = m;
  document.querySelectorAll(".seg button").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
  document.querySelectorAll("[data-panel]").forEach((p) => { p.hidden = p.dataset.panel !== m; });
  if (m === "map") showMap();
}
document.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));

function renderDraft() {
  const out = $("ent-found");
  $("ent-save").disabled = !draft;
  if (!draft) { out.innerHTML = ""; return; }
  out.innerHTML = `<div class="found ${draft.approximate ? "approx" : ""}">
    📍 ${draft.address ? esc(draft.address) + "<br>" : ""}<span class="coords">${fmtCoord(draft)}</span>
    ${draft.approximate ? "<br>⚠️ מיקום משוער. כדאי לדייק בלשונית \"סיכה במפה\"." : ""}
    <br><a href="${esc(mapsLink(draft))}" target="_blank" rel="noopener">בדיקה ב-Google Maps ↗</a>
    ${mode !== "map" ? ` · <button type="button" class="link-btn" id="ent-refine">דיוק על המפה</button>` : ""}
  </div>`;
  const refine = $("ent-refine");
  if (refine) refine.addEventListener("click", () => setMode("map"));
  if (marker) { marker.setPosition({ lat: draft.lat, lng: draft.lng }); marker.setVisible(true); }
}

async function resolveInto(text, btn) {
  $("ent-error").innerHTML = "";
  if (!text.trim()) { $("ent-error").innerHTML = `<div class="error">יש להזין ערך לחיפוש.</div>`; return; }
  btn.disabled = true;
  const r = await postJson("/api/resolve-location", { text });
  btn.disabled = false;
  if (r.error) { $("ent-error").innerHTML = `<div class="error">${esc(r.error)}</div>`; return; }
  draft = { lat: r.lat, lng: r.lng, address: r.address, source: r.source, input: text.trim(), approximate: r.approximate };
  renderDraft();
}
$("ent-address-go").addEventListener("click", (ev) => resolveInto($("ent-address").value, ev.currentTarget));
$("ent-paste-go").addEventListener("click", (ev) => resolveInto($("ent-paste").value, ev.currentTarget));
// Enter in a search box runs the search instead of submitting the dialog
[["ent-address", "ent-address-go"], ["ent-paste", "ent-paste-go"]].forEach(([inp, btn]) =>
  $(inp).addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); $(btn).click(); } }));

$("ent-cancel").addEventListener("click", () => $("entrance-dialog").close());

$("entrance-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  if (!draft) return;
  const label = $("ent-label").value.trim();
  if (!label) { $("ent-error").innerHTML = `<div class="error">יש לתת שם לכניסה.</div>`; return; }
  const fields = { label, lat: draft.lat, lng: draft.lng, address: draft.address || "",
                   source: draft.source, input: draft.input || "" };
  if (editing) Object.assign(editing, fields);
  else state.entrances.push({ id: newId(), main: false, ...fields });
  $("entrance-dialog").close();
  commit();
});

// ---- Google Maps JavaScript API (loaded only when the map is opened) -------
let mapsPromise = null, map = null, marker = null, refMarkers = [];

function loadMaps() {
  if (!window.MAPS_BROWSER_KEY) return Promise.reject(new Error("no-key"));
  if (!mapsPromise) {
    mapsPromise = new Promise((resolve, reject) => {
      window.__mapsReady = resolve;
      window.gm_authFailure = () => showMapError(
        "Google דחה את מפתח המפה. יש לוודא שה-Maps JavaScript API מופעל ושהמפתח מתיר את הכתובת הזו (ראו README).");
      const s = document.createElement("script");
      s.src = "https://maps.googleapis.com/maps/api/js?key=" + encodeURIComponent(window.MAPS_BROWSER_KEY) +
              "&language=he&region=IL&loading=async&callback=__mapsReady";
      s.async = true;
      s.onerror = () => { mapsPromise = null; reject(new Error("load")); };
      document.head.appendChild(s);
    }).then(() => Promise.all([google.maps.importLibrary("maps"), google.maps.importLibrary("marker")]));
  }
  return mapsPromise;
}

function showMapError(msg) {
  $("map").innerHTML = `<div class="error">${esc(msg)}</div>`;
  map = null; marker = null;
}

async function showMap() {
  try {
    await loadMaps();
  } catch (e) {
    showMapError(e.message === "no-key"
      ? "כדי להשתמש במפה צריך מפתח API בקובץ ‎.env (ראו README). אפשר בינתיים להדביק קואורדינטות."
      : "לא הצלחתי לטעון את Google Maps. יש לבדוק את החיבור לאינטרנט.");
    return;
  }
  const others = state.entrances.filter((e) => !editing || e.id !== editing.id);
  const center = draft || others.find((e) => e.main) || others[0] || { lat: 31.9, lng: 34.85 };
  if (!map) {
    map = new google.maps.Map($("map"), {
      center: { lat: center.lat, lng: center.lng }, zoom: draft || others.length ? 17 : 8,
      gestureHandling: "greedy", mapTypeControl: true, streetViewControl: false, clickableIcons: false,
    });
    marker = new google.maps.Marker({ map, draggable: true, visible: false });
    const place = (latLng) => {
      draft = { lat: latLng.lat(), lng: latLng.lng(), address: "", source: "map", input: "" };
      marker.setPosition(latLng); marker.setVisible(true);
      renderDraft();
    };
    map.addListener("click", (ev) => place(ev.latLng));
    marker.addListener("dragend", (ev) => place(ev.latLng));
  } else {
    map.setCenter({ lat: center.lat, lng: center.lng });
    if (draft || others.length) map.setZoom(17);
  }
  // other entrances as faded reference pins
  refMarkers.forEach((m) => m.setMap(null));
  refMarkers = others.map((e) => new google.maps.Marker({
    map, position: { lat: e.lat, lng: e.lng }, title: e.label, opacity: 0.5, clickable: false,
    label: { text: e.main ? "★" : "•", color: "#fff" },
  }));
  if (draft) { marker.setPosition({ lat: draft.lat, lng: draft.lng }); marker.setVisible(true); }
  else marker.setVisible(false);
}

// =====================================================================
// Tabs
// =====================================================================
document.querySelectorAll(".tab").forEach((btn) => btn.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
  $("tab-single").hidden = btn.dataset.tab !== "single";
  $("tab-csv").hidden = btn.dataset.tab !== "csv";
}));

function entrancesOrError(target) {
  if (state.entrances.length) return state.entrances;
  target.innerHTML = `<div class="error">יש להגדיר קודם את בית החולים (לפחות כניסה אחת).</div>`;
  $("hospital-section").scrollIntoView({ behavior: "smooth" });
  return null;
}

const checkAddress = (address, entrances) => postJson("/api/check", { address, entrances });

// =====================================================================
// Single address
// =====================================================================
$("single-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const out = $("single-result");
  const entrances = entrancesOrError(out);
  if (!entrances) return;
  const btn = ev.submitter || ev.target.querySelector("button");
  btn.disabled = true; btn.textContent = "בבדיקה… (יכול לקחת כחצי דקה לכל כניסה)";
  out.innerHTML = "";
  const r = await checkAddress($("address").value.trim(), entrances);
  btn.disabled = false; btn.textContent = "בדיקה";
  out.innerHTML = r.error ? `<div class="error">${esc(r.error)}</div>` : renderResult(r);
});

function renderResult(r) {
  let html = `<div class="card verdict ${r.suitable ? "ok" : "bad"}">${esc(r.verdict)}</div>`;
  for (const item of r.entrances) {
    const e = item.entrance, res = item.result;
    const isBest = e.id === r.best_entrance_id;
    const summary = res
      ? `${res.best_minutes} דק' · <span class="badge ${res.suitable ? "ok" : "bad"}">${res.suitable ? "מתאימה" : "לא מתאימה"}</span>`
      : `<span class="badge bad">שגיאה</span>`;
    html += `<details class="entrance-result" ${isBest || r.entrances.length === 1 ? "open" : ""}>
      <summary>${e.main ? "⭐" : "🚪"} ${esc(e.label)} · ${summary}${isBest && r.entrances.length > 1 ? " · הכי טובה" : ""}</summary>
      <div class="body">${res ? renderDestination(res, r) : `<div class="error">${esc(item.error)}</div>`}</div>
    </details>`;
  }
  html += `<p class="muted">קריאות API: ${r.api_calls} · מהמטמון: ${r.cache_hits}</p>`;
  return html;
}

function renderDestination(res, r) {
  const w = res.walk;
  let html = `<div class="card">
    <h2>🚶 הליכה</h2>
    <div class="big">${w.minutes} דק' <span class="muted">· ${(w.distance_m / 1000).toFixed(2)} ק"מ</span></div>
    ${w.ok ? `<span class="badge ok">מתאים להליכה</span>` : `<span class="badge bad">יותר מ-${esc(r.max_walk_minutes)} דק' הליכה</span>`}
  </div>`;
  html += `<div class="card"><h2>🚌 תחבורה ציבורית (קווים ישירים)</h2>`;
  html += res.options.length
    ? res.options.map((o) => renderOption(o, r)).join("")
    : `<div class="error">${esc(res.transit_message)}</div>`;
  return html + `</div>`;
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

// =====================================================================
// CSV mode
// =====================================================================
let csvResults = [];

$("csv-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const out = $("csv-result"), prog = $("csv-progress");
  const entrances = entrancesOrError(out);
  if (!entrances) return;
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
    const r = await checkAddress(rows[i].address, entrances);
    csvResults.push(toCsvRow(rows[i], r));
    renderCsvTable();
  }
  prog.innerHTML = `<div class="muted">הסתיים: נבדקו ${rows.length} כתובות.</div>`;
  btn.disabled = false;
});

function toCsvRow(row, r) {
  if (r.error) return { ...row, suitable: null, verdict: r.error, best_minutes: "", best_entrance: "", walk_minutes: "", direct_lines: "" };
  const best = r.entrances.find((i) => i.entrance.id === r.best_entrance_id).result;
  return {
    ...row,
    suitable: r.suitable,
    verdict: r.verdict,
    best_minutes: r.best_minutes,
    best_entrance: r.best_entrance_label,
    walk_minutes: best.walk.minutes,
    direct_lines: best.options.length
      ? best.options.map((o) => `${o.legs.map((l) => l.line).join("→")} (${o.total_min} דק'${o.meets_criteria ? ", ✓" : ""})`).join("; ")
      : best.transit_message,
  };
}

function sortedResults() {
  // by travel time; rows with errors last
  return [...csvResults].sort((a, b) =>
    (a.suitable === null) - (b.suitable === null) || (a.best_minutes || 1e9) - (b.best_minutes || 1e9));
}

function renderCsvTable() {
  const rows = sortedResults();
  const multi = state.entrances.length > 1;
  $("csv-result").innerHTML = `<div class="card">
    <div class="row-actions"><h2>תוצאות (${rows.filter((r) => r.suitable).length} מתאימות מתוך ${rows.length})</h2>
      <button class="secondary" id="csv-download">⬇️ הורדת CSV</button></div>
    <div class="table-wrap"><table>
      <thead><tr><th>כתובת</th><th>מחיר</th><th>הליכה</th><th>קו ישיר</th><th>זמן מיטבי</th>${multi ? "<th>כניסה</th>" : ""}<th>התאמה</th></tr></thead>
      <tbody>${rows.map((r) => {
        const url = safeUrl(r.link);
        const addr = url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(r.address)}</a>` : esc(r.address);
        const mark = r.suitable === null ? `<span class="badge bad">שגיאה</span>`
          : `<span class="badge ${r.suitable ? "ok" : "bad"}">${r.suitable ? "מתאימה" : "לא מתאימה"}</span>`;
        return `<tr><td>${addr}</td><td>${esc(r.price)}</td>
          <td>${r.walk_minutes !== "" ? esc(r.walk_minutes) + " דק'" : ""}</td>
          <td>${esc(r.direct_lines)}</td>
          <td>${r.best_minutes !== "" ? esc(r.best_minutes) + " דק'" : ""}</td>
          ${multi ? `<td>${esc(r.best_entrance)}</td>` : ""}
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

initEntrances();
