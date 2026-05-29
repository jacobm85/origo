#!/usr/bin/env python3
"""Hämta Försvarsmaktens riksintressen och påverkansområden och konvertera till
GeoJSON (data/forsvarsmakten_riksintressen.geojson).

Källan publiceras som en zip med en nästlad shp-zip:
  https://www.forsvarsmakten.se/.../riksintressen-shp-gdp-lyrx.zip
    └── Riksintresse_och_paverkansomraden_Externt_shp (1).zip
          └── shp/Riksintressen_paverkansomraden_Extern.shp (m.fl.)

Shapefilen är polygoner i SWEREF99 TM (EPSG:3006). Varje område blir en
(Multi)Polygon-feature i WGS84 lon/lat med egenskaperna objnamn, lan, kommun,
kategori, underkategori och en härledd typ (Riksintresse/Påverkansområde).

Använder bara standardbiblioteket (se tools/swedish_shapefile.py). Filen checkas
in så att lagret finns även utan nätåtkomst, men Dockerfile kör scriptet vid
varje build så att en färsk version hämtas hem.

Kör: python tools/build_forsvarsmakten_riksintressen.py
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

from swedish_shapefile import build_polygon_geojson

URL = ("https://www.forsvarsmakten.se/globalassets/04-regler-och-tillstand/"
       "tillstand-och-allmanna-handlingar/riksintressen/"
       "riksintressen-shp-gdp-lyrx.zip")
USER_AGENT = "origo-forsvarsmakten-fetch/1.0"

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "data", "forsvarsmakten_riksintressen.geojson")


def properties(row: dict) -> dict:
    kategori = row.get("KATEGORI", "")
    typ = "Påverkansområde" if kategori.startswith("Påverkans") else "Riksintresse"
    return {
        "objnamn": row.get("OBJNAMN", ""),
        "lan": row.get("LNAMN", ""),
        "kommun": row.get("KNAMN", ""),
        "kategori": kategori,
        "underkategori": row.get("UKATEGORI", ""),
        "typ": typ,
    }


def build() -> int:
    print(f"Hämtar {URL}")
    try:
        req = urllib.request.Request(URL, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=180) as resp:
            zip_bytes = resp.read()
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        if os.path.exists(OUT):
            print(f"VARNING: nedladdning misslyckades ({exc}); "
                  f"behåller befintlig {os.path.relpath(OUT, ROOT)}", file=sys.stderr)
            return 0
        print(f"FEL: nedladdning misslyckades och ingen befintlig fil finns: {exc}",
              file=sys.stderr)
        return 1

    fc, n_geom, n_attr = build_polygon_geojson(zip_bytes, properties)
    if n_geom != n_attr:
        print(f"VARNING: {n_geom} geometrier men {n_attr} dbf-poster", file=sys.stderr)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(fc, fh, ensure_ascii=False, separators=(",", ":"))
    size_kb = os.path.getsize(OUT) / 1024
    print(f"Skrev {len(fc['features'])} områden till "
          f"{os.path.relpath(OUT, ROOT)} ({size_kb:.0f} kB)")
    return 0


if __name__ == "__main__":
    sys.exit(build())
