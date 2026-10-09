"""Hospital entrances: resolving free text / coordinates / Google Maps links to lat,lng, and storage."""
import json
import os
import re
import time
from pathlib import Path
from urllib.parse import parse_qs, unquote, urljoin, urlparse

import requests

from routes_client import RoutesError

SOURCES = {"address", "map", "coords", "link"}
# Short links we are willing to fetch (to follow their redirect). Nothing else is fetched.
SHORT_HOSTS = {"maps.app.goo.gl", "goo.gl", "g.co"}
GOOGLE_HOST_RE = re.compile(r"(^|\.)(google\.[a-z.]+|goo\.gl|g\.co)$")

_NUM = r"[-+]?\d{1,3}(?:\.\d+)?"
COORDS_RE = re.compile(rf"^\(?\s*({_NUM})\s*[,;\s]\s*({_NUM})\s*\)?$")
# Strip RTL/LTR marks that sneak in when copying from Hebrew pages.
BIDI_RE = re.compile("[‎‏‪-‮⁦-⁩]")


def valid_latlng(lat, lng):
    return -90 <= lat <= 90 and -180 <= lng <= 180


def parse_coordinates(text):
    m = COORDS_RE.match(BIDI_RE.sub("", text or "").strip())
    if not m:
        return None
    lat, lng = float(m.group(1)), float(m.group(2))
    return (lat, lng) if valid_latlng(lat, lng) else None


def parse_maps_url(url):
    """Return ("coords", (lat, lng)) or ("query", text) or None. Never fetches anything."""
    full = unquote(url)
    u = urlparse(url)

    m = re.search(r"!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)", full)  # exact place pin
    if m:
        return "coords", (float(m.group(1)), float(m.group(2)))

    qs = parse_qs(u.query)
    for key in ("q", "query", "ll", "destination", "daddr", "center", "sll"):
        for value in qs.get(key, []):
            c = parse_coordinates(value)
            if c:
                return "coords", c

    m = re.search(r"@(-?\d+\.\d+),(-?\d+\.\d+)", full)  # map centre
    if m:
        c = (float(m.group(1)), float(m.group(2)))
        if valid_latlng(*c):
            return "coords", c

    m = re.search(r"/maps/(?:place|search)/([^/@?]+)", u.path)
    if m:
        text = unquote(m.group(1)).replace("+", " ").strip()
        c = parse_coordinates(text)
        return ("coords", c) if c else ("query", text)

    for key in ("q", "query", "destination", "daddr"):
        if qs.get(key) and qs[key][0].strip():
            return "query", qs[key][0].strip()
    return None


def expand_short_url(url, max_hops=5):
    """Follow redirects of a Google short link, refusing to leave Google domains."""
    for _ in range(max_hops):
        host = (urlparse(url).hostname or "").lower()
        if urlparse(url).scheme not in ("http", "https") or not GOOGLE_HOST_RE.search(host):
            raise RoutesError("הקישור אינו קישור של Google Maps.", "bad_link")
        if host not in SHORT_HOSTS:
            return url
        try:
            resp = requests.get(url, allow_redirects=False, timeout=10,
                                headers={"User-Agent": "Mozilla/5.0"})
        except requests.RequestException:
            raise RoutesError("לא הצלחתי לפתוח את הקישור המקוצר. אפשר להדביק את הקישור המלא.", "network")
        location = resp.headers.get("Location")
        if not location:
            break
        url = urljoin(url, location)
    raise RoutesError("לא הצלחתי לפתוח את הקישור המקוצר. אפשר להדביק את הקישור המלא.", "bad_link")


def looks_like_url(text):
    return bool(re.match(r"^(https?://|www\.|maps\.app\.goo\.gl/|goo\.gl/|maps\.google\.)", text, re.I))


def resolve_location(text, client):
    """Free text, coordinates or a maps link -> {"lat", "lng", "address", "source", "approximate"}."""
    text = BIDI_RE.sub("", text or "").strip()
    if not text:
        raise RoutesError("יש להזין כתובת, תיאור, קואורדינטות או קישור.", "missing_input")

    c = parse_coordinates(text)
    if c:
        return {"lat": c[0], "lng": c[1], "address": "", "source": "coords", "approximate": False}

    if looks_like_url(text):
        url = text if re.match(r"^https?://", text, re.I) else "https://" + text
        if (urlparse(url).hostname or "").lower() in SHORT_HOSTS:
            url = expand_short_url(url)
        parsed = parse_maps_url(url)
        if not parsed:
            raise RoutesError("לא מצאתי מיקום בקישור. אפשר לנסות להעתיק קואורדינטות מ-Google Maps.", "bad_link")
        kind, value = parsed
        if kind == "coords":
            return {"lat": value[0], "lng": value[1], "address": "", "source": "link", "approximate": False}
        g = client.geocode(value)
        return dict(g, source="link")

    return dict(client.geocode(text), source="address")


# ---- persistence --------------------------------------------------------------
def empty_state():
    return {"updated_at": 0, "hospital": "", "entrances": []}


def _text(value, limit):
    return str(value or "").strip()[:limit]


def validate_state(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get("entrances", []), list):
        raise RoutesError("מבנה נתוני הכניסות אינו תקין.", "bad_input")
    entrances = []
    for e in payload.get("entrances", []):
        entrances.append(validate_entrance(e))
    try:
        updated_at = int(payload.get("updated_at") or 0)
    except (TypeError, ValueError):
        updated_at = 0
    return {"updated_at": updated_at, "hospital": _text(payload.get("hospital"), 200),
            "entrances": entrances}


def validate_entrance(e):
    if not isinstance(e, dict):
        raise RoutesError("מבנה כניסה אינו תקין.", "bad_input")
    try:
        lat, lng = float(e["lat"]), float(e["lng"])
    except (KeyError, TypeError, ValueError):
        raise RoutesError("לכל כניסה חייבות להיות קואורדינטות.", "bad_input")
    if not valid_latlng(lat, lng):
        raise RoutesError("קואורדינטות לא תקינות.", "bad_input")
    source = e.get("source") if e.get("source") in SOURCES else "coords"
    return {
        "id": _text(e.get("id"), 64) or f"e{int(time.time() * 1000)}",
        "label": _text(e.get("label"), 80) or "כניסה",
        "lat": round(lat, 7), "lng": round(lng, 7),
        "address": _text(e.get("address"), 300),
        "input": _text(e.get("input"), 2000),
        "source": source,
        "main": bool(e.get("main")),
    }


class EntranceStore:
    def __init__(self, path):
        self.path = Path(path)

    def load(self):
        try:
            return validate_state(json.loads(self.path.read_text(encoding="utf-8")))
        except (FileNotFoundError, ValueError, RoutesError):
            return empty_state()

    def save(self, state):
        state = validate_state(state)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, self.path)
        return state
