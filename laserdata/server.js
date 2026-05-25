/* Laserdata backend.
 *
 * Två endpoints:
 *   POST /api/laserdata/estimate    JSON {"cells":["id1",…]}        → JSON {count,totalSize}
 *   POST /api/laserdata/download    JSON eller form-body cells=…    → application/zip (strömmas)
 *   GET  /health                                                    → JSON {ok,mode}
 *
 * Konfiguration: config.json (valfri) eller miljövariabler. Env vinner över
 * config.json, så i container kan du köra helt utan config.json.
 * Två lägen för fil-uppslagning:
 *   1. Root-mode (default):  filer = path.join(root, filenamePattern.replace('{id}', cellId))
 *   2. Manifest-mode:        explicit cell_id → {path, size} i en JSON-fil
 */

const express = require('express');
const archiver = require('archiver');
const path = require('path');
const fs = require('fs');

const CONFIG_PATH = process.env.CONFIG || path.join(__dirname, 'config.json');

// config.json är valfri: env-variabler kan tillhandahålla allt (t.ex. i Docker).
let config = {};
if (fs.existsSync(CONFIG_PATH)) {
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error(`[laserdata] Kunde inte läsa config: ${e.message}`);
    process.exit(1);
  }
}

const PORT = parseInt(process.env.PORT || config.port || 3001, 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN || config.corsOrigin || '*';
const MAX_BYTES = parseInt(process.env.MAX_BYTES || config.maxBytes || (50 * 1024 ** 3), 10);
const MAX_CELLS = parseInt(process.env.MAX_CELLS || config.maxCells || 200, 10);
const ROOT = process.env.LASERDATA_ROOT || config.root;
const PATTERN = process.env.LASERDATA_PATTERN || config.filenamePattern || '{id}.laz';
const MANIFEST_PATH = process.env.LASERDATA_MANIFEST || config.manifest;

const CELL_ID_RE = /^[A-Za-z0-9_.-]+$/;

let lookupCell;
let modeDescription;

if (MANIFEST_PATH) {
  // Manifest-läge: explicit cell_id -> {path, size}
  const manifestAbs = path.isAbsolute(MANIFEST_PATH)
    ? MANIFEST_PATH
    : path.join(__dirname, MANIFEST_PATH);
  if (!fs.existsSync(manifestAbs)) {
    console.error(`[laserdata] Manifest saknas: ${manifestAbs}`);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestAbs, 'utf8'));
  lookupCell = (id) => {
    if (!CELL_ID_RE.test(id)) return null;
    const entry = manifest[id];
    return entry && entry.path ? entry : null;
  };
  modeDescription = `manifest ${manifestAbs} (${Object.keys(manifest).length} celler)`;
} else if (ROOT) {
  // Root-läge: räkna ut sökväg på begäran
  const rootResolved = path.resolve(ROOT);
  if (!fs.existsSync(rootResolved)) {
    console.error(`[laserdata] Katalogen i "root" finns inte: ${rootResolved}`);
    process.exit(1);
  }
  lookupCell = (id) => {
    if (!CELL_ID_RE.test(id)) return null;
    const filename = PATTERN.replace('{id}', id);
    const fullPath = path.resolve(rootResolved, filename);
    // Path traversal-skydd: resolverad path måste stanna under root
    const rel = path.relative(rootResolved, fullPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return { path: fullPath };
  };
  modeDescription = `root ${rootResolved} (mönster: ${PATTERN})`;
} else {
  console.error('[laserdata] Konfigurera antingen "root" eller "manifest" (config.json eller LASERDATA_ROOT/LASERDATA_MANIFEST).');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

function parseCellIds(body) {
  let raw = body && body.cells;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch (e) { raw = raw.split(','); }
  }
  if (!Array.isArray(raw)) {
    const err = new Error('Body måste innehålla "cells" som en lista av id:n.');
    err.status = 400;
    throw err;
  }
  return raw.map((x) => String(x).trim()).filter(Boolean);
}

function resolveCells(ids) {
  if (ids.length === 0) {
    const e = new Error('Inga rutor angivna.'); e.status = 400; throw e;
  }
  if (ids.length > MAX_CELLS) {
    const e = new Error(`För många rutor (${ids.length} > ${MAX_CELLS}).`);
    e.status = 413;
    throw e;
  }
  const resolved = [];
  const seen = new Set();
  let totalSize = 0;
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const entry = lookupCell(id);
    if (!entry) {
      const e = new Error(`Okänt eller ogiltigt cell-id: ${id}`); e.status = 400; throw e;
    }
    if (!fs.existsSync(entry.path)) {
      const e = new Error(`Fil saknas på NAS för ruta ${id}`); e.status = 404; throw e;
    }
    const size = entry.size != null ? entry.size : fs.statSync(entry.path).size;
    resolved.push({ id, path: entry.path, size });
    totalSize += size;
  }
  return { resolved, totalSize };
}

app.post('/api/laserdata/estimate', (req, res) => {
  try {
    const ids = parseCellIds(req.body);
    const { resolved, totalSize } = resolveCells(ids);
    if (totalSize > MAX_BYTES) {
      return res.status(413).json({
        error: `Totalstorlek ${totalSize} överskrider gräns ${MAX_BYTES}.`,
        count: resolved.length,
        totalSize
      });
    }
    return res.json({ count: resolved.length, totalSize });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/laserdata/download', (req, res) => {
  let resolved;
  let totalSize;
  try {
    const ids = parseCellIds(req.body);
    ({ resolved, totalSize } = resolveCells(ids));
  } catch (e) {
    return res.status(e.status || 500).type('text/plain').send(e.message);
  }
  if (totalSize > MAX_BYTES) {
    return res.status(413).type('text/plain')
      .send(`Totalstorlek ${totalSize} överskrider gräns ${MAX_BYTES}.`);
  }

  const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+$/, '');
  const filename = `laserdata-${stamp}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  // Store-läge: LAZ är redan komprimerat. zip64 för totalstorlek > 4 GB.
  const archive = archiver('zip', { store: true, zip64: true });
  archive.on('warning', (err) => console.warn('[laserdata] archive warning:', err.message));
  archive.on('error', (err) => {
    console.error('[laserdata] archive error:', err);
    if (!res.headersSent) res.status(500).end();
    else res.destroy(err);
  });
  archive.pipe(res);
  for (const f of resolved) {
    archive.file(f.path, { name: path.basename(f.path) });
  }
  archive.finalize();
});

app.get('/health', (req, res) => {
  res.json({ ok: true, mode: modeDescription });
});

app.listen(PORT, () => {
  console.log(`[laserdata] Backend lyssnar på :${PORT}`);
  console.log(`[laserdata] Läge: ${modeDescription}`);
  console.log(`[laserdata] CORS_ORIGIN: ${CORS_ORIGIN}`);
});
