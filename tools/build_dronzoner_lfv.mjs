#!/usr/bin/env node
/*
 * build_dronzoner_lfv.mjs — hämtar Sveriges geografiska UAS-zoner (drönarzoner)
 * från LFV:s Dronechart och skriver en GeoJSON som Origo visar som ett eget
 * lager i gruppen "Drönare".
 *
 * - Källa: LFV Dronechart, ED-318-formaterad fil (EASA/EUROCAE-standarden för
 *   UAS Geographical Zones): https://dronechart.lfv.se/data/uas_zones_ED318.json
 *   Öppen, ingen nyckel. Data tillhandahålls av Transportstyrelsen (myndigheten
 *   som beslutar om de geografiska UAS-zonerna) och publiceras via LFV.
 * - ED-318 är inte rak GeoJSON som Origo vill ha den: egenskaperna är
 *   språk-objekt ({text,lang}-listor), och punktzoner anges som en Point med
 *   ett `extent` (cirkel + radie) i stället för en polygon. Den här
 *   generatorn plattar därför ut texterna till svenska och bygger om
 *   cirkel-punkterna till riktiga polygoner (geodetisk approximation i lon/lat)
 *   så att zonens utbredning ritas korrekt.
 * - Varje feature taggas med `kategori` (av `reason`) och `restriktion` (av
 *   `type`) så att de kan färgas/filtreras i kartan.
 *
 * Kör: node tools/build_dronzoner_lfv.mjs [--output <fil>]
 * Faller tillbaka på befintlig outputfil om källan inte svarar, så ett bygge
 * aldrig bryts av en otillgänglig tjänst (samma mönster som TED-generatorn).
 */
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT = resolve(__dirname, '..', 'data', 'dronzoner_lfv.geojson');
const SOURCE = 'https://dronechart.lfv.se/data/uas_zones_ED318.json';

// ---- språk-/uppslagshjälp ---------------------------------------------------

// ED-318 använder "se-SE" för svenska; ta svenska i första hand, annars engelska.
function pickLang(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return '';
  const sv = arr.find((x) => /^s[ev]/i.test(x.lang || ''));
  const en = arr.find((x) => /^en/i.test(x.lang || ''));
  return (sv || en || arr[0]).text || '';
}

const REASON_SV = {
  AIR_TRAFFIC: 'Flygtrafik',
  SENSITIVE: 'Känsligt objekt',
  PRIVACY: 'Integritet',
  NATURE: 'Natur/miljö',
  EMERGENCY: 'Räddningstjänst',
  OTHER: 'Övrigt'
};

const TYPE_SV = {
  PROHIBITED: 'Förbjudet',
  REQ_AUTHORIZATION: 'Kräver tillstånd',
  CONDITIONAL: 'Villkorat',
  NO_RESTRICTION: 'Ingen restriktion'
};

const REF_SV = { AGL: 'över mark (AGL)', AMSL: 'över havet (AMSL)', SFC: 'mark (SFC)' };

function reasonsToSv(reason) {
  const arr = Array.isArray(reason) ? reason : reason ? [reason] : [];
  return arr.map((r) => REASON_SV[r] || r);
}

// Höjdintervall från geometrins `layer`, t.ex. "0–150 m över mark (AGL)".
function formatHeight(layer) {
  if (!layer) return '';
  const uom = layer.uom || 'm';
  const lo = layer.lower != null ? `${layer.lower}` : '0';
  const hi = layer.upper != null ? `${layer.upper}` : '';
  const ref = REF_SV[layer.upperReference || layer.lowerReference] || layer.upperReference || '';
  if (!hi) return `${lo} ${uom}${ref ? ' ' + ref : ''}`;
  return `${lo}–${hi} ${uom}${ref ? ' ' + ref : ''}`;
}

// Sammanfatta tillstånds-/anmälningsmyndigheter (namn + kontakt).
function formatAuthorities(zoneAuthority) {
  const arr = Array.isArray(zoneAuthority) ? zoneAuthority : [];
  return arr
    .map((za) => {
      const name = pickLang(za.name);
      const phone = pickLang(za.phone);
      const email = pickLang(za.email);
      const url = pickLang(za.siteURL);
      const purpose =
        za.purpose === 'AUTHORIZATION' ? 'tillstånd' : za.purpose === 'NOTIFICATION' ? 'anmälan' : za.purpose || '';
      const bits = [name && purpose ? `${name} (${purpose})` : name || purpose];
      if (phone) bits.push(`tel ${phone}`);
      if (email) bits.push(email);
      if (url) bits.push(url);
      return bits.filter(Boolean).join(', ');
    })
    .filter(Boolean)
    .join(' • ');
}

// ---- cirkel → polygon -------------------------------------------------------

// Bygg en sluten ring runt [lon,lat] med given radie (meter). Geodetisk
// approximation som räcker gott för zonradier (≤ några km): en grad latitud
// ≈ 111 320 m, en grad longitud ≈ 111 320·cos(lat). 64 hörn ger en jämn cirkel.
function circleToPolygon([lon, lat], radius, steps = 64) {
  const dLat = radius / 111320;
  const dLon = radius / (111320 * Math.cos((lat * Math.PI) / 180));
  const ring = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    ring.push([+(lon + dLon * Math.cos(a)).toFixed(6), +(lat + dLat * Math.sin(a)).toFixed(6)]);
  }
  return { type: 'Polygon', coordinates: [ring] };
}

// ---- huvudlogik -------------------------------------------------------------

async function fetchSource() {
  const res = await fetch(SOURCE, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} från ${SOURCE}`);
  return res.json();
}

function buildFeature(f) {
  const p = f.properties || {};
  const g = f.geometry || {};
  let geometry = g;

  // Punkt med cirkel-extent → polygon. Höjdinfo (`layer`) ligger på Point-
  // geometrin; behåll den genom att flytta över den till props nedan.
  if (g.type === 'Point' && g.extent && g.extent.subType === 'Circle' && g.extent.radius) {
    geometry = circleToPolygon(g.coordinates, g.extent.radius);
  }

  const reasons = reasonsToSv(p.reason);
  const props = {
    identifier: p.identifier || '',
    namn: pickLang(p.name),
    kategori: reasons[0] || 'Övrigt',
    kategorier: reasons.join(', '),
    restriktion: TYPE_SV[p.type] || p.type || '',
    hojd: formatHeight(g.layer),
    villkor: Array.isArray(p.restrictionConditions)
      ? p.restrictionConditions.join(', ')
      : p.restrictionConditions || '',
    meddelande: pickLang(p.message),
    ovrigt: pickLang(p.otherReasonInfo) || pickLang(p.extendedProperties),
    myndighet: formatAuthorities(p.zoneAuthority),
    galler_fran: Array.isArray(p.limitedApplicability)
      ? (p.limitedApplicability[0]?.startDateTime || '').slice(0, 10)
      : '',
    land: p.country || ''
  };

  return { type: 'Feature', geometry, properties: props };
}

async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--output');
  const output = outIdx >= 0 ? resolve(args[outIdx + 1]) : DEFAULT_OUTPUT;

  let fc;
  try {
    fc = await fetchSource();
  } catch (err) {
    console.error(`[dronzoner] Kunde inte hämta källan: ${err.message}`);
    if (existsSync(output)) {
      console.error('[dronzoner] Behåller befintlig fil.');
      return;
    }
    throw err;
  }

  const features = (fc.features || []).map(buildFeature);
  const issued = fc.metadata?.issued || '';
  const out = {
    type: 'FeatureCollection',
    metadata: {
      source: SOURCE,
      provider: 'Transportstyrelsen (via LFV Dronechart)',
      issued,
      generated: new Date().toISOString()
    },
    features
  };

  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(out, null, 1));
  console.log(
    `[dronzoner] Skrev ${features.length} UAS-zoner till ${output}` +
      (issued ? ` (utgåva ${issued.slice(0, 10)}).` : '.')
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
