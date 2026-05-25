"""Jonosfär-proxy.

Tar emot GET /iono/latest?lat=..&lon=.. från kartan (via nginx /proxy/iono/)
och frågar Lantmäteriets tjänst "Jonosfär Direkt" med Basic Auth. Svaret
(JSON med bl.a. `variability` och `gpsTime`) skickas vidare oförändrat.

Inloggningsuppgifterna läses från miljövariablerna IONO_USER / IONO_PASS och
lämnar aldrig servern — de ligger inte i koden och ska inte checkas in. Sätt
dem i docker-compose.yml.
"""
import base64
import json
import os
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlencode, urlparse, parse_qs

USER = os.environ.get('IONO_USER', '')
PASSWORD = os.environ.get('IONO_PASS', '')
API_BASE = os.environ.get('IONO_API_BASE', 'https://api.lantmateriet.se/iono/1.0').rstrip('/')
TIMEOUT = float(os.environ.get('IONO_TIMEOUT', '10'))

_AUTH = base64.b64encode(f'{USER}:{PASSWORD}'.encode()).decode()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if not parsed.path.endswith('/latest'):
            return self._json(404, {'error': 'Not found'})

        if not USER or not PASSWORD:
            return self._json(500, {'error': 'IONO_USER/IONO_PASS är inte satta i compose.'})

        qs = parse_qs(parsed.query)
        lat = (qs.get('lat') or [''])[0]
        lon = (qs.get('lon') or [''])[0]
        if not lat or not lon:
            return self._json(400, {'error': 'Saknar lat/lon'})

        url = f'{API_BASE}/variabilities/latest?' + urlencode({'latitude': lat, 'longitude': lon})
        req = urllib.request.Request(url, headers={
            'Authorization': f'Basic {_AUTH}',
            'Accept': 'application/json',
            'User-Agent': 'origo-iono-proxy/1.0'
        })
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                body = resp.read()
            return self._raw(200, body)
        except urllib.error.HTTPError as e:
            return self._json(e.code, {'error': f'Lantmäteriet svarade {e.code}'})
        except (urllib.error.URLError, OSError) as e:
            return self._json(502, {'error': f'Kunde inte nå Lantmäteriet: {e}'})

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
    server = ThreadingHTTPServer(('0.0.0.0', 3002), Handler)
    server.daemon_threads = True
    server.serve_forever()
