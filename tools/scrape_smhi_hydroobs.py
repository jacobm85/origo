#!/usr/bin/env python3
"""Download SMHI hydroobs station catalogue and emit a GeoJSON.

The opendata-download-hydroobs API publishes one station catalogue per
"parameter" (a measured quantity). Each entry includes WGS84 coordinates
which makes the conversion straightforward.

Default targets:
  - parameter 7 -> data/smhi_istjocklek.geojson         (ice thickness, cm)
  - parameter 9 -> data/smhi_snodensitet.geojson        (water content, mm)
"""

from __future__ import annotations

import argparse
import json
import urllib.request
from pathlib import Path

API_TEMPLATE = "https://opendata-download-hydroobs.smhi.se/api/version/latest/parameter/{pid}.json"

REPO_ROOT = Path(__file__).resolve().parent.parent

DEFAULTS = [
    (7, REPO_ROOT / "data" / "smhi_istjocklek.geojson"),
    (9, REPO_ROOT / "data" / "smhi_snodensitet.geojson"),
]


def fetch(parameter_id: int) -> dict:
    url = API_TEMPLATE.format(pid=parameter_id)
    req = urllib.request.Request(url, headers={"User-Agent": "origo-smhi-scraper/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def to_geojson(data: dict) -> tuple[dict, int, int]:
    parameter_title = data.get("title", "")
    parameter_unit = data.get("unit", "")
    parameter_key = data.get("key", "")
    features = []
    active = 0
    for s in data.get("station", []):
        lon = s.get("longitude")
        lat = s.get("latitude")
        if lon is None or lat is None:
            continue
        if s.get("active"):
            active += 1
        properties = {
            "station_id": s.get("key"),
            "namn": s.get("name"),
            "aktiv": bool(s.get("active")),
            "hojd_m": s.get("height"),
            "parameter": parameter_title,
            "enhet": parameter_unit,
            "parameter_id": parameter_key,
        }
        # Build a clickable link to the actual measurement data
        for link in s.get("link", []):
            if link.get("rel") == "station" and link.get("type") == "application/json":
                properties["data_url"] = link.get("href")
                break
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": properties,
        })
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
        fc, active, total = to_geojson(data)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(fc, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"  -> {output} ({total} stationer, {active} aktiva)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
