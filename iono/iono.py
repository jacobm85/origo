"""Jonosfär-proxy + nationellt rutnät.

Endpoints (nås via nginx /proxy/iono/...):
  GET /iono/latest?lat=&lon=   → punktvärde från "Jonosfär Direkt" (Lantmäteriet),
                                 kompletterat med level + color (6-gradig skala).
  GET /iono/grid               → cachat GeoJSON-rutnät över Sverige, färgklassat.
  GET /iono/health             → status + när rutnätet senast byggdes.

Servern samplar punkt-API:t i ett rutnät och cachar resultatet. Rutnätet byggs
en gång vid start och därefter på intervall (default var 60:e minut — sätt
IONO_GRID_REFRESH_EVERY_MIN, eller IONO_GRID_REFRESH_AT för en fast klockslag).

Inloggningsuppgifterna läses från LM_USER / LM_PASS och lämnar aldrig
servern. Färgtrösklar och rutnätets utbredning/upplösning styrs via env.
"""
import base64
import datetime
import json
import math
import os
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlencode, urlparse, parse_qs

# Gemensam Lantmäteri-inloggning. LM_USER/LM_PASS är den nya kanoniska
# varianten; IONO_USER/IONO_PASS behålls som fallback för äldre .env-filer.
USER = os.environ.get('LM_USER') or os.environ.get('IONO_USER', '')
PASSWORD = os.environ.get('LM_PASS') or os.environ.get('IONO_PASS', '')
API_BASE = os.environ.get('IONO_API_BASE', 'https://api.lantmateriet.se/iono/1.0').rstrip('/')
TIMEOUT = float(os.environ.get('IONO_TIMEOUT', '10'))
_AUTH = base64.b64encode(f'{USER}:{PASSWORD}'.encode()).decode()

# --- Färgskala: Lantmäteriets 6-gradiga jonosfärskala på "variability" (mm).
#     Klasser: 0–5, 5–10, 10–15, 15–20, 20–25, 25–30+ (grön -> röd).
#     IONO_BREAKS = övre gränser för de fem första klasserna (den sjätte är resten).
#     Antal färger/etiketter måste vara antal brytpunkter + 1. Justera i .env. ---
IONO_BREAKS = [float(x) for x in os.environ.get(
    'IONO_BREAKS', '5,10,15,20,25').split(',')]
IONO_COLORS = [c.strip() for c in os.environ.get(
    'IONO_COLORS', '#a6d96a,#2e9e3f,#f2c200,#fdae61,#e8602c,#d23c1e').split(',')]
IONO_LABELS = [s.strip() for s in os.environ.get(
    'IONO_LABELS', '0–5,5–10,10–15,15–20,20–25,25–30+').split(',')]
COLOR_NONE = os.environ.get('IONO_COLOR_NONE', '#999999')

# --- Rutnätets utbredning och upplösning i SWEREF 99 TM (EPSG:3006), meter ---
#     Rutnätet genereras i kartans projektion så att cellerna blir RAKA rektanglar
#     (ett lon/lat-rutnät blir krökt/vridet i transversal Mercator). Cellcentrum
#     konverteras till lat/lon för punkt-API:t via invers Gauss-konform projektion.
GRID_E_MIN = float(os.environ.get('IONO_GRID_E_MIN', '250000'))
GRID_E_MAX = float(os.environ.get('IONO_GRID_E_MAX', '920000'))
GRID_N_MIN = float(os.environ.get('IONO_GRID_N_MIN', '6130000'))
GRID_N_MAX = float(os.environ.get('IONO_GRID_N_MAX', '7700000'))
GRID_DE = float(os.environ.get('IONO_GRID_DE', '50000'))   # 50 km
GRID_DN = float(os.environ.get('IONO_GRID_DN', '50000'))   # 50 km
GRID_WORKERS = int(os.environ.get('IONO_GRID_WORKERS', '6'))

# SWEREF 99 TM (EPSG:3006) → WGS84, Lantmäteriets Gauss-konforma invers (Krüger).
_TM_A = 6378137.0                 # GRS80 halvstora axel
_TM_F = 1.0 / 298.257222101       # GRS80 tillplattning
_TM_K0 = 0.9996
_TM_FE = 500000.0
_TM_FN = 0.0
_TM_LON0 = math.radians(15.0)     # centralmeridian


def grid3006_to_wgs84(easting, northing):
    """SWEREF 99 TM (E, N) → (lat, lon) i grader."""
    e2 = _TM_F * (2 - _TM_F)
    n = _TM_F / (2 - _TM_F)
    a_hat = _TM_A / (1 + n) * (1 + n ** 2 / 4 + n ** 4 / 64)
    xi = (northing - _TM_FN) / (_TM_K0 * a_hat)
    eta = (easting - _TM_FE) / (_TM_K0 * a_hat)
    d1 = n / 2 - 2 / 3 * n ** 2 + 37 / 96 * n ** 3 - 1 / 360 * n ** 4
    d2 = 1 / 48 * n ** 2 + 1 / 15 * n ** 3 - 437 / 1440 * n ** 4
    d3 = 17 / 480 * n ** 3 - 37 / 840 * n ** 4
    d4 = 4397 / 161280 * n ** 4
    xi_p = (xi
            - d1 * math.sin(2 * xi) * math.cosh(2 * eta)
            - d2 * math.sin(4 * xi) * math.cosh(4 * eta)
            - d3 * math.sin(6 * xi) * math.cosh(6 * eta)
            - d4 * math.sin(8 * xi) * math.cosh(8 * eta))
    eta_p = (eta
             - d1 * math.cos(2 * xi) * math.sinh(2 * eta)
             - d2 * math.cos(4 * xi) * math.sinh(4 * eta)
             - d3 * math.cos(6 * xi) * math.sinh(6 * eta)
             - d4 * math.cos(8 * xi) * math.sinh(8 * eta))
    phi_star = math.asin(math.sin(xi_p) / math.cosh(eta_p))
    dlon = math.atan2(math.sinh(eta_p), math.cos(xi_p))
    lon = _TM_LON0 + dlon
    aa = e2 + e2 ** 2 + e2 ** 3 + e2 ** 4
    bb = -(7 * e2 ** 2 + 17 * e2 ** 3 + 30 * e2 ** 4) / 6
    cc = (224 * e2 ** 3 + 889 * e2 ** 4) / 120
    dd = -(4279 * e2 ** 4) / 1260
    sp = math.sin(phi_star)
    lat = phi_star + sp * math.cos(phi_star) * (aa + bb * sp ** 2 + cc * sp ** 4 + dd * sp ** 6)
    return math.degrees(lat), math.degrees(lon)

# --- Schema: var N:e minut (default 60), eller fast klockslag HH:MM om
#     IONO_GRID_REFRESH_EVERY_MIN sätts till 0 och IONO_GRID_REFRESH_AT anges ---
REFRESH_AT = os.environ.get('IONO_GRID_REFRESH_AT', '07:00')
REFRESH_EVERY_MIN = int(os.environ.get('IONO_GRID_REFRESH_EVERY_MIN', '60'))

_grid_lock = threading.Lock()
_grid_json = None
_grid_built_at = None
_rebuild_event = threading.Event()
_building = False


def classify(v):
    if v is None:
        return ('okänd', COLOR_NONE)
    for i, b in enumerate(IONO_BREAKS):
        if v <= b:
            return (IONO_LABELS[i], IONO_COLORS[i])
    return (IONO_LABELS[-1], IONO_COLORS[-1])


def fetch_variability(lat, lon):
    url = f'{API_BASE}/variabilities/latest?' + urlencode({'latitude': lat, 'longitude': lon})
    req = urllib.request.Request(url, headers={
        'Authorization': f'Basic {_AUTH}',
        'Accept': 'application/json',
        'User-Agent': 'origo-iono-proxy/1.0'
    })
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return json.loads(resp.read())


def _frange(start, stop, step):
    vals = []
    x = start
    while x <= stop + 1e-9:
        vals.append(round(x, 6))
        x += step
    return vals


def build_grid():
    # SV-hörn för varje cell i 3006 (meter).
    cells = [(e, n)
             for e in _frange(GRID_E_MIN, GRID_E_MAX - GRID_DE, GRID_DE)
             for n in _frange(GRID_N_MIN, GRID_N_MAX - GRID_DN, GRID_DN)]

    def work(cell):
        e, n = cell
        # Cellens mittpunkt → lat/lon för punkt-API:t.
        lat, lon = grid3006_to_wgs84(e + GRID_DE / 2.0, n + GRID_DN / 2.0)
        try:
            data = fetch_variability(lat, lon)
            v = float(data.get('variability'))
        except (urllib.error.URLError, OSError, ValueError, TypeError):
            v = None
        return (e, n, v)

    with ThreadPoolExecutor(max_workers=GRID_WORKERS) as ex:
        results = list(ex.map(work, cells))

    features = []
    for e, n, v in results:
        level, color = classify(v)
        # Rak rektangel i 3006 → blir en rak ruta på SWEREF-kartan.
        ring = [
            [e, n],
            [e + GRID_DE, n],
            [e + GRID_DE, n + GRID_DN],
            [e, n + GRID_DN],
            [e, n]
        ]
        features.append({
            'type': 'Feature',
            'properties': {'variability': v, 'level': level, 'color': color},
            'geometry': {'type': 'Polygon', 'coordinates': [ring]}
        })

    # Koordinaterna är i EPSG:3006. Vi anger gridCrs så att klienten transformerar
    # från rätt projektion (3006 → kartans projektion = identitet när kartan är
    # 3006). Ingen GeoJSON-"crs"-medlem (OL:s format-reprojektion hanterar den fel
    # i 3006 – klienten bygger geometrin manuellt och transformerar själv).
    fc = {
        'type': 'FeatureCollection',
        'gridCrs': 'EPSG:3006',
        'generated': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'features': features
    }
    return json.dumps(fc)


def _seconds_until_next():
    if REFRESH_EVERY_MIN > 0:
        return REFRESH_EVERY_MIN * 60
    try:
        hh, mm = (int(x) for x in REFRESH_AT.split(':'))
    except ValueError:
        hh, mm = 7, 0
    now = datetime.datetime.now()
    nxt = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if nxt <= now:
        nxt += datetime.timedelta(days=1)
    return max(60.0, (nxt - now).total_seconds())


def _do_build():
    global _grid_json, _grid_built_at, _building
    _building = True
    try:
        g = build_grid()
        with _grid_lock:
            _grid_json = g
            _grid_built_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
        print(f'[iono] rutnät byggt ({_grid_built_at})', flush=True)
    except Exception as e:  # noqa: BLE001 - logga och fortsätt
        print(f'[iono] kunde inte bygga rutnät: {e}', flush=True)
    finally:
        _building = False


def refresh_loop():
    # Bygg en gång vid start, vänta sedan på antingen schemat eller en
    # manuell trigger (/iono/refresh sätter _rebuild_event).
    while True:
        if USER and PASSWORD:
            _do_build()
        _rebuild_event.wait(timeout=_seconds_until_next())
        _rebuild_event.clear()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path.endswith('/grid'):
            with _grid_lock:
                g = _grid_json
            if g is None:
                return self._json(503, {'error': 'Rutnätet byggs fortfarande, försök strax igen.'})
            return self._raw(200, g.encode('utf-8'))

        if path.endswith('/health'):
            return self._json(200, {'ok': True, 'gridBuiltAt': _grid_built_at,
                                    'building': _building,
                                    'haveCreds': bool(USER and PASSWORD)})

        if path.endswith('/refresh'):
            if not USER or not PASSWORD:
                return self._json(500, {'error': 'LM_USER/LM_PASS är inte satta i .env.'})
            if _building:
                return self._json(202, {'status': 'busy', 'gridBuiltAt': _grid_built_at})
            _rebuild_event.set()
            return self._json(202, {'status': 'started', 'gridBuiltAt': _grid_built_at})

        if path.endswith('/latest'):
            if not USER or not PASSWORD:
                return self._json(500, {'error': 'LM_USER/LM_PASS är inte satta i .env.'})
            qs = parse_qs(parsed.query)
            lat = (qs.get('lat') or [''])[0]
            lon = (qs.get('lon') or [''])[0]
            if not lat or not lon:
                return self._json(400, {'error': 'Saknar lat/lon'})
            try:
                data = fetch_variability(lat, lon)
            except urllib.error.HTTPError as e:
                return self._json(e.code, {'error': f'Lantmäteriet svarade {e.code}'})
            except (urllib.error.URLError, OSError) as e:
                return self._json(502, {'error': f'Kunde inte nå Lantmäteriet: {e}'})
            try:
                v = float(data.get('variability'))
            except (ValueError, TypeError):
                v = None
            level, color = classify(v)
            data['level'] = level
            data['color'] = color
            return self._json(200, data)

        return self._json(404, {'error': 'Not found'})

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
    server = ThreadingHTTPServer(('0.0.0.0', 3002), Handler)
    server.daemon_threads = True
    server.serve_forever()
