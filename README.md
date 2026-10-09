# Nurse Commute 🏥

**Open the app: https://moodandmeaning.github.io/nurse-commute/**

A Hebrew, RTL, mobile-friendly web app that checks how easy it is to get from a rental apartment to a hospital. It runs entirely in your browser (hosted free on GitHub Pages) and talks directly to Google. There is no server, and nothing is stored anywhere except on your own device.

- **Hospital entrances**: type the hospital once (it becomes the *main entrance*), then add as many entrances as you like (e.g. "Staff entrance") by address/description, by dropping a pin on a map, or by pasting coordinates / a Google Maps link. Edit, rename or delete any of them. Every entrance is checked, and the verdict uses the best one.
- **Walking** time and distance (marked "suitable for walking" at ≤ 8 min)
- **Direct public transit lines only** (exactly one transit leg, no transfers), with line, operator, stops, walk to the stop and total time
- **Frequency** per line in 4 windows (06:00, 14:00, 22:00, 03:00) on the next regular weekday (Sun–Thu): up to 4 consecutive departures, average gap
- **Shabbat is never checked**: nothing between Friday 14:00 and Saturday 21:00 (configurable) is queried or counted, so missing Shabbat service never makes a line or apartment "not suitable". Results show "לא נבדקה תחבורה ציבורית בשבת". Friday morning (06:00, 10:00) is shown for information only.
- **Verdict** (weekdays only): suitable if walking ≤ 8 min, OR a direct line ≤ 15 min with a departure at least every 20 min in all four windows
- **CSV mode**: upload `address,price,link`, get a table sorted by travel time with suitable/not suitable marking, download it as CSV

Data comes from Google: the **Routes API** (`computeRoutes`, `WALK` + `TRANSIT`), the **Geocoding API** (via the Maps JavaScript geocoder) and the **Maps JavaScript API** (the pin-drop map).

## 1. Get a Google API key

1. Go to <https://console.cloud.google.com/> and create a project (or pick an existing one).
2. Enable billing for the project (Google requires it, and the free monthly credit covers personal use).
3. Open **APIs & Services → Library** and **Enable** each of these:
   - **Routes API**
   - **Geocoding API**
   - **Maps JavaScript API**
4. Open **APIs & Services → Credentials → Create credentials → API key**.
5. **Restrict the key.** It's used from a public web page, so this matters. Click the key, then:
   - **Application restrictions → Websites**, add:
     - `https://moodandmeaning.github.io/*`
     - `http://127.0.0.1:8000/*` (only if you run it locally, see below)
   - **API restrictions → Restrict key** → select Routes API, Geocoding API, Maps JavaScript API.
   - Save. It can take a few minutes to apply.

## 2. Use it on your phone

1. Open **https://moodandmeaning.github.io/nurse-commute/**.
2. Paste your API key in the 🔑 box. It's saved **only on that device** (browser storage) and only sent to Google. The key is never in this repository.
3. Add it to your home screen:
   - **iPhone (Safari):** Share button → *Add to Home Screen*.
   - **Android (Chrome):** ⋮ menu → *Add to Home screen* / *Install app*.

Each device (phone, computer) needs the key pasted once.

## 3. Hospital entrances

- The first time, type the hospital name or address and tap **save as main entrance**.
- **➕ Add entrance**: give it a name (e.g. "Staff entrance") and set its location in one of three ways:
  - **Address / description**: e.g. `שיבא כניסה מזרחית`. If Google's match is approximate you'll be told so, and can fix it on the map.
  - **Map pin**: tap the map (satellite view helps) and drag the pin. Other entrances are shown faded for reference.
  - **Coordinates / link**: `32.0461, 34.8516`, a full Google Maps link, or a Waze `ll=` link. Short `maps.app.goo.gl` links can't be read from a web page. Instead, long-press the spot in Google Maps and copy the coordinates shown at the top.
- Entrances are stored as lat/lng on the device and are there every time you open the app.
- **⚙️ Settings → Export / Import** saves them to a JSON file. Use it as a backup, or to move them to another device.

## 4. Settings: `settings.json`

The criteria live in `settings.json` in this repository. Edit and push it, and the app picks it up on the next load.

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
| `weekdays` | which days count as a regular weekday (Mon=0 … Sun=6). Days that touch Shabbat are always dropped | Sun–Thu |
| `shabbat` | period that's never checked: `start_day`/`start_time` to `end_day`/`end_time` (Fri=4, Sat=5) | Fri 14:00 → Sat 21:00 |
| `friday_info` | Friday windows shown for information only, never part of the verdict (`enabled: false` hides them) | 06:00, 10:00 |
| `max_lines_for_frequency` | how many direct lines to sample (controls API usage) | 3 |
| `cache_ttl_hours` | how long Google responses are cached on the device | 168 |

The verdict and CSV mode use regular weekdays only. A Friday window that runs into Shabbat stops counting at Shabbat start.

## 5. How frequency is measured

For each line and window, the app calls `computeRoutes` (TRANSIT, `computeAlternativeRoutes: true`) at the window start and takes that line's departure. It then calls again one minute after that trip's leave-home time, up to 4 departures. Departures already in the alternatives are reused, identical requests are shared, and every response is cached on the device (IndexedDB). A first check of an address costs roughly 10–40 API calls per entrance; repeat checks are free (⚙️ → *clear cache* resets this).

## 6. Run locally / tests

The app is plain HTML + JavaScript modules, so it needs a local web server (opening `index.html` directly won't work):

```powershell
python -m http.server 8000 --bind 127.0.0.1
```
Then open <http://127.0.0.1:8000/>. The tests run in the browser at <http://127.0.0.1:8000/tests/>. They use a fake Google client, so no key is needed.

## Caveats

- Walking time for the main entrance is to the hospital's **official address**. Check where the staff entrance is, and add it as an entrance.
- Google only returns a few alternatives per request, so a rarely suggested line may be missed.
