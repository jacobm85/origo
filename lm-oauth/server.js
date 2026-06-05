/* lm-oauth — OAuth2-proxy för Lantmäteriets API-portal (apimanager).
 *
 * Lantmäteriets OAuth2-skyddade tjänster (t.ex. Fastighetsindelning-WMS via
 * /proxy/lantmateriet/) kräver en Bearer-token. Tokenen är kortlivad (~1 h) och
 * hämtas med "client credentials"-flödet ur ett par: Consumer Key + Consumer
 * Secret (skapas per applikation i API-portalen).
 *
 * Den här tjänsten gör det automatiskt: den hämtar och cachar en token ur
 * LM_OAUTH_KEY/LM_OAUTH_SECRET och vidarebefordrar inkommande anrop till
 * apimanager med Authorization: Bearer. Nyckeln/secreten lämnar aldrig
 * containern. Faller tillbaka på en statisk LM_BEARER_TOKEN om key/secret
 * saknas (bakåtkompatibelt med den tidigare uppsättningen).
 *
 * nginx proxar /proxy/lantmateriet/ hit. Konfiguration via miljövariabler:
 *   LM_OAUTH_KEY / LM_OAUTH_SECRET – applikationens consumer key + secret
 *   LM_OAUTH_TOKEN_URL             – default https://apimanager.lantmateriet.se/oauth2/token
 *   LM_OAUTH_SCOPE                 – valfri scope (lämna tom om den inte krävs)
 *   LM_OAUTH_UPSTREAM              – default https://apimanager.lantmateriet.se
 *   LM_OAUTH_API_UPSTREAM         – runtime-gateway för "X-LM-Upstream: api"
 *                                   (default https://api.lantmateriet.se, t.ex. Markhöjd Direkt)
 *   LM_BEARER_TOKEN                – fallback: statisk token om key/secret saknas
 *   PORT                           – default 3004
 */

const express = require('express');
const { Readable } = require('stream');

const PORT = parseInt(process.env.PORT || 3004, 10);
const UPSTREAM = (process.env.LM_OAUTH_UPSTREAM || 'https://apimanager.lantmateriet.se').replace(/\/$/, '');
// Runtime-gatewayen för de tjänster som inte serveras av apimanager (t.ex.
// Markhöjd Direkt). Token hämtas alltid från samma token-endpoint (apimanager),
// men själva API-anropet måste gå till api.lantmateriet.se. nginx väljer denna
// gateway per location genom att sätta headern "X-LM-Upstream: api" – headern
// sätts server-side och kan inte styras av klienten (ingen öppen vidarekoppling).
const API_UPSTREAM = (process.env.LM_OAUTH_API_UPSTREAM || 'https://api.lantmateriet.se').replace(/\/$/, '');
const TOKEN_URL = process.env.LM_OAUTH_TOKEN_URL || 'https://apimanager.lantmateriet.se/oauth2/token';
const KEY = process.env.LM_OAUTH_KEY || '';
const SECRET = process.env.LM_OAUTH_SECRET || '';
const SCOPE = process.env.LM_OAUTH_SCOPE || '';
const STATIC_TOKEN = process.env.LM_BEARER_TOKEN || '';

const UPSTREAM_HOST = (() => { try { return new URL(UPSTREAM).host; } catch (e) { return ''; } })();
const API_UPSTREAM_HOST = (() => { try { return new URL(API_UPSTREAM).host; } catch (e) { return ''; } })();

let cachedToken = null;
let tokenExpiresAt = 0;

// Hämtar (och cachar) en access token via client credentials-flödet.
async function getToken() {
  if (KEY && SECRET) {
    const now = Date.now();
    // Förnya 60 s innan utgång för marginal.
    if (cachedToken && now < tokenExpiresAt - 60000) return cachedToken;
    const basic = Buffer.from(`${KEY}:${SECRET}`).toString('base64');
    const body = new URLSearchParams({ grant_type: 'client_credentials' });
    if (SCOPE) body.set('scope', SCOPE);
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body
    });
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`token-endpoint svarade ${resp.status}: ${t.slice(0, 200)}`);
    }
    const j = await resp.json();
    cachedToken = j.access_token;
    tokenExpiresAt = Date.now() + ((Number(j.expires_in) || 3600) * 1000);
    return cachedToken;
  }
  if (STATIC_TOKEN) return STATIC_TOKEN;
  throw new Error('LM_OAUTH_KEY/LM_OAUTH_SECRET (eller LM_BEARER_TOKEN) saknas');
}

const app = express();
app.disable('x-powered-by');

app.get('/health', (req, res) => res.json({
  ok: true,
  mode: (KEY && SECRET) ? 'client_credentials' : (STATIC_TOKEN ? 'static_token' : 'unconfigured'),
  tokenCached: Boolean(cachedToken)
}));

// Allt annat: vidarebefordra till apimanager med Bearer-token.
app.use(async (req, res) => {
  let token;
  try {
    token = await getToken();
  } catch (e) {
    return res.status(502).type('text/plain').send(`OAuth2-token misslyckades: ${e.message}`);
  }

  // Välj gateway: api.lantmateriet.se när nginx satt "X-LM-Upstream: api"
  // (t.ex. Markhöjd Direkt), annars apimanager (t.ex. Fastighetsindelning).
  const useApi = String(req.headers['x-lm-upstream'] || '').toLowerCase() === 'api';
  const base = useApi ? API_UPSTREAM : UPSTREAM;
  const baseHost = useApi ? API_UPSTREAM_HOST : UPSTREAM_HOST;

  const url = base + req.originalUrl;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: req.headers.accept || '*/*'
  };
  if (baseHost) headers.Host = baseHost;

  // WMS-anropen är GET; för andra metoder buffras body (sällsynt).
  let fetchBody;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    fetchBody = await new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', () => resolve(undefined));
    });
    if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
  }

  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers,
      body: fetchBody,
      redirect: 'follow'
    });
    res.status(upstream.status);
    const ct = upstream.headers.get('content-type');
    if (ct) res.set('Content-Type', ct);
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (upstream.body) Readable.fromWeb(upstream.body).pipe(res);
    else res.end();
  } catch (e) {
    res.status(502).type('text/plain').send(`Proxyfel mot ${baseHost || 'upstream'}: ${e.message}`);
  }
});

app.listen(PORT, () => {
  const mode = (KEY && SECRET) ? 'client_credentials (key+secret)'
    : (STATIC_TOKEN ? 'statisk LM_BEARER_TOKEN' : 'OKONFIGURERAD');
  console.log(`[lm-oauth] lyssnar på :${PORT} → ${UPSTREAM} (läge: ${mode})`);
});
