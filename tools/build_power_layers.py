#!/usr/bin/env python3
"""Bygg kraft-/elnätslager (punkter och linjer) som GeoJSON.

Källor:
  * WRI Global Power Plant Database  -> data/kraftverk_wri.geojson
      168 svenska kraftverk med kapacitet (MW), bränsle, ägare, år. CC-BY.
  * OpenStreetMap via Overpass:
      power=plant       -> data/osm_kraftverk.geojson      (kraftverk)
      power=substation  -> data/osm_stationer.geojson      (transformator-/kraftstationer)
      power=line        -> data/osm_kraftledningar.geojson  (kraftledningar)
    © OpenStreetMap contributors (ODbL).

Punkter/linjer i WGS84 lon/lat (Origo reprojicerar). Resultatet checkas in och
serveras statiskt. Kräver bara standardbiblioteket + nätåtkomst vid körning.

Kör: python tools/build_power_layers.py
"""
import csv
import io
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, 'data')

WRI_URL = ('https://raw.githubusercontent.com/wri/global-power-plant-database/'
           'master/output_database/global_power_plant_database.csv')
OVERPASS = 'https://overpass-api.de/api/interpreter'

FUEL_SV = {
    'Hydro': 'Vatten', 'Wind': 'Vind', 'Nuclear': 'Kärnkraft',
    'Biomass': 'Biomassa', 'Gas': 'Gas', 'Oil': 'Olja', 'Coal': 'Kol',
    'Solar': 'Sol', 'Waste': 'Avfall', 'Cogeneration': 'Kraftvärme',
    'Geothermal': 'Geotermisk', 'Petcoke': 'Petcoke', 'Storage': 'Lagring',
    'Other': 'Annat'
}

COORD_DECIMALS = 5


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def fetch(url, data=None, retries=3, timeout=180):
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(
                url, data=data,
                headers={'User-Agent': 'origo-power/1.0', 'Accept': '*/*'})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except (urllib.error.URLError, TimeoutError) as e:
            last = e
            log(f'  retry {i + 1}/{retries} ({e})')
            time.sleep(3 * (i + 1))
    raise last


def overpass(query):
    data = urllib.parse.urlencode({'data': query}).encode('utf-8')
    return json.loads(fetch(OVERPASS, data=data, timeout=300).decode('utf-8'))


def rnd(x):
    return round(x, COORD_DECIMALS)


# --- tolkningshjälp -------------------------------------------------------
def parse_capacity_mw(val):
    """plant:output:electricity -> MW (best effort)."""
    if not val:
        return None
    m = re.search(r'([\d.,]+)\s*([kKmMgG]?)[wW]?', str(val))
    if not m:
        return None
    try:
        num = float(m.group(1).replace(',', '.'))
    except ValueError:
        return None
    unit = m.group(2).lower()
    if unit == 'k':
        num /= 1000.0
    elif unit == 'g':
        num *= 1000.0
    elif unit == '':
        # bart tal: anta W om mycket stort, annars MW
        if num > 100000:
            num /= 1e6
    return round(num, 2)


def parse_voltage_kv(val):
    """voltage-tagg (V, ev. ';'-separerad) -> högsta kV."""
    if not val:
        return None
    nums = [int(n) for n in re.findall(r'\d+', str(val))]
    if not nums:
        return None
    v = max(nums)
    return round(v / 1000.0, 1) if v > 1000 else float(v)


def volt_klass(kv):
    if kv is None:
        return 0
    if kv < 50:
        return 1
    if kv < 150:
        return 2
    if kv < 300:
        return 3
    return 4


def centroid(el):
    if el['type'] == 'node':
        return el.get('lon'), el.get('lat')
    c = el.get('center')
    if c:
        return c.get('lon'), c.get('lat')
    return None, None


def write(name, features):
    path = os.path.join(DATA, name)
    fc = {'type': 'FeatureCollection', 'features': features}
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(fc, f, ensure_ascii=False, separators=(',', ':'))
    log(f'Skrev {path} ({os.path.getsize(path) / 1e6:.2f} MB, {len(features)} objekt)')


# --- 1. WRI ---------------------------------------------------------------
def build_wri():
    log('WRI Global Power Plant Database…')
    raw = fetch(WRI_URL, timeout=120).decode('utf-8')
    feats = []
    for r in csv.DictReader(io.StringIO(raw)):
        if r.get('country') != 'SWE':
            continue
        try:
            lon, lat = float(r['longitude']), float(r['latitude'])
        except (ValueError, KeyError):
            continue
        try:
            mw = round(float(r['capacity_mw']), 1)
        except (ValueError, KeyError):
            mw = None
        feats.append({
            'type': 'Feature',
            'geometry': {'type': 'Point', 'coordinates': [rnd(lon), rnd(lat)]},
            'properties': {
                'namn': r.get('name', ''),
                'bransle': FUEL_SV.get(r.get('primary_fuel', ''), r.get('primary_fuel', '')),
                'kapacitet_mw': mw,
                'driftar': r.get('commissioning_year', '').split('.')[0] or None,
                'agare': r.get('owner', '') or None,
                'kalla': r.get('source', '') or None
            }
        })
    write('kraftverk_wri.geojson', feats)


# --- 2-4. OSM via Overpass ------------------------------------------------
def build_osm_points(power_value, out_name, label):
    log(f'OSM power={power_value}…')
    q = (f'[out:json][timeout:280];area["ISO3166-1"="SE"][admin_level=2]->.a;'
         f'(nwr["power"="{power_value}"](area.a););out center tags;')
    data = overpass(q)
    feats = []
    for el in data.get('elements', []):
        lon, lat = centroid(el)
        if lon is None:
            continue
        t = el.get('tags', {})
        kv = parse_voltage_kv(t.get('voltage'))
        mw = parse_capacity_mw(t.get('plant:output:electricity')
                               or t.get('generator:output:electricity'))
        feats.append({
            'type': 'Feature',
            'geometry': {'type': 'Point', 'coordinates': [rnd(lon), rnd(lat)]},
            'properties': {
                'namn': t.get('name', '') or None,
                'typ': t.get(power_value, '') or t.get('plant:source')
                or t.get('generator:source') or None,
                'spanning_kv': kv,
                'volt_klass': volt_klass(kv),
                'kapacitet_mw': mw,
                'operator': t.get('operator', '') or None
            }
        })
    write(out_name, feats)


def build_osm_lines():
    log('OSM power=line…')
    q = ('[out:json][timeout:280];area["ISO3166-1"="SE"][admin_level=2]->.a;'
         '(way["power"="line"](area.a););out geom tags;')
    data = overpass(q)
    feats = []
    for el in data.get('elements', []):
        geom = el.get('geometry')
        if not geom or len(geom) < 2:
            continue
        coords = [[rnd(p['lon']), rnd(p['lat'])] for p in geom]
        t = el.get('tags', {})
        kv = parse_voltage_kv(t.get('voltage'))
        feats.append({
            'type': 'Feature',
            'geometry': {'type': 'LineString', 'coordinates': coords},
            'properties': {
                'spanning_kv': kv,
                'volt_klass': volt_klass(kv),
                'operator': t.get('operator', '') or None,
                'kablar': t.get('cables', '') or None
            }
        })
    write('osm_kraftledningar.geojson', feats)


def build_osm_charging():
    """Laddstationer för elfordon (amenity=charging_station) -> punkter."""
    log('OSM amenity=charging_station…')
    q = ('[out:json][timeout:280];area["ISO3166-1"="SE"][admin_level=2]->.a;'
         '(nwr["amenity"="charging_station"](area.a););out center tags;')
    data = overpass(q)
    feats = []
    for el in data.get('elements', []):
        lon, lat = centroid(el)
        if lon is None:
            continue
        t = el.get('tags', {})
        try:
            kap = int(re.findall(r'\d+', t.get('capacity', ''))[0])
        except (IndexError, ValueError):
            kap = None
        sockets = [k.split(':', 1)[1] for k in t
                   if k.startswith('socket:') and k.count(':') == 1]
        feats.append({
            'type': 'Feature',
            'geometry': {'type': 'Point', 'coordinates': [rnd(lon), rnd(lat)]},
            'properties': {
                'namn': t.get('name', '') or t.get('operator', '') or None,
                'operator': t.get('operator', '') or None,
                'antal_uttag': kap,
                'uttagstyper': ', '.join(sockets) or None,
                'avgift': t.get('fee', '') or None
            }
        })
    write('laddstationer_osm.geojson', feats)


def main():
    os.makedirs(DATA, exist_ok=True)
    build_wri()
    build_osm_points('plant', 'osm_kraftverk.geojson', 'Kraftverk')
    build_osm_points('substation', 'osm_stationer.geojson', 'Stationer')
    build_osm_lines()
    build_osm_charging()


if __name__ == '__main__':
    main()
