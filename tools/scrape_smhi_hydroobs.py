#!/usr/bin/env python3
"""Download SMHI hydroobs station catalogue and emit a GeoJSON.

For each station we also fetch the latest measurement so the popup shows
an actual value (cm of ice / mm of water content) and date, not just the
station metadata.

Default targets:
  - parameter 7 -> data/smhi_istjocklek.geojson         (ice thickness, cm)
  - parameter 9 -> data/smhi_snodensitet.geojson        (water content, mm)
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

API_TEMPLATE = "https://opendata-download-hydroobs.smhi.se/api/version/latest/parameter/{pid}.json"
DATA_TEMPLATE = (
    "https://opendata-download-hydroobs.smhi.se/api/version/latest/"
    "parameter/{pid}/station/{sid}/period/corrected-archive/data.json"
)

REPO_ROOT = Path(__file__).resolve().parent.parent

DEFAULTS = [
    (7, REPO_ROOT / "data" / "smhi_istjocklek.geojson"),
    (9, REPO_ROOT / "data" / "smhi_snodensitet.geojson"),
]


def fetch_json(url: str) -> dict | None:
    req = urllib.request.Request(url, headers={"User-Agent": "origo-smhi-scraper/2.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def ts_to_iso(ms: int | None) -> str | None:
    if ms is None or ms == 0 or ms < -10**13:
        return None
    try:
        return dt.datetime.fromtimestamp(ms / 1000, tz=dt.timezone.utc).date().isoformat()
    except (OverflowError, OSError, ValueError):
        return None


TITLE_PREFIX_RE = re.compile(r":\s*V[äa]lj\s+station.*", re.IGNORECASE)


def clean_parameter_title(raw: str) -> str:
    """Strip the trailing 'Välj station (sedan tidsutsnitt)' UI hint."""
    if not raw:
        return raw
    return TITLE_PREFIX_RE.sub("", raw).strip()


STATION_TEMPLATE = (
    "https://opendata-download-hydroobs.smhi.se/api/version/latest/"
    "parameter/{pid}/station/{sid}.json"
)


def _data_url(parameter_id: int, station_id: str, period_key: str) -> str:
    return (
        f"https://opendata-download-hydroobs.smhi.se/api/version/latest/"
        f"parameter/{parameter_id}/station/{station_id}/period/{period_key}/data.json"
    )


def latest_measurement(parameter_id: int, station_id: str) -> tuple[float | None, str | None, int]:
    """Return (value, date_iso, count) for the most recent measurement.

    Stations expose one or more "periods" (corrected-archive, latest-months,
    latest-day...). We look up the station metadata to discover which periods
    actually exist, then try the freshest available (largest "updated" timestamp).
    """
    meta = fetch_json(STATION_TEMPLATE.format(pid=parameter_id, sid=station_id))
    if not meta:
        return None, None, 0
    periods = meta.get("period") or []
    if not periods:
        return None, None, 0
    # Try most-recently-updated first
    periods_sorted = sorted(periods, key=lambda p: p.get("updated") or 0, reverse=True)
    for p in periods_sorted:
        key = p.get("key")
        if not key:
            continue
        payload = fetch_json(_data_url(parameter_id, station_id, key))
        if not payload:
            continue
        values = payload.get("value") or []
        if not values:
            continue
        last = values[-1]
        return last.get("value"), ts_to_iso(last.get("date")), len(values)
    return None, None, 0


def fetch(parameter_id: int) -> dict:
    return fetch_json(API_TEMPLATE.format(pid=parameter_id))


def to_geojson(data: dict, parameter_id: int) -> tuple[dict, int, int]:
    parameter_title = clean_parameter_title(data.get("title", ""))
    parameter_unit = data.get("unit", "")
    parameter_key = data.get("key", "")
    features = []
    active = 0
    stations = data.get("station", []) or []
    total = len(stations)
    for i, s in enumerate(stations, 1):
        lon = s.get("longitude")
        lat = s.get("latitude")
        if lon is None or lat is None:
            continue
        sid = s.get("key")
        if s.get("active"):
            active += 1
        senaste_varde, senaste_datum, antal_matningar = latest_measurement(parameter_id, sid)
        properties = {
            "station_id": sid,
            "namn": s.get("name"),
            "aktiv": bool(s.get("active")),
            "hojd_m": s.get("height"),
            "parameter": parameter_title,
            "enhet": parameter_unit,
            "parameter_id": parameter_key,
            "senaste_varde": senaste_varde,
            "senaste_datum": senaste_datum,
            "antal_matningar": antal_matningar,
            "forsta_datum": ts_to_iso(s.get("from")),
            "sista_datum": ts_to_iso(s.get("to")),
        }
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": properties,
        })
        print(f"  [{i:>3}/{total}] {s.get('name'):<40} senaste: {senaste_varde} {parameter_unit} ({senaste_datum})")
        # be a good citizen
        time.sleep(0.05)
    return (
        {"type": "FeatureCollection", "features": features},
        active,
        len(features),
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--parameter",
        type=int,
        help="SMHI parameter id (e.g. 7 for istjocklek, 9 for vatteninnehall)",
    )
    parser.add_argument("--output", type=Path, help="Output GeoJSON path")
    args = parser.parse_args()

    if args.parameter is not None:
        targets = [(args.parameter, args.output or (REPO_ROOT / "data" / f"smhi_param{args.parameter}.geojson"))]
    else:
        targets = DEFAULTS

    for pid, output in targets:
        print(f"Hamtar SMHI parameter {pid}")
        data = fetch(pid)
        if not data:
            print(f"  -> parameter {pid} not found", file=sys.stderr)
            continue
        fc, active, total = to_geojson(data, pid)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(fc, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"  -> {output} ({total} stationer, {active} aktiva)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
