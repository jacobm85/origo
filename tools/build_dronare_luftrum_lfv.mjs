#!/usr/bin/env node
/*
 * build_dronare_luftrum_lfv.mjs — hämtar de luftrumslager som LFV:s Dronechart
 * visar i sin drönarprofil (CTR/TIZ, ATZ, restriktions-/fareområden,
 * flygplatser/heliporter, drönar-buffertar runt flygplatser samt aktuella
 * AIP SUP) och skriver dem som GeoJSON-lager i Origo-gruppen "Drönare".
 *
 * - Källa: LFV:s öppna WFS (samma som dronechart.lfv.se använder),
 *   `https://dronechart.lfv.se/geoserver/wfs`. WFS 1.1.0, outputFormat=json,
 *   srsName=EPSG:4326. Ingen nyckel. Data ägs av LFV/Transportstyrelsen och
 *   uppdateras per AIRAC-cykel (~28 dygn) — daglig refresh räcker väl.
 * - De geografiska UAS-zonerna (drönarförbud/-restriktioner) hämtas separat av
 *   build_dronzoner_lfv.mjs. Den här generatorn täcker det omgivande luftrummet.
 * - Egenskaperna plattas till läsbara svenska fält (mais-/DAIM-schemana skiljer
 *   sig åt) och varje feature taggas med `lager` så att de kan färgas/filtreras.
 *   Skrivs i EPSG:4326 utan crs-member (som övriga GEOJSON-lager i appen).
 *
 * Kör: node tools/build_dronare_luftrum_lfv.mjs
 * Faller tillbaka på befintliga filer om WFS:en inte svarar.
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '..', 'data');
const WFS = 'https://dronechart.lfv.se/geoserver/wfs';

// Bygger en GetFeature-URL för ett WFS-typeName.
function wfsUrl(typeName) {
  const q = new URLSearchParams({
    service: 'WFS',
    version: '1.1.0',
    request: 'GetFeature',
    typeName,
    outputFormat: 'json',
    srsName: 'EPSG:4326'
  });
  return `${WFS}?${q}`;
}

function pick(p, keys) {
  for (const k of keys) if (p[k] != null && p[k] !== '') return p[k];
  return '';
}

// Defensiv: WFS bör ge [lon,lat] men om ett svar skulle ge [lat,lon] (första
// värdet 55–70, andra 10–25 för Sverige) byter vi ordning. Ranges överlappar
// inte, så heuristiken är säker.
function fixCoords(c) {
  if (typeof c[0] === 'number') {
    const [a, b] = c;
    if (a >= 54 && a <= 70 && b >= 9 && b <= 25) return [b, a];
    return c;
  }
  return c.map(fixCoords);
}

// Höjdintervall, t.ex. "GND–2700 ft" eller "0–150 m".
function heightRange(lower, upper, lowUom, upUom) {
  const lo = lower != null && lower !== '' ? String(lower) : 'GND';
  const hi = upper != null && upper !== '' ? `${upper}${upUom ? ' ' + upUom : ''}` : '';
  if (!hi) return lo;
  return `${lo}${lowUom && lo !== 'GND' ? ' ' + lowUom : ''}–${hi}`;
}

// --- normaliserare per schema --------------------------------------------------

// mais-områden (CTR/TIZ/ATZ/RSTA/DNGA): gemensamt attributschema.
function mapMaisArea(p, lager) {
  return {
    lager,
    namn: pick(p, ['NAMEOFAREA']),
    typ: pick(p, ['TYPEOFAREA']),
    beteckning: pick(p, ['POSITIONINDICATOR']),
    plats: pick(p, ['LOCATION']),
    hojd: heightRange(p.LOWER, p.UPPER),
    operator: pick(p, ['NAMEOFOPERATOR']),
    gäller_fr: pick(p, ['WEF']),
    kommentar: [pick(p, ['COMMENT_1']), pick(p, ['COMMENT_2'])].filter(Boolean).join(' ')
  };
}

// mais-punkter (flygplatser/heliporter).
function mapMaisPoint(p, lager) {
  return {
    lager,
    namn: pick(p, ['NAMEOFPOINT']),
    typ: pick(p, ['TYPEOFPOINT']),
    beteckning: pick(p, ['POSITIONINDICATOR']),
    plats: pick(p, ['LOCATION']),
    frekvens: pick(p, ['FREQ']),
    hojd_msl: pick(p, ['MSL']),
    operator: pick(p, ['NAMEOFOPERATOR'])
  };
}

// DAIM-buffertar (1 km runt heliporter, 5 km runt flygplatser).
function mapBuffer(p, lager) {
  return {
    lager,
    namn: pick(p, ['NAMEOFPOIN', 'NAMEOFAREA']),
    typ: pick(p, ['TYPEOFPOIN', 'TYPEOFAREA']),
    beteckning: pick(p, ['POSITIONIN']),
    plats: pick(p, ['LOCATION']),
    kommentar: pick(p, ['COM_SE', 'COMMENT_1'])
  };
}

// Militärt luftrum (EXEA/EXES). Samma mais-schema som övriga områden, men vi
// härleder `lager` per feature: militära TMA/CTR särskiljs från övriga sektorer
// (samma uppdelning som LFV:s drönarkarta gör med ett CQL-filter på namnet).
function mapMil(p, _lager) {
  const namn = pick(p, ['NAMEOFAREA']);
  const isCtrTma = /\b(CTR|TMA)\b/i.test(namn);
  return mapMaisArea(p, isCtrTma ? 'Militär TMA/CTR' : 'Militär sektor');
}

// Tillfälliga områden (DAIM_TOPO:fse_domr) — eget litet schema.
function mapFse(p, lager) {
  return {
    lager,
    namn: pick(p, ['Name']),
    hojd: heightRange(p.Lower, p.Upper),
    reviderad: pick(p, ['RevDate'])
  };
}

// Regionala UAS-sektorer (DAIM_TOPO:uav_sectors_region).
function mapUasSektor(p, lager) {
  return {
    lager,
    namn: pick(p, ['NAMEOFAREA']),
    typ: pick(p, ['TYPEOFAREA'])
  };
}

// AIP SUP (tillfälliga publikationer).
function mapSup(p, lager) {
  return {
    lager,
    namn: pick(p, ['NAME']),
    beteckning: pick(p, ['DESIG', 'ID']),
    hojd: heightRange(p.LOWER, p.UPPER, p.LOW_UOM, p.UP_UOM),
    fran: pick(p, ['FROM']),
    till: pick(p, ['TO']),
    schema: pick(p, ['SCHEDULE']),
    kommentar: pick(p, ['COM_SE']),
    lank: pick(p, ['URL'])
  };
}

// --- definition av utdatafiler -------------------------------------------------

const OUTPUTS = [
  {
    file: 'dronare_ctr_tiz.geojson',
    sources: [['mais:CTR', 'Kontrollzon (CTR)', mapMaisArea], ['mais:TIZ', 'Trafikinformationszon (TIZ)', mapMaisArea]]
  },
  {
    file: 'dronare_atz.geojson',
    sources: [['mais:ATZ', 'Trafikzon (ATZ)', mapMaisArea]]
  },
  {
    file: 'dronare_restriktion_fara.geojson',
    sources: [['mais:RSTA', 'Restriktionsområde', mapMaisArea], ['mais:DNGA', 'Fareområde', mapMaisArea]]
  },
  {
    file: 'dronare_flygplatser.geojson',
    sources: [['mais:ARP', 'Flygplats', mapMaisPoint], ['mais:HKP_ARP', 'Heliport', mapMaisPoint]]
  },
  {
    file: 'dronare_flygplats_buffert.geojson',
    sources: [
      ['DAIM_TOPO:HKP1K', 'Heliport 1 km', mapBuffer],
      ['DAIM_TOPO:RWY5K', 'Flygplats 5 km', mapBuffer]
    ]
  },
  {
    file: 'dronare_aip_sup.geojson',
    sources: [['DAIM_TOPO:SUP', 'AIP SUP', mapSup]]
  },
  {
    // Kontrollområden (TMA) – kontrollerat luftrum ovanför CTR. Både hela
    // TMA-ytan (TMAW) och dess sektorer (TMAS), precis som LFV:s drönarkarta.
    file: 'dronare_tma.geojson',
    sources: [
      ['mais:TMAW', 'Kontrollområde (TMA)', mapMaisArea],
      ['mais:TMAS', 'Kontrollområde (TMA-sektor)', mapMaisArea]
    ]
  },
  {
    // Militärt luftrum (militära TMA/CTR samt övnings-/mil-sektorer).
    file: 'dronare_militart.geojson',
    sources: [['mais:EXEA', '', mapMil], ['mais:EXES', '', mapMil]]
  },
  {
    // Tillfälligt reserverat (TRA) och gränsöverskridande (CBA) luftrum.
    file: 'dronare_tra_cba.geojson',
    sources: [
      ['mais:TRA', 'Tillfälligt reserverat (TRA)', mapMaisArea],
      ['mais:CBA', 'Gränsöverskridande (CBA)', mapMaisArea]
    ]
  },
  {
    // Trafikinformationsområde (TIA).
    file: 'dronare_tia.geojson',
    sources: [['mais:TIA', 'Trafikinformationsområde (TIA)', mapMaisArea]]
  },
  {
    // Delegerat luftrum (ATS-tjänst delegerad till annan leverantör).
    file: 'dronare_deleg.geojson',
    sources: [['mais:DELEG', 'Delegerat luftrum', mapMaisArea]]
  },
  {
    // Tillfälliga områden (temporära restriktioner, t.ex. skogsbrand/övning).
    file: 'dronare_tmp.geojson',
    sources: [['DAIM_TOPO:fse_domr', 'Tillfälligt område', mapFse]]
  },
  {
    // Regionala UAS-sektorer (drönarsektorindelning).
    file: 'dronare_uas_sektorer.geojson',
    sources: [['DAIM_TOPO:uav_sectors_region', 'UAS-sektor', mapUasSektor]]
  }
];

async function fetchLayer(typeName) {
  const res = await fetch(wfsUrl(typeName), { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} för ${typeName}`);
  const fc = await res.json();
  return fc.features || [];
}

async function buildOutput(def) {
  const features = [];
  for (const [typeName, lager, mapper] of def.sources) {
    const raw = await fetchLayer(typeName);
    for (const f of raw) {
      if (!f.geometry) continue;
      features.push({
        type: 'Feature',
        geometry: { type: f.geometry.type, coordinates: fixCoords(f.geometry.coordinates) },
        properties: mapper(f.properties || {}, lager)
      });
    }
    console.log(`  ${typeName}: ${raw.length} features`);
  }
  return features;
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  let failures = 0;
  for (const def of OUTPUTS) {
    const output = resolve(DATA_DIR, def.file);
    try {
      const features = await buildOutput(def);
      const out = {
        type: 'FeatureCollection',
        metadata: { source: WFS, provider: 'LFV / Transportstyrelsen', generated: new Date().toISOString() },
        features
      };
      writeFileSync(output, JSON.stringify(out, null, 1));
      console.log(`[luftrum] Skrev ${features.length} features → ${def.file}`);
    } catch (err) {
      failures++;
      console.error(`[luftrum] ${def.file} misslyckades: ${err.message}`);
      if (!existsSync(output)) console.error(`[luftrum]   (ingen befintlig fil att falla tillbaka på)`);
      else console.error(`[luftrum]   behåller befintlig fil.`);
    }
  }
  if (failures === OUTPUTS.length) process.exit(1); // allt föll → låt schemat logga fel
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
