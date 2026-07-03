#!/usr/bin/env node
/*
 * build_dronare_notam.mjs — hämtar aktiva NOTAM (Notice to Airmen) för svenskt
 * luftrum från LFV:s öppna WFS och skriver dem som ett GeoJSON-lager i
 * Origo-gruppen "Drönare". NOTAM finns på LFV:s ordinarie drönarkarta och är
 * ofta det som avgör om ett drönaruppdrag får flygas just nu (tillfälliga
 * restriktioner, flygningar, hinder m.m.).
 *
 * - Källa: LFV:s öppna WFS `https://dronechart.lfv.se/geoserver/wfs`,
 *   typeName `dynais:NOTAM`. WFS 1.1.0, outputFormat=json, srsName=EPSG:4326.
 *   GeoServern bygger redan ut varje NOTAM till en polygon (radie/koordinat),
 *   så vi återanvänder geometrin direkt.
 * - Egenskaperna avkodas till läsbar svenska: NOTAM-nummer (serie/nr/år),
 *   typ (ny/ersätter/avlyser), Q-kod, ämnesgrupp, omfattning (scope),
 *   trafik, höjdintervall, giltighetstid och själva meddelandetexten (Item E).
 *   Skrivs i EPSG:4326 utan crs-member (som övriga GEOJSON-lager i appen).
 *
 * Kör: node tools/build_dronare_notam.mjs
 * Faller tillbaka på befintlig fil om WFS:en inte svarar.
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT = resolve(__dirname, '..', 'data', 'dronare_notam.geojson');
const WFS = 'https://dronechart.lfv.se/geoserver/wfs';
const TYPE_NAME = 'dynais:NOTAM';

function wfsUrl() {
  const q = new URLSearchParams({
    service: 'WFS',
    version: '1.1.0',
    request: 'GetFeature',
    typeName: TYPE_NAME,
    outputFormat: 'json',
    srsName: 'EPSG:4326'
  });
  return `${WFS}?${q}`;
}

// Defensiv koordinatordning (se build_dronare_luftrum_lfv.mjs).
function fixCoords(c) {
  if (typeof c[0] === 'number') {
    const [a, b] = c;
    if (a >= 54 && a <= 70 && b >= 9 && b <= 25) return [b, a];
    return c;
  }
  return c.map(fixCoords);
}

// --- avkodningstabeller (ICAO NOTAM) -----------------------------------------

const TYPE_SV = { N: 'Ny', R: 'Ersätter', C: 'Avlyser' };

// Q-kodens ämnesgrupp (andra bokstaven i Q-koden = första i CODE23).
const SUBJECT_SV = {
  A: 'Luftrum/organisation',
  C: 'Kommunikation & övervakning',
  F: 'Anläggningar & tjänster',
  G: 'GNSS-tjänster',
  I: 'Instrumentinflygning (ILS/MLS)',
  L: 'Ljus/belysning',
  M: 'Manöver-/landningsområde',
  N: 'Navigeringshjälpmedel',
  O: 'Övrig information',
  P: 'Flygtrafikprocedurer',
  R: 'Luftrumsrestriktioner',
  S: 'Flygtrafik- & VOLMET-tjänst',
  W: 'Varningar (fara)'
};

const SCOPE_SV = { A: 'Flygplats', E: 'En-route', W: 'Navigeringsvarning', K: 'Checklista' };
const PURPOSE_SV = { N: 'Omedelbar', B: 'Bulletin (PIB)', O: 'Flygoperation', M: 'Övrigt', K: 'Checklista' };
const TRAFFIC_SV = { I: 'IFR', V: 'VFR', IV: 'IFR/VFR' };

function decodeSet(code, table) {
  if (!code) return '';
  return String(code)
    .split('')
    .map((ch) => table[ch] || ch)
    .join(', ');
}

// Höjd F)/G): NOTAM anger flygnivåer (hundratals fot). 0 = mark, 999 = obegränsat.
function notamHeight(lower, upper) {
  const lo = lower == null || lower === 0 ? 'GND' : `FL${lower}`;
  const hi = upper == null || upper >= 999 ? 'UNL' : `FL${upper}`;
  return `${lo}–${hi}`;
}

function fmtTime(iso) {
  if (!iso) return '';
  // "2026-07-05T00:00:00Z" → "2026-07-05 00:00 UTC"
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]} UTC` : iso;
}

function mapNotam(p) {
  const serie = p.SERIES || '';
  const nr = p.NO != null ? p.NO : '';
  const ar = p.YEAR != null ? String(p.YEAR).padStart(2, '0') : '';
  const nummer = serie && nr ? `${serie}${nr}/${ar}` : '';
  const qkod = p.CODE23 || p.CODE45 ? `Q${p.CODE23 || ''}${p.CODE45 || ''}` : '';
  const amne = p.CODE23 ? SUBJECT_SV[p.CODE23[0]] || '' : '';
  const est = p.EST ? ' (est.)' : '';
  return {
    nummer,
    typ: TYPE_SV[p.TYPE] || p.TYPE || '',
    amne,
    q_kod: qkod,
    omfattning: decodeSet(p.SCOPE, SCOPE_SV),
    syfte: decodeSet(p.PURPOSE, PURPOSE_SV),
    trafik: TRAFFIC_SV[p.TRAFFIC] || p.TRAFFIC || '',
    hojd: notamHeight(p.LOWER, p.UPPER),
    plats: p.ITEM_A || p.FIR || '',
    radie_nm: p.RADIUS != null ? String(p.RADIUS) : '',
    giltig_fran: fmtTime(p.STARTVALIDITY),
    giltig_till: fmtTime(p.ENDVALIDITY) + est,
    meddelande: (p.ITEM_E || '').replace(/\s*\n\s*/g, ' ').trim()
  };
}

async function main() {
  mkdirSync(dirname(OUTPUT), { recursive: true });
  let fc;
  try {
    const res = await fetch(wfsUrl(), { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fc = await res.json();
  } catch (err) {
    console.error(`[notam] Kunde inte hämta ${TYPE_NAME}: ${err.message}`);
    if (existsSync(OUTPUT)) {
      console.error('[notam] Behåller befintlig fil.');
      return;
    }
    process.exit(1);
  }

  const features = [];
  for (const f of fc.features || []) {
    if (!f.geometry) continue;
    features.push({
      type: 'Feature',
      geometry: { type: f.geometry.type, coordinates: fixCoords(f.geometry.coordinates) },
      properties: mapNotam(f.properties || {})
    });
  }

  const out = {
    type: 'FeatureCollection',
    metadata: {
      source: WFS,
      typeName: TYPE_NAME,
      provider: 'LFV / Transportstyrelsen',
      generated: new Date().toISOString()
    },
    features
  };
  writeFileSync(OUTPUT, JSON.stringify(out, null, 1));
  console.log(`[notam] Skrev ${features.length} aktiva NOTAM → ${OUTPUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
