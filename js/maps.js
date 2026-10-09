// Lazy loader for the Google Maps JavaScript API (map pin + geocoder).
let loading = null;
let authFailed = false;
const authListeners = new Set();

export const MAPS_AUTH_ERROR =
  "Google דחה את המפתח. יש לוודא שה-Maps JavaScript API מופעל ושהמפתח מתיר את האתר הזה (ראו README).";

export function onMapsAuthFailure(fn) { authListeners.add(fn); }

export function loadMaps(apiKey, language = "he", region = "IL") {
  if (!apiKey) return Promise.reject(new Error("no-key"));
  if (authFailed) return Promise.reject(new Error("auth"));
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      window.__nurseMapsReady = resolve;
      window.gm_authFailure = () => {
        authFailed = true;
        authListeners.forEach((fn) => fn());
      };
      const s = document.createElement("script");
      s.src = "https://maps.googleapis.com/maps/api/js?key=" + encodeURIComponent(apiKey) +
        `&language=${language}&region=${region}&loading=async&callback=__nurseMapsReady`;
      s.async = true;
      s.onerror = () => { loading = null; reject(new Error("load")); };
      document.head.appendChild(s);
    }).then(() => Promise.all([
      google.maps.importLibrary("maps"),
      google.maps.importLibrary("marker"),
      google.maps.importLibrary("geocoding"),
    ]));
  }
  return loading;
}
