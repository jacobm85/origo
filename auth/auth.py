import os
import hashlib
import http.cookies
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import parse_qs, unquote_plus

USER = os.environ.get('APP_USER', 'admin')
PASSWORD = os.environ.get('APP_PASSWORD', 'origo')
# Session token = SHA-256 of "user:password" — never leaves the server
TOKEN = hashlib.sha256(f"{USER}:{PASSWORD}".encode()).hexdigest()

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/auth/check'):
            cookies = http.cookies.SimpleCookie(self.headers.get('Cookie', ''))
            val = cookies['origo_auth'].value if 'origo_auth' in cookies else ''
            if val == TOKEN:
                self.respond(200)
            else:
                self.respond(401)
        else:
            self.respond(404)

    def do_POST(self):
        if self.path == '/auth/login':
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length).decode()
            params = parse_qs(body)
            user = unquote_plus(params.get('user', [''])[0])
            pw   = unquote_plus(params.get('pass', [''])[0])
            if user == USER and pw == PASSWORD:
                self.send_response(302)
                self.send_header('Set-Cookie',
                    f'origo_auth={TOKEN}; Path=/; HttpOnly; SameSite=Strict')
                self.send_header('Location', '/')
                self.end_headers()
            else:
                self.send_response(302)
                self.send_header('Location', '/login?error=1')
                self.end_headers()
        else:
            self.respond(404)

    def respond(self, code):
        self.send_response(code)
        self.end_headers()

    def log_message(self, *_):
        pass

HTTPServer(('0.0.0.0', 3000), Handler).serve_forever()
