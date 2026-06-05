#!/usr/bin/env node
/*
 * build_ted_upphandlingar.mjs — hämtar offentliga upphandlingar som rör
 * mätning / mätningsteknik / GIS / kartframställning / fotogrammetri /
 * laserskanning ("reality capture") från TED (Tenders Electronic Daily,
 * ted.europa.eu) och skriver en GeoJSON som Origo visar som ett eget lager.
 *
 * - Källa: TED:s öppna REST-API v3 (https://api.ted.europa.eu/v3/notices/search),
 *   ingen nyckel krävs. Filtrerar på CPV-koder (mätning/GIS m.m.),
 *   utförandeland Sverige (place-of-performance = SWE) och publiceringsår.
 * - Geografisk placering: i första hand annonsens NUTS-region för utförande
 *   (var jobbet är, inte utställaren); annars utställarens ort; annars Sverige.
 *   Punkterna jittras deterministiskt så att flera på samma centrum inte döljer
 *   varandra. Mönstret följer tools/scrape_lansstyrelsen.py.
 * - Varje feature taggas med kategori(er) och år så att layer-filter-pluginet
 *   kan filtrera på roll/kategori och publiceringsår.
 *
 * Kör: node tools/build_ted_upphandlingar.mjs [--from-year 2021] [--output <fil>]
 * Faller tillbaka på en befintlig outputfil om TED inte svarar, så ett bygge
 * aldrig bryts av en otillgänglig tjänst.
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT = resolve(__dirname, '..', 'data', 'ted_upphandlingar.geojson');

const API = 'https://api.ted.europa.eu/v3/notices/search';

// CPV-koder (prefix räcker i kategori-matchningen nedan; här är de exakta som
// skickas till TED för att begränsa träffmängden).
const CPV = [
  '71250000', // Arkitekt-, tekniska och mätningstjänster
  '71350000', // Tekniska och vetenskapliga tjänster inom ingenjörsväsen
  '71351000', // Geologiska, geofysiska och andra vetenskapliga undersökningar
  '71351810', // Topografiska tjänster
  '71354000', // Kartframställning
  '71354100', // Digital kartframställning
  '71354300', // Fastighetsmätning (cadastral)
  '71354500', // Marin kartläggning
  '71355000', // Mätningstjänster (surveying)
  '71355100', // Fotogrammetri
  '71355200', // Ordnance surveying
  '38221000', // Geografiska informationssystem (GIS)
  '38291000', // Telemetriutrustning / mätinstrument
  '79961200' // Flygfototjänster
];

// Kategori-regler (prefix-match mot CPV). Ordningen = prioritet för "kategori".
const CAT_RULES = [
  ['Fotogrammetri/skanning', ['71355100', '79961', '71355900']],
  ['Mätning/geodesi', ['71355000', '71355200', '71351810', '71250000', '71354300']],
  ['Kartframställning', ['71354']],
  ['GIS', ['38221', '72319', '38291']],
  ['Geoteknik/geofysik', ['71351', '71332']]
];
const CAT_FALLBACK = 'Övrigt mätning/GIS';

// Läsbara namn på de vanligaste annonstyperna.
const NOTICE_TYPE_LABEL = {
  'cn-standard': 'Upphandlingsannons',
  'cn-social': 'Upphandlingsannons',
  'cn-desg': 'Projekttävling',
  'pin-only': 'Förhandsannons',
  'pin-buyer': 'Förhandsannons',
  'pin-cfc-standard': 'Förhandsannons',
  'can-standard': 'Tilldelningsannons',
  'can-social': 'Tilldelningsannons',
  'can-desg': 'Resultat projekttävling',
  'can-modif': 'Ändringsannons',
  'corr': 'Rättelse'
};

// NUTS3-centrum (län) + NUTS2-fallback. WGS84 [lon, lat], ca länscentrum.
const NUTS = {
  SE110: [18.0686, 59.3294], // Stockholm
  SE121: [17.6389, 59.8586], // Uppsala
  SE122: [16.5077, 59.1955], // Södermanland (Nyköping)
  SE123: [15.6214, 58.4108], // Östergötland (Linköping)
  SE124: [15.2066, 59.2741], // Örebro
  SE125: [16.5448, 59.6099], // Västmanland (Västerås)
  SE211: [14.1618, 57.7826], // Jönköping
  SE212: [14.8059, 56.8777], // Kronoberg (Växjö)
  SE213: [16.3616, 56.6634], // Kalmar
  SE214: [18.2948, 57.6348], // Gotland (Visby)
  SE221: [15.5869, 56.1612], // Blekinge (Karlskrona)
  SE224: [13.0038, 55.6050], // Skåne (Malmö)
  SE231: [12.2520, 57.1057], // Halland (Varberg-ish)
  SE232: [11.9746, 57.7089], // Västra Götaland (Göteborg)
  SE311: [13.5034, 59.4022], // Värmland (Karlstad)
  SE312: [15.6356, 60.4858], // Dalarna (Falun)
  SE313: [17.1413, 60.6749], // Gävleborg (Gävle)
  SE321: [17.9379, 62.6323], // Västernorrland (Härnösand)
  SE322: [14.6357, 63.1792], // Jämtland (Östersund)
  SE331: [20.2630, 63.8258], // Västerbotten (Umeå)
  SE332: [22.1567, 65.5848], // Norrbotten (Luleå)
  // NUTS2-fallback
  SE11: [18.0686, 59.3294],
  SE12: [16.5448, 59.6099],
  SE21: [14.8059, 56.8777],
  SE22: [13.0038, 55.6050],
  SE23: [11.9746, 57.7089],
  SE31: [13.5034, 59.4022],
  SE32: [15.0, 62.9],
  SE33: [20.5, 65.0]
};
const SWEDEN = [16.3, 62.5];

// Ort → WGS84 [lon, lat] för utställar-fallback (urval av kommuner/orter).
const CITY = {
  stockholm: [18.0686, 59.3294], goteborg: [11.9746, 57.7089], malmo: [13.0038, 55.6050],
  uppsala: [17.6389, 59.8586], vasteras: [16.5448, 59.6099], orebro: [15.2066, 59.2741],
  linkoping: [15.6214, 58.4108], helsingborg: [12.6944, 56.0467], jonkoping: [14.1618, 57.7826],
  norrkoping: [16.1924, 58.5877], lund: [13.1910, 55.7047], umea: [20.2630, 63.8258],
  gavle: [17.1413, 60.6749], boras: [12.9401, 57.7210], sodertalje: [17.6253, 59.1955],
  eskilstuna: [16.5077, 59.3710], halmstad: [12.8578, 56.6745], vaxjo: [14.8059, 56.8777],
  karlstad: [13.5034, 59.4022], sundsvall: [17.3063, 62.3908], ostersund: [14.6357, 63.1792],
  trollhattan: [12.2886, 58.2837], lulea: [22.1567, 65.5848], boden: [21.6890, 65.8251],
  kalmar: [16.3616, 56.6634], kristianstad: [14.1565, 56.0294], falun: [15.6356, 60.4858],
  skelleftea: [20.9528, 64.7507], karlskrona: [15.5869, 56.1612], skovde: [13.8456, 58.3912],
  varberg: [12.2520, 57.1057], ornskoldsvik: [18.7156, 63.2909], nykoping: [17.0086, 58.7528],
  visby: [18.2948, 57.6348], borlange: [15.4366, 60.4856], vanersborg: [12.3236, 58.3806],
  uddevalla: [11.9424, 58.3498], motala: [15.0357, 58.5371], landskrona: [12.8302, 55.8708],
  trelleborg: [13.1571, 55.3753], ystad: [13.8204, 55.4297], pitea: [21.4795, 65.3172],
  kiruna: [20.2253, 67.8558], hudiksvall: [17.1059, 61.7274], mariestad: [13.8237, 58.7099],
  lidkoping: [13.1576, 58.5052], katrineholm: [16.2061, 59.0011], vetlanda: [15.0759, 57.4282],
  enkoping: [17.0780, 59.6358], lerum: [12.2693, 57.7704], molndal: [12.0136, 57.6554],
  kungsbacka: [12.0766, 57.4872], halsingborg: [12.6944, 56.0467], harnosand: [17.9379, 62.6323],
  ronneby: [15.2759, 56.2099], karlskoga: [14.5240, 59.3268], kungalv: [11.9805, 57.8704]
};

function normalise(s) {
  return String(s || '').trim().toLowerCase()
    .replace(/å/g, 'a').replace(/ä/g, 'a').replace(/ö/g, 'o')
    .replace(/[^a-z0-9 -]/g, '');
}

function pickSwe(map) {
  // TED returnerar språk-objekt {swe:[...], eng:[...]} eller en sträng/array.
  if (map == null) return '';
  if (typeof map === 'string') return map;
  if (Array.isArray(map)) return map[0] || '';
  const arr = map.swe || map.eng || map.mul || Object.values(map)[0];
  return Array.isArray(arr) ? (arr[0] || '') : (arr || '');
}

function categoriesFor(cpvs) {
  const hit = [];
  for (const [name, prefixes] of CAT_RULES) {
    if (cpvs.some((c) => prefixes.some((p) => c.startsWith(p)))) hit.push(name);
  }
  return hit.length ? hit : [CAT_FALLBACK];
}

function mostSpecificNuts(pop) {
  // pop = ["SE312","SWE",...] → välj längsta SE-koden (mest specifik) som finns i tabellen.
  const codes = [...new Set((pop || []).filter((x) => /^SE/.test(x)))]
    .sort((a, b) => b.length - a.length);
  for (const c of codes) {
    if (NUTS[c]) return c;
    // testa kortare prefix (SE312 → SE31)
    if (NUTS[c.slice(0, 4)]) return c.slice(0, 4);
  }
  return null;
}

function jitter(lon, lat, key) {
  // deterministisk spridning (~ ±5 km) så punkter på samma centrum inte staplas
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  const r1 = ((h >>> 0) % 10000) / 10000 - 0.5;
  const r2 = (((h >>> 8) >>> 0) % 10000) / 10000 - 0.5;
  return [lon + r1 * 0.12, lat + r2 * 0.07];
}

function locate(notice) {
  const nuts = mostSpecificNuts(notice['place-of-performance']);
  if (nuts && NUTS[nuts]) return { coord: NUTS[nuts], from: `nuts:${nuts}`, nuts };
  const city = pickSwe(notice['buyer-city']);
  const c = CITY[normalise(city)];
  if (c) return { coord: c, from: `utställare:${city}`, nuts: nuts || '' };
  return { coord: SWEDEN, from: 'sverige (okänd ort)', nuts: nuts || '' };
}

async function search(query, fields, onPage) {
  const limit = 100;
  let page = 1;
  let total = Infinity;
  const out = [];
  while (out.length < total && page <= 200) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, fields, page, limit, scope: 'ALL' })
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`TED svarade ${res.status}: ${t.slice(0, 200)}`);
    }
    const data = await res.json();
    total = data.totalNoticeCount || 0;
    const notices = data.notices || [];
    out.push(...notices);
    if (onPage) onPage(out.length, total);
    if (!notices.length) break;
    page += 1;
  }
  return out;
}

function toGeoJson(notices) {
  const features = [];
  const seen = new Set();
  for (const n of notices) {
    const pubnum = n['publication-number'];
    if (!pubnum || seen.has(pubnum)) continue;
    seen.add(pubnum);
    const cpvs = [...new Set(n['classification-cpv'] || [])];
    const cats = categoriesFor(cpvs);
    const date = ((n['publication-date'] || '').match(/^\d{4}-\d{2}-\d{2}/) || [''])[0];
    const year = parseInt((date.match(/^(\d{4})/) || [])[1], 10) || null;
    const { coord, from, nuts } = locate(n);
    const [lon, lat] = jitter(coord[0], coord[1], pubnum);
    const links = n.links || {};
    const lank = (links.pdf && (links.pdf.SWE || links.pdf.ENG || links.pdf.MUL))
      || (links.xml && links.xml.MUL)
      || `https://ted.europa.eu/sv/notice/-/detail/${pubnum}`;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [Number(lon.toFixed(5)), Number(lat.toFixed(5))] },
      properties: {
        titel: pickSwe(n['notice-title']),
        kategori: cats[0],
        kategorier: cats.join(', '),
        utstallare: pickSwe(n['buyer-name']),
        utstallarort: pickSwe(n['buyer-city']),
        ar: year,
        datum: date,
        typ: NOTICE_TYPE_LABEL[n['notice-type']] || n['notice-type'] || '',
        cpv: cpvs.join(', '),
        nuts,
        plats: from,
        publikationsnummer: pubnum,
        lank
      }
    });
  }
  return { type: 'FeatureCollection', features };
}

async function main() {
  const args = process.argv.slice(2);
  const getArg = (name, def) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : def;
  };
  const fromYear = parseInt(getArg('from-year', '2021'), 10);
  const output = resolve(getArg('output', DEFAULT_OUTPUT));

  const query = `(classification-cpv IN (${CPV.join(' ')}))`
    + ' AND (place-of-performance IN (SWE))'
    + ` AND (publication-date >= ${fromYear}0101)`;
  const fields = ['publication-number', 'notice-title', 'buyer-name', 'buyer-city',
    'place-of-performance', 'classification-cpv', 'publication-date', 'notice-type', 'links'];

  console.log(`[ted] hämtar upphandlingar (CPV mätning/GIS, Sverige, fr.o.m. ${fromYear}) …`);
  let notices;
  try {
    notices = await search(query, fields, (got, total) => {
      process.stdout.write(`\r[ted] ${got}/${total}…   `);
    });
    process.stdout.write('\n');
  } catch (err) {
    console.error(`[ted] hämtning misslyckades: ${err.message}`);
    if (existsSync(output)) {
      console.error('[ted] behåller befintlig outputfil.');
      return 0;
    }
    console.error('[ted] skriver tom FeatureCollection så bygget inte bryts.');
    notices = [];
  }

  const fc = toGeoJson(notices);
  // statistik
  const byFrom = { nuts: 0, utstallare: 0, sverige: 0 };
  fc.features.forEach((f) => {
    const p = f.properties.plats;
    if (p.startsWith('nuts')) byFrom.nuts += 1;
    else if (p.startsWith('utställare')) byFrom.utstallare += 1;
    else byFrom.sverige += 1;
  });
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(fc, null, 1)}\n`, 'utf-8');
  console.log(`[ted] klart: ${fc.features.length} upphandlingar → ${output}`);
  console.log(`[ted] placering: ${byFrom.nuts} via NUTS-region, ${byFrom.utstallare} via utställarort, ${byFrom.sverige} okänd ort.`);
  return 0;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
