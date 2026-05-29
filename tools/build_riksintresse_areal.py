#!/usr/bin/env python3
"""Bygg ett kommun-choroplet (data/riksintresse_areal.geojson) över arealen
riksintresse enligt 3 kap miljöbalken per kommun, från SCB:s öppna statistik-API.

SCB-tabell MI0803C/OmrRiksInt ("Områden av riksintresse enligt 3 kap
miljöbalken, hektar efter region, typ av riksintresse, ...") frågas för
landareal, alla typer summerade (Totalt), senaste tillgängliga år (2014).
Värdet per kommun klassas i kvintiler (klass 1–5; 0 = inget riksintresse / data
saknas). Origo-stilen i index.json färgsätter på ri_areal_klass.

Kommungeometrin och förenklings-/klassningshjälpfunktionerna återanvänds från
build_kommun_choropleth.py. Endast standardbiblioteket krävs. Nätåtkomst krävs
vid körning; resultatet checkas in och Dockerfile kör scriptet vid varje build.

Kör: python tools/build_riksintresse_areal.py
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

from build_kommun_choropleth import (
    build_base, classify, log, quintile_breaks,
)

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "data", "riksintresse_areal.geojson")

SCB_URL = "https://api.scb.se/OV0104/v1/doris/sv/ssd/MI/MI0803/MI0803C/OmrRiksInt"
YEAR = "2014"
# 999 = Totalt (alla typer av riksintresse), 000002ZF = Landareal.
QUERY = {
    "query": [
        {"code": "Region", "selection": {"filter": "all", "values": ["*"]}},
        {"code": "Riksintresse", "selection": {"filter": "item", "values": ["999"]}},
        {"code": "ContentsCode", "selection": {"filter": "item", "values": ["000002ZF"]}},
        {"code": "Tid", "selection": {"filter": "item", "values": [YEAR]}},
    ],
    "response": {"format": "json"},
}


def fetch_scb() -> dict:
    """Returnera {kommunkod(4 siffror): hektar}. Saknat/'..' hoppas över."""
    body = json.dumps(QUERY).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (origo-scb-riksintresse/1.0)",
    }
    payload = None
    last_exc = None
    for attempt in range(4):
        try:
            req = urllib.request.Request(SCB_URL, data=body, headers=headers)
            with urllib.request.urlopen(req, timeout=60) as resp:
                payload = json.load(resp)
            break
        except (urllib.error.URLError, ConnectionError, OSError) as exc:
            last_exc = exc
            time.sleep(2 * (attempt + 1))
    if payload is None:
        raise last_exc
    out = {}
    for row in payload.get("data", []):
        kod = row["key"][0]
        if len(kod) != 4:  # bara kommuner (riket=00, län=2 siffror hoppas)
            continue
        raw = row["values"][0]
        try:
            out[kod] = float(raw)
        except (TypeError, ValueError):
            continue  # ".." = saknas
    return out


def build() -> int:
    log("Hämtar riksintresse-areal per kommun från SCB…")
    try:
        areal = fetch_scb()
    except Exception as exc:  # noqa: BLE001 – nät/parsefel ska inte bryta bygget
        if os.path.exists(OUT):
            print(f"VARNING: SCB-hämtning misslyckades ({exc}); "
                  f"behåller befintlig {os.path.relpath(OUT, ROOT)}", file=sys.stderr)
            return 0
        print(f"FEL: SCB-hämtning misslyckades och ingen befintlig fil finns: {exc}",
              file=sys.stderr)
        return 1

    feats = build_base()
    # Klassa endast positiva värden; 0/saknas blir klass 0.
    breaks = quintile_breaks([v for v in areal.values() if v and v > 0])
    for f in feats:
        kod = f["properties"]["kommunkod"]
        ha = areal.get(kod)
        f["properties"]["ri_areal_ha"] = round(ha, 1) if ha is not None else None
        f["properties"]["ri_areal_ar"] = int(YEAR)
        f["properties"]["ri_areal_klass"] = classify(ha, breaks) if ha and ha > 0 else 0

    fc = {"type": "FeatureCollection", "features": feats}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(fc, fh, ensure_ascii=False, separators=(",", ":"))
    size_kb = os.path.getsize(OUT) / 1024
    with_data = sum(1 for f in feats if f["properties"]["ri_areal_klass"])
    log(f"Skrev {len(feats)} kommuner ({with_data} med riksintresse) till "
        f"{os.path.relpath(OUT, ROOT)} ({size_kb:.0f} kB). Klassgränser: {breaks}")
    return 0


if __name__ == "__main__":
    sys.exit(build())
