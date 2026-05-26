#!/usr/bin/env python3
"""Bygg ett kommun-choropletlager (data/kommun_stats.geojson) från Kolada och
Entryscape (Energimarknadsinspektionen).

Pipelinen:
  1. Hämtar Sveriges kommungränser (GioPalusa/SwedenGeoJSON, WGS84 lon/lat) och
     förenklar geometrin (Douglas–Peucker) så filen blir liten nog att servera.
  2. Hämtar mätvärden per kommun:
       - Kolada v3  (solcellsanläggningar: antal N45974, effekt MW N45970)
       - Entryscape (avbrottsindikatorer elnät per kommun: SAIDI)
     Senaste året med värde per kommun används.
  3. Klassar varje mätvärde i 5 kvintiler (klass 1–5, 0 = saknar data) och
     skriver både råvärde, år och klass som feature-egenskaper. Origo-stilarna
     i index.json filtrerar på <metric>_klass för färgsättningen.

Kör: python tools/build_kommun_choropleth.py
Kräver bara standardbiblioteket. Nätåtkomst krävs vid körning; resultatet
(data/kommun_stats.geojson) checkas in och serveras statiskt.
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE = os.path.join(HERE, '_cache')
OUT = os.path.join(ROOT, 'data', 'kommun_stats.geojson')
OUT_LAN = os.path.join(ROOT, 'data', 'lan_stats.geojson')

KOMMUN_URL = ('https://raw.githubusercontent.com/GioPalusa/SwedenGeoJSON/'
              'main/Kommun/kommun.geojson')

# Geometriförenkling (grader). ~0.004° ≈ 400 m – gott nog för nationellt
# kommun-choroplet och håller filen liten.
SIMPLIFY_TOL = 0.004
COORD_DECIMALS = 4
# Hoppa över pyttesmå öar/ringar för att krympa filen ytterligare.
MIN_RING_SPAN = 0.01  # grader (~1 km)

# Kolada-KPI:er som ska bli lager. (metric-nyckel, KPI-id, etikett)
KOLADA_KPIS = [
    ('solcell_antal', 'N45974', 'Solcellsanläggningar, antal'),
    ('solcell_mw', 'N45970', 'Solcellsanläggningar, installerad effekt (MW)'),
]

# Entryscape rowstore-dataset (Ei). (metric-nyckel, dataset-id, värdekolumn, etikett)
ENTRYSCAPE = [
    ('avbrott_saidi', '5e724427-c4b1-4771-9850-3dff3db48870',
     'saidi_pl_unpl_gt3min_all', 'Elavbrott SAIDI (min/kund/år)'),
]

ALL_METRICS = [m[0] for m in KOLADA_KPIS] + [m[0] for m in ENTRYSCAPE]

# Kolada-KPI:er som bara finns på läns-/regionnivå (municipality_type "L").
# Kolada-region-id = "00" + länskod (0001 = Stockholm/01, 0025 = Norrbotten/25).
LAN_KOLADA_KPIS = [
    ('vatten_tot', 'N85042', 'Vattenanvändning totalt (kbm/inv)'),
    ('vatten_ind', 'N85045', 'Vattenanvändning industri (kbm/inv)'),
]
LAN_METRICS = [m[0] for m in LAN_KOLADA_KPIS]


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def fetch(url, retries=3, timeout=120):
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': 'origo-choropleth/1.0',
                'Accept': 'application/json'
            })
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except (urllib.error.URLError, TimeoutError) as e:
            last = e
            log(f'  retry {i + 1}/{retries} ({e})')
            time.sleep(2 * (i + 1))
    raise last


def fetch_json(url, **kw):
    return json.loads(fetch(url, **kw).decode('utf-8'))


# ---------------------------------------------------------------------------
# 1. Kommungeometri
# ---------------------------------------------------------------------------
def get_kommun_geojson():
    os.makedirs(CACHE, exist_ok=True)
    cached = os.path.join(CACHE, 'kommun.geojson')
    if not os.path.exists(cached):
        log('Laddar ner kommungränser (~23 MB)…')
        data = fetch(KOMMUN_URL, timeout=300)
        with open(cached, 'wb') as f:
            f.write(data)
    with open(cached, encoding='utf-8') as f:
        return json.load(f)


def _perp_dist(p, a, b):
    (px, py), (ax, ay), (bx, by) = p, a, b
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
    t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    cx, cy = ax + t * dx, ay + t * dy
    return ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5


def _dp(points, tol):
    """Douglas–Peucker på en lista av [x, y]."""
    if len(points) < 3:
        return points
    dmax, idx = 0.0, 0
    a, b = points[0], points[-1]
    for i in range(1, len(points) - 1):
        d = _perp_dist(points[i], a, b)
        if d > dmax:
            dmax, idx = d, i
    if dmax > tol:
        left = _dp(points[:idx + 1], tol)
        right = _dp(points[idx:], tol)
        return left[:-1] + right
    return [a, b]


def _ring_span(ring):
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return max(max(xs) - min(xs), max(ys) - min(ys))


def _round_ring(ring):
    return [[round(x, COORD_DECIMALS), round(y, COORD_DECIMALS)] for x, y in ring]


def simplify_ring(ring):
    if _ring_span(ring) < MIN_RING_SPAN:
        return None
    simp = _dp(ring, SIMPLIFY_TOL)
    if len(simp) < 4:
        return None
    # håll ringen sluten
    if simp[0] != simp[-1]:
        simp.append(simp[0])
    return _round_ring(simp)


def simplify_geometry(geom):
    t = geom['type']
    if t == 'Polygon':
        rings = [r for r in (simplify_ring(rr) for rr in geom['coordinates']) if r]
        return {'type': 'Polygon', 'coordinates': rings} if rings else None
    if t == 'MultiPolygon':
        polys = []
        for poly in geom['coordinates']:
            rings = [r for r in (simplify_ring(rr) for rr in poly) if r]
            if rings:
                polys.append(rings)
        return {'type': 'MultiPolygon', 'coordinates': polys} if polys else None
    return geom


def build_base():
    gj = get_kommun_geojson()
    feats = []
    for f in gj['features']:
        p = f.get('properties', {})
        kod = p.get('kommunkod')
        if not kod:
            continue
        geom = simplify_geometry(f['geometry'])
        if not geom:
            continue
        feats.append({
            'type': 'Feature',
            'geometry': geom,
            'properties': {
                'kommunkod': kod,
                'namn': p.get('namnkortform') or p.get('beslutatnamn') or kod,
                'lan': p.get('lanskod', '')
            }
        })
    log(f'Kommuner efter förenkling: {len(feats)}')
    return feats


def fetch_lan_names():
    """{länskod: namn} från Kolada-regionlistan (type L), utan "Region "-prefix."""
    d = fetch_json('https://api.kolada.se/v3/municipality?per_page=400')
    out = {}
    for x in d.get('values', []):
        if x.get('type') == 'L' and x.get('id') not in (None, '0000'):
            out[x['id'][2:]] = x['title'].replace('Region ', '').strip()
    return out


def build_lan_base(kommun_feats, lan_names):
    """Slår ihop kommunpolygonerna per länskod till en MultiPolygon per län.
    (Ingen äkta dissolve – inre kommungränser blir delade kanter som inte syns
    under en enfärgad fyllning, vilket räcker för ett läns-choroplet.)"""
    groups = {}
    for f in kommun_feats:
        lan = f['properties'].get('lan')
        if not lan:
            continue
        g = f['geometry']
        polys = g['coordinates'] if g['type'] == 'MultiPolygon' else [g['coordinates']]
        groups.setdefault(lan, []).extend(polys)
    feats = []
    for lan, polys in sorted(groups.items()):
        feats.append({
            'type': 'Feature',
            'geometry': {'type': 'MultiPolygon', 'coordinates': polys},
            'properties': {'lanskod': lan, 'namn': lan_names.get(lan, lan)}
        })
    log(f'Län: {len(feats)}')
    return feats


# ---------------------------------------------------------------------------
# 2. Mätvärden
# ---------------------------------------------------------------------------
def kolada_latest(kpi, codes):
    """Returnerar {kommunkod: (varde, ar)} – senaste året med T-värde."""
    out = {}
    # Kolada v3 tillåter bara ett tjugotal kommuner per anrop -> små batchar.
    for i in range(0, len(codes), 20):
        batch = codes[i:i + 20]
        url = (f'https://api.kolada.se/v3/data/kpi/{kpi}/municipality/'
               + ','.join(batch))
        data = fetch_json(url)
        for row in data.get('values', []):
            mun = row.get('municipality')
            period = row.get('period')
            vals = row.get('values', [])
            t = next((v for v in vals if v.get('gender') == 'T'), None)
            if not t or t.get('value') is None:
                continue
            prev = out.get(mun)
            if prev is None or period > prev[1]:
                out[mun] = (float(t['value']), int(period))
    return out


def _norm_num(s):
    if s is None:
        return None
    s = str(s).strip().replace(' ', '').replace(' ', '').replace(',', '.')
    if s == '':
        return None
    try:
        return float(s)
    except ValueError:
        return None


def entryscape_latest(dataset, value_col):
    """Returnerar {kommunkod(4): (varde, ar)} – senaste året per kommun."""
    out = {}
    offset, limit = 0, 500
    while True:
        url = (f'https://ei.entryscape.net/rowstore/dataset/{dataset}/json'
               f'?_limit={limit}&_offset={offset}')
        data = fetch_json(url)
        rows = data.get('results', [])
        if not rows:
            break
        for raw in rows:
            # Normalisera nycklar (BOM + whitespace förekommer).
            row = {k.lstrip('﻿').strip(): v for k, v in raw.items()}
            mid = row.get('municipality_id')
            if not mid:
                continue
            kod = str(mid).strip().zfill(4)
            year = None
            try:
                year = int(str(row.get('year', '')).strip())
            except ValueError:
                pass
            val = _norm_num(row.get(value_col))
            if val is None or year is None:
                continue
            prev = out.get(kod)
            if prev is None or year > prev[1]:
                out[kod] = (val, year)
        if len(rows) < limit:
            break
        offset += limit
    return out


# ---------------------------------------------------------------------------
# 3. Klassning (kvintiler)
# ---------------------------------------------------------------------------
def quintile_breaks(values):
    vs = sorted(v for v in values if v is not None)
    if len(vs) < 5:
        return None
    return [vs[int(len(vs) * q)] for q in (0.2, 0.4, 0.6, 0.8)]


def classify(val, breaks):
    if val is None or breaks is None:
        return 0
    for i, b in enumerate(breaks):
        if val < b:
            return i + 1
    return 5


# ---------------------------------------------------------------------------
def main():
    feats = build_base()
    codes = [f['properties']['kommunkod'] for f in feats]

    metric_values = {}   # metric -> {kommunkod: (varde, ar)}
    metric_label = {}

    for key, kpi, label in KOLADA_KPIS:
        log(f'Kolada {kpi} ({label})…')
        metric_values[key] = kolada_latest(kpi, codes)
        metric_label[key] = label
        log(f'  värden: {len(metric_values[key])} kommuner')

    for key, ds, col, label in ENTRYSCAPE:
        log(f'Entryscape {ds} kolumn {col} ({label})…')
        metric_values[key] = entryscape_latest(ds, col)
        metric_label[key] = label
        log(f'  värden: {len(metric_values[key])} kommuner')

    # Klassgränser per metric.
    breaks = {}
    for key in ALL_METRICS:
        vals = [v[0] for v in metric_values.get(key, {}).values()]
        breaks[key] = quintile_breaks(vals)
        log(f'Brytpunkter {key}: {breaks[key]}')

    # Skriv egenskaper på varje kommun.
    for f in feats:
        kod = f['properties']['kommunkod']
        for key in ALL_METRICS:
            vy = metric_values.get(key, {}).get(kod)
            if vy:
                varde, ar = vy
                f['properties'][f'{key}_varde'] = round(varde, 3)
                f['properties'][f'{key}_ar'] = ar
                f['properties'][f'{key}_klass'] = classify(varde, breaks[key])
            else:
                f['properties'][f'{key}_varde'] = None
                f['properties'][f'{key}_ar'] = None
                f['properties'][f'{key}_klass'] = 0

    fc = {'type': 'FeatureCollection', 'features': feats}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(fc, f, ensure_ascii=False, separators=(',', ':'))
    size_mb = os.path.getsize(OUT) / 1e6
    log(f'Skrev {OUT} ({size_mb:.2f} MB, {len(feats)} kommuner)')

    # --- Läns-choroplet (Kolada-KPI:er på regionnivå) ---
    lan_names = fetch_lan_names()
    lan_feats = build_lan_base(feats, lan_names)
    lan_codes = sorted({f['properties']['lanskod'] for f in lan_feats})
    region_ids = ['00' + c for c in lan_codes]

    lan_values = {}   # metric -> {länskod: (varde, ar)}
    for key, kpi, label in LAN_KOLADA_KPIS:
        log(f'Kolada (län) {kpi} ({label})…')
        by_region = kolada_latest(kpi, region_ids)   # {regionid: (varde, ar)}
        lan_values[key] = {rid[2:]: vy for rid, vy in by_region.items()}
        log(f'  värden: {len(lan_values[key])} län')

    lan_breaks = {}
    for key in LAN_METRICS:
        vals = [v[0] for v in lan_values.get(key, {}).values()]
        lan_breaks[key] = quintile_breaks(vals)
        log(f'Brytpunkter (län) {key}: {lan_breaks[key]}')

    for f in lan_feats:
        lan = f['properties']['lanskod']
        for key in LAN_METRICS:
            vy = lan_values.get(key, {}).get(lan)
            if vy:
                varde, ar = vy
                f['properties'][f'{key}_varde'] = round(varde, 3)
                f['properties'][f'{key}_ar'] = ar
                f['properties'][f'{key}_klass'] = classify(varde, lan_breaks[key])
            else:
                f['properties'][f'{key}_varde'] = None
                f['properties'][f'{key}_ar'] = None
                f['properties'][f'{key}_klass'] = 0

    lan_fc = {'type': 'FeatureCollection', 'features': lan_feats}
    with open(OUT_LAN, 'w', encoding='utf-8') as f:
        json.dump(lan_fc, f, ensure_ascii=False, separators=(',', ':'))
    log(f'Skrev {OUT_LAN} ({os.path.getsize(OUT_LAN) / 1e6:.2f} MB, {len(lan_feats)} län)')

    # Sammanfattning av brytpunkter för index.json-stilarna.
    print(json.dumps({**{k: breaks[k] for k in ALL_METRICS},
                      **{k: lan_breaks[k] for k in LAN_METRICS}}, ensure_ascii=False))


if __name__ == '__main__':
    main()
