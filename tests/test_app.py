import io
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import analyzer  # noqa: E402
import app as webapp  # noqa: E402
from routes_client import RoutesClient, RoutesError, _error_from_response  # noqa: E402

TZ = ZoneInfo("Asia/Jerusalem")
NOW = datetime(2026, 10, 9, 12, 0, tzinfo=TZ)  # Friday
SETTINGS = webapp.load_settings()


def iso(dt):
    return dt.astimezone(ZoneInfo("UTC")).strftime("%Y-%m-%dT%H:%M:%SZ")


def step(mode, secs, td=None):
    s = {"travelMode": mode, "staticDuration": f"{secs}s"}
    if td:
        s["transitDetails"] = td
    return s


def transit_step(line, dep, ride_min, operator="דן"):
    return step("TRANSIT", ride_min * 60, {
        "headsign": "בית החולים",
        "stopDetails": {
            "departureStop": {"name": "תחנה א"}, "arrivalStop": {"name": "שער בית החולים"},
            "departureTime": iso(dep), "arrivalTime": iso(dep + timedelta(minutes=ride_min)),
        },
        "transitLine": {"nameShort": line, "agencies": [{"name": operator}], "vehicle": {"type": "BUS"}},
        "stopCount": 4,
    })


class FakeClient:
    """Line `line` departs every `headway` minutes (aligned to midnight + offset), all day."""

    def __init__(self, walk_min=20, headway=10, ride=8, walk_to=3, walk_from=2, line="5",
                 direct=True, transit=True, offset=1, active_hours=None):
        self.walk_min, self.headway, self.ride = walk_min, headway, ride
        self.walk_to, self.walk_from, self.line = walk_to, walk_from, line
        self.direct, self.has_transit, self.offset = direct, transit, offset
        self.active_hours = active_hours  # set of hours the line runs, None = always
        self.calls = []
        self.api_calls = self.cache_hits = 0

    def walk(self, o, d):
        if self.walk_min is None:
            return {}
        return {"routes": [{"duration": f"{self.walk_min * 60 - 5}s", "distanceMeters": self.walk_min * 80}]}

    def _next_dep(self, earliest):
        midnight = earliest.replace(hour=0, minute=0, second=0, microsecond=0)
        mins = (earliest - midnight).total_seconds() / 60
        k = max(0, -(-(mins - self.offset) // self.headway))
        dep = midnight + timedelta(minutes=self.offset + k * self.headway)
        while self.active_hours is not None and dep.hour not in self.active_hours:
            dep += timedelta(minutes=self.headway)
        return dep

    def transit(self, o, d, t):
        self.calls.append(t)
        if not self.has_transit:
            return {}
        leave = analyzer.parse_time(t).astimezone(TZ)
        routes = []
        dep = self._next_dep(leave + timedelta(minutes=self.walk_to))
        for _ in range(2):  # the API returns alternatives: next two departures
            steps = [step("WALK", self.walk_to * 60), transit_step(self.line, dep, self.ride)]
            if not self.direct:
                steps.append(transit_step("99", dep + timedelta(minutes=self.ride + 2), 5))
            steps.append(step("WALK", self.walk_from * 60))
            routes.append({"duration": "900s", "legs": [{"steps": steps}]})
            dep = self._next_dep(dep + timedelta(minutes=1))
        return {"routes": routes}


def run(client, settings=SETTINGS):
    return analyzer.analyze(client, "הרצל 10, רמת גן", "שיבא", settings, now=NOW)


def test_dates_are_next_sunday_and_saturday():
    d = analyzer.target_dates(NOW, SETTINGS)
    assert d["weekday"].isoformat() == "2026-10-11"
    assert d["saturday"].isoformat() == "2026-10-10"


def test_short_walk_is_suitable():
    r = run(FakeClient(walk_min=6))
    assert r["walk"]["ok"] and r["suitable"]
    assert "הליכה של 6" in r["verdict"]


def test_frequent_direct_line_is_suitable():
    r = run(FakeClient(walk_min=20, headway=10))
    assert not r["walk"]["ok"]
    assert r["suitable"], r["verdict"]
    o = r["options"][0]
    assert o["legs"][0]["line"] == "5" and o["legs"][0]["operator"] == "דן"
    assert o["walk_to_stop_min"] == 3 and o["total_min"] == 13
    morning = o["frequency"]["weekday"]["morning"]
    assert morning["departures"] == ["06:11", "06:21", "06:31", "06:41"]
    assert morning["avg_gap"] == 10


def test_consecutive_buses_found_when_walk_to_stop_exceeds_headway():
    # walk to stop 6 min, bus every 5 min: must still find 4 consecutive buses
    r = run(FakeClient(walk_min=30, headway=5, walk_to=6, walk_from=1, ride=5))
    f = r["options"][0]["frequency"]["weekday"]["afternoon"]
    assert f["count"] == 4 and f["avg_gap"] == 5


def test_hourly_line_is_not_suitable():
    r = run(FakeClient(walk_min=20, headway=60))
    assert not r["suitable"]
    f = r["options"][0]["frequency"]["weekday"]["morning"]
    assert f["count"] <= 2 and not f["ok"]
    assert "לא מתאימה" in r["verdict"]


def test_line_missing_at_night_fails_night_window():
    r = run(FakeClient(walk_min=20, headway=10, active_hours=set(range(5, 24))))
    assert not r["suitable"]
    assert not r["options"][0]["frequency"]["weekday"]["night"]["ok"]
    assert r["options"][0]["frequency"]["weekday"]["morning"]["ok"]
    assert "לילה" in r["verdict"]


def test_slow_line_fails_time_limit():
    r = run(FakeClient(walk_min=20, headway=10, ride=20))
    assert not r["suitable"]


def test_transfer_routes_are_filtered_out():
    r = run(FakeClient(walk_min=20, direct=False))
    assert r["options"] == []
    assert r["transit_message"] == "אין קו ישיר מהכתובת הזו"
    assert not r["suitable"]


def test_transfers_allowed_when_direct_only_disabled():
    s = dict(SETTINGS, direct_only=False, max_transit_minutes=30)
    r = run(FakeClient(walk_min=20, direct=False), s)
    assert r["options"] and r["options"][0]["transfers"] == 1


def test_no_transit_at_all():
    r = run(FakeClient(walk_min=20, transit=False))
    assert r["transit_message"].startswith("אין קו ישיר מהכתובת הזו")
    assert not r["suitable"]


def test_address_not_found():
    with pytest.raises(RoutesError) as e:
        run(FakeClient(walk_min=None))
    assert e.value.code == "address_not_found"


def test_saturday_does_not_affect_default_verdict_but_is_reported():
    r = run(FakeClient(walk_min=20, headway=10))
    assert set(r["options"][0]["frequency"]) == {"weekday", "saturday"}


class FakeResp:
    def __init__(self, code, body):
        self.status_code, self._body = code, body

    def json(self):
        return self._body


def test_error_mapping():
    e = _error_from_response(FakeResp(400, {"error": {"message": "Origin address could not be geocoded."}}))
    assert e.code == "address_not_found"
    e = _error_from_response(FakeResp(403, {"error": {"status": "PERMISSION_DENIED", "message": "x"}}))
    assert e.code == "auth"
    # real Google response shape for a bad key
    e = _error_from_response(FakeResp(400, {"error": {
        "message": "API key not valid. Please pass a valid API key.", "status": "INVALID_ARGUMENT",
        "details": [{"reason": "API_KEY_INVALID"}]}}))
    assert e.code == "auth"


def test_cache_avoids_repeat_calls(tmp_path, monkeypatch):
    calls = []

    class R:
        status_code = 200

        def json(self):
            return {"routes": [{"duration": "60s", "distanceMeters": 50}]}

    monkeypatch.setattr("routes_client.requests.post", lambda *a, **k: calls.append(1) or R())
    c = RoutesClient("key", cache_dir=tmp_path)
    c.walk("a", "b")
    c.walk("a", "b")
    assert len(calls) == 1 and c.cache_hits == 1


# ---- Flask endpoints --------------------------------------------------------
@pytest.fixture
def http(monkeypatch, tmp_path):
    monkeypatch.setattr(webapp, "BASE", Path(webapp.__file__).parent)
    return webapp.app.test_client()


def test_index_is_hebrew_rtl(http):
    html = http.get("/").get_data(as_text=True)
    assert 'dir="rtl"' in html and "כניסת הצוות" in html


def test_check_without_key_gives_hebrew_error(http, monkeypatch):
    monkeypatch.setenv("GOOGLE_MAPS_API_KEY", "")
    monkeypatch.setattr(webapp, "make_client",
                        lambda s: RoutesClient("", cache_dir=Path("nonexistent_cache_dir")))
    r = http.post("/api/check", json={"address": "רחוב לא קיים 1", "hospital": "שיבא"})
    assert r.status_code == 400 and "מפתח API" in r.get_json()["error"]


def test_check_endpoint_with_fake_client(http, monkeypatch):
    monkeypatch.setattr(webapp, "make_client", lambda s: FakeClient(walk_min=5))
    r = http.post("/api/check", json={"address": "הרצל 10", "hospital": "שיבא"})
    assert r.status_code == 200 and r.get_json()["suitable"] is True


def test_csv_parse_hebrew_headers_cp1255(http):
    data = "כתובת,מחיר,קישור\nהרצל 10 רמת גן,5000,https://x.co/1\n,,\n".encode("cp1255")
    r = http.post("/api/csv/parse", data={"file": (io.BytesIO(data), "a.csv")},
                  content_type="multipart/form-data")
    assert r.get_json()["rows"] == [{"address": "הרצל 10 רמת גן", "price": "5000", "link": "https://x.co/1"}]


def test_csv_parse_requires_address_column(http):
    r = http.post("/api/csv/parse", data={"file": (io.BytesIO(b"foo,bar\n1,2\n"), "a.csv")},
                  content_type="multipart/form-data")
    assert r.status_code == 400


def test_csv_export(http):
    rows = [{"address": "א", "price": "1", "link": "l", "suitable": True, "best_minutes": 7},
            {"address": "ב", "price": "2", "link": "", "suitable": False, "best_minutes": 30}]
    r = http.post("/api/csv/export", json={"rows": rows})
    text = r.get_data().decode("utf-8")
    assert text.startswith("﻿address,price,link")
    assert "מתאימה" in text and "לא מתאימה" in text
