/*!
 * tile-upload — delad hjälpmodul för laserdata-/ortofoto-pluginen.
 *
 * Läser en uppladdad fil (koordinatlista CSV/TXT, GeoJSON eller zippad shapefil)
 * och returnerar geometrierna i kartans projektion. Kör sedan en STAC-sökning på
 * geometriernas utbredning och returnerar de indexrutor som geometrierna
 * träffar/skär – så att de kan markeras för nedladdning.
 *
 * Skärningen är exakt och handkodad (punkt-i-polygon + segment-skärning), så
 * inga geometri-bibliotek behövs. .shp parsas med vendorad shpjs
 * (plugins/vendor/shp.min.js), som laddas först när en .shp/.zip används.
 *
 * Exponerar globalen `TileUpload`. Kräver att `origo.js` laddats först.
 */
(function (root) {
  if (typeof Origo === 'undefined') {
    // eslint-disable-next-line no-console
    console.error('[tile-upload] Origo-globalen saknas – ladda origo.js före detta skript.');
    return;
  }

  // ---- shpjs (lazy) ----
  function loadShp() {
    if (root.shp) return Promise.resolve(root.shp);
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'plugins/vendor/shp.min.js';
      s.onload = () => (root.shp ? resolve(root.shp) : reject(new Error('shp.min.js laddades men shp saknas')));
      s.onerror = () => reject(new Error('Kunde inte ladda plugins/vendor/shp.min.js'));
      document.head.appendChild(s);
    });
  }

  // ---- CRS-väljare ----
  // Koordinatsystem som kan väljas vid uppladdning. Alla EPSG-koder utom 'auto'
  // måste vara registrerade (index.json proj4Defs) för att geom.transform ska
  // funka. 'auto' gissar BARA WGS84 vs SWEREF 99 TM på koordinaternas storlek –
  // den kan inte skilja lokala SWEREF-zoner åt (välj rätt zon explicit).
  const CRS_LIST = [
    { code: 'EPSG:3006', label: 'SWEREF 99 TM' },
    { code: 'EPSG:3007', label: 'SWEREF 99 12 00' },
    { code: 'EPSG:3008', label: 'SWEREF 99 13 30' },
    { code: 'EPSG:3012', label: 'SWEREF 99 14 15' },
    { code: 'EPSG:3009', label: 'SWEREF 99 15 00' },
    { code: 'EPSG:3013', label: 'SWEREF 99 15 45' },
    { code: 'EPSG:3010', label: 'SWEREF 99 16 30' },
    { code: 'EPSG:3014', label: 'SWEREF 99 17 15' },
    { code: 'EPSG:3011', label: 'SWEREF 99 18 00' },
    { code: 'EPSG:3015', label: 'SWEREF 99 18 45' },
    { code: 'EPSG:3016', label: 'SWEREF 99 20 15' },
    { code: 'EPSG:3017', label: 'SWEREF 99 21 45' },
    { code: 'EPSG:3018', label: 'SWEREF 99 23 15' },
    { code: 'EPSG:3021', label: 'RT90 2.5 gon V' },
    { code: 'EPSG:4326', label: 'WGS84 (lon/lat)' },
    { code: 'auto', label: 'Auto (WGS84/SWEREF 99 TM)' }
  ];

  function crsOptionsHtml(selected) {
    const sel = selected || 'EPSG:3006';
    return CRS_LIST.map((c) => `<option value="${c.code}"${c.code === sel ? ' selected' : ''}>${c.label}</option>`).join('');
  }

  // ---- CRS ----
  // Avgör källans CRS. 'auto' gissar på koordinaternas storlek (svensk data):
  // SWEREF 99 TM-värden är stora (>1000), WGS84 är grader.
  function resolveCrs(crs, sampleXY) {
    if (crs === 'EPSG:3006' || crs === 'EPSG:4326') return crs;
    const mag = Math.max(Math.abs(sampleXY[0] || 0), Math.abs(sampleXY[1] || 0));
    return mag > 1000 ? 'EPSG:3006' : 'EPSG:4326';
  }

  function toMapProj(geom, srcCrs, mapProj) {
    if (srcCrs !== mapProj.getCode()) geom.transform(srcCrs, mapProj);
    return geom;
  }

  // ---- byggare ----
  const G = Origo.ol.geom;

  function geojsonToOl(g) {
    if (!g) return null;
    switch (g.type) {
      case 'Point': return new G.Point(g.coordinates);
      case 'MultiPoint': return new G.MultiPoint(g.coordinates);
      case 'LineString': return new G.LineString(g.coordinates);
      case 'MultiLineString': return new G.MultiLineString(g.coordinates);
      case 'Polygon': return new G.Polygon(g.coordinates);
      case 'MultiPolygon': return new G.MultiPolygon(g.coordinates);
      default: return null;
    }
  }

  // Plockar fram ett exempel-koordinatpar ur en GeoJSON-geometri (för CRS-gissning).
  function sampleCoord(g) {
    let c = g && g.coordinates;
    while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
    return Array.isArray(c) ? c : [0, 0];
  }

  // ---- parsers → array av OL-geometrier i kartans projektion ----
  function parseGeoJSON(text, crs, mapProj) {
    const obj = JSON.parse(text);
    const feats = obj.type === 'FeatureCollection' ? (obj.features || [])
      : obj.type === 'Feature' ? [obj]
        : obj.type ? [{ geometry: obj }] : [];
    const geoms = [];
    feats.forEach((f) => {
      const gj = f.geometry || f;
      if (gj && gj.type === 'GeometryCollection') {
        (gj.geometries || []).forEach((sub) => {
          const ol = geojsonToOl(sub);
          if (ol) geoms.push(toMapProj(ol, resolveCrs(crs, sampleCoord(sub)), mapProj));
        });
        return;
      }
      const ol = geojsonToOl(gj);
      if (ol) geoms.push(toMapProj(ol, resolveCrs(crs, sampleCoord(gj)), mapProj));
    });
    return geoms;
  }

  function parseCoordinateList(text, crs, mapProj) {
    const points = [];
    text.split(/\r?\n/).forEach((line) => {
      const t = line.trim();
      if (!t || /[a-df-zA-DF-Z]/.test(t.replace(/[eE][+-]?\d/g, ''))) return; // hoppa rubrik/text
      const nums = t.split(/[\s,;]+/).map(Number).filter((n) => Number.isFinite(n));
      if (nums.length < 2) return;
      // Svensk regel: nordligt värde (lat/N) är störst → blir y, det andra x.
      const a = nums[0];
      const b = nums[1];
      const y = Math.abs(a) >= Math.abs(b) ? a : b;
      const x = Math.abs(a) >= Math.abs(b) ? b : a;
      points.push([x, y]);
    });
    if (!points.length) return [];
    const srcCrs = resolveCrs(crs, points[0]);
    return points.map((xy) => toMapProj(new G.Point(xy.slice()), srcCrs, mapProj));
  }

  async function parseShapefile(file, crs, mapProj) {
    const shp = await loadShp();
    const buffer = await readAsArrayBuffer(file);
    const name = (file.name || '').toLowerCase();
    let collections;
    if (name.endsWith('.zip')) {
      const result = await shp(buffer); // FeatureCollection eller array av sådana
      collections = Array.isArray(result) ? result : [result];
    } else {
      // Enskild .shp (ingen .dbf krävs – vi behöver bara geometrin).
      const geomsArr = await shp.parseShp(buffer);
      collections = [{ features: (geomsArr || []).map((g) => ({ geometry: g })) }];
    }
    const geoms = [];
    collections.forEach((fc) => {
      (fc.features || []).forEach((f) => {
        const ol = geojsonToOl(f.geometry);
        if (ol) geoms.push(toMapProj(ol, resolveCrs(crs, sampleCoord(f.geometry)), mapProj));
      });
    });
    return geoms;
  }

  function readAsText(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(new Error('Kunde inte läsa filen'));
      r.readAsText(file);
    });
  }
  function readAsArrayBuffer(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(new Error('Kunde inte läsa filen'));
      r.readAsArrayBuffer(file);
    });
  }

  // Läser filen → array av OL-geometrier i kartans projektion.
  async function parse(file, opts) {
    const { crs = 'auto', mapProj } = opts;
    const name = (file.name || '').toLowerCase();
    if (name.endsWith('.zip') || name.endsWith('.shp')) {
      return parseShapefile(file, crs, mapProj);
    }
    const text = await readAsText(file);
    if (name.endsWith('.geojson') || name.endsWith('.json') || /^\s*[{[]/.test(text)) {
      return parseGeoJSON(text, crs, mapProj);
    }
    return parseCoordinateList(text, crs, mapProj);
  }

  // ---- exakt skärning (koordinater i meter, kartans projektion) ----
  function pointInRing(p, ring) {
    let inside = false;
    const x = p[0];
    const y = p[1];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const xi = ring[i][0];
      const yi = ring[i][1];
      const xj = ring[j][0];
      const yj = ring[j][1];
      const hit = ((yi > y) !== (yj > y))
        && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
      if (hit) inside = !inside;
    }
    return inside;
  }

  function ccw(a, b, c) {
    return (c[1] - a[1]) * (b[0] - a[0]) > (b[1] - a[1]) * (c[0] - a[0]);
  }
  // Segment AB vs CD skär varandra.
  function segInt(a, b, c, d) {
    return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
  }

  function pathHitsRing(path, ring) {
    for (let i = 0; i < path.length; i += 1) if (pointInRing(path[i], ring)) return true;
    for (let i = 0; i < path.length - 1; i += 1) {
      for (let j = 0; j < ring.length - 1; j += 1) {
        if (segInt(path[i], path[i + 1], ring[j], ring[j + 1])) return true;
      }
    }
    return false;
  }

  function ringsHit(ringA, ringB) {
    if (pointInRing(ringA[0], ringB) || pointInRing(ringB[0], ringA)) return true;
    for (let i = 0; i < ringA.length - 1; i += 1) {
      for (let j = 0; j < ringB.length - 1; j += 1) {
        if (segInt(ringA[i], ringA[i + 1], ringB[j], ringB[j + 1])) return true;
      }
    }
    return false;
  }

  // Plattar ut en OL-geometri till {points, paths, polys} (polys = ytterringar).
  function flatten(geom) {
    const out = { points: [], paths: [], polys: [] };
    const type = geom.getType();
    if (type === 'Point') out.points.push(geom.getCoordinates());
    else if (type === 'MultiPoint') geom.getCoordinates().forEach((p) => out.points.push(p));
    else if (type === 'LineString') out.paths.push(geom.getCoordinates());
    else if (type === 'MultiLineString') geom.getCoordinates().forEach((l) => out.paths.push(l));
    else if (type === 'Polygon') out.polys.push(geom.getCoordinates()[0]);
    else if (type === 'MultiPolygon') geom.getCoordinates().forEach((poly) => out.polys.push(poly[0]));
    return out;
  }

  function flatTouchesTile(flat, tilePolys) {
    for (let t = 0; t < tilePolys.length; t += 1) {
      const ring = tilePolys[t];
      for (let i = 0; i < flat.points.length; i += 1) if (pointInRing(flat.points[i], ring)) return true;
      for (let i = 0; i < flat.paths.length; i += 1) if (pathHitsRing(flat.paths[i], ring)) return true;
      for (let i = 0; i < flat.polys.length; i += 1) if (ringsHit(flat.polys[i], ring)) return true;
    }
    return false;
  }

  // Bygger tile-geometri (WGS84) → kartans projektion.
  function tileGeometry(geojson, mapProj) {
    const ol = geojsonToOl(geojson);
    if (!ol) return null;
    ol.transform('EPSG:4326', mapProj);
    return ol;
  }

  function extentsOverlap(a, b) {
    return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
  }

  // Kör STAC-sökning på geometriernas utbredning och returnerar de slimmade
  // feature-objekt vars rutor någon geometri skär. { matched, truncated, searched }.
  async function matchTiles(opts) {
    const { geometries, mapProj, searchUrl, limit = 4000, collection } = opts;
    if (!geometries || !geometries.length) return { matched: [], truncated: false, searched: 0 };

    // Samlad utbredning i kartans projektion → WGS84-bbox för sökningen.
    let extent = geometries[0].getExtent().slice();
    geometries.forEach((g) => {
      const e = g.getExtent();
      extent[0] = Math.min(extent[0], e[0]);
      extent[1] = Math.min(extent[1], e[1]);
      extent[2] = Math.max(extent[2], e[2]);
      extent[3] = Math.max(extent[3], e[3]);
    });
    const wgs = Origo.ol.proj.transformExtent(extent, mapProj, 'EPSG:4326');

    const res = await fetch(searchUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bbox: [wgs[0], wgs[1], wgs[2], wgs[3]], limit, collection })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data && data.error ? data.error : `Sökningen svarade ${res.status}`);
    const features = data.features || [];

    const flats = geometries.map(flatten);
    const matched = [];
    features.forEach((f) => {
      if (!f.geometry) return;
      const tg = tileGeometry(f.geometry, mapProj);
      if (!tg) return;
      const tExt = tg.getExtent();
      const tilePolys = flatten(tg).polys;
      if (!tilePolys.length) return;
      for (let i = 0; i < flats.length; i += 1) {
        if (!extentsOverlap(geometries[i].getExtent(), tExt)) continue;
        if (flatTouchesTile(flats[i], tilePolys)) { matched.push(f); break; }
      }
    });

    return { matched, truncated: features.length >= limit, searched: features.length, extent };
  }

  root.TileUpload = { parse, matchTiles, crsOptionsHtml, CRS_LIST };
}(window));
