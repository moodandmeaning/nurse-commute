import csv
import io
import json
import os
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, Response, jsonify, render_template, request

from analyzer import analyze
from locations import EntranceStore, resolve_location, validate_entrance
from routes_client import RoutesClient, RoutesError

BASE = Path(__file__).parent
load_dotenv(BASE / ".env")

app = Flask(__name__)
store = EntranceStore(BASE / "data" / "entrances.json")

CSV_ALIASES = {
    "address": ("address", "כתובת"),
    "price": ("price", "מחיר"),
    "link": ("link", "url", "קישור"),
}


def load_settings():
    # Read every time so edits to settings.json apply without a restart.
    return json.loads((BASE / "settings.json").read_text(encoding="utf-8"))


def make_client(settings):
    return RoutesClient(
        api_key=os.environ.get("GOOGLE_MAPS_API_KEY", "").strip(),
        cache_dir=BASE / "cache",
        cache_ttl_hours=settings["cache_ttl_hours"],
        language_code=settings["language_code"],
        region_code=settings["region_code"],
    )


def error(e, status=400):
    return jsonify({"error": e.message_he, "code": e.code}), status


@app.get("/")
def index():
    # The map runs in the browser, so it needs a key the browser can see.
    # Prefer a separate key restricted to HTTP referrers (see README).
    browser_key = (os.environ.get("GOOGLE_MAPS_BROWSER_KEY") or os.environ.get("GOOGLE_MAPS_API_KEY", "")).strip()
    return render_template("index.html", settings=load_settings(), maps_browser_key=browser_key)


@app.get("/api/entrances")
def api_entrances_get():
    return jsonify(store.load())


@app.put("/api/entrances")
def api_entrances_put():
    try:
        return jsonify(store.save(request.get_json(silent=True)))
    except RoutesError as e:
        return error(e)


@app.post("/api/resolve-location")
def api_resolve_location():
    data = request.get_json(silent=True) or {}
    settings = load_settings()
    try:
        return jsonify(resolve_location(data.get("text"), make_client(settings)))
    except RoutesError as e:
        return error(e)


@app.post("/api/check")
def api_check():
    data = request.get_json(silent=True) or {}
    settings = load_settings()
    client = make_client(settings)
    try:
        entrances = [validate_entrance(e) for e in (data.get("entrances") or [])]
        result = analyze(client, data.get("address"), entrances, settings)
    except RoutesError as e:
        return error(e)
    result["api_calls"], result["cache_hits"] = client.api_calls, client.cache_hits
    return jsonify(result)


@app.post("/api/csv/parse")
def api_csv_parse():
    f = request.files.get("file")
    if not f:
        return jsonify({"error": "לא נבחר קובץ."}), 400
    raw = f.read()
    for enc in ("utf-8-sig", "cp1255"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        return jsonify({"error": "לא הצלחתי לקרוא את הקובץ. יש לשמור אותו כ-CSV בקידוד UTF-8."}), 400

    reader = csv.DictReader(io.StringIO(text))
    headers = {(h or "").strip().lower(): h for h in (reader.fieldnames or [])}
    cols = {}
    for field, aliases in CSV_ALIASES.items():
        cols[field] = next((headers[a] for a in aliases if a in headers), None)
    if not cols["address"]:
        return jsonify({"error": "בקובץ חייבת להיות עמודה בשם address (וגם price, link)."}), 400

    rows = []
    for r in reader:
        addr = (r.get(cols["address"]) or "").strip()
        if addr:
            rows.append({k: (r.get(c) or "").strip() if c else "" for k, c in cols.items()})
    if not rows:
        return jsonify({"error": "לא נמצאו כתובות בקובץ."}), 400
    return jsonify({"rows": rows})


@app.post("/api/csv/export")
def api_csv_export():
    rows = (request.get_json(silent=True) or {}).get("rows", [])
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["address", "price", "link", "suitable", "best_minutes", "best_entrance",
                "walk_minutes", "direct_lines", "verdict"])
    for r in rows:
        w.writerow([r.get("address", ""), r.get("price", ""), r.get("link", ""),
                    {True: "מתאימה", False: "לא מתאימה"}.get(r.get("suitable"), "שגיאה"),
                    r.get("best_minutes", ""), r.get("best_entrance", ""), r.get("walk_minutes", ""),
                    r.get("direct_lines", ""), r.get("verdict", "")])
    # BOM so Excel shows Hebrew correctly
    return Response("﻿" + out.getvalue(), mimetype="text/csv; charset=utf-8",
                    headers={"Content-Disposition": "attachment; filename=apartments_results.csv"})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", 5000)), debug=False)
