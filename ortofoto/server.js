/* Ortofoto-backend.
 *
 * Speglar laserdata-backenden men hämtar från Lantmäteriets STAC-bild-API i
 * stället för en lokal NAS. Basic Auth injiceras server-side så att Lantmäteriets
 * uppgifter aldrig hamnar i klienten eller i git.
 *
 * Endpoints (nginx proxar /api/ortofoto/ hit, bakom inloggningen):
 *   POST /api/ortofoto/search    JSON {"bbox":[w,s,e,n],"limit"?}  → slimmad FeatureCollection
 *   POST /api/ortofoto/estimate  JSON {"items":["href",…]}         → {count,totalSize}
 *   POST /api/ortofoto/download  JSON/form items=[…] (+ valfri crs)  → application/zip (strömmas)
 *   GET  /health                                                   → {ok}
 *
 * Skickas "crs":"EPSG:30xx" med i download:en reprojiceras varje ortofoto
 * server-side med gdalwarp innan det zippas. Utan crs strömmas filerna
 * oförändrade. Styrs av CONVERT_ENABLED / CONVERT_CRS_ALLOW.
 *
 * Konfiguration via miljövariabler:
 *   LM_USER / LM_PASS             – Basic Auth mot api.lantmateriet.se + dl*.lantmateriet.se
 *   STAC_SEARCH_URL               – default https://api.lantmateriet.se/stac-bild/v1/search
 *   ALLOWED_HOST_SUFFIX           – default ".lantmateriet.se" (SSRF-skydd)
 *   MAX_FILES                     – default 100
 *   MAX_BYTES                     – default 50 GB
 *   PORT                          – default 3003
 */

const express = require('express');
const archiver = require('archiver');
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const { spawn } = require('child_process');
const { Readable } = require('stream');

const PORT = parseInt(process.env.PORT || 3003, 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const STAC_SEARCH_URL = process.env.STAC_SEARCH_URL
  || 'https://api.lantmateriet.se/stac-bild/v1/search';
const STAC_COLLECTIONS_URL = STAC_SEARCH_URL.replace(/\/search\/?$/, '/collections');
const ALLOWED_HOST_SUFFIX = process.env.ALLOWED_HOST_SUFFIX || '.lantmateriet.se';
const MAX_FILES = parseInt(process.env.MAX_FILES || 100, 10);
const MAX_BYTES = parseInt(process.env.MAX_BYTES || (50 * 1024 ** 3), 10);
const SEARCH_LIMIT = parseInt(process.env.SEARCH_LIMIT || 4000, 10);

// --- Frivillig reprojektion server-side (lokalt SWEREF) ---------------------
// Klienten kan skicka ett mål-CRS i nedladdningen ("crs": "EPSG:3010"). Då
// laddas varje ortofoto hem till en temp-fil och reprojiceras med gdalwarp
// innan det zippas. Utan mål-CRS strömmas filerna oförändrade som förut.
const CONVERT_ENABLED = (process.env.CONVERT_ENABLED || 'true').toLowerCase() !== 'false';
// Tillåtna mål-CRS (allowlist). Default: SWEREF 99 TM + de tolv lokala zonerna.
const CONVERT_CRS_ALLOW = (process.env.CONVERT_CRS_ALLOW
  || 'EPSG:3006,EPSG:3007,EPSG:3008,EPSG:3009,EPSG:3010,EPSG:3011,EPSG:3012,'
   + 'EPSG:3013,EPSG:3014,EPSG:3015,EPSG:3016,EPSG:3017,EPSG:3018')
  .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

// Gemensam Lantmäteri-inloggning. LM_USER/LM_PASS är den nya kanoniska
// varianten; LM_STAC_USER/LM_STAC_PASS behålls som fallback för äldre .env.
const USER = process.env.LM_USER || process.env.LM_STAC_USER || '';
const PASS = process.env.LM_PASS || process.env.LM_STAC_PASS || '';
if (!USER || !PASS) {
  console.warn('[ortofoto] VARNING: LM_USER/LM_PASS saknas – '
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

// --- Reprojektion (frivillig) -------------------------------------------- //
// Validerar ett begärt mål-CRS mot allowlistan. Returnerar normaliserad kod
// ("EPSG:3010") eller null om konverteringen ska hoppas över / koden ej tillåts.
function normalizeCrs(crs) {
  if (!CONVERT_ENABLED) return null;
  const c = String(crs || '').trim().toUpperCase();
  if (!/^EPSG:\d{4,5}$/.test(c)) return null;
  return CONVERT_CRS_ALLOW.includes(c) ? c : null;
}

// Kör ett externt kommando och resolvar/reject:ar på exitkod. stderr surfas i
// felmeddelandet så ett trasigt anrop blir begripligt i klienten.
function runCmd(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', (e) => reject(new Error(`Kunde inte köra ${cmd}: ${e.message}`)));
    p.on('close', (code) => (code === 0
      ? resolve()
      : reject(new Error(`${cmd} avslutades med kod ${code}${err ? `: ${err.trim().slice(0, 400)}` : ''}`))));
  });
}

// Strömmar en fetch-respons-body till en lokal fil (minnessäkert).
async function downloadToFile(resp, dest) {
  const nodeStream = Readable.fromWeb(resp.body);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    nodeStream.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    nodeStream.pipe(out);
  });
}

// Reprojicerar ett nedladdat ortofoto (GeoTIFF) till targetCrs med gdalwarp.
// Bild = byte-data → kubisk omsampling + PREDICTOR=2. Okända filtyper lämnas
// oförändrade. Returnerar { path, name } för resultatfilen.
async function convertFile(srcPath, origName, targetCrs, tmpDir) {
  const lower = origName.toLowerCase();
  if (lower.endsWith('.tif') || lower.endsWith('.tiff')) {
    const outPath = path.join(tmpDir, `out_${origName}`);
    await runCmd('gdalwarp', ['-t_srs', targetCrs, '-r', 'cubic', '-of', 'GTiff',
      '-co', 'COMPRESS=DEFLATE', '-co', 'PREDICTOR=2', '-co', 'TILED=YES',
      '-overwrite', srcPath, outPath]);
    return { path: outPath, name: origName };
  }
  return { path: srcPath, name: origName };
}

// --- POST /api/ortofoto/search ------------------------------------------- //
app.post('/api/ortofoto/search', async (req, res) => {
  const bbox = req.body && req.body.bbox;
  if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some((n) => typeof n !== 'number')) {
    return res.status(400).json({ error: 'bbox måste vara [väst, syd, öst, nord] i WGS84.' });
  }
  const limit = Math.min(parseInt(req.body.limit, 10) || SEARCH_LIMIT, SEARCH_LIMIT);
  // Valfritt: filtrera på flygår server-side (CQL2) så att taget (limit) gäller
  // per år i stället för summan av alla år.
  const year = parseInt(req.body && req.body.year, 10);
  const body = { bbox, limit };
  if (Number.isFinite(year)) {
    body.filter = { op: '=', args: [{ property: 'flygar' }, year] };
    body['filter-lang'] = 'cql2-json';
  }
  try {
    const upstream = await fetch(STAC_SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: AUTH_HEADER },
      body: JSON.stringify(body)
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

// --- GET /api/ortofoto/years --------------------------------------------- //
// Distinkta flygår från ALLA collections (ett projekt = ett år). Cachas, så
// klienten kan visa hela årslistan direkt – oberoende av zoom och 4000-taket.
let yearsCache = null;
let yearsCacheAt = 0;
const YEARS_TTL = 6 * 3600 * 1000;
app.get('/api/ortofoto/years', async (req, res) => {
  const now = Date.now();
  if (yearsCache && now - yearsCacheAt < YEARS_TTL) return res.json({ years: yearsCache });
  try {
    const years = new Set();
    let url = `${STAC_COLLECTIONS_URL}?limit=2000`;
    for (let i = 0; i < 20 && url; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const r = await fetch(url, { headers: { Authorization: AUTH_HEADER, Accept: 'application/json' } });
      if (!r.ok) throw new Error(`collections svarade ${r.status}`);
      // eslint-disable-next-line no-await-in-loop
      const j = await r.json();
      (j.collections || []).forEach((c) => {
        const iv = c.extent && c.extent.temporal && c.extent.temporal.interval;
        const t = iv && iv[0] && iv[0][0];
        if (t) { const y = new Date(t).getUTCFullYear(); if (y) years.add(y); }
      });
      const next = (j.links || []).find((l) => l.rel === 'next');
      url = next && next.href ? next.href : null;
    }
    yearsCache = Array.from(years).sort((a, b) => b - a);
    yearsCacheAt = now;
    return res.json({ years: yearsCache });
  } catch (e) {
    return res.status(502).json({ error: `Kunde inte hämta flygår: ${e.message}` });
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
  // Frivilligt mål-CRS: reprojicera varje ortofoto server-side innan det zippas.
  const targetCrs = normalizeCrs(req.body && req.body.crs);

  const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+$/, '');
  const crsTag = targetCrs ? `-${targetCrs.replace(':', '')}` : '';
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="ortofoto${crsTag}-${stamp}.zip"`);

  // Store-läge: GeoTIFF (COG/DEFLATE) är redan komprimerat. zip64 för > 4 GB.
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

  // Temp-katalog för konverteringen (en in-/ut-fil i taget, städas löpande).
  let tmpDir = null;
  if (targetCrs) {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ortoconv-'));
  }

  try {
    for (const href of items) {
      if (aborted) break;
      const resp = await fetch(href, { headers: { Authorization: AUTH_HEADER } });
      if (!resp.ok || !resp.body) {
        console.warn(`[ortofoto] hoppar över ${href} (status ${resp.status})`);
        continue;
      }
      const name = path.basename(new URL(href).pathname) || 'fil.bin';

      if (!targetCrs) {
        const nodeStream = Readable.fromWeb(resp.body);
        archive.append(nodeStream, { name });
        // Vänta tills denna fil lästs klart innan nästa hämtas (minnessäkert).
        await new Promise((resolve, reject) => {
          nodeStream.on('end', resolve);
          nodeStream.on('error', reject);
        });
      } else {
        // Ladda hem → reprojicera → lägg i zip:en → städa. En fil i taget håller
        // temp-diskbruket nere (~en in- + en utfil oavsett antal rutor).
        const inPath = path.join(tmpDir, `in_${name}`);
        await downloadToFile(resp, inPath);
        const out = await convertFile(inPath, name, targetCrs, tmpDir);
        const rs = fs.createReadStream(out.path);
        archive.append(rs, { name: out.name });
        await new Promise((resolve, reject) => {
          rs.on('end', resolve);
          rs.on('error', reject);
        });
        await fsp.rm(inPath, { force: true }).catch(() => {});
        if (out.path !== inPath) await fsp.rm(out.path, { force: true }).catch(() => {});
      }
    }
    await archive.finalize();
  } catch (err) {
    console.error('[ortofoto] download error:', err);
    if (!res.headersSent) res.status(502).type('text/plain').send(err.message);
    else res.destroy(err);
  } finally {
    if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

app.get('/health', (req, res) => res.json({
  ok: true,
  hasAuth: Boolean(USER && PASS),
  convert: CONVERT_ENABLED,
  convertCrs: CONVERT_CRS_ALLOW
}));

app.listen(PORT, () => {
  console.log(`[ortofoto] Backend lyssnar på :${PORT}`);
  console.log(`[ortofoto] STAC: ${STAC_SEARCH_URL}`);
  console.log(`[ortofoto] Auth: ${USER ? 'konfigurerad' : 'SAKNAS'} | MAX_FILES=${MAX_FILES} | MAX_BYTES=${MAX_BYTES}`);
  console.log(`[ortofoto] Konvertering: ${CONVERT_ENABLED ? `på (mål-CRS: ${CONVERT_CRS_ALLOW.join(', ')})` : 'av'}`);
});
