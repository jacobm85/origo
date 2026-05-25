import os
import hashlib
import http.cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote_plus

USER = os.environ.get('APP_USER', 'admin')
PASSWORD = os.environ.get('APP_PASSWORD', 'origo')
# Session token = SHA-256 of "user:password" — never leaves the server.
TOKEN = hashlib.sha256(f"{USER}:{PASSWORD}".encode()).hexdigest()
# Keep the login for 30 days so the browser doesn't drop it on restart.
COOKIE_MAX_AGE = 60 * 60 * 24 * 30


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        # nginx auth_request hits this on every request. Validate the cookie.
        if self.path.startswith('/auth/check'):
            self.respond(200 if self._is_authed() else 401)
        else:
            self.respond(404)

    def do_POST(self):
        if self.path == '/auth/login':
            user, pw = self._read_credentials()
            if user == USER and pw == PASSWORD:
                self.send_response(302)
                self.send_header(
                    'Set-Cookie',
                    f'origo_auth={TOKEN}; Path=/; Max-Age={COOKIE_MAX_AGE}; '
                    'HttpOnly; SameSite=Lax')
                self.send_header('Location', '/')
                self.end_headers()
            else:
                self.send_response(302)
                self.send_header('Location', '/login?error=1')
                self.end_headers()
        else:
            self.respond(404)

    def _is_authed(self):
        try:
            cookies = http.cookies.SimpleCookie(self.headers.get('Cookie', ''))
            morsel = cookies.get('origo_auth')
            return morsel is not None and morsel.value == TOKEN
        except http.cookies.CookieError:
            return False

    def _read_credentials(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length).decode('utf-8', 'replace')
            params = parse_qs(body)
            user = unquote_plus(params.get('user', [''])[0])
            pw = unquote_plus(params.get('pass', [''])[0])
            return user, pw
        except (ValueError, OSError):
            return '', ''

    def respond(self, code):
        self.send_response(code)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def log_message(self, *_):
        pass


if __name__ == '__main__':
    # ThreadingHTTPServer handles the SPA's many parallel requests; the old
    # single-threaded server queued them and tripped nginx auth_request 500s.
    server = ThreadingHTTPServer(('0.0.0.0', 3000), Handler)
    server.daemon_threads = True
    server.serve_forever()
