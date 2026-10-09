# Nurse Commute 🏥

A small Flask web app with a Hebrew, RTL, mobile-friendly UI. It checks how easy it is to get from a rental apartment to a hospital:

- **Hospital entrances**: type the hospital once (it becomes the *main entrance*), then add as many entrances as you like (e.g. "Staff entrance") by address/description, by dropping a pin on a map, or by pasting coordinates / a Google Maps link. Edit, rename or delete any of them. Every entrance is checked, and the verdict uses the best one.
- **Walking** time and distance (marked "suitable for walking" at ≤ 8 min)
- **Direct public transit lines only** (exactly one transit leg, no transfers), with line, operator, stops, walk to the stop and total time
- **Frequency** per line in 4 windows (06:00, 14:00, 22:00, 03:00), on the next weekday (Sun–Thu) and on Saturday: up to 4 consecutive departures, average gap
- **Verdict**: suitable if walking ≤ 8 min, OR a direct line ≤ 15 min with a departure at least every 20 min in all four windows
- **CSV mode**: upload `address,price,link`, get a sorted table with suitable/not suitable marking, download it as CSV

Data comes from the Google **Routes API** (`computeRoutes`, `WALK` + `TRANSIT`), the **Geocoding API** (turning hospital names / entrance descriptions into coordinates) and the **Maps JavaScript API** (the pin-drop map).

## 1. Get an API key

1. Go to <https://console.cloud.google.com/> and create a project (or pick an existing one).
2. Enable billing for the project (Google requires it, and the free monthly credit covers personal use).
3. Open **APIs & Services → Library** and **Enable** each of these:
   - **Routes API**
   - **Geocoding API**
   - **Maps JavaScript API**
4. Open **APIs & Services → Credentials → Create credentials → API key**.
5. Recommended: click the key → **API restrictions → Restrict key** → select the three APIs above.
6. Copy `.env.example` to `.env` and paste the key:
   ```
   GOOGLE_MAPS_API_KEY=AIza...
   ```
   `.env` is in `.gitignore` and is never committed.

**Map key (optional but recommended).** The pin-drop map runs in your browser, so its key is visible in the page source. If `GOOGLE_MAPS_BROWSER_KEY` isn't set, the app reuses `GOOGLE_MAPS_API_KEY`. That's fine while the app only runs on your own computer. For extra safety, create a second key restricted to **Maps JavaScript API** with an **HTTP referrer** restriction of `http://127.0.0.1:5000/*` and `http://localhost:5000/*`, and put it in `.env`:
```
GOOGLE_MAPS_BROWSER_KEY=AIza...
```

## 2. Run

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python app.py
```
Open <http://127.0.0.1:5000> (on your phone, run with `--host` on your LAN, or just use the desktop browser's mobile view).

Tests (no API key needed, they use a fake Routes client):
```powershell
.venv\Scripts\python -m pytest -q
```

## 3. Hospital entrances

- The first time, type the hospital name or address and click **save as main entrance**. The app finds its coordinates.
- **➕ Add entrance**: give it a name (e.g. "Staff entrance") and set its location in one of three ways:
  - **Address / description**: e.g. `שיבא כניסה מזרחית`. If Google's match is only approximate, you'll be told so and can fix it on the map.
  - **Map pin**: click the map (satellite view helps) and drag the pin. Other entrances are shown faded for reference.
  - **Coordinates / link**: `32.0461, 34.8516`, or any Google Maps link, including short `maps.app.goo.gl/...` links (the server follows their redirect, and only to Google domains). Waze `ll=` links work too.
- Every entrance is stored as lat/lng, in the browser (localStorage) and in `data/entrances.json`. When the app opens, the newer of the two is used, so your entrances are always there. `data/` is in `.gitignore` because it's personal location data.
- Each apartment check runs the full analysis for every entrance (more entrances = more API calls the first time; results are cached).

## 4. Settings: `settings.json`

Changes take effect on the next check, with no restart needed.

| key | meaning | default |
|---|---|---|
| `max_walk_minutes` | walking time that counts as suitable | 8 |
| `direct_only` | only lines with no transfers | true |
| `max_transit_legs_if_not_direct` | max legs when `direct_only` is false | 2 |
| `max_transit_minutes` | max travel time for a line | 15 |
| `transit_time_basis` | `total` (door to door) or `in_vehicle` | total |
| `max_gap_minutes` | max average gap between departures | 20 |
| `min_departures_per_window` | fewer departures than this fails the window (so a single hourly bus is never suitable) | 2 |
| `windows` | time windows to check | 06:00, 14:00, 22:00, 03:00 |
| `window_length_minutes` | only departures within this many minutes of the window start count | 60 |
| `departures_per_window` | consecutive departures to sample | 4 |
| `weekdays` | which days count as a "weekday" (Python: Mon=0 … Sun=6) | Sun–Thu |
| `verdict_days` | days that must pass for the verdict: `weekday`, `saturday` | `["weekday"]` |
| `max_lines_for_frequency` | how many direct lines to sample (controls API usage) | 3 |
| `cache_ttl_hours` | how long API responses are cached in `cache/` | 168 |

Saturday frequency is always shown. Add `"saturday"` to `verdict_days` if you work Shabbat shifts and need transit then. Note that most Israeli lines don't run on Shabbat.

## 5. How frequency is measured

For each line and window, the app calls `computeRoutes` (TRANSIT, `computeAlternativeRoutes: true`) at the window start, takes that line's departure, then calls again one minute after that trip's leave-home time, up to 4 departures. Departures that already appear among the alternatives are reused, and every response is cached on disk. A first check of an address costs roughly 8–60 API calls per entrance; repeat checks are free.

## Caveats

- Walking time for the main entrance is to the hospital's **official address**. Check where the staff entrance is, and add it as an entrance.
- Google only returns a few alternatives per request, so a rarely suggested line may be missed.
