// Google Routes API (computeRoutes) + geocoding, with a persistent cache.
import { cacheGet, cachePut } from "./cache.js";
import { loadMaps } from "./maps.js";

export const ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";
const WALK_FIELDS = "routes.duration,routes.distanceMeters";
const TRANSIT_FIELDS = [
  "routes.duration",
  "routes.distanceMeters",
  "routes.legs.steps.travelMode",
  "routes.legs.steps.staticDuration",
  "routes.legs.steps.distanceMeters",
  "routes.legs.steps.transitDetails",
].join(",");

/** Error with a Hebrew message that can be shown to the user. */
export class RoutesError extends Error {
  constructor(messageHe, code = "api_error") {
    super(messageHe);
    this.messageHe = messageHe;
    this.code = code;
  }
}

const NO_KEY = () => new RoutesError("חסר מפתח API. יש להדביק אותו בהגדרות (🔑) בראש העמוד.", "no_api_key");
const NETWORK = () => new RoutesError("אין חיבור לאינטרנט או ל-Google. כדאי לנסות שוב.", "network");

/** A string is an address; {lat, lng} is an exact location. */
export function waypoint(place) {
  if (place && typeof place === "object") {
    return { location: { latLng: { latitude: place.lat, longitude: place.lng } } };
  }
  return { address: place };
}

export class RoutesClient {
  constructor({ apiKey, settings, fetchFn }) {
    this.apiKey = (apiKey || "").trim();
    this.settings = settings;
    this.ttl = settings.cache_ttl_hours * 3600 * 1000;
    this.fetch = fetchFn || ((...a) => fetch(...a));
    this.apiCalls = 0;
    this.cacheHits = 0;
    this.inflight = new Map(); // identical requests share one network call
  }

  walk(origin, destination) {
    return this.compute(this.body(origin, destination, "WALK"), WALK_FIELDS);
  }

  transit(origin, destination, departureTimeRfc3339) {
    const body = this.body(origin, destination, "TRANSIT");
    body.departureTime = departureTimeRfc3339;
    body.computeAlternativeRoutes = true;
    return this.compute(body, TRANSIT_FIELDS);
  }

  body(origin, destination, mode) {
    return {
      origin: waypoint(origin),
      destination: waypoint(destination),
      travelMode: mode,
      languageCode: this.settings.language_code,
      regionCode: this.settings.region_code,
    };
  }

  async cached(key, produce) {
    const hit = await cacheGet(key, this.ttl);
    if (hit !== undefined) { this.cacheHits++; return hit; }
    if (!this.inflight.has(key)) {
      const p = produce().then(async (data) => { await cachePut(key, data); return data; })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return this.inflight.get(key);
  }

  compute(body, fields) {
    return this.cached(JSON.stringify([body, fields]), async () => {
      if (!this.apiKey) throw NO_KEY();
      for (let attempt = 0; ; attempt++) {
        this.apiCalls++;
        let resp;
        try {
          resp = await this.fetch(ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Goog-Api-Key": this.apiKey, "X-Goog-FieldMask": fields },
            body: JSON.stringify(body),
          });
        } catch (e) {
          throw NETWORK();
        }
        let data = {};
        try { data = await resp.json(); } catch (e) { /* empty body */ }
        if (resp.ok) return data;
        // Google occasionally answers 5xx for a moment; retry once before giving up.
        if (resp.status >= 500 && attempt === 0) {
          await new Promise((r) => setTimeout(r, this.retryDelayMs ?? 1500));
          continue;
        }
        throw errorFromResponse(resp.status, data);
      }
    });
  }

  /** Address or description -> {lat, lng, address, approximate}. Uses the Maps JS geocoder. */
  async geocode(query) {
    const { language_code: lang, region_code: region } = this.settings;
    const data = await this.cached(JSON.stringify(["geocode", query, lang, region]), async () => {
      if (!this.apiKey) throw NO_KEY();
      try {
        await loadMaps(this.apiKey, lang, region);
      } catch (e) {
        throw e.message === "auth"
          ? new RoutesError("Google דחה את המפתח. יש לוודא שה-Maps JavaScript API וה-Geocoding API מופעלים (ראו README).", "auth")
          : NETWORK();
      }
      this.apiCalls++;
      try {
        const { results } = await new google.maps.Geocoder().geocode({ address: query, region });
        const top = results[0];
        return {
          lat: top.geometry.location.lat(),
          lng: top.geometry.location.lng(),
          address: top.formatted_address || "",
          approximate: Boolean(top.partial_match) || top.geometry.location_type === "APPROXIMATE",
        };
      } catch (e) {
        if (e.code === "ZERO_RESULTS") return null; // cache "not found" too
        throw geocodeError(e.code);
      }
    });
    if (!data) throw new RoutesError("המיקום לא נמצא. אפשר לנסות ניסוח אחר או לסמן סיכה במפה.", "location_not_found");
    return data;
  }
}

export function geocodeError(code) {
  if (code === "REQUEST_DENIED") {
    return new RoutesError("Google דחה את בקשת איתור הכתובת. יש לוודא שה-Geocoding API מופעל ושהמפתח נכון (ראו README).", "auth");
  }
  if (code === "OVER_QUERY_LIMIT") return new RoutesError("חרגת ממכסת הבקשות של Google. כדאי לנסות שוב בעוד כמה דקות.", "quota");
  return new RoutesError(`שגיאה מ-Google באיתור הכתובת (${code || "?"}).`, "api_error");
}

export function errorFromResponse(status, body) {
  const err = (body && body.error) || {};
  const msg = (err.message || "").toLowerCase();
  const reasons = new Set((err.details || []).map((d) => d && d.reason));
  if ([401, 403].includes(status) || ["PERMISSION_DENIED", "UNAUTHENTICATED"].includes(err.status) ||
      reasons.has("API_KEY_INVALID") || msg.includes("api key")) {
    if (msg.includes("referer") || reasons.has("API_KEY_HTTP_REFERRER_BLOCKED")) {
      return new RoutesError("המפתח מוגבל לאתרים אחרים. יש להוסיף את כתובת האתר הזה להגבלות המפתח (ראו README).", "auth");
    }
    if (msg.includes("has not been used") || msg.includes("disabled") || reasons.has("SERVICE_DISABLED")) {
      return new RoutesError("ה-Routes API לא מופעל בפרויקט ב-Google Cloud. יש להפעיל אותו (ראו README).", "auth");
    }
    return new RoutesError("מפתח ה-API נדחה. יש לוודא שהמפתח נכון ושה-Routes API מופעל בפרויקט (ראו README).", "auth");
  }
  if (status === 429) return new RoutesError("חרגת ממכסת הבקשות של Google. כדאי לנסות שוב בעוד כמה דקות.", "quota");
  if (msg.includes("geocod") || msg.includes("address") || err.status === "NOT_FOUND") {
    return new RoutesError("הכתובת לא נמצאה. כדאי לבדוק את האיות ולהוסיף שם עיר.", "address_not_found");
  }
  if (status >= 500) return new RoutesError("השירות של Google לא זמין כרגע. כדאי לנסות שוב בעוד דקה.", "api_error");
  return new RoutesError(`שגיאה מ-Google (${status}): ${err.message || ""}`.trim(), "api_error");
}
