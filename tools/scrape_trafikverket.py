#!/usr/bin/env python3
"""Scrape Trafikverkets publika projektkatalog (/vara-projekt/).

Uses the public web API at https://www.trafikverket.se/api/projects which is the
same one that powers the project list on trafikverket.se. No API key needed.

Each project becomes a Point Feature in GeoJSON with coordinates converted from
SWEREF99 TM (EPSG:3006) to WGS84. Projects without coordinates are skipped.

The response covers all project types (Vag, Jarnvag, Gang- och cykelvag, Sjofart).
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API_URL = "https://www.trafikverket.se/api/projects"
SITE_BASE = "https://www.trafikverket.se"
USER_AGENT = "origo-trafikverket-scraper/2.0"
OUTPUT_PATH = Path(__file__).resolve().parent.parent / "data" / "trafikverket_projekt.geojson"

# Max accepted by the API (returns 400 above this).
PAGE_SIZE = 25


def sweref99_tm_to_wgs84(easting: float, northing: float) -> tuple[float, float]:
    """Convert SWEREF99 TM (EPSG:3006) easting/northing to WGS84 lon/lat.

    Implements the inverse transverse Mercator series on the GRS80 ellipsoid
    with central meridian 15 E, scale factor 0.9996, false easting 500000.
    See HMK - Geodetisk infrastruktur / Lantmateriet TR 2009:14.
    """
    a = 6378137.0
    f = 1.0 / 298.257222101
    k0 = 0.9996
    lambda0 = math.radians(15.0)
    FN = 0.0
    FE = 500000.0

    e2 = f * (2 - f)
    n = f / (2 - f)
    a_hat = (a / (1 + n)) * (1 + n*n/4 + n*n*n*n/64)

    d1 = n/2 - 2*n*n/3 + 37*n*n*n/96 - n*n*n*n/360
    d2 = n*n/48 + n*n*n/15 - 437*n*n*n*n/1440
    d3 = 17*n*n*n/480 - 37*n*n*n*n/840
    d4 = 4397*n*n*n*n/161280

    A = e2 + e2**2 + e2**3 + e2**4
    B = -(7*e2**2 + 17*e2**3 + 30*e2**4) / 6
    C = (224*e2**3 + 889*e2**4) / 120
    D = -(4279*e2**4) / 1260

    xi = (northing - FN) / (k0 * a_hat)
    eta = (easting - FE) / (k0 * a_hat)

    xi_p = (xi
            - d1 * math.sin(2*xi) * math.cosh(2*eta)
            - d2 * math.sin(4*xi) * math.cosh(4*eta)
            - d3 * math.sin(6*xi) * math.cosh(6*eta)
            - d4 * math.sin(8*xi) * math.cosh(8*eta))
    eta_p = (eta
             - d1 * math.cos(2*xi) * math.sinh(2*eta)
             - d2 * math.cos(4*xi) * math.sinh(4*eta)
             - d3 * math.cos(6*xi) * math.sinh(6*eta)
             - d4 * math.cos(8*xi) * math.sinh(8*eta))

    phi_star = math.asin(math.sin(xi_p) / math.cosh(eta_p))
    delta_lambda = math.atan(math.sinh(eta_p) / math.cos(xi_p))

    phi = (phi_star
           + math.sin(phi_star) * math.cos(phi_star)
           * (A + B * math.sin(phi_star)**2
              + C * math.sin(phi_star)**4
              + D * math.sin(phi_star)**6))
    lambda_ = lambda0 + delta_lambda
    return math.degrees(lambda_), math.degrees(phi)


def fetch_page(page: int) -> dict:
    url = f"{API_URL}?pageSize={PAGE_SIZE}&currentPage={page}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def normalise_link(link: str | None) -> str:
    if not link:
        return ""
    if link.startswith("http"):
        return link
    return SITE_BASE + link


def to_features(items: list[dict]) -> list[dict]:
    features: list[dict] = []
    for it in items:
        url_data = it.get("UrlData") or {}
        coords = url_data.get("Coordinates") or []
        if not coords:
            continue
        # Each project may have multiple Coordinates entries (e.g., a route).
        # We emit one Feature per coordinate so all are visible/clickable.
        for ci, c in enumerate(coords):
            try:
                e_raw = float(c["Easting"])
                n_raw = float(c["Northing"])
            except (KeyError, TypeError, ValueError):
                continue
            # Sweden in SWEREF99 TM: Easting 0..1100000, Northing 6100000..7700000
            # Skip absurd values - some entries have placeholder zeros or swapped axes.
            if not (0 < e_raw < 1200000 and 6000000 < n_raw < 7700000):
                continue
            try:
                lon, lat = sweref99_tm_to_wgs84(e_raw, n_raw)
            except (OverflowError, ValueError):
                continue
            project_types = it.get("ProjectTypes") or []
            counties = it.get("Counties") or []
            features.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": {
                    "id": it.get("Id"),
                    "namn": it.get("Name"),
                    "beskrivning": it.get("Preamble"),
                    "typer": ", ".join(project_types),
                    "lan": ", ".join(counties),
                    "url": normalise_link(it.get("Link")),
                    "punkt_index": ci if len(coords) > 1 else None,
                },
            })
    return features


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=OUTPUT_PATH, help="Output GeoJSON path")
    parser.add_argument("--max-pages", type=int, default=100, help="Safety cap")
    args = parser.parse_args()

    # First page tells us TotalHits
    print(f"Hamtar sida 1 av Trafikverket /vara-projekt/")
    try:
        first = fetch_page(1)
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read()[:300].decode('utf-8', 'replace')}", file=sys.stderr)
        return 1

    total = first.get("TotalHits", 0)
    items = list(first.get("Items") or [])
    num_pages = min(args.max_pages, (total + PAGE_SIZE - 1) // PAGE_SIZE)
    print(f"  TotalHits={total} -> {num_pages} sidor")

    for p in range(2, num_pages + 1):
        try:
            page_data = fetch_page(p)
        except Exception as exc:  # noqa: BLE001
            print(f"  sida {p} misslyckades: {exc}", file=sys.stderr)
            continue
        page_items = page_data.get("Items") or []
        items.extend(page_items)
        print(f"  sida {p}: +{len(page_items)} (totalt {len(items)})")

    # De-dup on Id
    seen: set = set()
    unique = []
    for it in items:
        i = it.get("Id")
        if i in seen:
            continue
        seen.add(i)
        unique.append(it)

    features = to_features(unique)
    fc = {"type": "FeatureCollection", "features": features}

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(fc, ensure_ascii=False, indent=1), encoding="utf-8")

    n_with_coords = sum(1 for it in unique if (it.get("UrlData") or {}).get("Coordinates"))
    print(
        f"Klart. {len(unique)} unika projekt, {n_with_coords} med koordinater"
        f" -> {len(features)} punkter -> {args.output}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
