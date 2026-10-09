# Nurse Commute 🏥

A small Flask web app with a Hebrew, RTL, mobile-friendly UI. It checks how easy it is to get from a rental apartment to a hospital:

- **Walking** time and distance (marked "suitable for walking" at ≤ 8 min)
- **Direct public transit lines only** (exactly one transit leg, no transfers), with line, operator, stops, walk to the stop and total time
- **Frequency** per line in 4 windows (06:00, 14:00, 22:00, 03:00), on the next weekday (Sun–Thu) and on Saturday: up to 4 consecutive departures, average gap
- **Verdict**: suitable if walking ≤ 8 min, OR a direct line ≤ 15 min with a departure at least every 20 min in all four windows
- **CSV mode**: upload `address,price,link`, get a sorted table with suitable/not suitable marking, download it as CSV

Data comes from the Google **Routes API** (`computeRoutes`, `WALK` + `TRANSIT`).

## 1. Get an API key

1. Go to <https://console.cloud.google.com/> and create a project (or pick an existing one).
2. Enable billing for the project (Google requires it, and the free monthly credit covers personal use).
3. Open **APIs & Services → Library**, search for **Routes API**, and click **Enable**.
4. Open **APIs & Services → Credentials → Create credentials → API key**.
5. Recommended: click the key → **API restrictions → Restrict key → Routes API**.
6. Copy `.env.example` to `.env` and paste the key:
   ```
   GOOGLE_MAPS_API_KEY=AIza...
   ```
   `.env` is in `.gitignore` and is never committed.

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

## 3. Settings: `settings.json`

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

## How frequency is measured

For each line and window, the app calls `computeRoutes` (TRANSIT, `computeAlternativeRoutes: true`) at the window start, takes that line's departure, then calls again one minute after that trip's leave-home time, up to 4 departures. Departures that already appear among the alternatives are reused, and every response is cached on disk. A first check of an address costs roughly 8–60 API calls; repeat checks are free.

## Caveats

- Walking time is to the hospital's **official address**. Check where the staff entrance is.
- Google only returns a few alternatives per request, so a rarely suggested line may be missed.
