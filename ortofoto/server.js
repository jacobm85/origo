/* Ortofoto-backend.
 *
 * Speglar laserdata-backenden men hämtar från Lantmäteriets STAC-bild-API i
 * stället för en lokal NAS. Basic Auth injiceras server-side så att Lantmäteriets
 * uppgifter aldrig hamnar i klienten eller i git.
 *
 * Endpoints (nginx proxar /api/ortofoto/ hit, bakom inloggningen):
 *   POST /api/ortofoto/search    JSON {"bbox":[w,s,e,n],"limit"?}  → slimmad FeatureCollection
 *   POST /api/ortofoto/estimate  JSON {"items":["href",…]}         → {count,totalSize}
 *   POST /api/ortofoto/download  JSON eller form items=[…]         → application/zip (strömmas)
 *   GET  /health                                                   → {ok}
 *
 * Konfiguration via miljövariabler:
 *   LM_STAC_USER / LM_STAC_PASS   – Basic Auth mot api.lantmateriet.se + dl*.lantmateriet.se
 *   STAC_SEARCH_URL               – default https://api.lantmateriet.se/stac-bild/v1/search
 *   ALLOWED_HOST_SUFFIX           – default ".lantmateriet.se" (SSRF-skydd)
 *   MAX_FILES                     – default 100
 *   MAX_BYTES                     – default 50 GB
 *   PORT                          – default 3003
 */

const express = require('express');
const archiver = require('archiver');
const path = require('path');
const { Readable } = require('stream');

const PORT = parseInt(process.env.PORT || 3003, 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const STAC_SEARCH_URL = process.env.STAC_SEARCH_URL
  || 'https://api.lantmateriet.se/stac-bild/v1/search';
const ALLOWED_HOST_SUFFIX = process.env.ALLOWED_HOST_SUFFIX || '.lantmateriet.se';
const MAX_FILES = parseInt(process.env.MAX_FILES || 100, 10);
const MAX_BYTES = parseInt(process.env.MAX_BYTES || (50 * 1024 ** 3), 10);
const SEARCH_LIMIT = parseInt(process.env.SEARCH_LIMIT || 4000, 10);

const USER = process.env.LM_STAC_USER || '';
const PASS = process.env.LM_STAC_PASS || '';
if (!USER || !PASS) {
  console.warn('[ortofoto] VARNING: LM_STAC_USER/LM_STAC_PASS saknas – '
    + 'sök och nedladdning kommer att nekas av Lantmäteriet (401).');
}
const AUTH_HEADER = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

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
    const e = new Error('Inga filer angivna.'); e.status = 400; throw e;
  }
  if (items.length > MAX_FILES) {
    const e = new Error(`För många filer (${items.length} > ${MAX_FILES}).`);
    e.status = 413;
    throw e;
  }
  return items;
}

// --- POST /api/ortofoto/search ------------------------------------------- //
app.post('/api/ortofoto/search', async (req, res) => {
  const bbox = req.body && req.body.bbox;
  if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some((n) => typeof n !== 'number')) {
    return res.status(400).json({ error: 'bbox måste vara [väst, syd, öst, nord] i WGS84.' });
  }
  const limit = Math.min(parseInt(req.body.limit, 10) || SEARCH_LIMIT, SEARCH_LIMIT);
  try {
    const upstream = await fetch(STAC_SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: AUTH_HEADER },
      body: JSON.stringify({ bbox, limit })
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
      return {
        id: f.id,
        year: f.properties ? f.properties.flygar : null,
        datetime: f.properties ? f.properties.datetime : null,
        resolution: f.properties ? f.properties.upplosning : null,
        geometry: f.geometry,
        dataHref: dataAsset.href || null,
        dataSize: dataAsset['file:size'] != null ? dataAsset['file:size'] : null,
        metadataHref: a.metadata ? a.metadata.href : null,
        thumbnailHref: a.thumbnail ? a.thumbnail.href : null
      };
    }).filter((f) => f.dataHref);
    const years = Array.from(new Set(features.map((f) => f.year).filter((y) => y != null)))
      .sort((x, y) => y - x);
    return res.json({
      count: features.length,
      limit,
      truncated: (data.features || []).length >= limit,
      years,
      features
    });
  } catch (e) {
    return res.status(502).json({ error: `Kunde inte nå Lantmäteriet: ${e.message}` });
  }
});

// --- POST /api/ortofoto/estimate ----------------------------------------- //
// HEAD:ar varje fil (med auth) och summerar Content-Length.
app.post('/api/ortofoto/estimate', async (req, res) => {
  let items;
  try { items = parseItems(req.body); } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
  let totalSize = 0;
  try {
    const sizes = await Promise.all(items.map(async (href) => {
      const head = await fetch(href, { method: 'HEAD', headers: { Authorization: AUTH_HEADER } });
      const len = parseInt(head.headers.get('content-length'), 10);
      return Number.isNaN(len) ? 0 : len;
    }));
    totalSize = sizes.reduce((a, b) => a + b, 0);
  } catch (e) {
    return res.status(502).json({ error: `Kunde inte beräkna storlek: ${e.message}` });
  }
  if (totalSize > MAX_BYTES) {
    return res.status(413).json({ error: `Totalstorlek ${totalSize} överskrider gräns ${MAX_BYTES}.`, count: items.length, totalSize });
  }
  return res.json({ count: items.length, totalSize });
});

// --- POST /api/ortofoto/download ----------------------------------------- //
app.post('/api/ortofoto/download', async (req, res) => {
  let items;
  try { items = parseItems(req.body); } catch (e) {
    return res.status(e.status || 500).type('text/plain').send(e.message);
  }

  const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+$/, '');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="ortofoto-${stamp}.zip"`);

  // Store-läge: GeoTIFF (COG) är redan komprimerat. zip64 för > 4 GB.
  const archive = archiver('zip', { store: true, zip64: true });
  archive.on('warning', (err) => console.warn('[ortofoto] archive warning:', err.message));
  archive.on('error', (err) => {
    console.error('[ortofoto] archive error:', err);
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
      const resp = await fetch(href, { headers: { Authorization: AUTH_HEADER } });
      if (!resp.ok || !resp.body) {
        console.warn(`[ortofoto] hoppar över ${href} (status ${resp.status})`);
        continue;
      }
      const name = path.basename(new URL(href).pathname) || 'fil.bin';
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
    console.error('[ortofoto] download error:', err);
    if (!res.headersSent) res.status(502).type('text/plain').send(err.message);
    else res.destroy(err);
  }
});

app.get('/health', (req, res) => res.json({ ok: true, hasAuth: Boolean(USER && PASS) }));

app.listen(PORT, () => {
  console.log(`[ortofoto] Backend lyssnar på :${PORT}`);
  console.log(`[ortofoto] STAC: ${STAC_SEARCH_URL}`);
  console.log(`[ortofoto] Auth: ${USER ? 'konfigurerad' : 'SAKNAS'} | MAX_FILES=${MAX_FILES} | MAX_BYTES=${MAX_BYTES}`);
});
