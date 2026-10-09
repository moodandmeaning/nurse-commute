"""Commute analysis: walking, direct transit lines, frequency per time window, verdict."""
import math
import re
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from routes_client import RoutesError

VEHICLE_HE = {
    "BUS": "אוטובוס", "INTERCITY_BUS": "אוטובוס בינעירוני", "TROLLEYBUS": "טרוליבוס",
    "SHARE_TAXI": "מונית שירות", "LIGHT_RAIL": "רכבת קלה", "TRAM": "רכבת קלה",
    "SUBWAY": "רכבת תחתית", "METRO_RAIL": "מטרו", "HEAVY_RAIL": "רכבת",
    "COMMUTER_TRAIN": "רכבת", "HIGH_SPEED_TRAIN": "רכבת", "RAIL": "רכבת",
    "CABLE_CAR": "רכבל", "FERRY": "מעבורת",
}
DAY_LABELS = {"weekday": "יום חול", "saturday": "שבת"}
NO_DIRECT_MSG = "אין קו ישיר מהכתובת הזו"
NO_TRANSIT_MSG = "לא נמצאו תוצאות תחבורה ציבורית בין הכתובות"
WALK_WARNING = "זמן ההליכה מחושב לכתובת הרשמית של בית החולים. כדאי לבדוק איפה נמצאת כניסת הצוות."


# ---- small helpers ------------------------------------------------------
def seconds(duration):
    """'123s' -> 123"""
    if not duration:
        return 0
    return float(str(duration).rstrip("s"))


def minutes_up(secs):
    return int(math.ceil(secs / 60.0 - 1e-9))


def parse_time(value):
    # Google may send nanoseconds; Python handles up to microseconds.
    value = re.sub(r"(\.\d{6})\d+", r"\1", value).replace("Z", "+00:00")
    return datetime.fromisoformat(value)


def rfc3339(dt):
    return dt.astimezone(ZoneInfo("UTC")).strftime("%Y-%m-%dT%H:%M:%SZ")


def target_dates(now, settings):
    """Next weekday (per settings['weekdays']) and next Saturday, both strictly after today."""
    today = now.date()
    result = {}
    d = today + timedelta(days=1)
    while d.weekday() not in settings["weekdays"]:
        d += timedelta(days=1)
    result["weekday"] = d
    d = today + timedelta(days=1)
    while d.weekday() != 5:
        d += timedelta(days=1)
    result["saturday"] = d
    return result


def window_start(day: date, hhmm, tz):
    h, m = (int(x) for x in hhmm.split(":"))
    return datetime(day.year, day.month, day.day, h, m, tzinfo=tz)


# ---- parsing transit routes ----------------------------------------------
def route_options(response, settings, tz):
    """Turn a TRANSIT computeRoutes response into options, keeping only allowed leg counts."""
    max_legs = 1 if settings["direct_only"] else settings["max_transit_legs_if_not_direct"]
    options = []
    for route in response.get("routes", []):
        steps = [s for leg in route.get("legs", []) for s in leg.get("steps", [])]
        transit_idx = [i for i, s in enumerate(steps) if s.get("travelMode") == "TRANSIT"]
        if not transit_idx or len(transit_idx) > max_legs:
            continue
        first, last = transit_idx[0], transit_idx[-1]
        walk_before = sum(seconds(s.get("staticDuration")) for s in steps[:first])
        walk_after = sum(seconds(s.get("staticDuration")) for s in steps[last + 1:])

        legs = []
        for i in transit_idx:
            td = steps[i].get("transitDetails", {})
            sd = td.get("stopDetails", {})
            line = td.get("transitLine", {})
            vehicle = line.get("vehicle", {})
            agencies = line.get("agencies") or [{}]
            legs.append({
                "line": line.get("nameShort") or line.get("name") or "?",
                "line_name": line.get("name", ""),
                "operator": agencies[0].get("name", ""),
                "vehicle": VEHICLE_HE.get(vehicle.get("type", ""),
                                          (vehicle.get("name") or {}).get("text", "")),
                "headsign": td.get("headsign", ""),
                "board_stop": (sd.get("departureStop") or {}).get("name", ""),
                "alight_stop": (sd.get("arrivalStop") or {}).get("name", ""),
                "departure": parse_time(sd["departureTime"]).astimezone(tz),
                "arrival": parse_time(sd["arrivalTime"]).astimezone(tz),
                "stop_count": td.get("stopCount"),
            })

        dep, arr = legs[0]["departure"], legs[-1]["arrival"]
        in_vehicle = (arr - dep).total_seconds()  # includes transfer waits if any
        options.append({
            "key": " + ".join(f"{l['line']}|{l['operator']}" for l in legs),
            "legs": legs,
            "transfers": len(legs) - 1,
            "departure": dep,
            "walk_to_stop_sec": walk_before,
            "walk_from_stop_sec": walk_after,
            "in_vehicle_sec": in_vehicle,
            "total_sec": walk_before + in_vehicle + walk_after,
        })
    return options


def travel_minutes(option, settings):
    basis = option["in_vehicle_sec"] if settings["transit_time_basis"] == "in_vehicle" else option["total_sec"]
    return minutes_up(basis)


# ---- frequency sampling ---------------------------------------------------
def sample_window(client, apartment, hospital, key, start, settings, tz):
    """Collect up to N consecutive departures of one line inside [start, start+window_length].

    Each follow-up request asks to leave home one minute after the previous trip's
    leave-home time (= boarding time - walk to stop), so the next vehicle is found."""
    end = start + timedelta(minutes=settings["window_length_minutes"])
    wanted = settings["departures_per_window"]
    found = {}
    t = start
    for _ in range(wanted):
        resp = client.transit(apartment, hospital, rfc3339(t))
        matches = sorted(
            (o for o in route_options(resp, settings, tz)
             if o["key"] == key and t <= o["departure"] <= end and o["departure"] not in found),
            key=lambda o: o["departure"])
        if not matches:
            break
        for o in matches:  # alternatives can already include several departures of the line
            if len(found) < wanted:
                found[o["departure"]] = o
        if len(found) >= wanted:
            break
        last = max(found.values(), key=lambda o: o["departure"])
        t = last["departure"] - timedelta(seconds=last["walk_to_stop_sec"]) + timedelta(minutes=1)

    deps = sorted(found)
    gaps = [(b - a).total_seconds() / 60 for a, b in zip(deps, deps[1:])]
    avg_gap = round(sum(gaps) / len(gaps), 1) if gaps else None
    max_travel = max((travel_minutes(o, settings) for o in found.values()), default=None)

    problems = []
    if len(deps) < settings["min_departures_per_window"]:
        problems.append("אין יציאות" if not deps else "יציאה אחת בלבד בשעה")
    if avg_gap is not None and avg_gap > settings["max_gap_minutes"]:
        problems.append(f"רווח ממוצע {avg_gap:g} דק'")
    if max_travel is not None and max_travel > settings["max_transit_minutes"]:
        problems.append(f"נסיעה {max_travel} דק'")

    return {
        "departures": [d.strftime("%H:%M") for d in deps],
        "count": len(deps),
        "avg_gap": avg_gap,
        "travel_minutes": max_travel,
        "ok": not problems,
        "problems": problems,
    }


# ---- main entry point ------------------------------------------------------
# Errors that concern the apartment or the API itself, not a specific entrance.
GLOBAL_ERRORS = {"address_not_found", "no_api_key", "auth", "quota", "network", "missing_input"}


def analyze(client, apartment, entrances, settings, now=None):
    """Analyze the apartment against every hospital entrance; the verdict uses the best entrance."""
    apartment = (apartment or "").strip()
    if not apartment:
        raise RoutesError("יש להזין כתובת דירה.", "missing_input")
    if not entrances:
        raise RoutesError("יש להגדיר לפחות כניסה אחת לבית החולים.", "missing_input")

    per_entrance = []
    for e in entrances:
        item = {"entrance": {k: e.get(k) for k in ("id", "label", "lat", "lng", "main")}}
        try:
            item["result"] = analyze_destination(client, apartment, {"lat": e["lat"], "lng": e["lng"]},
                                                 settings, now)
        except RoutesError as err:
            if err.code in GLOBAL_ERRORS:
                raise
            item["error"] = err.message_he
        per_entrance.append(item)

    ok = [i for i in per_entrance if "result" in i]
    if not ok:
        raise RoutesError("לא נמצא מסלול הליכה לאף כניסה. ייתכן שכתובת הדירה לא נמצאה; כדאי להוסיף שם עיר.",
                          "address_not_found")

    best = min(ok, key=lambda i: (not i["result"]["suitable"], i["result"]["best_minutes"]))
    r = best["result"]
    verdict = r["verdict"]
    if len(entrances) > 1:
        verdict += f" (דרך {best['entrance']['label']})"
    return {
        "apartment": apartment,
        "entrances": per_entrance,
        "best_entrance_id": best["entrance"]["id"],
        "best_entrance_label": best["entrance"]["label"],
        "suitable": r["suitable"],
        "verdict": verdict,
        "best_minutes": r["best_minutes"],
        "max_walk_minutes": settings["max_walk_minutes"],
        "dates": r["dates"],
        "day_labels": DAY_LABELS,
        "windows": r["windows"],
        "warning": WALK_WARNING,
    }


def analyze_destination(client, apartment, destination, settings, now=None):
    """Full analysis to one destination (address string or {"lat", "lng"})."""
    hospital = destination
    tz = ZoneInfo(settings["timezone"])
    now = now or datetime.now(tz)

    # A. walking
    walk_resp = client.walk(apartment, hospital)
    if not walk_resp.get("routes"):
        raise RoutesError("לא נמצא מסלול הליכה לכניסה הזו.", "no_walk_route")
    w = walk_resp["routes"][0]
    walk_min = minutes_up(seconds(w.get("duration")))
    walk = {
        "minutes": walk_min,
        "distance_m": w.get("distanceMeters", 0),
        "ok": walk_min <= settings["max_walk_minutes"],
    }

    # B. discover direct lines: first query of every window on both days
    days = target_dates(now, settings)
    any_transit = False
    lines = {}
    for day_key, day in days.items():
        for win in settings["windows"]:
            resp = client.transit(apartment, hospital, rfc3339(window_start(day, win["time"], tz)))
            any_transit = any_transit or bool(resp.get("routes"))
            for o in route_options(resp, settings, tz):
                lines.setdefault(o["key"], o)

    ranked = sorted(lines.values(), key=lambda o: o["total_sec"])
    checked = ranked[: settings["max_lines_for_frequency"]]

    # C. frequency per line, per window, per day
    options = []
    for o in checked:
        freq = {}
        for day_key, day in days.items():
            freq[day_key] = {
                win["key"]: sample_window(client, apartment, hospital, o["key"],
                                          window_start(day, win["time"], tz), settings, tz)
                for win in settings["windows"]
            }
        meets = all(freq[d][w["key"]]["ok"] for d in settings["verdict_days"] for w in settings["windows"])
        options.append({
            "key": o["key"],
            "legs": [{k: v for k, v in leg.items() if k not in ("departure", "arrival")} for leg in o["legs"]],
            "transfers": o["transfers"],
            "walk_to_stop_min": minutes_up(o["walk_to_stop_sec"]),
            "walk_from_stop_min": minutes_up(o["walk_from_stop_sec"]),
            "in_vehicle_min": minutes_up(o["in_vehicle_sec"]),
            "total_min": minutes_up(o["total_sec"]),
            "frequency": freq,
            "meets_criteria": meets,
        })

    transit_message = None
    if not options:
        transit_message = NO_DIRECT_MSG if any_transit else f"{NO_DIRECT_MSG} ({NO_TRANSIT_MSG})"

    # D. verdict
    good_lines = [o for o in options if o["meets_criteria"]]
    suitable = walk["ok"] or bool(good_lines)
    verdict = make_verdict(walk, options, good_lines, settings)

    best_minutes = min([walk_min] + [o["total_min"] for o in options])
    return {
        "walk": walk,
        "options": options,
        "transit_message": transit_message,
        "suitable": suitable,
        "verdict": verdict,
        "best_minutes": best_minutes,
        "dates": {k: v.strftime("%d/%m/%Y") for k, v in days.items()},
        "day_labels": DAY_LABELS,
        "windows": [{"key": w["key"], "label": w["label"], "time": w["time"]} for w in settings["windows"]],
        "warning": WALK_WARNING,
    }


def make_verdict(walk, options, good_lines, settings):
    if walk["ok"]:
        return f"✅ מתאימה: הליכה של {walk['minutes']} דקות בלבד"
    if good_lines:
        best = min(good_lines, key=lambda o: o["total_min"])
        names = " ← ".join(l["line"] for l in best["legs"])
        kind = "ישיר" if best["transfers"] == 0 else f"עם {best['transfers']} החלפות"
        return (f"✅ מתאימה: קו {names} {kind}, {best['total_min']} דקות, "
                f"יציאה לפחות כל {settings['max_gap_minutes']} דקות בכל החלונות")
    if not options:
        return f"❌ לא מתאימה: {walk['minutes']} דקות הליכה ו{NO_DIRECT_MSG}"
    labels = {w["key"]: w["label"] for w in settings["windows"]}

    def failing_windows(o):
        return [f"{labels[w]}" + (f" ({DAY_LABELS[d]})" if len(settings["verdict_days"]) > 1 else "")
                for d in settings["verdict_days"] for w, r in o["frequency"][d].items() if not r["ok"]]

    closest = min(options, key=lambda o: len(failing_windows(o)))
    failing = failing_windows(closest)
    return (f"❌ לא מתאימה: {walk['minutes']} דקות הליכה, והקו הקרוב ביותר "
            f"({' ← '.join(l['line'] for l in closest['legs'])}) לא עומד בדרישות "
            f"(עד {settings['max_transit_minutes']} דק', כל {settings['max_gap_minutes']} דק') "
            f"בחלונות: {', '.join(failing)}")
