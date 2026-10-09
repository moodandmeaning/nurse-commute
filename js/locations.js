// Hospital entrances: free text / coordinates / Google Maps links -> lat,lng, and validation.
import { RoutesError } from "./routes.js";

export const SOURCES = new Set(["address", "map", "coords", "link"]);
const SHORT_HOSTS = new Set(["maps.app.goo.gl", "goo.gl", "g.co"]);
const NUM = String.raw`[-+]?\d{1,3}(?:\.\d+)?`;
const COORDS_RE = new RegExp(String.raw`^\(?\s*(${NUM})\s*[,;\s]\s*(${NUM})\s*\)?$`);
// RTL/LTR marks sneak in when copying from Hebrew pages.
const BIDI_RE = /[‎‏‪-‮⁦-⁩]/g;

export const validLatLng = (lat, lng) => Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

export function parseCoordinates(text) {
  const m = String(text || "").replace(BIDI_RE, "").trim().match(COORDS_RE);
  if (!m) return null;
  const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
  return validLatLng(lat, lng) ? [lat, lng] : null;
}

const safeDecode = (s) => { try { return decodeURIComponent(s); } catch (e) { return s; } };

/** -> ["coords", [lat, lng]] | ["query", text] | null. Never fetches anything. */
export function parseMapsUrl(url) {
  let u;
  try { u = new URL(url); } catch (e) { return null; }
  const full = safeDecode(url);

  let m = full.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/); // exact place pin
  if (m) return ["coords", [parseFloat(m[1]), parseFloat(m[2])]];

  for (const key of ["q", "query", "ll", "destination", "daddr", "center", "sll"]) {
    for (const value of u.searchParams.getAll(key)) {
      const c = parseCoordinates(value);
      if (c) return ["coords", c];
    }
  }

  m = full.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/); // map centre
  if (m) {
    const c = [parseFloat(m[1]), parseFloat(m[2])];
    if (validLatLng(...c)) return ["coords", c];
  }

  m = u.pathname.match(/\/maps\/(?:place|search)\/([^/@?]+)/);
  if (m) {
    const text = safeDecode(m[1].replace(/\+/g, " ")).trim();
    const c = parseCoordinates(text);
    return c ? ["coords", c] : ["query", text];
  }

  for (const key of ["q", "query", "destination", "daddr"]) {
    const v = (u.searchParams.get(key) || "").trim();
    if (v) return ["query", v];
  }
  return null;
}

export const looksLikeUrl = (text) =>
  /^(https?:\/\/|www\.|maps\.app\.goo\.gl\/|goo\.gl\/|maps\.google\.)/i.test(text);

/** Free text, coordinates or a maps link -> {lat, lng, address, source, approximate}. */
export async function resolveLocation(text, client) {
  text = String(text || "").replace(BIDI_RE, "").trim();
  if (!text) throw new RoutesError("יש להזין כתובת, תיאור, קואורדינטות או קישור.", "missing_input");

  const c = parseCoordinates(text);
  if (c) return { lat: c[0], lng: c[1], address: "", source: "coords", approximate: false };

  if (looksLikeUrl(text)) {
    const url = /^https?:\/\//i.test(text) ? text : "https://" + text;
    let host = "";
    try { host = new URL(url).hostname.toLowerCase(); } catch (e) { /* handled below */ }
    if (SHORT_HOSTS.has(host)) {
      throw new RoutesError(
        "קישור מקוצר (maps.app.goo.gl) לא נתמך. אפשר לפתוח אותו ולהעתיק את הקישור המלא מהדפדפן, " +
        "או בגוגל מפות: לחיצה ארוכה על המקום והעתקת הקואורדינטות שמופיעות למעלה.", "bad_link");
    }
    const parsed = parseMapsUrl(url);
    if (!parsed) throw new RoutesError("לא מצאתי מיקום בקישור. אפשר לנסות להעתיק קואורדינטות מ-Google Maps.", "bad_link");
    const [kind, value] = parsed;
    if (kind === "coords") return { lat: value[0], lng: value[1], address: "", source: "link", approximate: false };
    return { ...(await client.geocode(value)), source: "link" };
  }

  return { ...(await client.geocode(text)), source: "address" };
}

// ---- validation (used for imported files) ---------------------------------------
const txt = (v, limit) => String(v ?? "").trim().slice(0, limit);

export function validateEntrance(e) {
  if (!e || typeof e !== "object") throw new RoutesError("מבנה כניסה אינו תקין.", "bad_input");
  const lat = Number(e.lat), lng = Number(e.lng);
  if (e.lat === undefined || e.lng === undefined || Number.isNaN(lat) || Number.isNaN(lng)) {
    throw new RoutesError("לכל כניסה חייבות להיות קואורדינטות.", "bad_input");
  }
  if (!validLatLng(lat, lng)) throw new RoutesError("קואורדינטות לא תקינות.", "bad_input");
  return {
    id: txt(e.id, 64) || `e${Date.now()}${Math.random().toString(16).slice(2)}`,
    label: txt(e.label, 80) || "כניסה",
    lat: Math.round(lat * 1e7) / 1e7,
    lng: Math.round(lng * 1e7) / 1e7,
    address: txt(e.address, 300),
    input: txt(e.input, 2000),
    source: SOURCES.has(e.source) ? e.source : "coords",
    main: Boolean(e.main),
  };
}

export function validateState(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.entrances ?? [])) {
    throw new RoutesError("מבנה נתוני הכניסות אינו תקין.", "bad_input");
  }
  return {
    updated_at: Number.parseInt(payload.updated_at, 10) || 0,
    hospital: txt(payload.hospital, 200),
    entrances: (payload.entrances || []).map(validateEntrance),
  };
}
