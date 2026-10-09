// Browser test suite. Results are shown on the page and exposed as window.__testResults.
import * as A from "../js/analyzer.js";
import { decodeBytes, exportCsv, parseCsv, readApartments } from "../js/csv.js";
import { parseCoordinates, parseMapsUrl, resolveLocation, validateState } from "../js/locations.js";
import { errorFromResponse, geocodeError, RoutesClient, RoutesError, waypoint } from "../js/routes.js";

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function assert(cond, msg = "assertion failed") { if (!cond) throw new Error(msg); }
function eq(a, b, msg = "") {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${msg} expected ${jb}, got ${ja}`);
}
async function rejects(promiseFn, code) {
  try { await promiseFn(); } catch (e) {
    if (code) eq(e.code, code, "error code");
    return e;
  }
  throw new Error("expected an error");
}

const SETTINGS = await (await fetch("../settings.json")).json();
const TZ = "Asia/Jerusalem";
const NOW = A.zonedToMs(2026, 10, 9, 12, 0, TZ); // Friday
const SHEBA = { lat: 32.0461, lng: 34.8516 };
const MIN = 60000;
const pyWeekday = (ms) => { const p = A.tzParts(ms, TZ); return (new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() + 6) % 7; };
const SUN_THU = new Set([6, 0, 1, 2, 3]);

// ---- fake Google client ---------------------------------------------------------
const step = (mode, secs, td) => ({ travelMode: mode, staticDuration: `${secs}s`, ...(td ? { transitDetails: td } : {}) });
const transitStep = (line, dep, rideMin, operator = "דן") => step("TRANSIT", rideMin * 60, {
  headsign: "בית החולים",
  stopDetails: {
    departureStop: { name: "תחנה א" }, arrivalStop: { name: "שער בית החולים" },
    departureTime: A.rfc3339(dep), arrivalTime: A.rfc3339(dep + rideMin * MIN),
  },
  transitLine: { nameShort: line, agencies: [{ name: operator }], vehicle: { type: "BUS" } },
  stopCount: 4,
});

/** Line departs every `headway` minutes (aligned to local midnight + offset). */
class FakeClient {
  constructor({ walkMin = 20, headway = 10, ride = 8, walkTo = 3, walkFrom = 2, line = "5",
                direct = true, transit = true, offset = 1, activeHours = null, activeDays = null } = {}) {
    Object.assign(this, { walkMin, headway, ride, walkTo, walkFrom, line, direct, hasTransit: transit, offset, activeHours, activeDays });
    this.calls = []; this.apiCalls = 0; this.cacheHits = 0;
  }
  async walk() {
    if (this.walkMin === null) return {};
    return { routes: [{ duration: `${this.walkMin * 60 - 5}s`, distanceMeters: this.walkMin * 80 }] };
  }
  nextDep(earliest) {
    const p = A.tzParts(earliest, TZ);
    const midnight = A.zonedToMs(p.y, p.m, p.d, 0, 0, TZ);
    const mins = (earliest - midnight) / MIN;
    const k = Math.max(0, Math.ceil((mins - this.offset) / this.headway));
    let dep = midnight + (this.offset + k * this.headway) * MIN;
    const runs = (ms) => (!this.activeHours || this.activeHours.has(A.tzParts(ms, TZ).h)) &&
                         (!this.activeDays || this.activeDays.has(pyWeekday(ms)));
    for (let i = 0; i < 2000 && !runs(dep); i++) dep += this.headway * MIN;
    return dep;
  }
  async transit(o, d, t) {
    this.calls.push(t);
    if (!this.hasTransit) return {};
    const leave = Date.parse(t);
    const routes = [];
    let dep = this.nextDep(leave + this.walkTo * MIN);
    for (let i = 0; i < 2; i++) { // the API returns alternatives: next two departures
      const steps = [step("WALK", this.walkTo * 60), transitStep(this.line, dep, this.ride)];
      if (!this.direct) steps.push(transitStep("99", dep + (this.ride + 2) * MIN, 5));
      steps.push(step("WALK", this.walkFrom * 60));
      routes.push({ duration: "900s", legs: [{ steps }] });
      dep = this.nextDep(dep + MIN);
    }
    return { routes };
  }
}

const run = (client, settings = SETTINGS) => A.analyzeDestination(client, "הרצל 10, רמת גן", SHEBA, settings, NOW);
const MAIN = { id: "m", label: "כניסה ראשית", lat: 32.0461, lng: 34.8516, main: true };
const STAFF = { id: "s", label: "כניסת צוות", lat: 32.04, lng: 34.86, main: false };

// ---- time handling ------------------------------------------------------------------
test("dates are the next regular weekday and next Friday", () => {
  const d = A.targetDates(NOW, SETTINGS); // NOW is Friday 9/10
  eq(d.weekday, { y: 2026, m: 10, d: 11 }); // Sunday
  eq(d.friday, { y: 2026, m: 10, d: 16 });
  const thu = A.zonedToMs(2026, 10, 8, 12, 0, TZ);
  eq(A.targetDates(thu, SETTINGS).weekday, { y: 2026, m: 10, d: 11 }, "Thursday -> Sunday, skipping Fri/Sat");
});

test("Shabbat boundaries (Fri 14:00 to Sat 21:00) and custom times", () => {
  const at = (d, h, m) => A.isShabbat(A.zonedToMs(2026, 10, d, h, m, TZ), SETTINGS);
  eq([at(9, 13, 59), at(9, 14, 0), at(10, 3, 0), at(10, 20, 59), at(10, 21, 0), at(11, 3, 0)],
     [false, true, true, true, false, false]);
  const later = { ...SETTINGS, shabbat: { ...SETTINGS.shabbat, start_time: "16:00", end_time: "19:30" } };
  eq([A.isShabbat(A.zonedToMs(2026, 10, 9, 15, 0, TZ), later), A.isShabbat(A.zonedToMs(2026, 10, 10, 20, 0, TZ), later)],
     [false, false]);
});

test("weekdays setting that includes Friday/Saturday is ignored", () => {
  const s = { ...SETTINGS, weekdays: [4, 5, 6, 0, 1, 2, 3] };
  eq(A.regularWeekdays(s), [6, 0, 1, 2, 3]);
  const thu = A.zonedToMs(2026, 10, 8, 12, 0, TZ);
  eq(A.targetDates(thu, s).weekday, { y: 2026, m: 10, d: 11 });
});

test("zoned times are Israel time (summer and winter)", () => {
  eq(A.rfc3339(A.zonedToMs(2026, 10, 11, 6, 0, TZ)), "2026-10-11T03:00:00Z"); // IDT +3
  eq(A.rfc3339(A.zonedToMs(2026, 12, 6, 6, 0, TZ)), "2026-12-06T04:00:00Z"); // IST +2
  eq(A.hhmm(Date.parse("2026-10-11T03:05:00Z"), TZ), "06:05");
});

test("parseTime handles nanoseconds", () => {
  eq(A.parseTime("2026-10-11T03:05:00.123456789Z"), Date.parse("2026-10-11T03:05:00.123Z"));
});

// ---- analysis -------------------------------------------------------------------------
test("short walk is suitable", async () => {
  const r = await run(new FakeClient({ walkMin: 6 }));
  assert(r.walk.ok && r.suitable);
  assert(r.verdict.includes("הליכה של 6"), r.verdict);
});

test("frequent direct line is suitable", async () => {
  const r = await run(new FakeClient({ walkMin: 20, headway: 10 }));
  assert(!r.walk.ok);
  assert(r.suitable, r.verdict);
  const o = r.options[0];
  eq([o.legs[0].line, o.legs[0].operator], ["5", "דן"]);
  eq([o.walk_to_stop_min, o.total_min], [3, 13]);
  const morning = o.frequency.weekday.morning;
  eq(morning.departures, ["06:11", "06:21", "06:31", "06:41"]);
  eq(morning.avg_gap, 10);
});

test("consecutive buses found when walk to stop exceeds headway", async () => {
  const r = await run(new FakeClient({ walkMin: 30, headway: 5, walkTo: 6, walkFrom: 1, ride: 5 }));
  const f = r.options[0].frequency.weekday.afternoon;
  eq([f.count, f.avg_gap], [4, 5]);
});

test("hourly line is not suitable", async () => {
  const r = await run(new FakeClient({ walkMin: 20, headway: 60 }));
  assert(!r.suitable);
  const f = r.options[0].frequency.weekday.morning;
  assert(f.count <= 2 && !f.ok);
  assert(r.verdict.includes("לא מתאימה"));
});

test("line missing at night fails the night window", async () => {
  const hours = new Set(Array.from({ length: 19 }, (_, i) => i + 5));
  const r = await run(new FakeClient({ walkMin: 20, headway: 10, activeHours: hours }));
  assert(!r.suitable);
  assert(!r.options[0].frequency.weekday.night.ok);
  assert(r.options[0].frequency.weekday.morning.ok);
  assert(r.verdict.includes("לילה"), r.verdict);
});

test("slow line fails the time limit", async () => {
  const r = await run(new FakeClient({ walkMin: 20, headway: 10, ride: 20 }));
  assert(!r.suitable);
});

test("routes with transfers are filtered out", async () => {
  const r = await run(new FakeClient({ walkMin: 20, direct: false }));
  eq(r.options, []);
  eq(r.transit_message, "אין קו ישיר מהכתובת הזו");
  assert(!r.suitable);
});

test("transfers allowed when direct_only is false", async () => {
  const s = { ...SETTINGS, direct_only: false, max_transit_minutes: 30 };
  const r = await run(new FakeClient({ walkMin: 20, direct: false }), s);
  eq(r.options[0].transfers, 1);
});

test("no transit at all", async () => {
  const r = await run(new FakeClient({ walkMin: 20, transit: false }));
  assert(r.transit_message.startsWith("אין קו ישיר מהכתובת הזו"));
  assert(!r.suitable);
});

test("Shabbat is never queried", async () => {
  for (const now of [NOW, A.zonedToMs(2026, 10, 8, 23, 0, TZ), A.zonedToMs(2026, 10, 10, 22, 0, TZ)]) {
    const c = new FakeClient({ walkMin: 20, headway: 10 });
    await A.analyzeDestination(c, "x", SHEBA, SETTINGS, now);
    const bad = c.calls.filter((t) => A.isShabbat(Date.parse(t), SETTINGS) || pyWeekday(Date.parse(t)) === 5);
    eq(bad, [], "calls during Shabbat");
    assert(c.calls.length > 0);
  }
});

test("only weekday windows in frequency; Shabbat note present", async () => {
  const r = await run(new FakeClient({ walkMin: 20, headway: 10 }));
  eq(Object.keys(r.options[0].frequency), ["weekday"]);
  eq(r.shabbat_note, "לא נבדקה תחבורה ציבורית בשבת");
  eq(r.windows.map((w) => w.key), ["morning", "afternoon", "evening", "night"]);
});

test("line with no Friday/Shabbat service is still suitable", async () => {
  const r = await run(new FakeClient({ walkMin: 20, headway: 10, activeDays: SUN_THU }));
  assert(r.suitable, r.verdict);
  const fri = r.options[0].friday_info;
  eq(Object.keys(fri), ["fri_06", "fri_10"]);
  eq([fri.fri_06.count, fri.fri_10.count], [0, 0]);
  assert(!r.verdict.includes("שישי") && !r.verdict.includes("שבת"), r.verdict);
});

test("Friday info is shown but never changes the verdict", async () => {
  const off = await run(new FakeClient({ walkMin: 20, headway: 10 }), { ...SETTINGS, friday_info: { enabled: false, windows: [] } });
  const on = await run(new FakeClient({ walkMin: 20, headway: 10 }));
  eq([on.suitable, on.verdict], [off.suitable, off.verdict]);
  eq(on.options[0].friday_info.fri_06.departures, ["06:11", "06:21", "06:31", "06:41"]);
  eq(off.friday_windows, []);
});

test("a line that runs only on Friday is not suitable", async () => {
  const r = await run(new FakeClient({ walkMin: 20, headway: 10, activeDays: new Set([4]) }));
  assert(!r.suitable, r.verdict);
});

test("Friday window running into Shabbat stops at Shabbat start", async () => {
  const s = { ...SETTINGS, friday_info: { enabled: true, windows: [{ key: "fri_1330", label: "x", time: "13:30" }] } };
  const r = await run(new FakeClient({ walkMin: 20, headway: 10 }), s);
  eq(r.options[0].friday_info.fri_1330.departures, ["13:41", "13:51"]);
});

test("CSV path (analyze) uses weekdays only", async () => {
  const c = new FakeClient({ walkMin: 20, headway: 10, activeDays: SUN_THU });
  const r = await A.analyze(c, "x", [MAIN], SETTINGS, NOW);
  assert(r.suitable);
  eq(r.shabbat_note, "לא נבדקה תחבורה ציבורית בשבת");
});

test("apartment not found -> address_not_found", async () => {
  await rejects(() => A.analyze(new FakeClient({ walkMin: null }), "כתובת", [MAIN], SETTINGS, NOW), "address_not_found");
});

test("missing inputs", async () => {
  await rejects(() => A.analyze(new FakeClient(), "", [MAIN], SETTINGS, NOW), "missing_input");
  await rejects(() => A.analyze(new FakeClient(), "x", [], SETTINGS, NOW), "missing_input");
});

class PerEntranceClient {
  constructor(byLat) { this.byLat = byLat; }
  walk(o, d) { return this.byLat[d.lat].walk(o, d); }
  transit(o, d, t) { return this.byLat[d.lat].transit(o, d, t); }
}

test("best entrance wins", async () => {
  const c = new PerEntranceClient({ [MAIN.lat]: new FakeClient({ walkMin: 25, headway: 60 }), [STAFF.lat]: new FakeClient({ walkMin: 7 }) });
  const r = await A.analyze(c, "הרצל 10", [MAIN, STAFF], SETTINGS, NOW);
  assert(r.suitable);
  eq(r.best_entrance_label, "כניסת צוות");
  assert(r.verdict.includes("(דרך כניסת צוות)"), r.verdict);
  eq(r.entrances.map((i) => i.result.suitable), [false, true]);
});

test("one entrance failing does not break the others", async () => {
  const c = new PerEntranceClient({ [MAIN.lat]: new FakeClient({ walkMin: null }), [STAFF.lat]: new FakeClient({ walkMin: 20, headway: 10 }) });
  const r = await A.analyze(c, "הרצל 10", [MAIN, STAFF], SETTINGS, NOW);
  assert("error" in r.entrances[0]);
  eq(r.best_entrance_label, "כניסת צוות");
});

// ---- Google client -------------------------------------------------------------------
const jsonResp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test("error mapping", () => {
  eq(errorFromResponse(400, { error: { message: "Origin address could not be geocoded." } }).code, "address_not_found");
  eq(errorFromResponse(403, { error: { status: "PERMISSION_DENIED", message: "x" } }).code, "auth");
  eq(errorFromResponse(400, { error: { message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT",
    details: [{ reason: "API_KEY_INVALID" }] } }).code, "auth");
  const disabled = errorFromResponse(403, { error: { message: "Routes API has not been used in project 1 before or it is disabled." } });
  assert(disabled.messageHe.includes("לא מופעל"), disabled.messageHe);
  const ref = errorFromResponse(403, { error: { message: "Requests from referer https://x/ are blocked.", details: [{ reason: "API_KEY_HTTP_REFERRER_BLOCKED" }] } });
  assert(ref.messageHe.includes("מוגבל"), ref.messageHe);
  eq(errorFromResponse(429, {}).code, "quota");
  eq(geocodeError("REQUEST_DENIED").code, "auth");
  eq(geocodeError("OVER_QUERY_LIMIT").code, "quota");
});

test("client: no key -> Hebrew error", async () => {
  const c = new RoutesClient({ apiKey: "", settings: { ...SETTINGS, cache_ttl_hours: 0 } });
  const e = await rejects(() => c.walk("unique-no-key-" + Math.random(), SHEBA), "no_api_key");
  assert(e.messageHe.includes("מפתח"));
});

test("client: caches responses and shares identical in-flight requests", async () => {
  let calls = 0;
  const fetchFn = async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return jsonResp(200, { routes: [{ duration: "60s" }] }); };
  const c = new RoutesClient({ apiKey: "k", settings: SETTINGS, fetchFn });
  const origin = "cache-test-" + Math.random();
  await Promise.all([c.walk(origin, SHEBA), c.walk(origin, SHEBA)]);
  await c.walk(origin, SHEBA);
  eq(calls, 1);
  eq(c.cacheHits >= 1, true);
});

test("client: retries once on 5xx", async () => {
  let calls = 0;
  const fetchFn = async () => (++calls === 1 ? jsonResp(503, { error: { message: "unavailable" } }) : jsonResp(200, { routes: [] }));
  const c = new RoutesClient({ apiKey: "k", settings: SETTINGS, fetchFn });
  c.retryDelayMs = 1;
  eq(await c.walk("retry-" + Math.random(), SHEBA), { routes: [] });
  eq(calls, 2);
});

test("client: sends latLng waypoint and field mask", async () => {
  let sent;
  const fetchFn = async (url, opts) => { sent = { url, opts }; return jsonResp(200, {}); };
  const c = new RoutesClient({ apiKey: "KEY", settings: SETTINGS, fetchFn });
  await c.transit("addr-" + Math.random(), { lat: 32, lng: 34.8 }, "2026-10-11T03:00:00Z");
  const body = JSON.parse(sent.opts.body);
  eq(body.destination, { location: { latLng: { latitude: 32, longitude: 34.8 } } });
  eq([body.travelMode, body.computeAlternativeRoutes], ["TRANSIT", true]);
  eq(sent.opts.headers["X-Goog-Api-Key"], "KEY");
  assert(sent.opts.headers["X-Goog-FieldMask"].includes("routes.legs.steps.transitDetails"));
  eq(waypoint("x"), { address: "x" });
});

// ---- locations --------------------------------------------------------------------------
test("parse coordinates", () => {
  const cases = [
    ["32.0461, 34.8516", [32.0461, 34.8516]], ["32.0461 34.8516", [32.0461, 34.8516]],
    ["(32.0461,34.8516)", [32.0461, 34.8516]], ["‎32.0461, 34.8516‏", [32.0461, 34.8516]],
    ["-33.86, 151.2", [-33.86, 151.2]], ["95.0, 34.8", null], ["הרצל 10", null], ["10 20 30", null],
  ];
  for (const [t, want] of cases) eq(parseCoordinates(t), want, t);
});

test("parse Google Maps links", () => {
  const cases = [
    ["https://www.google.com/maps/place/Sheba/@32.04,34.85,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d32.0461!4d34.8516", ["coords", [32.0461, 34.8516]]],
    ["https://www.google.com/maps/@32.05,34.86,18z", ["coords", [32.05, 34.86]]],
    ["https://maps.google.com/?q=32.0461,34.8516", ["coords", [32.0461, 34.8516]]],
    ["https://www.google.com/maps/search/?api=1&query=32.0461%2C34.8516", ["coords", [32.0461, 34.8516]]],
    ["https://www.google.com/maps/dir/?api=1&destination=32.1,34.9", ["coords", [32.1, 34.9]]],
    ["https://www.google.com/maps/place/%D7%A9%D7%99%D7%91%D7%90", ["query", "שיבא"]],
    ["https://www.google.com/maps/search/?api=1&query=Sheba+Medical+Center", ["query", "Sheba Medical Center"]],
    ["https://waze.com/ul?ll=32.0461,34.8516&navigate=yes", ["coords", [32.0461, 34.8516]]],
    ["https://example.com/nothing", null],
  ];
  for (const [u, want] of cases) eq(parseMapsUrl(u), want, u);
});

class FakeGeocoder {
  constructor() { this.queries = []; }
  async geocode(q) { this.queries.push(q); return { lat: 32, lng: 34.8, address: "תוצאה", approximate: false }; }
}

test("resolve: coordinates, links, text, short links, empty", async () => {
  const g = new FakeGeocoder();
  let r = await resolveLocation("32.0461, 34.8516", g);
  eq([r.lat, r.lng, r.source], [32.0461, 34.8516, "coords"]);
  eq(g.queries, []);
  eq((await resolveLocation("https://maps.google.com/?q=32.1,34.9", g)).source, "link");
  r = await resolveLocation("https://www.google.com/maps/place/Sheba+Hospital", g);
  eq([r.source, g.queries], ["link", ["Sheba Hospital"]]);
  r = await resolveLocation("שיבא כניסה מזרחית", g);
  eq([r.source, g.queries.at(-1)], ["address", "שיבא כניסה מזרחית"]);
  const e = await rejects(() => resolveLocation("https://maps.app.goo.gl/abc", g), "bad_link");
  assert(e.messageHe.includes("קואורדינטות"));
  await rejects(() => resolveLocation("https://example.com/x", g), "bad_link");
  await rejects(() => resolveLocation("  ", g), "missing_input");
});

test("validate entrances state", async () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ ...STAFF, id: String(i) }));
  eq(validateState({ entrances: many }).entrances.length, 50);
  const v = validateState({ updated_at: 5, hospital: "שיבא", entrances: [MAIN] });
  eq([v.updated_at, v.entrances[0].main, v.entrances[0].source], [5, true, "coords"]);
  for (const bad of [{ entrances: [{ label: "x" }] }, { entrances: [{ label: "x", lat: 100, lng: 30 }] }, { entrances: "nope" }]) {
    let threw = false;
    try { validateState(bad); } catch (e) { threw = e instanceof RoutesError; }
    assert(threw, JSON.stringify(bad));
  }
});

// ---- CSV --------------------------------------------------------------------------------
test("CSV: quoted fields with commas and newlines", () => {
  eq(parseCsv('a,b\n"x, y","line1\nline2"\n"q ""quoted""",z'), [["a", "b"], ["x, y", "line1\nline2"], ['q "quoted"', "z"]]);
});

test("CSV: English and Hebrew headers, Windows-1255 encoding", () => {
  eq(readApartments('address,price,link\n"הרצל 10, רמת גן",5000,https://x.co/1\n,,\n').rows,
    [{ address: "הרצל 10, רמת גן", price: "5000", link: "https://x.co/1" }]);
  // "כתובת,מחיר\r\nהרצל 1,1" in windows-1255
  const bytes = new Uint8Array([0xeb, 0xfa, 0xe5, 0xe1, 0xfa, 0x2c, 0xee, 0xe7, 0xe9, 0xf8, 0x0d, 0x0a,
    0xe4, 0xf8, 0xf6, 0xec, 0x20, 0x31, 0x2c, 0x31]);
  eq(readApartments(decodeBytes(bytes.buffer)).rows, [{ address: "הרצל 1", price: "1", link: "" }]);
  assert(readApartments("foo,bar\n1,2\n").error);
});

test("CSV export has BOM, header, escaping and Hebrew marks", () => {
  const text = exportCsv([
    { address: "א, ב", price: "1", suitable: true, best_minutes: 7 },
    { address: "ג", suitable: false, best_minutes: 30 },
    { address: "ד", suitable: null, verdict: "שגיאה" },
  ]);
  assert(text.startsWith("﻿address,price,link,suitable"));
  assert(text.includes('"א, ב",1,,מתאימה,7'), text);
  assert(text.includes("לא מתאימה"));
});

// ---- runner --------------------------------------------------------------------------------
const results = [];
for (const t of tests) {
  try { await t.fn(); results.push({ name: t.name, ok: true }); }
  catch (e) { results.push({ name: t.name, ok: false, error: String(e && e.stack || e) }); }
}
const failed = results.filter((r) => !r.ok);
document.getElementById("summary").innerHTML =
  `<h2 class="${failed.length ? "fail" : "pass"}">${results.length - failed.length}/${results.length} passed</h2>`;
document.getElementById("out").innerHTML = results.map((r) =>
  `<div class="${r.ok ? "pass" : "fail"}">${r.ok ? "✓" : "✗"} ${r.name}</div>${r.ok ? "" : `<pre>${r.error.replace(/</g, "&lt;")}</pre>`}`).join("");
window.__testResults = results;
