# Nurse Commute: project notes

Hebrew RTL, mobile-first web app: checks how easy it is to get from a rental apartment to a hospital (walking + direct public transit + frequency). Built for a nurse looking for an apartment.

- Live: https://moodandmeaning.github.io/nurse-commute/ (GitHub Pages, `main` branch, repo root; repo is public)
- Static site, no server: plain HTML + ES modules in `js/`, no build step, no dependencies.

## Layout

- `index.html`: the page (Hebrew, `dir="rtl"`). `css/style.css`: styles with light/dark tokens.
- `js/app.js`: UI: API key box, entrances list + editor dialog + map, single-address mode, CSV mode.
- `js/analyzer.js`: the logic: walking, direct-line filtering, frequency sampling, Shabbat rules, verdict.
- `js/routes.js`: Google Routes API client (`computeRoutes`) + geocoding via the Maps JS Geocoder; Hebrew error mapping; one retry on 5xx.
- `js/locations.js`: parse coordinates / Google Maps links; validate entrances. `js/csv.js`: CSV parse/export. `js/cache.js`: IndexedDB response cache. `js/maps.js`: lazy Maps JS loader.
- `settings.json`: all criteria (the user's "settings file"). Read at page load.
- `tests/`: browser test suite (`tests/index.html`) with a fake Google client.
- `manifest.webmanifest`, `icons/`: Add to Home Screen.

## Requirements decided with the user (keep these)

- Walking ≤ 8 min → suitable. OR a **direct** line (exactly one transit leg; `computeAlternativeRoutes: true`, filter out multi-leg) ≤ 15 min door to door, with a departure at least every 20 min (avg gap, ≥ 2 departures) in **all four windows**: 06:00, 14:00, 22:00, 03:00. A line once an hour is never suitable.
- Frequency: up to 4 consecutive departures per window; the next request leaves home 1 min after the previous trip's leave-home time (boarding time − walk to stop), so buses aren't skipped when walk to stop > headway.
- **Shabbat is never checked** (Fri 14:00 → Sat 21:00, configurable): no requests, no departures counted. The verdict and CSV mode use the next regular weekday (Sun–Thu) only. The results show "לא נבדקה תחבורה ציבורית בשבת". Friday 06:00/10:00 shown as info only, never in the verdict.
- No direct line → "אין קו ישיר מהכתובת הזו". CSV: no direct line and walk > 8 → not suitable. Results sorted by best time; downloadable CSV with BOM.
- Hospital **entrances**: main entrance from the typed hospital name; unlimited extra entrances (address/description, map pin, coordinates/Google Maps link), editable/renamable/deletable; stored as lat/lng in localStorage, export/import JSON. Every entrance is analyzed; the verdict uses the best one. Short `maps.app.goo.gl` links can't be expanded in a browser, so the app explains how to copy coordinates.
- Show the warning about the hospital's official address vs. the staff entrance.
- All user-facing text in Hebrew; errors in clear Hebrew.

## API key (never commit it)

- The key is pasted into the app per device (localStorage). It's never in the repo. `.env` (gitignored) only holds it for local testing.
- Google Cloud project "My First Project". Key "Maps Platform API Key" is restricted to referrers `https://moodandmeaning.github.io/*` and `http://127.0.0.1:8000/*`, and to Routes, Geocoding and Maps JavaScript APIs. A new local port or domain must be added to the key's website list.
- Geocoding goes through the Maps JS Geocoder because the Geocoding REST web service rejects referrer-restricted keys.

## Working on it

- Run locally: `python -m http.server 8000 --bind 127.0.0.1`, open http://127.0.0.1:8000/ (port 8000 matches the key restriction).
- Tests: open http://127.0.0.1:8000/tests/. All must pass before pushing.
- Workflow the user asked for: commit with a clear English message and push to GitHub after every work session and every big change. Pages redeploys automatically (~1 min; phones may cache ~10 min).
- History: v1 was a Python/Flask server (see git history before commit 1fa0854); rewritten as a static app so it can run on GitHub Pages from a phone.
