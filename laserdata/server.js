/* Laserdata-backend.
 *
 * Hämtar Lantmäteriets laserdata (punktmoln, LAZ/COPC) DIREKT från deras
 * STAC-höjd-API i stället för från en lokal NAS. Speglar ortofoto-backenden:
 * Basic Auth injiceras server-side så att Lantmäteriets uppgifter aldrig hamnar
 * i klienten eller i git. Behörigheten ligger på samma Geotorget-konto som
 * ortofoto/jonosfär (LM_USER/LM_PASS).
 *
 * STAC: https://api.lantmateriet.se/stac-hojd/v1/  (collection "dsm-skoglig-copc",
 * "Laserdata Skog", asset "data" = .copc.laz på dl*.lantmateriet.se).
 *
 * Endpoints (nginx proxar /api/laserdata/ hit, bakom inloggningen):
 *   POST /api/laserdata/search    JSON {"bbox":[w,s,e,n],"limit"?}  → slimmad FeatureCollection
 *   POST /api/laserdata/estimate  JSON {"items":["href",…]}         → {count,totalSize}
 *   POST /api/laserdata/download  JSON eller form items=[…]         → application/zip (strömmas)
 *   GET  /health                                                    → {ok,hasAuth}
 *
 * Konfiguration via miljövariabler:
 *   LM_USER / LM_PASS    – Basic Auth mot api.lantmateriet.se + dl*.lantmateriet.se
 *   STAC_SEARCH_URL      – default https://api.lantmateriet.se/stac-hojd/v1/search
 *   STAC_COLLECTION      – default dsm-skoglig-copc
 *   ALLOWED_HOST_SUFFIX  – default ".lantmateriet.se" (SSRF-skydd)
 *   MAX_FILES            – default 200
 *   MAX_BYTES            – default 50 GB
 *   PORT                 – default 3001
 *   LASERDATA_PRIME      – "false" stänger av sessions-primingen (default på)
 *   LASERDATA_PRIME_COLLECTION – default dtm-cog (markhöjdmodellen)
 *   LASERDATA_PRIME_URL  – valfri explicit .tif-URL att prima med
 *   LASERDATA_PRIME_BBOX – liten WGS84-bbox för prime-sökningen
 */

const express = require('express');
const archiver = require('archiver');
const path = require('path');
const { Readable } = require('stream');

const PORT = parseInt(process.env.PORT || 3001, 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const STAC_SEARCH_URL = process.env.STAC_SEARCH_URL
  || 'https://api.lantmateriet.se/stac-hojd/v1/search';
const STAC_COLLECTION = process.env.STAC_COLLECTION || 'dsm-skoglig-copc';
const ALLOWED_HOST_SUFFIX = process.env.ALLOWED_HOST_SUFFIX || '.lantmateriet.se';
const MAX_FILES = parseInt(process.env.MAX_FILES || 200, 10);
const MAX_BYTES = parseInt(process.env.MAX_BYTES || (50 * 1024 ** 3), 10);
const SEARCH_LIMIT = parseInt(process.env.SEARCH_LIMIT || 4000, 10);

// Gemensam Lantmäteri-inloggning. LM_USER/LM_PASS är den kanoniska varianten;
// IONO_USER/LM_STAC_USER behålls som fallback för äldre .env-filer.
const USER = process.env.LM_USER || process.env.LM_STAC_USER || process.env.IONO_USER || '';
const PASS = process.env.LM_PASS || process.env.LM_STAC_PASS || process.env.IONO_PASS || '';
if (!USER || !PASS) {
  console.warn('[laserdata] VARNING: LM_USER/LM_PASS saknas – '
    + 'sök och nedladdning kommer att nekas av Lantmäteriet (401).');
}
const AUTH_HEADER = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

// --- Sessions-"priming" mot Lantmäteriets nedladdningsgateway ---------------
// Observation: laserdata-rutorna (dsm-skoglig-copc) ger 403 tills man först har
// gjort en lyckad nedladdning av en produkt kontot är auktoriserat för
// (markhöjdmodellen, dtm-cog). Gatewayen sätter då en sessions-cookie
// (JSESSIONID) som tycks låsa upp efterföljande nedladdningar. Vi replikerar
// det: vid start (och vid 401/403) GET:ar vi en markhöjd-ruta med Basic Auth,
// fångar cookien och slänger innehållet (sparas aldrig till disk), och skickar
// sedan cookien på laserdata-anropen. Stäng av med LASERDATA_PRIME=false.
const PRIME_ENABLED = (process.env.LASERDATA_PRIME || 'true').toLowerCase() !== 'false';
const PRIME_COLLECTION = process.env.LASERDATA_PRIME_COLLECTION || 'dtm-cog';
const PRIME_URL = process.env.LASERDATA_PRIME_URL || ''; // valfri explicit .tif-URL
const PRIME_BBOX = (process.env.LASERDATA_PRIME_BBOX || '13.0,55.6,13.2,55.8')
  .split(',').map(Number);

let sessionCookie = '';   // "namn=värde; namn2=värde2" som skickas vidare
let priming = null;       // pågående prime-löfte (avdupliceras)

// Plockar ut name=value-paren ur Set-Cookie-headern (utan attribut).
function cookiePairsFromResponse(resp) {
  let setCookies = [];
  if (typeof resp.headers.getSetCookie === 'function') setCookies = resp.headers.getSetCookie();
  else { const sc = resp.headers.get('set-cookie'); if (sc) setCookies = [sc]; }
  return setCookies.map((c) => c.split(';')[0].trim()).filter(Boolean);
}

// Slår ihop nya cookies med befintliga (nya skriver över samma namn).
function mergeCookies(pairs) {
  if (!pairs.length) return;
  const jar = new Map();
  sessionCookie.split('; ').filter(Boolean).forEach((p) => {
    const i = p.indexOf('='); if (i > 0) jar.set(p.slice(0, i), p.slice(i + 1));
  });
  pairs.forEach((p) => {
    const i = p.indexOf('='); if (i > 0) jar.set(p.slice(0, i), p.slice(i + 1));
  });
  sessionCookie = Array.from(jar, ([k, v]) => `${k}=${v}`).join('; ');
}

// Headers för Lantmäteri-anropen: Basic Auth + ev. sessions-cookie.
function lmHeaders(extra) {
  const h = Object.assign({ Authorization: AUTH_HEADER }, extra || {});
  if (sessionCookie) h.Cookie = sessionCookie;
  return h;
}

// Tömmer en web-ReadableStream (vi behöver inte spara innehållet).
function drain(webStream) {
  return new Promise((resolve) => {
    if (!webStream) { resolve(); return; }
    const s = Readable.fromWeb(webStream);
    s.on('data', () => {});
    s.on('end', resolve);
    s.on('error', resolve);
  });
}

// Hittar en markhöjd-asset att prima med (öppen STAC-sökning, ingen auth krävs).
async function findPrimeHref() {
  if (PRIME_URL) return PRIME_URL;
  const resp = await fetch(STAC_SEARCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ collections: [PRIME_COLLECTION], bbox: PRIME_BBOX, limit: 1 })
  });
  if (!resp.ok) throw new Error(`prime-sök svarade ${resp.status}`);
  const data = await resp.json();
  const f = (data.features || [])[0];
  const href = f && f.assets && f.assets.data && f.assets.data.href;
  if (!href) throw new Error(`hittade inget item i ${PRIME_COLLECTION} att prima med`);
  return href;
}

// Etablerar sessionen genom ett autentiserat GET mot markhöjd-tjänsten.
async function prime() {
  if (!PRIME_ENABLED) return null;
  if (priming) return priming;
  priming = (async () => {
    try {
      const href = await findPrimeHref();
      if (!isAllowedUrl(href)) throw new Error(`otillåten prime-URL: ${href}`);
      const resp = await fetch(href, { headers: lmHeaders() });
      mergeCookies(cookiePairsFromResponse(resp));
      await drain(resp.body); // "ladda ner klart" och släng innehållet
      console.log(`[laserdata] prime ${resp.status} via ${PRIME_COLLECTION} – cookie: ${sessionCookie ? 'satt' : 'ingen'}`);
    } catch (e) {
      console.warn(`[laserdata] prime misslyckades: ${e.message}`);
    } finally {
      priming = null;
    }
  })();
  return priming;
}

// Hämtar med Basic + cookie. Vid 401/403 primas sessionen och anropet görs om en gång.
async function fetchLm(url, opts = {}) {
  let resp = await fetch(url, Object.assign({}, opts, { headers: lmHeaders(opts.headers) }));
  if ((resp.status === 401 || resp.status === 403) && PRIME_ENABLED) {
    await prime();
    resp = await fetch(url, Object.assign({}, opts, { headers: lmHeaders(opts.headers) }));
  }
  // Fånga ev. uppdaterad sessions-cookie.
  mergeCookies(cookiePairsFromResponse(resp));
  return resp;
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: false, limit: '4mb' }));

app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

// --- SSRF-skydd: bara https mot *.lantmateriet.se tillåts laddas ner. ---
function isAllowedUrl(href) {
  try {
    const u = new URL(href);
    if (u.protocol !== 'https:') return false;
    return u.hostname === ALLOWED_HOST_SUFFIX.replace(/^\./, '')
      || u.hostname.endsWith(ALLOWED_HOST_SUFFIX);
  } catch (e) {
    return false;
  }
}

function parseItems(body) {
  let raw = body && body.items;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch (e) { raw = raw.split(','); }
  }
  if (!Array.isArray(raw)) {
    const err = new Error('Body måste innehålla "items" som en lista av URL:er.');
    err.status = 400;
    throw err;
  }
  const seen = new Set();
  const items = [];
  for (const x of raw) {
    const href = String(x).trim();
    if (!href || seen.has(href)) continue;
    seen.add(href);
    if (!isAllowedUrl(href)) {
      const e = new Error(`Otillåten URL: ${href}`); e.status = 400; throw e;
    }
    items.push(href);
  }
  if (items.length === 0) {
    const e = new Error('Inga rutor angivna.'); e.status = 400; throw e;
  }
  if (items.length > MAX_FILES) {
    const e = new Error(`För många rutor (${items.length} > ${MAX_FILES}).`);
    e.status = 413;
    throw e;
  }
  return items;
}

// --- POST /api/laserdata/search ------------------------------------------ //
app.post('/api/laserdata/search', async (req, res) => {
  const bbox = req.body && req.body.bbox;
  if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some((n) => typeof n !== 'number')) {
    return res.status(400).json({ error: 'bbox måste vara [väst, syd, öst, nord] i WGS84.' });
  }
  const limit = Math.min(parseInt(req.body.limit, 10) || SEARCH_LIMIT, SEARCH_LIMIT);
  try {
    const upstream = await fetch(STAC_SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: AUTH_HEADER },
      body: JSON.stringify({ collections: [STAC_COLLECTION], bbox, limit })
    });
    if (!upstream.ok) {
      const text = await upstream.text();
      return res.status(upstream.status === 401 ? 502 : upstream.status)
        .json({ error: `Lantmäteriet STAC svarade ${upstream.status}`, detail: text.slice(0, 300) });
    }
    const data = await upstream.json();
    const features = (data.features || []).map((f) => {
      const a = f.assets || {};
      const dataAsset = a.data || {};
      const props = f.properties || {};
      const size = dataAsset['file:size'] != null ? dataAsset['file:size'] : dataAsset.size;
      return {
        id: f.id,
        datetime: props.datetime || null,
        geometry: f.geometry,
        dataHref: dataAsset.href || null,
        dataSize: size != null ? size : null
      };
    }).filter((f) => f.dataHref);
    return res.json({
      count: features.length,
      limit,
      truncated: (data.features || []).length >= limit,
      features
    });
  } catch (e) {
    return res.status(502).json({ error: `Kunde inte nå Lantmäteriet: ${e.message}` });
  }
});

// --- POST /api/laserdata/estimate ---------------------------------------- //
// HEAD:ar varje fil (med auth) och summerar Content-Length.
app.post('/api/laserdata/estimate', async (req, res) => {
  let items;
  try { items = parseItems(req.body); } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
  let totalSize = 0;
  try {
    const sizes = await Promise.all(items.map(async (href) => {
      const head = await fetchLm(href, { method: 'HEAD' });
      // 401/403 från dl-värden = fel inloggning eller saknad produktbehörighet.
      // Surfa det tydligt i stället för att tyst rapportera 0 byte (vilket
      // tidigare gav en tom zip vid nedladdning).
      if (head.status === 401 || head.status === 403) {
        const e = new Error(`Lantmäteriet nekade åtkomst (${head.status}). Kontrollera LM_USER/LM_PASS och att kontot har behörighet till produkten (${STAC_COLLECTION}).`);
        e.status = 502;
        throw e;
      }
      const len = parseInt(head.headers.get('content-length'), 10);
      return Number.isNaN(len) ? 0 : len;
    }));
    totalSize = sizes.reduce((a, b) => a + b, 0);
  } catch (e) {
    return res.status(e.status || 502).json({ error: e.message });
  }
  if (totalSize > MAX_BYTES) {
    return res.status(413).json({ error: `Totalstorlek ${totalSize} överskrider gräns ${MAX_BYTES}.`, count: items.length, totalSize });
  }
  return res.json({ count: items.length, totalSize });
});

// --- POST /api/laserdata/download ---------------------------------------- //
app.post('/api/laserdata/download', async (req, res) => {
  let items;
  try { items = parseItems(req.body); } catch (e) {
    return res.status(e.status || 500).type('text/plain').send(e.message);
  }

  const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+$/, '');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="laserdata-${stamp}.zip"`);

  // Store-läge: LAZ/COPC är redan komprimerat. zip64 för totalstorlek > 4 GB.
  const archive = archiver('zip', { store: true, zip64: true });
  archive.on('warning', (err) => console.warn('[laserdata] archive warning:', err.message));
  archive.on('error', (err) => {
    console.error('[laserdata] archive error:', err);
    if (!res.headersSent) res.status(500).end();
    else res.destroy(err);
  });
  archive.pipe(res);

  // Avbryt om klienten kopplar ner.
  let aborted = false;
  res.on('close', () => { if (!res.writableEnded) aborted = true; });

  try {
    for (const href of items) {
      if (aborted) break;
      const resp = await fetchLm(href);
      if (!resp.ok || !resp.body) {
        // Avbryt hellre med ett tydligt fel än att tyst hoppa över och leverera
        // en (delvis) tom zip. För första filen har inga bytes skrivits än, så
        // klienten får ett rent felmeddelande i stället för en trasig zip.
        const name = path.basename(new URL(href).pathname) || href;
        throw new Error(`Lantmäteriet svarade ${resp.status} för ${name}. Kontrollera LM_USER/LM_PASS och produktbehörighet.`);
      }
      const name = path.basename(new URL(href).pathname) || 'fil.laz';
      const nodeStream = Readable.fromWeb(resp.body);
      archive.append(nodeStream, { name });
      // Vänta tills denna fil lästs klart innan nästa hämtas (minnessäkert).
      await new Promise((resolve, reject) => {
        nodeStream.on('end', resolve);
        nodeStream.on('error', reject);
      });
    }
    await archive.finalize();
  } catch (err) {
    console.error('[laserdata] download error:', err);
    if (!res.headersSent) res.status(502).type('text/plain').send(err.message);
    else res.destroy(err);
  }
});

app.get('/health', (req, res) => res.json({
  ok: true,
  hasAuth: Boolean(USER && PASS),
  prime: PRIME_ENABLED,
  primed: Boolean(sessionCookie)
}));

app.listen(PORT, () => {
  console.log(`[laserdata] Backend lyssnar på :${PORT}`);
  console.log(`[laserdata] STAC: ${STAC_SEARCH_URL} (collection ${STAC_COLLECTION})`);
  console.log(`[laserdata] Auth: ${USER ? 'konfigurerad' : 'SAKNAS'} | MAX_FILES=${MAX_FILES} | MAX_BYTES=${MAX_BYTES}`);
  console.log(`[laserdata] Prime: ${PRIME_ENABLED ? `på (${PRIME_URL || PRIME_COLLECTION})` : 'av'}`);
  // Etablera sessionen direkt vid start (som användarens manuella markhöjd-test).
  if (PRIME_ENABLED) prime();
});
