import { analyze, SHABBAT_NOTE } from "./analyzer.js";
import { cacheClear } from "./cache.js";
import { decodeBytes, exportCsv, readApartments } from "./csv.js";
import { resolveLocation, validateState } from "./locations.js";
import { loadMaps, MAPS_AUTH_ERROR, onMapsAuthFailure } from "./maps.js";
import { RoutesClient, RoutesError } from "./routes.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "");
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `e${Date.now()}${Math.random().toString(16).slice(2)}`);
const fmtCoord = (e) => `${Number(e.lat).toFixed(6)}, ${Number(e.lng).toFixed(6)}`;
const mapsLink = (e) => `https://www.google.com/maps/search/?api=1&query=${e.lat},${e.lng}`;
const errMsg = (e) => (e instanceof RoutesError ? e.messageHe : "שגיאה לא צפויה. כדאי לנסות שוב.");

const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
};

function download(text, filename, type) {
  const a = Object.assign(document.createElement("a"),
    { href: URL.createObjectURL(new Blob([text], { type })), download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

let settings = null;

// =====================================================================
// API key: pasted once per device, kept in localStorage only
// =====================================================================
const KEY_STORE = "nurse-commute:api-key";
const apiKey = () => (store.get(KEY_STORE) || "").trim();
const makeClient = () => new RoutesClient({ apiKey: apiKey(), settings });

function renderKey() {
  const has = Boolean(apiKey());
  $("key-section").hidden = has;
  $("key-status").textContent = has ? `🔑 מפתח שמור במכשיר (…${apiKey().slice(-4)})` : "🔑 אין מפתח שמור";
}

$("key-save").addEventListener("click", () => {
  const k = $("api-key").value.trim();
  if (!/^AIza[\w-]{30,}$/.test(k)) {
    $("key-error").innerHTML = `<div class="error">זה לא נראה כמו מפתח של Google (מתחיל ב-AIza).</div>`;
    return;
  }
  store.set(KEY_STORE, k);
  location.reload(); // the map script is loaded with the key, so start fresh
});

$("key-change").addEventListener("click", () => {
  $("key-section").hidden = false;
  $("api-key").value = "";
  $("key-section").scrollIntoView({ behavior: "smooth" });
  $("api-key").focus();
});

$("cache-clear").addEventListener("click", async () => {
  await cacheClear();
  $("cache-clear").textContent = "נוקה ✓";
});

// =====================================================================
// Entrances: saved in localStorage; export/import as a JSON file
// =====================================================================
const STORE_KEY = "nurse-commute:entrances";
let state = { updated_at: 0, hospital: "", entrances: [] };

function readLocal() {
  try {
    return validateState(JSON.parse(store.get(STORE_KEY)));
  } catch (e) { return null; }
}

function setStatus(text) { $("entrance-status").textContent = text; }

function commit() {
  state.updated_at = Date.now();
  setStatus(store.set(STORE_KEY, JSON.stringify(state)) ? "נשמר ✓" : "⚠️ השמירה במכשיר נכשלה");
  renderEntrances();
}

function renderEntrances() {
  const list = state.entrances;
  $("hospital-setup").hidden = list.length > 0;
  if (!list.length) $("hospital").value = state.hospital || "";
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
  try {
    const r = await resolveLocation(text, makeClient());
    state.hospital = text;
    state.entrances = [{ id: newId(), label: "כניסה ראשית", main: true, lat: r.lat, lng: r.lng,
                         address: r.address, input: text, source: r.source }, ...state.entrances];
    commit();
    if (r.approximate) setStatus("⚠️ המיקום משוער. כדאי לבדוק ולדייק בעריכה ← סיכה במפה");
  } catch (e) {
    out.innerHTML = `<div class="error">${esc(errMsg(e))}</div>`;
  } finally {
    btn.disabled = false;
  }
});

$("add-entrance").addEventListener("click", () => openEditor(null));

$("entrances-export").addEventListener("click", () => {
  download(JSON.stringify(state, null, 2), "hospital-entrances.json", "application/json");
});

$("entrances-import").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = "";
  if (!file) return;
  try {
    const imported = validateState(JSON.parse(decodeBytes(await file.arrayBuffer())));
    if (state.entrances.length && !confirm(`להחליף את ${state.entrances.length} הכניסות הקיימות ב-${imported.entrances.length} כניסות מהקובץ?`)) return;
    state = imported;
    commit();
    setStatus(`יובאו ${state.entrances.length} כניסות ✓`);
  } catch (e) {
    setStatus("⚠️ הקובץ אינו קובץ כניסות תקין");
  }
});

// =====================================================================
// Entrance editor (dialog): address/description, map pin, coordinates/link
// =====================================================================
let editing = null; // entrance being edited, or null for a new one
let draft = null;   // {lat, lng, address, source, input, approximate}
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
  renderDraft();
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
  try {
    const r = await resolveLocation(text, makeClient());
    draft = { lat: r.lat, lng: r.lng, address: r.address, source: r.source, input: text.trim(), approximate: r.approximate };
    renderDraft();
  } catch (e) {
    $("ent-error").innerHTML = `<div class="error">${esc(errMsg(e))}</div>`;
  } finally {
    btn.disabled = false;
  }
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

// ---- map (Google Maps JavaScript API, loaded on first use) ----------------
let map = null, marker = null, refMarkers = [];

function showMapError(msg) {
  $("map").innerHTML = `<div class="error">${esc(msg)}</div>`;
  map = null; marker = null;
}
onMapsAuthFailure(() => showMapError(MAPS_AUTH_ERROR));

async function showMap() {
  try {
    await loadMaps(apiKey(), settings.language_code, settings.region_code);
  } catch (e) {
    showMapError(e.message === "no-key"
      ? "כדי להשתמש במפה צריך להדביק מפתח Google API (🔑 בראש העמוד). אפשר בינתיים להדביק קואורדינטות."
      : e.message === "auth" ? MAPS_AUTH_ERROR : "לא הצלחתי לטעון את Google Maps. יש לבדוק את החיבור לאינטרנט.");
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

async function checkAddress(address, entrances) {
  const client = makeClient();
  try {
    const r = await analyze(client, address, entrances, settings);
    return { ...r, api_calls: client.apiCalls, cache_hits: client.cacheHits };
  } catch (e) {
    if (!(e instanceof RoutesError)) console.error(e);
    return { error: errMsg(e) };
  }
}

// =====================================================================
// Single address
// =====================================================================
$("single-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const out = $("single-result");
  const entrances = entrancesOrError(out);
  if (!entrances) return;
  const btn = ev.submitter || ev.target.querySelector("button");
  btn.disabled = true; btn.textContent = "בבדיקה… (יכול לקחת עד חצי דקה)";
  out.innerHTML = "";
  const r = await checkAddress($("address").value.trim(), entrances);
  btn.disabled = false; btn.textContent = "בדיקה";
  out.innerHTML = r.error ? `<div class="error">${esc(r.error)}</div>` : renderResult(r);
});

function renderResult(r) {
  let html = `<div class="card verdict ${r.suitable ? "ok" : "bad"}">${esc(r.verdict)}</div>
    <p class="note">🕯️ ${esc(r.shabbat_note)}</p>`;
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
  html += `<p class="muted">קריאות ל-Google: ${r.api_calls} · מהמטמון: ${r.cache_hits}</p>`;
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
  html += `</tbody></table></div>`;
  html += renderFridayInfo(o, r);
  return html + `</div>`;
}

/** Friday morning: informational only, never part of the verdict. */
function renderFridayInfo(o, r) {
  if (!r.friday_windows || !r.friday_windows.length) return "";
  const rows = r.friday_windows.map((win) => {
    const f = o.friday_info[win.key];
    const detail = f.count
      ? `<span class="times">${f.departures.map(esc).join(" · ")}</span>${f.avg_gap != null ? ` · כל ~${f.avg_gap} דק'` : ""}`
      : "אין יציאות";
    return `<div><b>${esc(win.label)}</b> <span class="muted">${esc(win.time)}</span>: ${detail}</div>`;
  }).join("");
  return `<div class="info-block">
    <div class="muted">שישי ${esc(r.dates.friday)}, לידיעה בלבד (לא משפיע על ההחלטה)</div>${rows}
  </div>`;
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

  let parsed;
  try { parsed = readApartments(decodeBytes(await file.arrayBuffer())); }
  catch (e) { parsed = { error: "לא הצלחתי לקרוא את הקובץ." }; }
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
    <p class="note">🕯️ ${esc(SHABBAT_NOTE)} · נבדקו ימים א'–ה' בלבד</p>
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
  $("csv-download").addEventListener("click", () =>
    download(exportCsv(sortedResults()), "apartments_results.csv", "text/csv;charset=utf-8"));
}

// =====================================================================
// Start
// =====================================================================
function renderCriteria() {
  const s = settings;
  $("criteria").innerHTML = `הקריטריונים: הליכה עד ${s.max_walk_minutes} דק', או קו ${s.direct_only ? "ישיר (בלי החלפות)" : "תחבורה ציבורית"}
    עד ${s.max_transit_minutes} דק' עם יציאה לפחות כל ${s.max_gap_minutes} דק' בכל החלונות
    (${s.windows.map((w) => `${esc(w.label)} ${esc(w.time)}`).join(", ")}) בימים א'–ה'. שבת לא נבדקת.`;
}

async function init() {
  try {
    settings = await (await fetch("settings.json", { cache: "no-cache" })).json();
  } catch (e) {
    document.querySelector("main").insertAdjacentHTML("afterbegin",
      `<div class="error">לא הצלחתי לטעון את ההגדרות. יש לבדוק את החיבור לאינטרנט ולרענן.</div>`);
    return;
  }
  renderCriteria();
  renderKey();
  state = readLocal() || state;
  renderEntrances();
}

init();
