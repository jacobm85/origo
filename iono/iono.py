"""Jonosfär-proxy + nationellt rutnät.

Endpoints (nås via nginx /proxy/iono/...):
  GET /iono/latest?lat=&lon=   → punktvärde från "Jonosfär Direkt" (Lantmäteriet),
                                 kompletterat med level + color (SWEPOS-trafikljus).
  GET /iono/grid               → cachat GeoJSON-rutnät över Sverige, färgklassat.
  GET /iono/health             → status + när rutnätet senast byggdes.

Servern samplar punkt-API:t i ett rutnät och cachar resultatet. Rutnätet byggs
en gång vid start och därefter på schema (default dagligen kl 07:00 — sätt
IONO_GRID_REFRESH_AT, eller IONO_GRID_REFRESH_EVERY_MIN för intervall).

Inloggningsuppgifterna läses från IONO_USER / IONO_PASS och lämnar aldrig
servern. Färgtrösklar och rutnätets utbredning/upplösning styrs via env.
"""
import base64
import datetime
import json
import os
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlencode, urlparse, parse_qs

USER = os.environ.get('IONO_USER', '')
PASSWORD = os.environ.get('IONO_PASS', '')
API_BASE = os.environ.get('IONO_API_BASE', 'https://api.lantmateriet.se/iono/1.0').rstrip('/')
TIMEOUT = float(os.environ.get('IONO_TIMEOUT', '10'))
_AUTH = base64.b64encode(f'{USER}:{PASSWORD}'.encode()).decode()

# --- Färgnivåer (trafikljus likt SWEPOS). Trösklar på "variability". ---
# OBS: justera dessa i .env när du sett de faktiska värdena. v <= GREEN_MAX = grön,
# <= YELLOW_MAX = gul, <= ORANGE_MAX = orange, däröver = röd.
GREEN_MAX = float(os.environ.get('IONO_GREEN_MAX', '30'))
YELLOW_MAX = float(os.environ.get('IONO_YELLOW_MAX', '60'))
ORANGE_MAX = float(os.environ.get('IONO_ORANGE_MAX', '100'))
COLOR_GREEN = os.environ.get('IONO_COLOR_GREEN', '#2e9e3f')
COLOR_YELLOW = os.environ.get('IONO_COLOR_YELLOW', '#f2c200')
COLOR_ORANGE = os.environ.get('IONO_COLOR_ORANGE', '#e08a1e')
COLOR_RED = os.environ.get('IONO_COLOR_RED', '#d23c1e')
COLOR_NONE = os.environ.get('IONO_COLOR_NONE', '#999999')

# --- Rutnätets utbredning (WGS84) och upplösning (grader) ---
GRID_LAT_MIN = float(os.environ.get('IONO_GRID_LAT_MIN', '55.2'))
GRID_LAT_MAX = float(os.environ.get('IONO_GRID_LAT_MAX', '69.1'))
GRID_LON_MIN = float(os.environ.get('IONO_GRID_LON_MIN', '10.5'))
GRID_LON_MAX = float(os.environ.get('IONO_GRID_LON_MAX', '24.2'))
GRID_DLAT = float(os.environ.get('IONO_GRID_DLAT', '0.5'))   # ~55 km
GRID_DLON = float(os.environ.get('IONO_GRID_DLON', '1.0'))   # ~50–70 km
GRID_WORKERS = int(os.environ.get('IONO_GRID_WORKERS', '6'))

# --- Schema: dagligen kl HH:MM (default), eller var N:e minut om satt ---
REFRESH_AT = os.environ.get('IONO_GRID_REFRESH_AT', '07:00')
REFRESH_EVERY_MIN = int(os.environ.get('IONO_GRID_REFRESH_EVERY_MIN', '0'))

_grid_lock = threading.Lock()
_grid_json = None
_grid_built_at = None
_rebuild_event = threading.Event()
_building = False


def classify(v):
    if v is None:
        return ('okänd', COLOR_NONE)
    if v <= GREEN_MAX:
        return ('grön', COLOR_GREEN)
    if v <= YELLOW_MAX:
        return ('gul', COLOR_YELLOW)
    if v <= ORANGE_MAX:
        return ('orange', COLOR_ORANGE)
    return ('röd', COLOR_RED)


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
    points = [(lat, lon)
              for lat in _frange(GRID_LAT_MIN, GRID_LAT_MAX, GRID_DLAT)
              for lon in _frange(GRID_LON_MIN, GRID_LON_MAX, GRID_DLON)]

    def work(pt):
        lat, lon = pt
        try:
            data = fetch_variability(lat, lon)
            v = float(data.get('variability'))
        except (urllib.error.URLError, OSError, ValueError, TypeError):
            v = None
        return (lat, lon, v)

    with ThreadPoolExecutor(max_workers=GRID_WORKERS) as ex:
        results = list(ex.map(work, points))

    half_lat = GRID_DLAT / 2.0
    half_lon = GRID_DLON / 2.0
    features = []
    for lat, lon, v in results:
        level, color = classify(v)
        ring = [
            [lon - half_lon, lat - half_lat],
            [lon + half_lon, lat - half_lat],
            [lon + half_lon, lat + half_lat],
            [lon - half_lon, lat + half_lat],
            [lon - half_lon, lat - half_lat]
        ]
        features.append({
            'type': 'Feature',
            'properties': {'variability': v, 'level': level, 'color': color},
            'geometry': {'type': 'Polygon', 'coordinates': [ring]}
        })

    fc = {
        'type': 'FeatureCollection',
        'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:OGC:1.3:CRS84'}},
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
                return self._json(500, {'error': 'IONO_USER/IONO_PASS är inte satta i .env.'})
            if _building:
                return self._json(202, {'status': 'busy', 'gridBuiltAt': _grid_built_at})
            _rebuild_event.set()
            return self._json(202, {'status': 'started', 'gridBuiltAt': _grid_built_at})

        if path.endswith('/latest'):
            if not USER or not PASSWORD:
                return self._json(500, {'error': 'IONO_USER/IONO_PASS är inte satta i .env.'})
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
