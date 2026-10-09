import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import analyzer  # noqa: E402
import app as webapp  # noqa: E402
import locations  # noqa: E402
from locations import (EntranceStore, expand_short_url, parse_coordinates,  # noqa: E402
                       parse_maps_url, resolve_location, validate_state)
from routes_client import RoutesClient, RoutesError  # noqa: E402
from test_app import NOW, SETTINGS, FakeClient  # noqa: E402

MAIN = {"id": "m", "label": "כניסה ראשית", "lat": 32.0461, "lng": 34.8516, "main": True}
STAFF = {"id": "s", "label": "כניסת צוות", "lat": 32.0400, "lng": 34.8600, "main": False}


# ---- coordinates & links ---------------------------------------------------------
@pytest.mark.parametrize("text,expected", [
    ("32.0461, 34.8516", (32.0461, 34.8516)),
    ("32.0461 34.8516", (32.0461, 34.8516)),
    ("(32.0461,34.8516)", (32.0461, 34.8516)),
    ("‎32.0461, 34.8516‏", (32.0461, 34.8516)),
    ("-33.86, 151.2", (-33.86, 151.2)),
    ("95.0, 34.8", None),
    ("הרצל 10", None),
    ("10 20 30", None),
])
def test_parse_coordinates(text, expected):
    assert parse_coordinates(text) == expected


@pytest.mark.parametrize("url,expected", [
    ("https://www.google.com/maps/place/Sheba/@32.04,34.85,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d32.0461!4d34.8516",
     ("coords", (32.0461, 34.8516))),
    ("https://www.google.com/maps/@32.05,34.86,18z", ("coords", (32.05, 34.86))),
    ("https://maps.google.com/?q=32.0461,34.8516", ("coords", (32.0461, 34.8516))),
    ("https://www.google.com/maps/search/?api=1&query=32.0461%2C34.8516", ("coords", (32.0461, 34.8516))),
    ("https://www.google.com/maps/dir/?api=1&destination=32.1,34.9", ("coords", (32.1, 34.9))),
    ("https://www.google.com/maps/place/%D7%A9%D7%99%D7%91%D7%90", ("query", "שיבא")),
    ("https://www.google.com/maps/search/?api=1&query=Sheba+Medical+Center", ("query", "Sheba Medical Center")),
    ("https://waze.com/ul?ll=32.0461,34.8516&navigate=yes", ("coords", (32.0461, 34.8516))),
    ("https://example.com/nothing", None),
])
def test_parse_maps_url(url, expected):
    assert parse_maps_url(url) == expected


class Redirect:
    def __init__(self, location):
        self.headers = {"Location": location} if location else {}


def test_expand_short_url_follows_google_redirects(monkeypatch):
    target = "https://www.google.com/maps/place/X/@32.0461,34.8516,17z"
    monkeypatch.setattr(locations.requests, "get", lambda url, **k: Redirect(target))
    assert expand_short_url("https://maps.app.goo.gl/abc") == target


def test_expand_short_url_refuses_non_google_redirect(monkeypatch):
    monkeypatch.setattr(locations.requests, "get", lambda url, **k: Redirect("https://evil.example/x"))
    with pytest.raises(RoutesError):
        expand_short_url("https://maps.app.goo.gl/abc")


class FakeGeocoder:
    def __init__(self):
        self.queries = []

    def geocode(self, q):
        self.queries.append(q)
        return {"lat": 32.0, "lng": 34.8, "address": "תוצאה", "approximate": False}


def test_resolve_coordinates_without_api():
    g = FakeGeocoder()
    r = resolve_location("32.0461, 34.8516", g)
    assert (r["lat"], r["lng"], r["source"]) == (32.0461, 34.8516, "coords") and not g.queries


def test_resolve_link_and_address():
    g = FakeGeocoder()
    assert resolve_location("https://maps.google.com/?q=32.1,34.9", g)["source"] == "link"
    r = resolve_location("https://www.google.com/maps/place/Sheba+Hospital", g)
    assert r["source"] == "link" and g.queries == ["Sheba Hospital"]
    r = resolve_location("שיבא כניסה מזרחית", g)
    assert r["source"] == "address" and g.queries[-1] == "שיבא כניסה מזרחית"


def test_resolve_empty():
    with pytest.raises(RoutesError):
        resolve_location("  ", FakeGeocoder())


# ---- geocoding via the real client (HTTP mocked) -------------------------------
class GeoResp:
    def __init__(self, body):
        self.body = body

    def json(self):
        return self.body


@pytest.mark.parametrize("body,code", [
    ({"status": "ZERO_RESULTS", "results": []}, "location_not_found"),
    ({"status": "REQUEST_DENIED", "error_message": "not authorized"}, "auth"),
    ({"status": "OVER_QUERY_LIMIT"}, "quota"),
])
def test_geocode_errors(monkeypatch, tmp_path, body, code):
    monkeypatch.setattr("routes_client.requests.get", lambda *a, **k: GeoResp(body))
    with pytest.raises(RoutesError) as e:
        RoutesClient("key", cache_dir=tmp_path).geocode("x")
    assert e.value.code == code


def test_geocode_ok_and_cached(monkeypatch, tmp_path):
    calls = []
    body = {"status": "OK", "results": [{"formatted_address": "שיבא", "partial_match": True,
            "geometry": {"location": {"lat": 32.04, "lng": 34.85}, "location_type": "ROOFTOP"}}]}
    monkeypatch.setattr("routes_client.requests.get", lambda *a, **k: calls.append(1) or GeoResp(body))
    c = RoutesClient("key", cache_dir=tmp_path)
    r = c.geocode("שיבא")
    c.geocode("שיבא")
    assert r == {"lat": 32.04, "lng": 34.85, "address": "שיבא", "approximate": True}
    assert len(calls) == 1


def test_latlng_waypoint_body():
    body = RoutesClient("k")._body("הרצל 10", {"lat": 32.0, "lng": 34.8}, "WALK")
    assert body["origin"] == {"address": "הרצל 10"}
    assert body["destination"] == {"location": {"latLng": {"latitude": 32.0, "longitude": 34.8}}}


# ---- storage ------------------------------------------------------------------
def test_store_roundtrip(tmp_path):
    store = EntranceStore(tmp_path / "data" / "entrances.json")
    assert store.load()["entrances"] == []
    saved = store.save({"updated_at": 5, "hospital": "שיבא", "entrances": [MAIN, STAFF]})
    loaded = store.load()
    assert loaded == saved and [e["label"] for e in loaded["entrances"]] == ["כניסה ראשית", "כניסת צוות"]
    assert loaded["entrances"][0]["main"] is True


def test_store_unlimited_entrances(tmp_path):
    many = [dict(STAFF, id=str(i), label=f"כניסה {i}") for i in range(50)]
    assert len(EntranceStore(tmp_path / "e.json").save({"entrances": many})["entrances"]) == 50


@pytest.mark.parametrize("bad", [
    {"entrances": [{"label": "x"}]},
    {"entrances": [{"label": "x", "lat": 100, "lng": 30}]},
    {"entrances": "nope"},
])
def test_validate_rejects_bad(bad):
    with pytest.raises(RoutesError):
        validate_state(bad)


def test_corrupt_file_loads_empty(tmp_path):
    p = tmp_path / "e.json"
    p.write_text("{not json", encoding="utf-8")
    assert EntranceStore(p).load()["entrances"] == []


# ---- multi-entrance analysis ----------------------------------------------------
class PerEntranceClient:
    """Different commute per destination latitude."""

    def __init__(self, by_lat):
        self.by_lat = by_lat
        self.api_calls = self.cache_hits = 0

    def walk(self, o, d):
        return self.by_lat[d["lat"]].walk(o, d)

    def transit(self, o, d, t):
        return self.by_lat[d["lat"]].transit(o, d, t)


def test_best_entrance_wins():
    client = PerEntranceClient({MAIN["lat"]: FakeClient(walk_min=25, headway=60),
                                STAFF["lat"]: FakeClient(walk_min=7)})
    r = analyzer.analyze(client, "הרצל 10", [MAIN, STAFF], SETTINGS, now=NOW)
    assert r["suitable"] and r["best_entrance_label"] == "כניסת צוות"
    assert "(דרך כניסת צוות)" in r["verdict"]
    assert [i["result"]["suitable"] for i in r["entrances"]] == [False, True]


def test_one_entrance_failing_does_not_break_others():
    client = PerEntranceClient({MAIN["lat"]: FakeClient(walk_min=None),
                                STAFF["lat"]: FakeClient(walk_min=20, headway=10)})
    r = analyzer.analyze(client, "הרצל 10", [MAIN, STAFF], SETTINGS, now=NOW)
    assert "error" in r["entrances"][0] and r["best_entrance_label"] == "כניסת צוות"


# ---- HTTP endpoints ------------------------------------------------------------------
@pytest.fixture
def http(monkeypatch, tmp_path):
    monkeypatch.setattr(webapp, "store", EntranceStore(tmp_path / "entrances.json"))
    return webapp.app.test_client()


def test_entrances_endpoints(http):
    assert http.get("/api/entrances").get_json()["entrances"] == []
    r = http.put("/api/entrances", json={"updated_at": 10, "hospital": "שיבא", "entrances": [MAIN, STAFF]})
    assert r.status_code == 200
    got = http.get("/api/entrances").get_json()
    assert got["updated_at"] == 10 and len(got["entrances"]) == 2
    assert http.put("/api/entrances", json={"entrances": [{"lat": "x"}]}).status_code == 400


def test_resolve_endpoint_coordinates(http):
    r = http.post("/api/resolve-location", json={"text": "32.0461, 34.8516"}).get_json()
    assert r["lat"] == 32.0461 and r["source"] == "coords"


def test_index_has_entrances_ui(http):
    html = http.get("/").get_data(as_text=True)
    assert "הוספת כניסה" in html and "MAPS_BROWSER_KEY" in html
