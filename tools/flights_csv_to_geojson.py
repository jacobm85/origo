#!/usr/bin/env python3
"""Konvertera DLB-flygloggens CSV till GeoJSON för drone-flights-lagret.

Läser CSV:n (Dronelogbook-export) och skriver en GeoJSON med en punkt per
flygning vid startpunkten + de fält som behövs för popup, färg per år och
filtrering. Cirkeln (flygområdets omfattning) ritas i klienten utifrån
egenskapen `maxDistanceM`.

Användning:
    python tools/flights_csv_to_geojson.py [INDATA.csv] [UTDATA.geojson]

Default in:  temp/DLB-Flights.csv
Default ut:  flightdata/drone-flights.geojson

Persondata: utdatamappen (flightdata/) är gitignorad och monteras in i
origo-containern — den ska inte checkas in.
"""
import csv
import json
import os
import sys

IN = sys.argv[1] if len(sys.argv) > 1 else 'temp/DLB-Flights.csv'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'flightdata/drone-flights.geojson'

# CSV-kolumn -> egenskapsnyckel i GeoJSON
FIELDS = {
    'Organization': 'org',
    'Flight Date': 'date',
    'Project / Event Name': 'project',
    'Customer Name': 'customer',
    'Flight Number': 'flightNo',
    'Mission Name': 'mission',
    'Location Name': 'location',
    'Operation Type': 'operation',
    'Flight Type': 'flightType',
    'Duration': 'duration',
    'Pilot Info': 'pilot',
    'Drone Brand': 'droneBrand',
    'Drone Model': 'droneModel',
    'Drone Name': 'droneName',
    'maxAltitudeAGL': 'maxAltAGL',
    'Area ( sqm)': 'areaSqm',
    'Max Distance ( m)': 'maxDistanceM',
    'Travelled distance ( m)': 'travelledM',
    'Notes': 'notes'
}
NUMERIC = {'areaSqm', 'maxDistanceM', 'travelledM', 'maxAltAGL'}


def to_float(s):
    try:
        return float(str(s).strip())
    except (ValueError, TypeError):
        return None


def main():
    feats = []
    skipped = 0
    with open(IN, encoding='utf-8-sig', newline='') as f:
        reader = csv.DictReader(f)
        for row in reader:
            lat = to_float(row.get('TakeOff latitude'))
            lon = to_float(row.get('TakeOff longitude'))
            if lat is None or lon is None or (lat == 0 and lon == 0):
                skipped += 1
                continue

            props = {}
            for col, key in FIELDS.items():
                val = (row.get(col) or '').strip()
                if key in NUMERIC:
                    props[key] = to_float(val)
                else:
                    props[key] = val
            date = props.get('date') or ''
            props['year'] = int(date[:4]) if date[:4].isdigit() else None

            feats.append({
                'type': 'Feature',
                'properties': props,
                'geometry': {'type': 'Point', 'coordinates': [round(lon, 7), round(lat, 7)]}
            })

    fc = {
        'type': 'FeatureCollection',
        'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:OGC:1.3:CRS84'}},
        'features': feats
    }
    out_dir = os.path.dirname(OUT)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(fc, f, ensure_ascii=False)
    print(f'Skrev {len(feats)} flygningar till {OUT} (hoppade över {skipped} utan koordinater).')


if __name__ == '__main__':
    main()
