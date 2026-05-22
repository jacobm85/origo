#!/usr/bin/env python3
"""Fetch ongoing road work / construction projects from Trafikverket.

Trafikverket's open data API takes an XML request body and returns JSON.
We query the "RoadWork" object type (planned and ongoing roadworks) and
convert each item to a GeoJSON Point in EPSG:3857 so Origo can show it
without re-projecting.

Roadworks are a strong prospecting signal for geotechnical, hydrogeology
and environmental monitoring work near the affected stretch of road.

Required: an API key from https://data.trafikverket.se/. Provide it via
the TRAFIKVERKET_API_KEY environment variable or --api-key.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

API_URL = "https://api.trafikinfo.trafikverket.se/v2/data.json"
OUTPUT_PATH = Path(__file__).resolve().parent.parent / "data" / "trafikverket_projekt.geojson"


def build_query(api_key: str, limit: int) -> bytes:
    """Build the XML request body. RoadWork includes ongoing/planned roadworks
    with start/end dates and a point geometry in SWEREF99 TM (EPSG:3006)."""
    body = f"""<REQUEST>
  <LOGIN authenticationkey="{api_key}"/>
  <QUERY objecttype="RoadWork" schemaversion="1.5" limit="{limit}">
    <FILTER>
      <GTE name="EndTime" value="$now"/>
    </FILTER>
    <INCLUDE>Id</INCLUDE>
    <INCLUDE>Name</INCLUDE>
    <INCLUDE>Description</INCLUDE>
    <INCLUDE>Comment</INCLUDE>
    <INCLUDE>StartTime</INCLUDE>
    <INCLUDE>EndTime</INCLUDE>
    <INCLUDE>RoadNumber</INCLUDE>
    <INCLUDE>CountyNo</INCLUDE>
    <INCLUDE>CountyName</INCLUDE>
    <INCLUDE>LocationDescriptor</INCLUDE>
    <INCLUDE>Geometry.SWEREF99TM</INCLUDE>
    <INCLUDE>Geometry.WGS84</INCLUDE>
  </QUERY>
</REQUEST>"""
    return body.encode("utf-8")


COUNTY_NUMBERS = {
    1: "Stockholm", 3: "Uppsala", 4: "Sodermanland", 5: "Ostergotland",
    6: "Jonkoping", 7: "Kronoberg", 8: "Kalmar", 9: "Gotland",
    10: "Blekinge", 12: "Skane", 13: "Halland", 14: "Vastra Gotaland",
    17: "Varmland", 18: "Orebro", 19: "Vastmanland", 20: "Dalarna",
    21: "Gavleborg", 22: "Vasternorrland", 23: "Jamtland",
    24: "Vasterbotten", 25: "Norrbotten",
}


def parse_point_wgs84(wgs84: str) -> tuple[float, float] | None:
    """Parse 'POINT (lon lat)' from Geometry.WGS84."""
    if not wgs84:
        return None
    m = re.search(r"POINT\s*\(\s*([0-9.\-]+)\s+([0-9.\-]+)\s*\)", wgs84)
    if not m:
        return None
    return float(m.group(1)), float(m.group(2))


def to_geojson(items: list[dict]) -> tuple[dict, int]:
    features = []
    for it in items:
        geom = it.get("Geometry") or {}
        coords = parse_point_wgs84(geom.get("WGS84"))
        if not coords:
            continue
        county_no = it.get("CountyNo")
        if isinstance(county_no, list) and county_no:
            county_no = county_no[0]
        county_label = (
            it.get("CountyName")
            or (COUNTY_NUMBERS.get(int(county_no)) if county_no else None)
            or ""
        )
        road_no = it.get("RoadNumber")
        if isinstance(road_no, list):
            road_no = ", ".join(str(r) for r in road_no)
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [coords[0], coords[1]]},
            "properties": {
                "id": it.get("Id"),
                "namn": it.get("Name"),
                "beskrivning": it.get("Description") or it.get("Comment") or "",
                "vagnummer": road_no or "",
                "lan": county_label,
                "plats": it.get("LocationDescriptor") or "",
                "starttid": it.get("StartTime"),
                "sluttid": it.get("EndTime"),
            },
        })
    return {"type": "FeatureCollection", "features": features}, len(features)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--api-key",
        default=os.environ.get("TRAFIKVERKET_API_KEY", ""),
        help="Trafikverket API key. Default: $TRAFIKVERKET_API_KEY",
    )
    parser.add_argument("--output", type=Path, default=OUTPUT_PATH, help="Output GeoJSON path")
    parser.add_argument("--limit", type=int, default=2000, help="Max results to fetch")
    args = parser.parse_args()

    if not args.api_key or args.api_key.startswith("REPLACE_"):
        print(
            "ERROR: set TRAFIKVERKET_API_KEY env var (or --api-key) to a real key from\n"
            "       https://data.trafikverket.se/",
            file=sys.stderr,
        )
        return 1

    body = build_query(args.api_key, args.limit)
    req = urllib.request.Request(
        API_URL,
        data=body,
        headers={
            "Content-Type": "text/xml",
            "User-Agent": "origo-trafikverket-scraper/1.0",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        print(f"HTTP {e.code} from Trafikverket: {body[:300]}", file=sys.stderr)
        return 1

    result = payload.get("RESPONSE", {}).get("RESULT") or []
    if not result:
        print("Trafikverket returned an empty RESULT array.", file=sys.stderr)
        return 1

    items = result[0].get("RoadWork") or []
    print(f"Trafikverket returned {len(items)} RoadWork-objekt")

    fc, n = to_geojson(items)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(fc, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Skrev {n} punkter -> {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
