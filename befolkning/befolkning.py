"""Befolkning – SCB:s rutstatistik (1 km) + ytviktad befolkningsberäkning.

Tjänsten laddar ner SCB:s öppna rutstatistik "Totalbefolkning 1 km"
(stat:befolkning_1km_YYYY från geodata.scb.se) och lagrar den lokalt i en
volym. Den serverar rutnätet som GeoJSON för kartan och räknar ut total
befolkning för ett ritat/uppladdat område genom att summera rutorna och vikta
varje ruta efter hur stor andel av rutan som området täcker.

Endpoints (nås via nginx /proxy/befolkning/...):
  GET  /befolkning/health           → status (lagrat år, antal rutor, byggtid).
  GET  /befolkning/status           → som health men kollar även SCB live efter
                                        senaste tillgängliga år (upToDate).
  POST /befolkning/refresh[?force=1]→ ladda ner senaste året (eller tvinga om).
  GET  /befolkning/grid?bbox=minE,minN,maxE,maxN
                                     → rutor i bbox (EPSG:3006) med beftotalt +
                                        färgklass. Begränsat antal (zooma in).
  POST /befolkning/calc             → body = GeoJSON-geometri/feature (Polygon/
                                        MultiPolygon i EPSG:3006). Svarar med
                                        population, areaKm2, densityPerKm2 m.m.

Datan är öppen (CC0/SCB). Inga inloggningsuppgifter behövs. Källan är SCB:s
Register över totalbefolkningen (RTB) som uppdateras årligen; ett nytt
år-lager (befolkning_1km_YYYY) publiceras varje år.

SCB skyddar enskilda uppgifter statistiskt, så summan av delarna är inte alltid
exakt lika med totalen. Ytvikningen antar jämn fördelning inom varje ruta.
"""
import datetime
import json
import os
import re
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, quote

# --- Källa -----------------------------------------------------------------
SCB_WFS = os.environ.get(
    'SCB_WFS', 'https://geodata.scb.se/geoserver/stat/wfs').rstrip('?')
LAYER_WORKSPACE = os.environ.get('SCB_WORKSPACE', 'stat')
LAYER_BASE = os.environ.get('SCB_LAYER_BASE', 'befolkning_1km_')
POP_ATTR = os.environ.get('SCB_POP_ATTR', 'beftotalt')
TIMEOUT = float(os.environ.get('BEF_TIMEOUT', '60'))
PAGE_SIZE = int(os.environ.get('BEF_PAGE_SIZE', '20000'))
UA = 'origo-befolkning/1.0'

DATA_DIR = os.environ.get('BEF_DATA_DIR', '/data')
STORE_PATH = os.path.join(DATA_DIR, 'befolkning_1km.json')

# Hur många rutor /grid maximalt returnerar (skydd mot enorma svar).
MAX_GRID_CELLS = int(os.environ.get('BEF_MAX_GRID_CELLS', '40000'))

# --- Choropleth: klassindelning av total befolkning per 1 km-ruta ----------
#     BEF_BREAKS = övre gränser för de N-1 första klasserna (exklusiva).
#     Antal färger/etiketter = antal brytpunkter + 1.
BEF_BREAKS = [float(x) for x in os.environ.get(
    'BEF_BREAKS', '10,50,100,250,500,1000').split(',')]
BEF_COLORS = [c.strip() for c in os.environ.get(
    'BEF_COLORS', '#ffffb2,#fed976,#feb24c,#fd8d3c,#fc4e2a,#e31a1c,#b10026').split(',')]
BEF_LABELS = [s.strip() for s in os.environ.get(
    'BEF_LABELS', '1–9,10–49,50–99,100–249,250–499,500–999,1000+').split(',')]

# --- Tillstånd -------------------------------------------------------------
_lock = threading.Lock()
_cells = {}                 # (ei, ni) -> pop   där ei=E//size, ni=N//size
_cell_size = 1000
_year = None
_generated = None
_building = False
_last_error = None
_latest_known = None        # senast kända tillgängliga år hos SCB
_refresh_event = threading.Event()
_force_flag = threading.Event()


# ===========================================================================
# Färgklass
# ===========================================================================
def classify(pop):
    if pop is None or pop <= 0:
        return (None, None)
    for i, b in enumerate(BEF_BREAKS):
        if pop < b:
            return (BEF_LABELS[i], BEF_COLORS[i])
    return (BEF_LABELS[-1], BEF_COLORS[-1])


def legend():
    return [{'label': BEF_LABELS[i], 'color': BEF_COLORS[i]}
            for i in range(len(BEF_LABELS))]


# ===========================================================================
# rutid_scb → SV-hörn (E, N) i meter
#   "3950006133000" → E=395000, N=6133000  (6 siffror E + 7 siffror N)
# ===========================================================================
def parse_rutid(rutid):
    s = str(rutid).strip()
    if len(s) != 13 or not s.isdigit():
        return None
    return (int(s[:6]), int(s[6:]))


# ===========================================================================
# SCB WFS
# ===========================================================================
def _http_get(url):
    req = urllib.request.Request(url, headers={
        'Accept': 'application/json', 'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return resp.read()


def fetch_latest_year():
    """Läs WFS GetCapabilities och returnera högsta befolkning_1km_YYYY-året."""
    url = (f'{SCB_WFS}?service=WFS&version=2.0.0&request=GetCapabilities')
    raw = _http_get(url).decode('utf-8', 'replace')
    years = [int(y) for y in re.findall(
        re.escape(LAYER_BASE) + r'(\d{4})', raw)]
    return max(years) if years else None


def download_year(year):
    """Hämta alla rutor för ett år (attribut-only) och bygg cellindex."""
    typename = f'{LAYER_WORKSPACE}:{LAYER_BASE}{year}'
    cells = {}
    size = _cell_size
    start = 0
    while True:
        url = (
            f'{SCB_WFS}?service=WFS&version=2.0.0&request=GetFeature'
            f'&typeNames={typename}&outputFormat=application/json'
            f'&propertyName=rutid_scb,{POP_ATTR},rutstorl'
            f'&srsName=EPSG:3006&count={PAGE_SIZE}&startIndex={start}'
        )
        data = json.loads(_http_get(url))
        feats = data.get('features') or []
        for f in feats:
            p = f.get('properties') or {}
            corner = parse_rutid(p.get('rutid_scb'))
            if corner is None:
                continue
            e, n = corner
            try:
                pop = int(round(float(p.get(POP_ATTR) or 0)))
            except (ValueError, TypeError):
                pop = 0
            rs = p.get('rutstorl')
            if rs:
                try:
                    size = int(float(rs))
                except (ValueError, TypeError):
                    pass
            if pop > 0:
                cells[(e // size, n // size)] = pop
        if len(feats) < PAGE_SIZE:
            break
        start += len(feats)
    return cells, size


def _do_build():
    global _cells, _cell_size, _year, _generated, _building, _last_error
    global _latest_known
    _building = True
    _last_error = None
    try:
        force = _force_flag.is_set()
        _force_flag.clear()
        latest = fetch_latest_year()
        _latest_known = latest
        if latest is None:
            raise RuntimeError('Hittade inga befolkning_1km_YYYY-lager hos SCB.')
        if not force and _year == latest and _cells:
            print(f'[befolkning] redan senaste året ({latest}), hoppar över.',
                  flush=True)
            return
        print(f'[befolkning] laddar ner {LAYER_BASE}{latest} …', flush=True)
        cells, size = download_year(latest)
        if not cells:
            raise RuntimeError(f'Inga rutor hämtades för {latest}.')
        gen = datetime.datetime.now(datetime.timezone.utc).isoformat()
        with _lock:
            _cells = cells
            _cell_size = size
            _year = latest
            _generated = gen
        save_store()
        print(f'[befolkning] klart: {len(cells)} rutor, år {latest}.',
              flush=True)
    except Exception as e:  # noqa: BLE001 – logga och fortsätt
        _last_error = str(e)
        print(f'[befolkning] nedladdning misslyckades: {e}', flush=True)
    finally:
        _building = False


# ===========================================================================
# Lokal lagring
# ===========================================================================
def save_store():
    os.makedirs(DATA_DIR, exist_ok=True)
    # Kompakt: en rad per ruta [ei, ni, pop]. Återskapas till dict vid load.
    with _lock:
        payload = {
            'year': _year,
            'cellSize': _cell_size,
            'generated': _generated,
            'count': len(_cells),
            'cells': [[ei, ni, pop] for (ei, ni), pop in _cells.items()]
        }
    tmp = STORE_PATH + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(payload, fh, separators=(',', ':'))
    os.replace(tmp, STORE_PATH)


def load_store():
    global _cells, _cell_size, _year, _generated
    if not os.path.exists(STORE_PATH):
        return False
    try:
        with open(STORE_PATH, encoding='utf-8') as fh:
            payload = json.load(fh)
        cells = {(row[0], row[1]): row[2] for row in payload.get('cells', [])}
        with _lock:
            _cells = cells
            _cell_size = int(payload.get('cellSize') or 1000)
            _year = payload.get('year')
            _generated = payload.get('generated')
        print(f'[befolkning] laddade lokal lagring: {len(cells)} rutor, '
              f'år {_year}.', flush=True)
        return True
    except Exception as e:  # noqa: BLE001
        print(f'[befolkning] kunde inte läsa lagring: {e}', flush=True)
        return False


# ===========================================================================
# Geometri: area + klippning (ytvikning)
# ===========================================================================
def ring_area(ring):
    """Signerad area (m²) med shoelace. + = moturs i matematisk mening."""
    a = 0.0
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        a += x1 * y2 - x2 * y1
    return a / 2.0


def clip_ring_to_rect(ring, xmin, ymin, xmax, ymax):
    """Sutherland–Hodgman: klipp en ring mot en axelparallell rektangel.
    Returnerar den klippta ringens punktlista (kan vara tom)."""
    def clip_edge(pts, inside, intersect):
        out = []
        m = len(pts)
        if m == 0:
            return out
        for i in range(m):
            cur = pts[i]
            prev = pts[i - 1]
            cur_in = inside(cur)
            prev_in = inside(prev)
            if cur_in:
                if not prev_in:
                    out.append(intersect(prev, cur))
                out.append(cur)
            elif prev_in:
                out.append(intersect(prev, cur))
        return out

    def isect(p, q, t):
        return (p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t)

    pts = list(ring)
    # vänster x >= xmin
    pts = clip_edge(pts, lambda p: p[0] >= xmin,
                    lambda p, q: isect(p, q, (xmin - p[0]) / (q[0] - p[0])))
    # höger x <= xmax
    pts = clip_edge(pts, lambda p: p[0] <= xmax,
                    lambda p, q: isect(p, q, (xmax - p[0]) / (q[0] - p[0])))
    # nedre y >= ymin
    pts = clip_edge(pts, lambda p: p[1] >= ymin,
                    lambda p, q: isect(p, q, (ymin - p[1]) / (q[1] - p[1])))
    # övre y <= ymax
    pts = clip_edge(pts, lambda p: p[1] <= ymax,
                    lambda p, q: isect(p, q, (ymax - p[1]) / (q[1] - p[1])))
    return pts


def polygons_from_geometry(geom):
    """Normalisera en GeoJSON-geometri till en lista av polygoner.
    Varje polygon = [ytterring, hål1, …]; varje ring = [[x,y], …]."""
    if not geom:
        return []
    t = geom.get('type')
    coords = geom.get('coordinates')
    if t == 'Polygon':
        return [coords]
    if t == 'MultiPolygon':
        return list(coords)
    if t == 'GeometryCollection':
        out = []
        for g in geom.get('geometries', []):
            out.extend(polygons_from_geometry(g))
        return out
    return []


def polygon_signed_area(polygon):
    """Netto-area (m²) för en polygon (ytterring minus hål), absolutbelopp."""
    if not polygon:
        return 0.0
    area = abs(ring_area(polygon[0]))
    for hole in polygon[1:]:
        area -= abs(ring_area(hole))
    return max(0.0, area)


def cell_intersection_area(polygon, xmin, ymin, xmax, ymax):
    """Area (m²) av snittet mellan polygon (med hål) och en rektangel."""
    outer = abs(ring_area(clip_ring_to_rect(polygon[0], xmin, ymin, xmax, ymax)))
    if outer <= 0:
        return 0.0
    for hole in polygon[1:]:
        outer -= abs(ring_area(clip_ring_to_rect(hole, xmin, ymin, xmax, ymax)))
    return max(0.0, outer)


def calc_population(geom):
    polys = polygons_from_geometry(geom)
    if not polys:
        return None
    with _lock:
        cells = _cells
        size = _cell_size
        year = _year
    if not cells:
        return {'error': 'Ingen befolkningsdata laddad ännu.'}

    cell_area = float(size * size)
    total_area = sum(polygon_signed_area(p) for p in polys)

    # Bbox över alla polygoner → vilka cellindex som behöver testas.
    xs = [pt[0] for p in polys for ring in p for pt in ring]
    ys = [pt[1] for p in polys for ring in p for pt in ring]
    if not xs:
        return None
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    ei0, ei1 = int(minx // size), int(maxx // size)
    ni0, ni1 = int(miny // size), int(maxy // size)

    total_pop = 0.0
    cells_touched = 0
    full_cells = 0
    partial_cells = 0
    for ei in range(ei0, ei1 + 1):
        cx0 = ei * size
        cx1 = cx0 + size
        for ni in range(ni0, ni1 + 1):
            pop = cells.get((ei, ni))
            if not pop:
                continue
            cy0 = ni * size
            cy1 = cy0 + size
            inter = 0.0
            for p in polys:
                inter += cell_intersection_area(p, cx0, cy0, cx1, cy1)
            if inter <= 0:
                continue
            frac = min(1.0, inter / cell_area)
            total_pop += pop * frac
            cells_touched += 1
            if frac >= 0.999:
                full_cells += 1
            else:
                partial_cells += 1

    area_km2 = total_area / 1_000_000.0
    density = (total_pop / area_km2) if area_km2 > 0 else None
    return {
        'population': round(total_pop),
        'populationExact': total_pop,
        'areaKm2': area_km2,
        'densityPerKm2': density,
        'year': year,
        'cellSize': size,
        'cellsTouched': cells_touched,
        'fullCells': full_cells,
        'partialCells': partial_cells
    }


# ===========================================================================
# /grid – rutor i bbox som GeoJSON (EPSG:3006)
# ===========================================================================
def grid_geojson(bbox):
    minx, miny, maxx, maxy = bbox
    with _lock:
        cells = _cells
        size = _cell_size
        year = _year
    ei0, ei1 = int(minx // size), int(maxx // size)
    ni0, ni1 = int(miny // size), int(maxy // size)
    ncols = max(0, ei1 - ei0 + 1)
    nrows = max(0, ni1 - ni0 + 1)
    if ncols * nrows > MAX_GRID_CELLS * 4 and ncols * nrows > 0:
        # Grovt förhandsavslag innan vi ens slår i dicten.
        return {'tooMany': True, 'limit': MAX_GRID_CELLS}
    features = []
    for ei in range(ei0, ei1 + 1):
        for ni in range(ni0, ni1 + 1):
            pop = cells.get((ei, ni))
            if not pop:
                continue
            label, color = classify(pop)
            if color is None:
                continue
            e = ei * size
            n = ni * size
            ring = [[e, n], [e + size, n], [e + size, n + size],
                    [e, n + size], [e, n]]
            features.append({
                'type': 'Feature',
                'properties': {'beftotalt': pop, 'color': color,
                               'label': label},
                'geometry': {'type': 'Polygon', 'coordinates': [ring]}
            })
            if len(features) > MAX_GRID_CELLS:
                return {'tooMany': True, 'limit': MAX_GRID_CELLS}
    return {
        'type': 'FeatureCollection',
        'gridCrs': 'EPSG:3006',
        'year': year,
        'features': features
    }


# ===========================================================================
# /cell – alla attribut för EN ruta (live från SCB)
#   Rutnätet på kartan bär bara totalen; för full demografi (kön + åldrar)
#   hämtar vi rutans rad från SCB med ett CQL-filter på rutid_scb.
# ===========================================================================
def fetch_cell(e, n):
    with _lock:
        year = _year
    if not year:
        return {'found': False, 'error': 'Ingen data laddad.'}
    rutid = f'{int(round(e)):06d}{int(round(n)):07d}'
    typename = f'{LAYER_WORKSPACE}:{LAYER_BASE}{year}'
    cql = quote(f"rutid_scb='{rutid}'")
    url = (
        f'{SCB_WFS}?service=WFS&version=2.0.0&request=GetFeature'
        f'&typeNames={typename}&outputFormat=application/json'
        f'&srsName=EPSG:3006&count=1&CQL_FILTER={cql}'
    )
    try:
        data = json.loads(_http_get(url))
    except Exception as ex:  # noqa: BLE001
        return {'found': False, 'rutid': rutid, 'year': year,
                'error': f'Kunde inte nå SCB: {ex}'}
    feats = data.get('features') or []
    if not feats:
        return {'found': False, 'rutid': rutid, 'year': year}
    props = feats[0].get('properties') or {}
    pop = props.get(POP_ATTR)
    label, color = classify(pop)
    return {'found': True, 'rutid': rutid, 'year': year,
            'properties': props, 'beftotalt': pop,
            'label': label, 'color': color}


# ===========================================================================
# Refresh-tråd
# ===========================================================================
def refresh_loop():
    # Ladda lokal lagring; saknas den – ladda ner direkt vid start.
    if not load_store():
        _do_build()
    while True:
        _refresh_event.wait()
        _refresh_event.clear()
        _do_build()


def _status_dict(check_latest=False):
    latest = _latest_known
    if check_latest:
        try:
            latest = fetch_latest_year()
        except Exception:  # noqa: BLE001
            latest = _latest_known
    with _lock:
        year = _year
        count = len(_cells)
        gen = _generated
    return {
        'ok': True,
        'year': year,
        'latestYear': latest,
        'upToDate': (latest is not None and year == latest),
        'count': count,
        'cellSize': _cell_size,
        'generated': gen,
        'building': _building,
        'lastError': _last_error,
        'legend': legend()
    }


# ===========================================================================
# HTTP
# ===========================================================================
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path.endswith('/health'):
            return self._json(200, _status_dict(check_latest=False))

        if path.endswith('/status'):
            return self._json(200, _status_dict(check_latest=True))

        if path.endswith('/refresh'):
            return self._trigger_refresh(parsed)

        if path.endswith('/grid'):
            qs = parse_qs(parsed.query)
            bbox_str = (qs.get('bbox') or [''])[0]
            try:
                parts = [float(x) for x in bbox_str.split(',')]
                if len(parts) != 4:
                    raise ValueError
            except ValueError:
                return self._json(400, {'error': 'Ogiltig bbox (minE,minN,maxE,maxN).'})
            with _lock:
                have = bool(_cells)
            if not have:
                return self._json(503, {'error': 'Befolkningsdata laddas, försök strax igen.'})
            return self._json(200, grid_geojson(parts))

        if path.endswith('/cell'):
            qs = parse_qs(parsed.query)
            try:
                e = float((qs.get('e') or [''])[0])
                n = float((qs.get('n') or [''])[0])
            except ValueError:
                return self._json(400, {'error': 'Ogiltiga e/n.'})
            return self._json(200, fetch_cell(e, n))

        return self._json(404, {'error': 'Not found'})

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path.endswith('/refresh'):
            return self._trigger_refresh(parsed)

        if path.endswith('/calc'):
            length = int(self.headers.get('Content-Length') or 0)
            if length <= 0:
                return self._json(400, {'error': 'Tom body.'})
            try:
                body = json.loads(self.rfile.read(length))
            except (ValueError, json.JSONDecodeError):
                return self._json(400, {'error': 'Ogiltig JSON.'})
            geom = body
            if isinstance(body, dict) and body.get('type') == 'Feature':
                geom = body.get('geometry')
            elif isinstance(body, dict) and body.get('type') == 'FeatureCollection':
                feats = body.get('features') or []
                geom = feats[0].get('geometry') if feats else None
            with _lock:
                have = bool(_cells)
            if not have:
                return self._json(503, {'error': 'Befolkningsdata laddas, försök strax igen.'})
            result = calc_population(geom)
            if result is None:
                return self._json(400, {'error': 'Ingen yta i geometrin (Polygon/MultiPolygon krävs).'})
            if 'error' in result:
                return self._json(503, result)
            return self._json(200, result)

        return self._json(404, {'error': 'Not found'})

    def _trigger_refresh(self, parsed):
        if _building:
            return self._json(202, {'status': 'busy', 'year': _year})
        qs = parse_qs(parsed.query)
        if (qs.get('force') or ['0'])[0] in ('1', 'true', 'yes'):
            _force_flag.set()
        _refresh_event.set()
        return self._json(202, {'status': 'started', 'year': _year,
                                'latestYear': _latest_known})

    def _raw(self, code, body):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code, obj):
        self._raw(code, json.dumps(obj).encode('utf-8'))

    def log_message(self, *_):
        pass


if __name__ == '__main__':
    threading.Thread(target=refresh_loop, daemon=True).start()
    server = ThreadingHTTPServer(('0.0.0.0', 3005), Handler)
    server.daemon_threads = True
    server.serve_forever()
