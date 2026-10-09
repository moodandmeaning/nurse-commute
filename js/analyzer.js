// Commute analysis: walking, direct transit lines, frequency per time window, verdict.
import { RoutesError } from "./routes.js";

export const VEHICLE_HE = {
  BUS: "אוטובוס", INTERCITY_BUS: "אוטובוס בינעירוני", TROLLEYBUS: "טרוליבוס",
  SHARE_TAXI: "מונית שירות", LIGHT_RAIL: "רכבת קלה", TRAM: "רכבת קלה",
  SUBWAY: "רכבת תחתית", METRO_RAIL: "מטרו", HEAVY_RAIL: "רכבת",
  COMMUTER_TRAIN: "רכבת", HIGH_SPEED_TRAIN: "רכבת", RAIL: "רכבת",
  CABLE_CAR: "רכבל", FERRY: "מעבורת",
};
export const DAY_LABELS = { weekday: "יום חול", saturday: "שבת" };
export const NO_DIRECT_MSG = "אין קו ישיר מהכתובת הזו";
export const NO_TRANSIT_MSG = "לא נמצאו תוצאות תחבורה ציבורית בין הכתובות";
export const WALK_WARNING = "זמן ההליכה מחושב לכתובת הרשמית של בית החולים. כדאי לבדוק איפה נמצאת כניסת הצוות.";
// Errors about the apartment or the API itself, not about one specific entrance.
const GLOBAL_ERRORS = new Set(["address_not_found", "no_api_key", "auth", "quota", "network", "missing_input"]);

const MIN = 60 * 1000;

// ---- small helpers ----------------------------------------------------------
/** "123s" -> 123 */
export const seconds = (d) => (d ? parseFloat(String(d).replace(/s$/, "")) : 0);
export const minutesUp = (secs) => Math.ceil(secs / 60 - 1e-9);

/** RFC3339 (possibly with nanoseconds) -> epoch ms */
export function parseTime(value) {
  return Date.parse(value.replace(/(\.\d{3})\d+/, "$1"));
}

export const rfc3339 = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

const partsCache = new Map();
/** Wall-clock parts of an instant in a time zone. */
export function tzParts(ms, tz) {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
    partsCache.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}

/** Wall-clock time in a time zone -> epoch ms. */
export function zonedToMs(y, m, d, h, mi, tz) {
  const want = Date.UTC(y, m - 1, d, h, mi);
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const p = tzParts(guess, tz);
    const diff = want - Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
    if (!diff) break;
    guess += diff;
  }
  return guess;
}

export const hhmm = (ms, tz) => {
  const p = tzParts(ms, tz);
  return `${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}`;
};

/** Next weekday (settings.weekdays, Python numbering Mon=0..Sun=6) and next Saturday, after today. */
export function targetDates(nowMs, settings) {
  const p = tzParts(nowMs, settings.timezone);
  const base = Date.UTC(p.y, p.m - 1, p.d);
  const find = (ok) => {
    for (let i = 1; i <= 14; i++) {
      const dt = new Date(base + i * 864e5);
      if (ok((dt.getUTCDay() + 6) % 7)) return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
    }
    throw new Error("settings.weekdays is empty");
  };
  return { weekday: find((wd) => settings.weekdays.includes(wd)), saturday: find((wd) => wd === 5) };
}

export function windowStart(day, time, tz) {
  const [h, mi] = time.split(":").map(Number);
  return zonedToMs(day.y, day.m, day.d, h, mi, tz);
}

const fmtDate = (day) => `${String(day.d).padStart(2, "0")}/${String(day.m).padStart(2, "0")}/${day.y}`;

// ---- parsing transit routes ---------------------------------------------------
/** TRANSIT computeRoutes response -> options, keeping only allowed leg counts. */
export function routeOptions(response, settings) {
  const maxLegs = settings.direct_only ? 1 : settings.max_transit_legs_if_not_direct;
  const options = [];
  for (const route of response.routes || []) {
    const steps = (route.legs || []).flatMap((leg) => leg.steps || []);
    const transitIdx = steps.map((s, i) => (s.travelMode === "TRANSIT" ? i : -1)).filter((i) => i >= 0);
    if (!transitIdx.length || transitIdx.length > maxLegs) continue;
    const first = transitIdx[0], last = transitIdx[transitIdx.length - 1];
    const sum = (arr) => arr.reduce((a, s) => a + seconds(s.staticDuration), 0);
    const walkBefore = sum(steps.slice(0, first));
    const walkAfter = sum(steps.slice(last + 1));

    const legs = transitIdx.map((i) => {
      const td = steps[i].transitDetails || {};
      const sd = td.stopDetails || {};
      const line = td.transitLine || {};
      const vehicle = line.vehicle || {};
      const agency = (line.agencies || [{}])[0] || {};
      return {
        line: line.nameShort || line.name || "?",
        line_name: line.name || "",
        operator: agency.name || "",
        vehicle: VEHICLE_HE[vehicle.type] || (vehicle.name || {}).text || "",
        headsign: td.headsign || "",
        board_stop: (sd.departureStop || {}).name || "",
        alight_stop: (sd.arrivalStop || {}).name || "",
        departure: parseTime(sd.departureTime),
        arrival: parseTime(sd.arrivalTime),
        stop_count: td.stopCount,
      };
    });
    if (legs.some((l) => Number.isNaN(l.departure) || Number.isNaN(l.arrival))) continue;

    const dep = legs[0].departure, arr = legs[legs.length - 1].arrival;
    const inVehicle = (arr - dep) / 1000; // includes transfer waits if any
    options.push({
      key: legs.map((l) => `${l.line}|${l.operator}`).join(" + "),
      legs,
      transfers: legs.length - 1,
      departure: dep,
      walk_to_stop_sec: walkBefore,
      walk_from_stop_sec: walkAfter,
      in_vehicle_sec: inVehicle,
      total_sec: walkBefore + inVehicle + walkAfter,
    });
  }
  return options;
}

export function travelMinutes(option, settings) {
  return minutesUp(settings.transit_time_basis === "in_vehicle" ? option.in_vehicle_sec : option.total_sec);
}

// ---- frequency sampling ---------------------------------------------------------
/**
 * Collect up to N consecutive departures of one line inside [start, start + window length].
 * Each follow-up request asks to leave home one minute after the previous trip's
 * leave-home time (= boarding time - walk to stop), so the next vehicle is found.
 */
export async function sampleWindow(client, apartment, hospital, key, start, settings) {
  const end = start + settings.window_length_minutes * MIN;
  const wanted = settings.departures_per_window;
  const found = new Map();
  let t = start;
  for (let i = 0; i < wanted; i++) {
    const resp = await client.transit(apartment, hospital, rfc3339(t));
    const matches = routeOptions(resp, settings)
      .filter((o) => o.key === key && o.departure >= t && o.departure <= end && !found.has(o.departure))
      .sort((a, b) => a.departure - b.departure);
    if (!matches.length) break;
    for (const o of matches) { // alternatives can already include several departures of the line
      if (found.size < wanted && !found.has(o.departure)) found.set(o.departure, o);
    }
    if (found.size >= wanted) break;
    const lastDep = Math.max(...found.keys());
    const lastOpt = found.get(lastDep);
    t = lastDep - lastOpt.walk_to_stop_sec * 1000 + MIN;
  }

  const deps = [...found.keys()].sort((a, b) => a - b);
  const gaps = deps.slice(1).map((d, i) => (d - deps[i]) / MIN);
  const avgGap = gaps.length ? Math.round((gaps.reduce((a, b) => a + b, 0) / gaps.length) * 10) / 10 : null;
  const maxTravel = found.size ? Math.max(...[...found.values()].map((o) => travelMinutes(o, settings))) : null;

  const problems = [];
  if (deps.length < settings.min_departures_per_window) problems.push(deps.length ? "יציאה אחת בלבד בשעה" : "אין יציאות");
  if (avgGap !== null && avgGap > settings.max_gap_minutes) problems.push(`רווח ממוצע ${avgGap} דק'`);
  if (maxTravel !== null && maxTravel > settings.max_transit_minutes) problems.push(`נסיעה ${maxTravel} דק'`);

  return {
    departures: deps.map((d) => hhmm(d, settings.timezone)),
    count: deps.length,
    avg_gap: avgGap,
    travel_minutes: maxTravel,
    ok: problems.length === 0,
    problems,
  };
}

// ---- main entry points ------------------------------------------------------------
/** Analyze the apartment against every hospital entrance; the verdict uses the best entrance. */
export async function analyze(client, apartment, entrances, settings, nowMs = Date.now()) {
  apartment = (apartment || "").trim();
  if (!apartment) throw new RoutesError("יש להזין כתובת דירה.", "missing_input");
  if (!entrances || !entrances.length) throw new RoutesError("יש להגדיר לפחות כניסה אחת לבית החולים.", "missing_input");

  const settled = await Promise.allSettled(entrances.map((e) =>
    analyzeDestination(client, apartment, { lat: e.lat, lng: e.lng }, settings, nowMs)));
  const perEntrance = [];
  settled.forEach((s, i) => {
    const e = entrances[i];
    const item = { entrance: { id: e.id, label: e.label, lat: e.lat, lng: e.lng, main: Boolean(e.main) } };
    if (s.status === "fulfilled") item.result = s.value;
    else if (s.reason instanceof RoutesError && !GLOBAL_ERRORS.has(s.reason.code)) item.error = s.reason.messageHe;
    else throw s.reason;
    perEntrance.push(item);
  });

  const ok = perEntrance.filter((i) => i.result);
  if (!ok.length) {
    throw new RoutesError("לא נמצא מסלול הליכה לאף כניסה. ייתכן שכתובת הדירה לא נמצאה; כדאי להוסיף שם עיר.",
      "address_not_found");
  }
  const best = ok.reduce((a, b) => {
    const ka = [!a.result.suitable, a.result.best_minutes], kb = [!b.result.suitable, b.result.best_minutes];
    return kb[0] < ka[0] || (kb[0] === ka[0] && kb[1] < ka[1]) ? b : a;
  });
  const r = best.result;
  return {
    apartment,
    entrances: perEntrance,
    best_entrance_id: best.entrance.id,
    best_entrance_label: best.entrance.label,
    suitable: r.suitable,
    verdict: entrances.length > 1 ? `${r.verdict} (דרך ${best.entrance.label})` : r.verdict,
    best_minutes: r.best_minutes,
    max_walk_minutes: settings.max_walk_minutes,
    dates: r.dates,
    day_labels: DAY_LABELS,
    windows: r.windows,
    warning: WALK_WARNING,
  };
}

/** Full analysis to one destination (address string or {lat, lng}). */
export async function analyzeDestination(client, apartment, hospital, settings, nowMs = Date.now()) {
  const tz = settings.timezone;

  // A. walking
  const walkResp = await client.walk(apartment, hospital);
  if (!(walkResp.routes || []).length) throw new RoutesError("לא נמצא מסלול הליכה לכניסה הזו.", "no_walk_route");
  const w = walkResp.routes[0];
  const walkMin = minutesUp(seconds(w.duration));
  const walk = { minutes: walkMin, distance_m: w.distanceMeters || 0, ok: walkMin <= settings.max_walk_minutes };

  // B. discover direct lines: first query of every window on both days (in parallel)
  const days = targetDates(nowMs, settings);
  const slots = Object.entries(days).flatMap(([dayKey, day]) =>
    settings.windows.map((win) => ({ dayKey, win, start: windowStart(day, win.time, tz) })));
  const firstResponses = await Promise.all(slots.map((s) => client.transit(apartment, hospital, rfc3339(s.start))));
  const anyTransit = firstResponses.some((r) => (r.routes || []).length);
  const lines = new Map();
  for (const resp of firstResponses) {
    for (const o of routeOptions(resp, settings)) if (!lines.has(o.key)) lines.set(o.key, o);
  }
  const checked = [...lines.values()].sort((a, b) => a.total_sec - b.total_sec).slice(0, settings.max_lines_for_frequency);

  // C. frequency per line, per window, per day
  const options = await Promise.all(checked.map(async (o) => {
    const results = await Promise.all(slots.map((s) => sampleWindow(client, apartment, hospital, o.key, s.start, settings)));
    const freq = {};
    slots.forEach((s, i) => { (freq[s.dayKey] ||= {})[s.win.key] = results[i]; });
    const meets = settings.verdict_days.every((d) => settings.windows.every((win) => freq[d][win.key].ok));
    return {
      key: o.key,
      legs: o.legs.map(({ departure, arrival, ...rest }) => rest),
      transfers: o.transfers,
      walk_to_stop_min: minutesUp(o.walk_to_stop_sec),
      walk_from_stop_min: minutesUp(o.walk_from_stop_sec),
      in_vehicle_min: minutesUp(o.in_vehicle_sec),
      total_min: minutesUp(o.total_sec),
      frequency: freq,
      meets_criteria: meets,
    };
  }));

  const transitMessage = options.length ? null : (anyTransit ? NO_DIRECT_MSG : `${NO_DIRECT_MSG} (${NO_TRANSIT_MSG})`);

  // D. verdict
  const goodLines = options.filter((o) => o.meets_criteria);
  return {
    walk,
    options,
    transit_message: transitMessage,
    suitable: walk.ok || goodLines.length > 0,
    verdict: makeVerdict(walk, options, goodLines, settings),
    best_minutes: Math.min(walkMin, ...options.map((o) => o.total_min)),
    dates: Object.fromEntries(Object.entries(days).map(([k, d]) => [k, fmtDate(d)])),
    day_labels: DAY_LABELS,
    windows: settings.windows.map(({ key, label, time }) => ({ key, label, time })),
    warning: WALK_WARNING,
  };
}

export function makeVerdict(walk, options, goodLines, settings) {
  if (walk.ok) return `✅ מתאימה: הליכה של ${walk.minutes} דקות בלבד`;
  const names = (o) => o.legs.map((l) => l.line).join(" ← ");
  if (goodLines.length) {
    const best = goodLines.reduce((a, b) => (b.total_min < a.total_min ? b : a));
    const kind = best.transfers === 0 ? "ישיר" : `עם ${best.transfers} החלפות`;
    return `✅ מתאימה: קו ${names(best)} ${kind}, ${best.total_min} דקות, ` +
      `יציאה לפחות כל ${settings.max_gap_minutes} דקות בכל החלונות`;
  }
  if (!options.length) return `❌ לא מתאימה: ${walk.minutes} דקות הליכה ו${NO_DIRECT_MSG}`;

  const labels = Object.fromEntries(settings.windows.map((w) => [w.key, w.label]));
  const failing = (o) => settings.verdict_days.flatMap((d) => settings.windows
    .filter((w) => !o.frequency[d][w.key].ok)
    .map((w) => labels[w.key] + (settings.verdict_days.length > 1 ? ` (${DAY_LABELS[d]})` : "")));
  const closest = options.reduce((a, b) => (failing(b).length < failing(a).length ? b : a));
  return `❌ לא מתאימה: ${walk.minutes} דקות הליכה, והקו הקרוב ביותר (${names(closest)}) לא עומד בדרישות ` +
    `(עד ${settings.max_transit_minutes} דק', כל ${settings.max_gap_minutes} דק') בחלונות: ${failing(closest).join(", ")}`;
}
