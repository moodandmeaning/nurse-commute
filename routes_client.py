"""Thin wrapper around Google Routes API computeRoutes, with a disk cache."""
import hashlib
import json
import os
import time
from pathlib import Path

import requests

ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes"

WALK_FIELDS = "routes.duration,routes.distanceMeters"
TRANSIT_FIELDS = ",".join([
    "routes.duration",
    "routes.distanceMeters",
    "routes.legs.steps.travelMode",
    "routes.legs.steps.staticDuration",
    "routes.legs.steps.distanceMeters",
    "routes.legs.steps.transitDetails",
])


class RoutesError(Exception):
    """Error with a Hebrew message that can be shown to the user."""

    def __init__(self, message_he, code="api_error"):
        super().__init__(message_he)
        self.message_he = message_he
        self.code = code


class RoutesClient:
    def __init__(self, api_key, cache_dir="cache", cache_ttl_hours=168,
                 language_code="he", region_code="IL"):
        self.api_key = api_key
        self.cache_dir = Path(cache_dir)
        self.cache_ttl = cache_ttl_hours * 3600
        self.language_code = language_code
        self.region_code = region_code
        self.api_calls = 0
        self.cache_hits = 0

    # ---- public -------------------------------------------------------
    def walk(self, origin, destination):
        body = self._body(origin, destination, "WALK")
        return self._compute(body, WALK_FIELDS)

    def transit(self, origin, destination, departure_time_rfc3339):
        body = self._body(origin, destination, "TRANSIT")
        body["departureTime"] = departure_time_rfc3339
        body["computeAlternativeRoutes"] = True
        return self._compute(body, TRANSIT_FIELDS)

    # ---- internals ----------------------------------------------------
    def _body(self, origin, destination, mode):
        return {
            "origin": {"address": origin},
            "destination": {"address": destination},
            "travelMode": mode,
            "languageCode": self.language_code,
            "regionCode": self.region_code,
        }

    def _cache_path(self, body, fields):
        raw = json.dumps([body, fields], sort_keys=True, ensure_ascii=False)
        return self.cache_dir / (hashlib.sha256(raw.encode("utf-8")).hexdigest() + ".json")

    def _compute(self, body, fields):
        path = self._cache_path(body, fields)
        if path.exists() and time.time() - path.stat().st_mtime < self.cache_ttl:
            self.cache_hits += 1
            return json.loads(path.read_text(encoding="utf-8"))

        if not self.api_key:
            raise RoutesError(
                "חסר מפתח API. יש להגדיר GOOGLE_MAPS_API_KEY בקובץ ‎.env (ראו README).",
                "no_api_key")

        self.api_calls += 1
        try:
            resp = requests.post(
                ENDPOINT, json=body, timeout=30,
                headers={"X-Goog-Api-Key": self.api_key, "X-Goog-FieldMask": fields})
        except requests.RequestException:
            raise RoutesError("אין חיבור לשרת של Google. יש לבדוק את החיבור לאינטרנט.", "network")

        if resp.status_code != 200:
            raise _error_from_response(resp)

        data = resp.json()
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return data


def _error_from_response(resp):
    try:
        err = resp.json().get("error", {})
    except ValueError:
        err = {}
    msg = (err.get("message") or "").lower()
    status = err.get("status", "")

    if resp.status_code in (401, 403) or status in ("PERMISSION_DENIED", "UNAUTHENTICATED"):
        return RoutesError(
            "מפתח ה-API נדחה. יש לוודא שהמפתח נכון ושה-Routes API מופעל בפרויקט (ראו README).",
            "auth")
    if resp.status_code == 429:
        return RoutesError("חרגת ממכסת הבקשות של Google. כדאי לנסות שוב בעוד כמה דקות.", "quota")
    if "geocod" in msg or "address" in msg or status == "NOT_FOUND":
        if "destination" in msg:
            return RoutesError("כתובת בית החולים לא נמצאה. כדאי לנסות שם מלא יותר או כתובת עם עיר.",
                               "destination_not_found")
        return RoutesError("הכתובת לא נמצאה. כדאי לבדוק את האיות ולהוסיף שם עיר.",
                           "address_not_found")
    return RoutesError(f"שגיאה מ-Google ({resp.status_code}): {err.get('message', '')}".strip(),
                       "api_error")
