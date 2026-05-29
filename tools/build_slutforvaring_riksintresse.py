#!/usr/bin/env python3
"""Hämta Länsstyrelsernas riksintresse för slutförvaring av använt kärnbränsle
och konvertera till GeoJSON (data/slutforvaring_riksintresse.geojson).

Datamängden distribueras som en nedladdningstjänst (ATOM); shapefilen ligger på
  https://ext-dokument.lansstyrelsen.se/gemensamt/geodata/ShapeExport/lst.Riks_slutforvaring.zip
och är polygoner i SWEREF99 TM (EPSG:3006). Varje område blir en (Multi)Polygon
i WGS84 lon/lat.

Använder bara standardbiblioteket (se tools/swedish_shapefile.py). Filen checkas
in men Dockerfile kör scriptet vid varje build så att en färsk version hämtas.

Kör: python tools/build_slutforvaring_riksintresse.py
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

from swedish_shapefile import build_polygon_geojson

URL = ("https://ext-dokument.lansstyrelsen.se/gemensamt/geodata/ShapeExport/"
       "lst.Riks_slutforvaring.zip")
USER_AGENT = "origo-slutforvaring-fetch/1.0"

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "data", "slutforvaring_riksintresse.geojson")


def _fix(s: str) -> str:
    # Källdatan har en känd felkodning där "å" blivit "†" (U+2020). Daggern
    # förekommer aldrig legitimt i svensk text, så det är säkert att rätta.
    return s.replace("†", "å")


def properties(row: dict) -> dict:
    return {
        "namn": _fix(row.get("NAMN", "")),
        "beskrivning": _fix(row.get("BESKRIVNIN", "")),
        "kommun": _fix(row.get("KNAMN", "")),
        "referens": row.get("REFERENS", ""),
        "lank": row.get("OBJLANK", ""),
    }


def build() -> int:
    print(f"Hämtar {URL}")
    try:
        req = urllib.request.Request(URL, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=120) as resp:
            zip_bytes = resp.read()
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        if os.path.exists(OUT):
            print(f"VARNING: nedladdning misslyckades ({exc}); "
                  f"behåller befintlig {os.path.relpath(OUT, ROOT)}", file=sys.stderr)
            return 0
        print(f"FEL: nedladdning misslyckades och ingen befintlig fil finns: {exc}",
              file=sys.stderr)
        return 1

    # Liten datamängd – behåll detaljerna (lägre förenklingstolerans).
    fc, n_geom, n_attr = build_polygon_geojson(zip_bytes, properties, simplify_tol_m=5.0)
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
