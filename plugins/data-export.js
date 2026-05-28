/*!
 * data-export — Origo plugin.
 *
 * Användaren tänder lager i lagerlistan, klickar "Ladda ner data" i höger
 * verktygsmeny, väljer ett rit-verktyg (polygon / rektangel / cirkel), ritar
 * urvalsområdet på kartan och väljer "innanför" eller "skär". En zip-fil med
 * en shapefile per kartlager (Point/Line/Polygon ev. uppdelat) byggs i
 * webbläsaren och laddas ner.
 *
 * Lagertyper som stöds:
 *   - GEOJSON, WFS, AGS_FEATURE   – features hämtas direkt ur OL-källan
 *   - WMS (Geoserver/QGIS-server) – serversidig WFS GetFeature med BBOX
 *   - AGS_TILE / AGS_MAP          – ArcGIS REST /query med urvalsgeometri
 *   - XYZ / OSM (bakgrundskartor) – exkluderas (rasterlager utan features)
 *
 * Allt sker klientsidan: shapefile, DBF, PRJ, CPG och ZIP genereras i ren
 * JavaScript. Komprimering sker via webbläsarens CompressionStream
 * (deflate-raw) om den finns, annars STORED.
 *
 * Bundlad som IIFE. Exponerar globalen `DataExport(options)`. Kräver att
 * `origo.js` laddats först.
 */
(function (root) {
  if (typeof Origo === 'undefined') {
    // eslint-disable-next-line no-console
    console.error('[data-export] Origo-globalen saknas – ladda origo.js före detta skript.');
    return;
  }

  // ============================================================
  // CRC-32 (IEEE 802.3) – behövs av zip
  // ============================================================
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i += 1) {
      c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // ============================================================
  // Minimal ZIP-writer (STORED + DEFLATE via CompressionStream)
  // ============================================================
  async function deflateRaw(buf) {
    if (typeof CompressionStream === 'undefined') return null;
    try {
      const stream = new Blob([buf]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (e) {
      return null;
    }
  }

  function dosDateTime(d) {
    const dt = d || new Date();
    const time = ((dt.getHours() & 0x1F) << 11)
      | ((dt.getMinutes() & 0x3F) << 5)
      | ((Math.floor(dt.getSeconds() / 2)) & 0x1F);
    const date = (((dt.getFullYear() - 1980) & 0x7F) << 9)
      | (((dt.getMonth() + 1) & 0x0F) << 5)
      | (dt.getDate() & 0x1F);
    return { time, date };
  }

  async function buildZip(files) {
    const encoder = new TextEncoder();
    const { time, date } = dosDateTime();
    const local = [];
    const central = [];
    let offset = 0;

    for (const f of files) {
      const nameBytes = encoder.encode(f.name);
      const crc = crc32(f.data);
      const usize = f.data.length;
      let comp = f.data;
      let method = 0;
      const deflated = await deflateRaw(f.data);
      if (deflated && deflated.length < usize) {
        comp = deflated;
        method = 8;
      }
      const csize = comp.length;

      // Local file header
      const lfh = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(lfh.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0, true);
      lv.setUint16(8, method, true);
      lv.setUint16(10, time, true);
      lv.setUint16(12, date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, csize, true);
      lv.setUint32(22, usize, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      lfh.set(nameBytes, 30);
      local.push(lfh, comp);

      // Central directory entry
      const cdh = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cdh.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0, true);
      cv.setUint16(10, method, true);
      cv.setUint16(12, time, true);
      cv.setUint16(14, date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, csize, true);
      cv.setUint32(24, usize, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      cdh.set(nameBytes, 46);
      central.push(cdh);

      offset += lfh.length + comp.length;
    }

    const cdSize = central.reduce((s, p) => s + p.length, 0);
    const cdOffset = offset;

    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, cdOffset, true);
    ev.setUint16(20, 0, true);

    const parts = local.concat(central, [eocd]);
    const total = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(total);
    let p = 0;
    for (const part of parts) { out.set(part, p); p += part.length; }
    return new Blob([out], { type: 'application/zip' });
  }

  // ============================================================
  // DBF (dBase III) encoder
  // Field names: max 10 ASCII chars. UTF-8 i C-fält + .cpg = "UTF-8".
  // ============================================================
  function asciiSlug(s) {
    return String(s)
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9_]/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  function uniqDbfFieldName(raw, used) {
    let base = asciiSlug(raw || 'F').slice(0, 10);
    if (!base) base = 'F';
    let n = base;
    let i = 2;
    while (used.has(n.toUpperCase())) {
      const suffix = String(i);
      n = (base.slice(0, Math.max(1, 10 - suffix.length))) + suffix;
      i += 1;
    }
    used.add(n.toUpperCase());
    return n;
  }

  // Bestäm fält-typ/längd per attribut genom att titta på alla värden.
  function inferDbfFields(features, attrSpec) {
    const cols = new Map();         // origName -> { values, type, length, dec }
    const order = [];
    const seen = new Set();
    const consider = (name, value) => {
      if (!cols.has(name)) {
        cols.set(name, { values: [], type: 'C', length: 1, dec: 0 });
        order.push(name);
      }
      const c = cols.get(name);
      c.values.push(value);
    };
    // Prioritera attribut-spec ordningsmässigt (om finns)
    if (Array.isArray(attrSpec) && attrSpec.length) {
      attrSpec.forEach((a) => {
        if (a && a.name && !seen.has(a.name)) {
          seen.add(a.name);
          cols.set(a.name, { values: [], type: 'C', length: 1, dec: 0 });
          order.push(a.name);
        }
      });
    }
    features.forEach((f) => {
      const p = f.properties || (f.getProperties ? f.getProperties() : {});
      Object.keys(p).forEach((k) => {
        if (k === 'geometry' || k === 'geom' || k === 'the_geom') return;
        // Hoppa över OL geometry-objekt
        const v = p[k];
        if (v && typeof v === 'object' && v.getCoordinates) return;
        consider(k, v);
      });
    });

    // Avgör typ/längd
    const used = new Set();
    const fields = [];
    order.forEach((origName) => {
      const c = cols.get(origName);
      let type = 'C';
      let length = 1;
      let dec = 0;
      let allNum = true;
      let allBool = true;
      let allDate = true;
      let hasVal = false;
      let maxStrLen = 1;
      let maxIntDigits = 1;
      let maxDec = 0;

      c.values.forEach((v) => {
        if (v === undefined || v === null || v === '') return;
        hasVal = true;
        if (typeof v === 'boolean') { allNum = false; allDate = false; return; }
        allBool = false;
        if (typeof v === 'number' && Number.isFinite(v)) {
          const s = String(v);
          const dot = s.indexOf('.');
          if (dot >= 0) {
            maxIntDigits = Math.max(maxIntDigits, dot);
            maxDec = Math.max(maxDec, s.length - dot - 1);
          } else {
            maxIntDigits = Math.max(maxIntDigits, s.length);
          }
          allDate = false;
          return;
        }
        allNum = false;
        const s = String(v);
        if (/^\d{4}-\d{2}-\d{2}/.test(s) || (v instanceof Date)) {
          // håll allDate
        } else {
          allDate = false;
        }
        // Beräkna byte-längd som UTF-8
        const bytes = new TextEncoder().encode(s).length;
        maxStrLen = Math.max(maxStrLen, bytes);
      });

      if (!hasVal) {
        type = 'C';
        length = 1;
      } else if (allBool) {
        type = 'L';
        length = 1;
      } else if (allNum) {
        type = 'N';
        dec = Math.min(maxDec, 6);
        // +1 för punkt (om dec>0), +1 för ev. minustecken
        length = Math.min(19, maxIntDigits + (dec > 0 ? 1 + dec : 0) + 1);
      } else if (allDate) {
        type = 'D';
        length = 8;
      } else {
        type = 'C';
        length = Math.min(254, Math.max(1, maxStrLen));
      }
      const dbfName = uniqDbfFieldName(origName, used);
      fields.push({ origName, dbfName, type, length, dec });
    });
    return fields;
  }

  function dbfEncodeValue(field, v, encoder) {
    const pad = (s, n, left) => {
      if (s.length >= n) return s.slice(0, n);
      return left ? (' '.repeat(n - s.length) + s) : (s + ' '.repeat(n - s.length));
    };
    if (v === undefined || v === null || v === '') {
      return new Uint8Array(field.length).fill(0x20);
    }
    if (field.type === 'L') {
      const c = v ? 'T' : 'F';
      return encoder.encode(c);
    }
    if (field.type === 'N') {
      let n;
      if (typeof v === 'number') n = v;
      else n = Number(v);
      if (!Number.isFinite(n)) return encoder.encode(pad('', field.length, true));
      let s;
      if (field.dec > 0) s = n.toFixed(field.dec);
      else s = String(Math.trunc(n));
      // Trunkera om för långt
      if (s.length > field.length) s = s.slice(0, field.length);
      return encoder.encode(pad(s, field.length, true));
    }
    if (field.type === 'D') {
      let s;
      if (v instanceof Date) {
        s = `${v.getFullYear()}${String(v.getMonth() + 1).padStart(2, '0')}${String(v.getDate()).padStart(2, '0')}`;
      } else {
        s = String(v).replace(/-/g, '').slice(0, 8);
        if (s.length < 8) s = pad(s, 8, false);
      }
      return encoder.encode(s.slice(0, 8));
    }
    // C – char/string. UTF-8, trunkera till längd i bytes.
    let bytes = encoder.encode(String(v));
    if (bytes.length > field.length) {
      // Trunkera vid godkänd byte-gräns; fall tillbaka på enkel slice
      bytes = bytes.slice(0, field.length);
    }
    if (bytes.length < field.length) {
      const out = new Uint8Array(field.length);
      out.set(bytes);
      out.fill(0x20, bytes.length);
      return out;
    }
    return bytes;
  }

  function buildDbf(features, fields) {
    const encoder = new TextEncoder();
    const headerSize = 32 + fields.length * 32 + 1;
    const recordSize = 1 + fields.reduce((s, f) => s + f.length, 0);
    const total = headerSize + features.length * recordSize + 1; // 0x1A EOF

    const buf = new Uint8Array(total);
    const dv = new DataView(buf.buffer);

    const now = new Date();
    buf[0] = 0x03;
    buf[1] = now.getFullYear() % 100;
    buf[2] = now.getMonth() + 1;
    buf[3] = now.getDate();
    dv.setUint32(4, features.length, true);
    dv.setUint16(8, headerSize, true);
    dv.setUint16(10, recordSize, true);
    // reserved (12..31) = 0

    // Fältbeskrivningar
    let p = 32;
    fields.forEach((f) => {
      const nameBytes = encoder.encode(f.dbfName);
      const nb = new Uint8Array(11);
      nb.set(nameBytes.slice(0, 10));
      buf.set(nb, p);
      buf[p + 11] = f.type.charCodeAt(0);
      // 12..15 field data address (0)
      buf[p + 16] = f.length;
      buf[p + 17] = f.dec;
      // 18..31 reserved
      p += 32;
    });
    buf[p] = 0x0D;
    p += 1;

    // Records
    features.forEach((feat) => {
      const props = feat.properties || (feat.getProperties ? feat.getProperties() : {});
      buf[p] = 0x20;  // active record
      p += 1;
      fields.forEach((f) => {
        const v = props[f.origName];
        const enc = dbfEncodeValue(f, v, encoder);
        buf.set(enc, p);
        p += f.length;
      });
    });
    buf[p] = 0x1A;
    return buf;
  }

  // ============================================================
  // Shapefile (.shp + .shx) encoder
  // SHP_TYPE: 1=Point  3=PolyLine  5=Polygon  8=MultiPoint
  // ============================================================
  function ringSignedArea2D(ring) {
    let a = 0;
    for (let i = 0, n = ring.length; i < n; i += 1) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[(i + 1) % n];
      a += (x2 - x1) * (y2 + y1);
    }
    return a; // > 0 => CW (shapefile outer), < 0 => CCW (shapefile inner)
  }

  function ensureClosed(ring) {
    if (ring.length === 0) return ring;
    const [x0, y0] = ring[0];
    const [xN, yN] = ring[ring.length - 1];
    if (x0 !== xN || y0 !== yN) ring.push([x0, y0]);
    return ring;
  }

  // Konvertera OL/geojson-geometri till en lista av "parts" per shapefile-typ.
  // Returnerar { type, parts: [[ [x,y],... ], ...], bbox: [xmin,ymin,xmax,ymax] }
  function toShapeRecord(geomCoords, geomType) {
    const updateBbox = (bb, c) => {
      if (c[0] < bb[0]) bb[0] = c[0];
      if (c[1] < bb[1]) bb[1] = c[1];
      if (c[0] > bb[2]) bb[2] = c[0];
      if (c[1] > bb[3]) bb[3] = c[1];
    };
    const bb = [Infinity, Infinity, -Infinity, -Infinity];

    if (geomType === 'Point') {
      const c = geomCoords;
      updateBbox(bb, c);
      return { type: 1, point: c, bbox: bb };
    }
    if (geomType === 'MultiPoint') {
      geomCoords.forEach((c) => updateBbox(bb, c));
      return { type: 8, points: geomCoords, bbox: bb };
    }
    if (geomType === 'LineString') {
      geomCoords.forEach((c) => updateBbox(bb, c));
      return { type: 3, parts: [geomCoords], bbox: bb };
    }
    if (geomType === 'MultiLineString') {
      const parts = geomCoords.map((line) => {
        line.forEach((c) => updateBbox(bb, c));
        return line;
      });
      return { type: 3, parts, bbox: bb };
    }
    if (geomType === 'Polygon') {
      const parts = geomCoords.map((ring, idx) => {
        const r = ensureClosed(ring.map((c) => [c[0], c[1]]));
        const area = ringSignedArea2D(r);
        // outer ring (idx=0) ska vara CW (area>0); inner (idx>0) ska vara CCW (area<0)
        const wantClockwise = idx === 0;
        if ((wantClockwise && area < 0) || (!wantClockwise && area > 0)) r.reverse();
        r.forEach((c) => updateBbox(bb, c));
        return r;
      });
      return { type: 5, parts, bbox: bb };
    }
    if (geomType === 'MultiPolygon') {
      const parts = [];
      geomCoords.forEach((poly) => {
        poly.forEach((ring, idx) => {
          const r = ensureClosed(ring.map((c) => [c[0], c[1]]));
          const area = ringSignedArea2D(r);
          const wantClockwise = idx === 0;
          if ((wantClockwise && area < 0) || (!wantClockwise && area > 0)) r.reverse();
          r.forEach((c) => updateBbox(bb, c));
          parts.push(r);
        });
      });
      return { type: 5, parts, bbox: bb };
    }
    return null;
  }

  // Räkna ut content-length (i 16-bit ord) för en shape-record.
  function recordContentLength(rec) {
    // shape type (4)
    if (rec.type === 1) return (4 + 16) / 2;                  // pt: type + 2 doubles
    if (rec.type === 8) {                                     // MultiPoint
      const np = rec.points.length;
      return (4 + 32 + 4 + np * 16) / 2;
    }
    // PolyLine/Polygon: type + bbox(32) + numParts(4) + numPoints(4) + parts(numParts*4) + points(numPoints*16)
    const nParts = rec.parts.length;
    const nPts = rec.parts.reduce((s, p) => s + p.length, 0);
    return (4 + 32 + 4 + 4 + nParts * 4 + nPts * 16) / 2;
  }

  function writeShapeRecord(dv, off, rec) {
    dv.setInt32(off, rec.type, true);
    off += 4;
    if (rec.type === 1) {
      dv.setFloat64(off, rec.point[0], true);
      dv.setFloat64(off + 8, rec.point[1], true);
      return off + 16;
    }
    // bbox
    dv.setFloat64(off, rec.bbox[0], true);
    dv.setFloat64(off + 8, rec.bbox[1], true);
    dv.setFloat64(off + 16, rec.bbox[2], true);
    dv.setFloat64(off + 24, rec.bbox[3], true);
    off += 32;
    if (rec.type === 8) {
      dv.setInt32(off, rec.points.length, true);
      off += 4;
      rec.points.forEach((p) => {
        dv.setFloat64(off, p[0], true); dv.setFloat64(off + 8, p[1], true); off += 16;
      });
      return off;
    }
    // PolyLine / Polygon
    const nPts = rec.parts.reduce((s, p) => s + p.length, 0);
    dv.setInt32(off, rec.parts.length, true); off += 4;
    dv.setInt32(off, nPts, true); off += 4;
    let cum = 0;
    rec.parts.forEach((p) => { dv.setInt32(off, cum, true); off += 4; cum += p.length; });
    rec.parts.forEach((p) => {
      p.forEach((c) => {
        dv.setFloat64(off, c[0], true);
        dv.setFloat64(off + 8, c[1], true);
        off += 16;
      });
    });
    return off;
  }

  function buildShpShx(records, shapeType) {
    // Totala filstorleken
    let contentBytes = 0;
    records.forEach((r) => { contentBytes += 8 + recordContentLength(r) * 2; });
    const shpSize = 100 + contentBytes;
    const shxSize = 100 + records.length * 8;
    const shp = new Uint8Array(shpSize);
    const shx = new Uint8Array(shxSize);
    const dvShp = new DataView(shp.buffer);
    const dvShx = new DataView(shx.buffer);

    // Global bbox
    const gb = [Infinity, Infinity, -Infinity, -Infinity];
    records.forEach((r) => {
      const b = r.bbox || (r.point ? [r.point[0], r.point[1], r.point[0], r.point[1]] : null);
      if (!b) return;
      if (b[0] < gb[0]) gb[0] = b[0];
      if (b[1] < gb[1]) gb[1] = b[1];
      if (b[2] > gb[2]) gb[2] = b[2];
      if (b[3] > gb[3]) gb[3] = b[3];
    });
    if (!records.length) { gb[0] = 0; gb[1] = 0; gb[2] = 0; gb[3] = 0; }

    function writeHeader(dv, size16) {
      dv.setInt32(0, 9994, false);                 // file code (big-endian)
      // 4..23 unused = 0
      dv.setInt32(24, size16, false);              // file length in 16-bit words (big-endian)
      dv.setInt32(28, 1000, true);                 // version (little-endian)
      dv.setInt32(32, shapeType, true);            // shape type (little-endian)
      dv.setFloat64(36, gb[0], true);
      dv.setFloat64(44, gb[1], true);
      dv.setFloat64(52, gb[2], true);
      dv.setFloat64(60, gb[3], true);
      // Z & M ranges = 0
    }
    writeHeader(dvShp, shpSize / 2);
    writeHeader(dvShx, shxSize / 2);

    let off = 100;
    let shxOff = 100;
    records.forEach((r, i) => {
      const recLen16 = recordContentLength(r); // i 16-bit ord
      // Record header (big-endian)
      dvShp.setInt32(off, i + 1, false);            // record number
      dvShp.setInt32(off + 4, recLen16, false);     // content length
      const after = writeShapeRecord(dvShp, off + 8, r);
      // Shx
      dvShx.setInt32(shxOff, off / 2, false);       // offset i 16-bit ord
      dvShx.setInt32(shxOff + 4, recLen16, false);
      shxOff += 8;
      off = after;
    });
    return { shp, shx };
  }

  // ============================================================
  // PRJ WKT-strängar för EPSG:3006 / 4326 / 3857
  // ============================================================
  const PRJ = {
    'EPSG:3006': 'PROJCS["SWEREF99_TM",GEOGCS["GCS_SWEREF99",DATUM["D_SWEREF99",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",15.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]',
    'EPSG:4326': 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]',
    'EPSG:3857': 'PROJCS["WGS_1984_Web_Mercator_Auxiliary_Sphere",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Mercator_Auxiliary_Sphere"],PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",0.0],PARAMETER["Standard_Parallel_1",0.0],PARAMETER["Auxiliary_Sphere_Type",0.0],UNIT["Meter",1.0]]'
  };

  // ============================================================
  // Helpers: geometri / projektion / spatial filter
  // ============================================================
  function olGeomToCoordsAndType(olGeom) {
    const t = olGeom.getType();
    return { type: t, coords: olGeom.getCoordinates() };
  }

  // Klona en geometri och transformera till target SRS.
  function transformGeom(olGeom, fromProj, toProj) {
    if (fromProj === toProj) return olGeom.clone();
    return olGeom.clone().transform(fromProj, toProj);
  }

  function transformCoords(coords, fromProj, toProj) {
    if (fromProj === toProj) return coords;
    const transform = Origo.ol.proj.transform;
    const map = (c) => {
      if (typeof c[0] === 'number') return transform([c[0], c[1]], fromProj, toProj);
      return c.map(map);
    };
    return map(coords);
  }

  // Punkt-i-polygon på drawnPoly (ringar i kartans projektion 3857).
  function pointInPolygon(coord, polyCoords) {
    // polyCoords = [outerRing, hole1, hole2, ...]
    let inside = false;
    for (let r = 0; r < polyCoords.length; r += 1) {
      const ring = polyCoords[r];
      let nodes = 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
        const yi = ring[i][1]; const xi = ring[i][0];
        const yj = ring[j][1]; const xj = ring[j][0];
        const intersect = ((yi > coord[1]) !== (yj > coord[1]))
          && (coord[0] < ((xj - xi) * (coord[1] - yi)) / (yj - yi) + xi);
        if (intersect) nodes += 1;
      }
      if (r === 0) {
        if (nodes % 2 === 1) inside = true;
      } else if (nodes % 2 === 1) {
        // hål – exkludera
        inside = false;
      }
    }
    return inside;
  }

  function segmentsIntersect(a, b, c, d) {
    const o = (p1, p2, p3) => {
      const v = (p2[0] - p1[0]) * (p3[1] - p1[1]) - (p2[1] - p1[1]) * (p3[0] - p1[0]);
      if (v > 1e-12) return 1;
      if (v < -1e-12) return -1;
      return 0;
    };
    const o1 = o(a, b, c);
    const o2 = o(a, b, d);
    const o3 = o(c, d, a);
    const o4 = o(c, d, b);
    if (o1 !== o2 && o3 !== o4) return true;
    return false;
  }

  // Flatten OL-coords till array av positioner per ring/linje/punkt.
  function geometryRings(geom) {
    const t = geom.getType();
    const coords = geom.getCoordinates();
    if (t === 'Point') return [[coords]];
    if (t === 'MultiPoint') return [coords.map((c) => c)];
    if (t === 'LineString') return [coords];
    if (t === 'MultiLineString') return coords;
    if (t === 'Polygon') return coords;
    if (t === 'MultiPolygon') return coords.flat(1);
    return [];
  }

  function geometryAllCoords(geom) {
    return geometryRings(geom).flat(1);
  }

  // Normalisera Polygon/MultiPolygon till en lista av polygoner ([[outer, hole1,...], ...]).
  function getPolygonList(olGeom) {
    const t = olGeom.getType();
    if (t === 'Polygon') return [olGeom.getCoordinates()];
    if (t === 'MultiPolygon') return olGeom.getCoordinates();
    return [];
  }

  // Matchar feature mot någon av de drawn-polygonerna.
  function featureMatchesAny(feature, drawnPolyList, mode) {
    for (let i = 0; i < drawnPolyList.length; i += 1) {
      if (featureMatches(feature, drawnPolyList[i], mode)) return true;
    }
    return false;
  }

  // drawnPolyCoords: t.ex. [outerRing, hole1, ...]
  function featureMatches(feature, drawnPolyCoords, mode) {
    const geom = feature.getGeometry ? feature.getGeometry() : null;
    if (!geom) return false;
    const all = geometryAllCoords(geom);
    if (mode === 'within') {
      // Alla vertex i geom måste vara inom drawnPoly
      for (let i = 0; i < all.length; i += 1) {
        if (!pointInPolygon(all[i], drawnPolyCoords)) return false;
      }
      return all.length > 0;
    }
    // intersects
    for (let i = 0; i < all.length; i += 1) {
      if (pointInPolygon(all[i], drawnPolyCoords)) return true;
    }
    // Ev. drawnPoly-vertex inuti feature-geom?
    const t = geom.getType();
    if (t === 'Polygon' || t === 'MultiPolygon') {
      const outer = drawnPolyCoords[0];
      for (let i = 0; i < outer.length; i += 1) {
        if (geom.intersectsCoordinate(outer[i])) return true;
      }
    }
    // Segment-skärning: drawnPoly's outer ring mot feature-segments
    const drawnOuter = drawnPolyCoords[0];
    const rings = geometryRings(geom);
    for (let r = 0; r < rings.length; r += 1) {
      const ring = rings[r];
      for (let i = 0; i < ring.length - 1; i += 1) {
        for (let j = 0; j < drawnOuter.length - 1; j += 1) {
          if (segmentsIntersect(ring[i], ring[i + 1], drawnOuter[j], drawnOuter[j + 1])) return true;
        }
      }
    }
    return false;
  }

  // ============================================================
  // Layer-typer: vilka är exporterbara, vilken hämtnings-strategi.
  // ============================================================
  const RASTER_TYPES = new Set(['OSM', 'XYZ', 'WMTS', 'TILE']);

  function getLayerType(layer) {
    return String(layer.get('type') || '').toUpperCase();
  }

  function layerIsExportable(layer) {
    const t = getLayerType(layer);
    if (!t) return false;
    if (RASTER_TYPES.has(t)) return false;
    return true;
  }

  function sourceConfig(viewer, layer) {
    const map = viewer.getMapSource && viewer.getMapSource();
    if (!map) return null;
    const name = layer.get('sourceName') || layer.get('source');
    return name ? map[name] : null;
  }

  // ============================================================
  // Hämtare: client-side vector features (GEOJSON, WFS, AGS_FEATURE)
  // ============================================================
  function unwrapSource(olSrc) {
    if (!olSrc) return null;
    if (typeof olSrc.getSource === 'function' && olSrc.getSource()) return olSrc.getSource();
    return olSrc;
  }

  async function ensureVectorLoaded(layer, viewer) {
    const olSrc = unwrapSource(layer.getSource());
    if (!olSrc || typeof olSrc.getFeatures !== 'function') return [];
    if (olSrc.getFeatures().length) return olSrc.getFeatures();
    const view = viewer.getMap().getView();
    const proj = view.getProjection();
    try {
      olSrc.loadFeatures(proj.getExtent(), view.getResolution() || 1, proj);
    } catch (e) { /* ignore */ }
    return new Promise((resolve) => {
      let tries = 0;
      const iv = setInterval(() => {
        tries += 1;
        if (olSrc.getFeatures().length || tries > 40) {
          clearInterval(iv);
          resolve(olSrc.getFeatures());
        }
      }, 150);
    });
  }

  // ============================================================
  // Hämtare: WFS GetFeature mot Geoserver-WMS / WFS-layers
  // ============================================================
  function buildWfsUrl(baseUrl, params) {
    const u = new URL(baseUrl, window.location.origin);
    Object.keys(params).forEach((k) => u.searchParams.set(k, params[k]));
    return u.toString();
  }

  // Plocka första texten ur en GeoServer-XML <ows:ExceptionText>.
  function extractOgcExceptionText(xmlText) {
    const m = xmlText.match(/<(?:ows:)?ExceptionText[^>]*>([\s\S]*?)<\/(?:ows:)?ExceptionText>/i)
      || xmlText.match(/<ServiceException[^>]*>([\s\S]*?)<\/ServiceException>/i);
    if (m) return m[1].trim().replace(/\s+/g, ' ').slice(0, 240);
    return null;
  }

  function isLikelyJson(text) {
    const t = text.trim();
    return t.startsWith('{') || t.startsWith('[');
  }

  // En försök: returnera { features } vid JSON, eller throw med läsbart fel.
  async function fetchWfsOnce(url) {
    let res;
    try {
      res = await fetch(url, { headers: { Accept: 'application/json' } });
    } catch (e) {
      throw new Error(`Nätverksfel: ${e.message}`);
    }
    const text = await res.text();
    if (!res.ok) {
      const ex = extractOgcExceptionText(text);
      throw new Error(ex ? `HTTP ${res.status}: ${ex}` : `HTTP ${res.status}`);
    }
    if (!isLikelyJson(text)) {
      const ex = extractOgcExceptionText(text);
      throw new Error(ex || `Servern returnerade icke-JSON (${text.slice(0, 80).replace(/\s+/g, ' ')}…)`);
    }
    try {
      const data = JSON.parse(text);
      return data;
    } catch (e) {
      throw new Error(`JSON-fel: ${e.message}`);
    }
  }

  async function tryWfs(viewer, layer, drawnGeomMap, mapProj) {
    const cfg = sourceConfig(viewer, layer);
    if (!cfg || !cfg.url) throw new Error('Saknar källa-URL');
    const idStr = layer.get('id') || layer.get('layerName') || layer.get('name');
    if (!idStr) throw new Error('Saknar lager-id');
    const ext3857 = drawnGeomMap.getExtent();
    const bb = Origo.ol.proj.transformExtent(ext3857, mapProj, 'EPSG:4326');
    const bboxStr = `${bb.join(',')},EPSG:4326`;

    const typeList = idStr.split(',').map((s) => s.trim()).filter(Boolean);
    const targetSrs = 'EPSG:3006';

    // Olika WFS-implementationer förstår olika versioner + outputFormat-strängar.
    // Vi försöker i ordning tills en sätter en JSON-respons.
    const attempts = [
      { version: '2.0.0', key: 'typeNames', format: 'application/json' },
      { version: '2.0.0', key: 'typeNames', format: 'json' },
      { version: '1.1.0', key: 'typeName',  format: 'application/json' },
      { version: '1.1.0', key: 'typeName',  format: 'json' },
      { version: '1.0.0', key: 'typeName',  format: 'GML3' }   // sista utvägen som identifierare
    ];

    const allFeatures = [];
    let lastErr = null;
    for (const tn of typeList) {
      let gotForType = false;
      for (const a of attempts) {
        const params = {
          service: 'WFS',
          version: a.version,
          request: 'GetFeature',
          [a.key]: tn,
          outputFormat: a.format,
          srsName: targetSrs,
          bbox: bboxStr
        };
        if (a.version === '2.0.0') params.count = '10000';
        else params.maxFeatures = '10000';
        const url = buildWfsUrl(cfg.url, params);
        try {
          const data = await fetchWfsOnce(url);
          if (data && Array.isArray(data.features)) {
            data.features.forEach((f) => { f.__layerName = tn; allFeatures.push(f); });
            gotForType = true;
            break;
          }
        } catch (e) {
          lastErr = e;
        }
      }
      if (!gotForType && lastErr) {
        // Markera vilken typename som inte funkade
        lastErr = new Error(`${tn}: ${lastErr.message}`);
      }
    }
    if (allFeatures.length === 0 && lastErr) throw lastErr;
    return { format: 'geojson-3006', features: allFeatures };
  }

  // ============================================================
  // Hämtare: ArcGIS REST /query mot MapServer/FeatureServer
  // ============================================================
  async function queryArcGisSubLayer(baseUrl, subId, drawnGeomMap, mapProj) {
    // Transformera till WGS84 och bygg ESRI polygon-geometry. ArcGIS-formatet
    // använder en platt lista "rings" – fyll på från alla polygoner i ev. MultiPolygon.
    const geom4326 = transformGeom(drawnGeomMap, mapProj, 'EPSG:4326');
    const polyList = geom4326.getType() === 'MultiPolygon'
      ? geom4326.getCoordinates()
      : [geom4326.getCoordinates()];
    const rings = [];
    polyList.forEach((poly) => poly.forEach((ring) => rings.push(ring.map((c) => [c[0], c[1]]))));
    const esriGeom = { rings, spatialReference: { wkid: 4326 } };
    // Inkludera SR 102100/3857 också för servrar som inte gillar 4326 i geometry
    const out = [];
    let offset = 0;
    const pageSize = 1000;
    // Vi loopar tills serverns "exceededTransferLimit" är false eller inga fler resultat.
    for (let safety = 0; safety < 50; safety += 1) {
      const u = new URL(`${baseUrl.replace(/\/$/, '')}/${subId}/query`, window.location.origin);
      u.searchParams.set('f', 'geojson');
      u.searchParams.set('geometry', JSON.stringify(esriGeom));
      u.searchParams.set('geometryType', 'esriGeometryPolygon');
      u.searchParams.set('inSR', '4326');
      u.searchParams.set('spatialRel', 'esriSpatialRelIntersects');
      u.searchParams.set('outFields', '*');
      u.searchParams.set('outSR', '3006');
      u.searchParams.set('returnGeometry', 'true');
      u.searchParams.set('resultRecordCount', String(pageSize));
      u.searchParams.set('resultOffset', String(offset));
      const res = await fetch(u.toString());
      if (!res.ok) throw new Error(`ArcGIS HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(`ArcGIS: ${data.error.message || JSON.stringify(data.error)}`);
      const feats = data.features || [];
      feats.forEach((f) => { f.__layerName = String(subId); out.push(f); });
      if (feats.length < pageSize) break;
      if (data.properties && data.properties.exceededTransferLimit === false) break;
      offset += feats.length;
    }
    return out;
  }

  async function tryArcGis(viewer, layer, drawnGeomMap, mapProj) {
    const cfg = sourceConfig(viewer, layer);
    if (!cfg || !cfg.url) throw new Error('Saknar källa-URL');
    const idStr = String(layer.get('id') || '');
    if (!idStr) throw new Error('Saknar sublager-id');
    const subIds = idStr.split(',').map((s) => s.trim()).filter(Boolean);
    const all = [];
    let lastErr = null;
    for (const sub of subIds) {
      try {
        const fs = await queryArcGisSubLayer(cfg.url, sub, drawnGeomMap, mapProj);
        all.push(...fs);
      } catch (e) {
        lastErr = e;
      }
    }
    if (all.length === 0 && lastErr) throw lastErr;
    return { format: 'geojson-3006', features: all };
  }

  // ============================================================
  // Konvertera OL Feature -> GeoJSON-likt {properties, geometry-coords + type}
  // ============================================================
  function olFeatureToGeoJsonLike(feature, mapProj, targetProj) {
    const olGeom = feature.getGeometry && feature.getGeometry();
    if (!olGeom) return null;
    const g = transformGeom(olGeom, mapProj, targetProj);
    const props = Object.assign({}, feature.getProperties());
    delete props[feature.getGeometryName ? feature.getGeometryName() : 'geometry'];
    return { properties: props, _geomType: g.getType(), _geomCoords: g.getCoordinates() };
  }

  function geoJsonFeatureToInternal(gf, srsAlreadyTarget) {
    // gf är GeoJSON Feature (med crs som EPSG:3006 om vi bad om det)
    if (!gf || !gf.geometry) return null;
    return {
      properties: gf.properties || {},
      _geomType: gf.geometry.type,
      _geomCoords: gf.geometry.coordinates,
      _sourceSubLayer: gf.__layerName
    };
  }

  // ============================================================
  // Bygg shapefile-set för en grupp features (samma shape-type).
  // ============================================================
  function groupByShapeType(features) {
    const groups = { point: [], line: [], polygon: [], multipoint: [] };
    features.forEach((f) => {
      const t = f._geomType;
      if (t === 'Point') groups.point.push(f);
      else if (t === 'MultiPoint') groups.multipoint.push(f);
      else if (t === 'LineString' || t === 'MultiLineString') groups.line.push(f);
      else if (t === 'Polygon' || t === 'MultiPolygon') groups.polygon.push(f);
    });
    return groups;
  }

  function shapefileBytesForGroup(features, attrSpec) {
    const records = [];
    features.forEach((f) => {
      const rec = toShapeRecord(f._geomCoords, f._geomType);
      if (rec) records.push(rec);
    });
    if (!records.length) return null;
    const shapeType = records[0].type;
    const { shp, shx } = buildShpShx(records, shapeType);
    const fields = inferDbfFields(features, attrSpec);
    const dbf = buildDbf(features, fields);
    return { shp, shx, dbf };
  }

  function safeFileName(s) {
    return asciiSlug(s).slice(0, 60) || 'layer';
  }

  // ============================================================
  // ZIP-reader (för shapefile-uppladdning)
  // ============================================================
  async function inflateRaw(buf) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('Webbläsaren saknar DecompressionStream – kan ej packa upp DEFLATE');
    }
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function readZip(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    // Hitta EOCD (End of central directory) i de sista 65 557 bytena
    let eocd = -1;
    const minStart = Math.max(0, buf.length - 65557);
    for (let i = buf.length - 22; i >= minStart; i -= 1) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Inte en zip-fil (EOCD saknas)');
    const cdCount = dv.getUint16(eocd + 10, true);
    const cdOffset = dv.getUint32(eocd + 16, true);

    const entries = [];
    let p = cdOffset;
    const decoder = new TextDecoder();
    for (let i = 0; i < cdCount; i += 1) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Korrupt zip-CD');
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const usize = dv.getUint32(p + 24, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const lfh = dv.getUint32(p + 42, true);
      const name = decoder.decode(buf.slice(p + 46, p + 46 + nameLen));
      entries.push({ name, method, csize, usize, lfh });
      p += 46 + nameLen + extraLen + commentLen;
    }
    const out = {};
    for (const e of entries) {
      if (dv.getUint32(e.lfh, true) !== 0x04034b50) throw new Error('Korrupt zip-LFH');
      const nL = dv.getUint16(e.lfh + 26, true);
      const xL = dv.getUint16(e.lfh + 28, true);
      const dataStart = e.lfh + 30 + nL + xL;
      const compData = buf.slice(dataStart, dataStart + e.csize);
      let data;
      if (e.method === 0) data = compData;
      else if (e.method === 8) data = await inflateRaw(compData);
      else throw new Error(`Okänd zip-metod ${e.method} för ${e.name}`);
      out[e.name] = data;
    }
    return out;
  }

  // ============================================================
  // SHP-reader – plockar ut polygon-/linje-ringar
  // Stödjer Polygon (5/15/25), PolyLine (3/13/23), Point (1/11/21)
  // ============================================================
  function readShp(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (dv.getInt32(0, false) !== 9994) throw new Error('Ogiltig shapefile (file code != 9994)');
    const shapeType = dv.getInt32(32, true);
    const isPolygon = shapeType === 5 || shapeType === 15 || shapeType === 25;
    const isLine = shapeType === 3 || shapeType === 13 || shapeType === 23;
    const isPoint = shapeType === 1 || shapeType === 11 || shapeType === 21;
    if (!isPolygon && !isLine && !isPoint) {
      throw new Error(`Stödjer ej shape-typ ${shapeType} (förvänta polygon, linje eller punkt)`);
    }
    const records = [];
    let p = 100;
    while (p + 8 <= buf.length) {
      const contentLength = dv.getInt32(p + 4, false) * 2; // bytes
      const recStart = p + 8;
      const recType = dv.getInt32(recStart, true);
      if (recType !== 0) {
        if (isPoint) {
          const x = dv.getFloat64(recStart + 4, true);
          const y = dv.getFloat64(recStart + 12, true);
          records.push({ type: 'Point', coord: [x, y] });
        } else {
          const numParts = dv.getInt32(recStart + 36, true);
          const numPoints = dv.getInt32(recStart + 40, true);
          const partsStart = recStart + 44;
          const pointsStart = partsStart + numParts * 4;
          const parts = [];
          for (let i = 0; i < numParts; i += 1) parts.push(dv.getInt32(partsStart + i * 4, true));
          const points = [];
          for (let i = 0; i < numPoints; i += 1) {
            points.push([
              dv.getFloat64(pointsStart + i * 16, true),
              dv.getFloat64(pointsStart + i * 16 + 8, true)
            ]);
          }
          const rings = [];
          for (let i = 0; i < numParts; i += 1) {
            const s = parts[i];
            const e = (i + 1 < numParts) ? parts[i + 1] : numPoints;
            rings.push(points.slice(s, e));
          }
          records.push({ type: isPolygon ? 'Polygon' : 'PolyLine', rings });
        }
      }
      p = recStart + contentLength;
    }
    return { shapeType, records };
  }

  // ============================================================
  // SRS-detektion: först .prj-WKT, sedan koordinat-magnitud
  // ============================================================
  function detectSrsFromPrj(text) {
    if (!text) return null;
    const t = text.toUpperCase();
    const m = t.match(/AUTHORITY\s*\[\s*"EPSG"\s*,\s*"?(\d+)"?\s*\]/);
    if (m) return `EPSG:${m[1]}`;
    if (t.includes('SWEREF99_TM') || t.includes('SWEREF 99 TM') || t.includes('SWEREF99 TM')) return 'EPSG:3006';
    if (t.includes('SWEREF99_12_00')) return 'EPSG:3007';
    if (t.includes('SWEREF99_13_30')) return 'EPSG:3008';
    if (t.includes('SWEREF99_15_00')) return 'EPSG:3009';
    if (t.includes('SWEREF99_16_30')) return 'EPSG:3010';
    if (t.includes('SWEREF99_18_00')) return 'EPSG:3011';
    if (t.includes('SWEREF99_14_15')) return 'EPSG:3012';
    if (t.includes('SWEREF99_15_45')) return 'EPSG:3013';
    if (t.includes('SWEREF99_17_15')) return 'EPSG:3014';
    if (t.includes('SWEREF99_18_45')) return 'EPSG:3015';
    if (t.includes('SWEREF99_20_15')) return 'EPSG:3016';
    if (t.includes('SWEREF99_21_45')) return 'EPSG:3017';
    if (t.includes('SWEREF99_23_15')) return 'EPSG:3018';
    if (t.includes('RT90_2.5_GON_V') || t.includes('RT90 2.5 GON V')) return 'EPSG:3021';
    if (t.includes('WEB_MERCATOR') || t.includes('PSEUDO-MERCATOR') || t.includes('PSEUDO_MERCATOR')) return 'EPSG:3857';
    if (t.includes('GCS_WGS_1984') || t.includes('WGS_1984') || t.includes('WGS 84') || t.includes('WGS84')) return 'EPSG:4326';
    return null;
  }

  function detectSrsFromCoords(records) {
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
    const consume = (xy) => {
      if (xy[0] < minX) minX = xy[0];
      if (xy[0] > maxX) maxX = xy[0];
      if (xy[1] < minY) minY = xy[1];
      if (xy[1] > maxY) maxY = xy[1];
    };
    records.forEach((r) => {
      if (r.type === 'Point') consume(r.coord);
      else r.rings.forEach((ring) => ring.forEach(consume));
    });
    if (!Number.isFinite(minX)) return null;
    // Lon/lat
    if (Math.abs(minX) <= 180 && Math.abs(maxX) <= 180 && Math.abs(minY) <= 90 && Math.abs(maxY) <= 90) return 'EPSG:4326';
    // SWEREF99 TM (Sverige): E ~200 000–900 000, N ~6 100 000–7 700 000
    if (minX > 100000 && maxX < 1000000 && minY > 6000000 && maxY < 7800000) return 'EPSG:3006';
    // Web Mercator (Sverige): E ~1–3M, N ~7–12M
    if (Math.abs(minX) < 21000000 && Math.abs(maxX) < 21000000 && Math.abs(minY) < 21000000 && Math.abs(maxY) < 21000000
      && Math.abs(maxX) > 100000) return 'EPSG:3857';
    return null;
  }

  // Konvertera SHP-records till en OL polygon-feature i mapProj.
  // Varje SHP "Polygon"-record kan ha flera ringar (outer + holes). Vi grupperar
  // dem per shapefile-konventionen: CW = ny outer-ring, CCW = hål i föregående outer.
  function shpRecordsToPolygonFeature(records, srcSrs, mapProj) {
    const { Feature } = Origo.ol;
    const Polygon = Origo.ol.geom.Polygon;
    const MultiPolygon = Origo.ol.geom.MultiPolygon;
    const polys = records.filter((r) => r.type === 'Polygon');
    if (!polys.length) throw new Error('Hittade inga polygoner i shapefilen');

    // Bygg lista av polygoner [outer, hole1, hole2, ...] från alla records.
    const allPolys = [];
    polys.forEach((rec) => {
      let current = null;
      rec.rings.forEach((ring) => {
        const area = ringSignedArea2D(ring);
        // shapefile: area > 0 (CW) => outer; area < 0 (CCW) => hole
        if (area >= 0 || !current) {
          current = [ring];
          allPolys.push(current);
        } else {
          current.push(ring);
        }
      });
    });

    let geom;
    if (allPolys.length === 1) {
      geom = new Polygon(allPolys[0]);
    } else {
      geom = new MultiPolygon(allPolys);
    }
    if (srcSrs && srcSrs !== mapProj) {
      try {
        geom.transform(srcSrs, mapProj);
      } catch (e) {
        throw new Error(`Projektion ${srcSrs} är inte registrerad – konvertera filen till EPSG:3006/4326/3857 först`);
      }
    }
    return new Feature({ geometry: geom });
  }

  // ============================================================
  // Plugin
  // ============================================================
  function DataExport(options = {}) {
    const {
      icon = '#ic_download_24px',
      tooltipText = 'Ladda ner geodata',
      tooltipPlacement = 'east',
      targetSrs = 'EPSG:3006'
    } = options;
    const cls = 'o-data-export padding-small icon-smaller round light box-shadow';

    let viewer;
    let map;
    let target;
    let button;

    let active = false;
    let panelEl;
    let layerListEl;
    let statusEl;
    let progressEl;
    let downloadBtn;
    let clearBtn;
    let shapeButtons = {};
    let modeRadios = {};

    let drawSource;
    let drawLayer;
    let drawInteraction = null;
    let modifyInteraction = null;
    let drawnFeature = null;
    let activeShape = null;
    let activeMode = 'within';
    let listedLayers = [];
    let fileInput;

    // ---------- panel ----------
    function buildPanel() {
      const el = document.createElement('div');
      el.className = 'o-dxp-panel';
      el.innerHTML = `
        <div class="o-dxp-header">
          <h3>Ladda ner geodata</h3>
          <button type="button" class="o-dxp-close" title="Stäng">&times;</button>
        </div>
        <div class="o-dxp-body">
          <div class="o-dxp-section">
            <div class="o-dxp-section-title">1. Lager att exportera</div>
            <div class="o-dxp-layers"></div>
            <div class="o-dxp-hint" style="font-size:0.7rem;color:#7a8a9a;">
              Endast tända lager listas. Klicka på lager i lagerlistan för att tända/släcka.
            </div>
          </div>
          <div class="o-dxp-section">
            <div class="o-dxp-section-title">2. Rita urvalsområde</div>
            <div class="o-dxp-shape-buttons">
              <button type="button" data-shape="Polygon">Polygon</button>
              <button type="button" data-shape="Box">Rektangel</button>
              <button type="button" data-shape="Circle">Cirkel</button>
            </div>
            <div class="o-dxp-upload">
              <button type="button" class="o-dxp-upload-btn">… eller ladda upp shapefil</button>
              <input type="file" class="o-dxp-file" accept=".zip,.shp" hidden>
              <div class="o-dxp-upload-hint">
                Ladda upp en <code>.zip</code> (med .shp + .prj) eller en lös <code>.shp</code>.
                Koordinatsystemet detekteras automatiskt och du kan dra i punkterna efter import.
              </div>
            </div>
          </div>
          <div class="o-dxp-section">
            <div class="o-dxp-section-title">3. Inkludera</div>
            <div class="o-dxp-mode">
              <label><input type="radio" name="o-dxp-mode" value="within" checked> Innanför området</label>
              <label><input type="radio" name="o-dxp-mode" value="intersects"> Skär området</label>
            </div>
          </div>
          <div class="o-dxp-actions">
            <button type="button" class="o-dxp-clear">Rensa rita</button>
            <button type="button" class="o-dxp-download" disabled>Ladda ner .zip</button>
          </div>
          <div class="o-dxp-status"></div>
          <div class="o-dxp-progress"></div>
        </div>
      `;
      el.querySelector('.o-dxp-close').addEventListener('click', deactivate);
      layerListEl = el.querySelector('.o-dxp-layers');
      statusEl = el.querySelector('.o-dxp-status');
      progressEl = el.querySelector('.o-dxp-progress');
      downloadBtn = el.querySelector('.o-dxp-download');
      clearBtn = el.querySelector('.o-dxp-clear');
      downloadBtn.addEventListener('click', startDownload);
      clearBtn.addEventListener('click', clearDrawing);

      el.querySelectorAll('.o-dxp-shape-buttons button').forEach((b) => {
        shapeButtons[b.dataset.shape] = b;
        b.addEventListener('click', () => setActiveShape(b.dataset.shape));
      });
      el.querySelectorAll('input[name="o-dxp-mode"]').forEach((r) => {
        modeRadios[r.value] = r;
        r.addEventListener('change', () => { if (r.checked) activeMode = r.value; });
      });

      fileInput = el.querySelector('.o-dxp-file');
      el.querySelector('.o-dxp-upload-btn').addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', onFilePicked);

      makeDraggable(el.querySelector('.o-dxp-header'), el);
      panelEl = el;
      return el;
    }

    function makeDraggable(handle, panel) {
      let ox; let oy; let sx; let sy;
      handle.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.o-dxp-close')) return;
        const r = panel.getBoundingClientRect();
        const pr = panel.offsetParent
          ? panel.offsetParent.getBoundingClientRect() : { left: 0, top: 0 };
        ox = r.left - pr.left;
        oy = r.top - pr.top;
        sx = e.clientX;
        sy = e.clientY;
        const mv = (ev) => {
          panel.style.right = 'auto';
          panel.style.left = `${ox + ev.clientX - sx}px`;
          panel.style.top = `${oy + ev.clientY - sy}px`;
        };
        const up = () => {
          document.removeEventListener('pointermove', mv);
          document.removeEventListener('pointerup', up);
        };
        document.addEventListener('pointermove', mv);
        document.addEventListener('pointerup', up);
      });
    }

    function showPanel() {
      if (!panelEl) buildPanel();
      const host = document.getElementById(viewer.getId()) || document.body;
      if (!panelEl.isConnected) host.appendChild(panelEl);
      refreshLayerList();
    }

    function hidePanel() {
      if (panelEl && panelEl.parentNode) panelEl.parentNode.removeChild(panelEl);
    }

    // ---------- layer list ----------
    function refreshLayerList() {
      if (!layerListEl) return;
      const layers = viewer.getLayers().filter((l) => {
        if (!l.getVisible()) return false;
        // Exkludera dragga rit-lagret
        if (l === drawLayer) return false;
        return true;
      });
      listedLayers = layers.map((layer) => {
        const t = getLayerType(layer);
        const exportable = layerIsExportable(layer);
        return { layer, type: t, exportable };
      });

      layerListEl.innerHTML = '';
      if (!listedLayers.length) {
        layerListEl.innerHTML = '<div class="o-dxp-empty">Inga tända lager.</div>';
        updateDownloadEnabled();
        return;
      }
      const frag = document.createDocumentFragment();
      listedLayers.forEach((entry, idx) => {
        const row = document.createElement('label');
        row.className = 'o-dxp-layer-row';
        if (!entry.exportable) row.classList.add('is-unsupported');
        row.innerHTML = `
          <input type="checkbox" ${entry.exportable ? 'checked' : ''} ${entry.exportable ? '' : 'disabled'}>
          <span class="o-dxp-layer-title"></span>
          <span class="o-dxp-layer-tag"></span>
        `;
        row.querySelector('.o-dxp-layer-title').textContent = entry.layer.get('title') || entry.layer.get('name');
        row.querySelector('.o-dxp-layer-tag').textContent = entry.exportable ? entry.type : 'raster';
        const cb = row.querySelector('input');
        cb.addEventListener('change', () => {
          listedLayers[idx].selected = cb.checked;
          updateDownloadEnabled();
        });
        listedLayers[idx].selected = entry.exportable;
        frag.appendChild(row);
      });
      layerListEl.appendChild(frag);
      updateDownloadEnabled();
    }

    function updateDownloadEnabled() {
      if (!downloadBtn) return;
      const anyLayer = listedLayers.some((e) => e.selected);
      const haveShape = !!drawnFeature;
      downloadBtn.disabled = !(anyLayer && haveShape);
    }

    function setStatus(text, isError) {
      if (!statusEl) return;
      statusEl.textContent = text || '';
      statusEl.classList.toggle('is-error', !!isError);
    }

    // ---------- drawing ----------
    function ensureDrawLayer() {
      if (drawLayer) return;
      const { Style, Stroke, Fill } = Origo.ol.style;
      drawSource = new Origo.ol.source.Vector();
      drawLayer = new Origo.ol.layer.Vector({
        source: drawSource,
        style: new Style({
          stroke: new Stroke({ color: 'rgba(200,40,40,1)', width: 2, lineDash: [6, 4] }),
          fill: new Fill({ color: 'rgba(200,40,40,0.10)' })
        }),
        properties: { name: 'o-dxp-draw', queryable: false }
      });
      drawLayer.setZIndex(9000);
      map.addLayer(drawLayer);
    }

    function ensureModifyInteraction() {
      if (modifyInteraction || !drawSource) return;
      modifyInteraction = new Origo.ol.interaction.Modify({ source: drawSource });
      modifyInteraction.on('modifyend', () => {
        // Behåll drawnFeature-pekaren (Modify ändrar geometrin in-place på samma feature)
        updateDownloadEnabled();
      });
      map.addInteraction(modifyInteraction);
    }

    function removeModifyInteraction() {
      if (modifyInteraction) { map.removeInteraction(modifyInteraction); modifyInteraction = null; }
    }

    function setActiveShape(shape) {
      Object.keys(shapeButtons).forEach((s) => shapeButtons[s].classList.toggle('is-active', s === shape));
      if (drawInteraction) { map.removeInteraction(drawInteraction); drawInteraction = null; }
      removeModifyInteraction();
      activeShape = shape;
      const Draw = Origo.ol.interaction.Draw;
      const createBox = Origo.ol.interaction.createBox
        || (Draw && Draw.createBox);
      const opts = { source: drawSource };
      if (shape === 'Polygon') opts.type = 'Polygon';
      else if (shape === 'Box') {
        opts.type = 'Circle';
        if (typeof createBox === 'function') opts.geometryFunction = createBox();
      } else if (shape === 'Circle') {
        opts.type = 'Circle';
      }
      drawInteraction = new Draw(opts);
      drawInteraction.on('drawstart', () => {
        drawSource.clear();
        drawnFeature = null;
        updateDownloadEnabled();
      });
      drawInteraction.on('drawend', (e) => {
        drawnFeature = e.feature;
        setTimeout(() => {
          if (drawInteraction) { map.removeInteraction(drawInteraction); drawInteraction = null; }
          Object.keys(shapeButtons).forEach((s) => shapeButtons[s].classList.remove('is-active'));
          ensureModifyInteraction();
          updateDownloadEnabled();
          setStatus('Klart – du kan dra i punkterna för att justera området.');
        }, 0);
      });
      map.addInteraction(drawInteraction);
      setStatus('Klicka på kartan för att rita.');
    }

    function clearDrawing() {
      if (drawInteraction) { map.removeInteraction(drawInteraction); drawInteraction = null; }
      removeModifyInteraction();
      drawSource && drawSource.clear();
      drawnFeature = null;
      Object.keys(shapeButtons).forEach((s) => shapeButtons[s].classList.remove('is-active'));
      setStatus('');
      progressEl.innerHTML = '';
      if (fileInput) fileInput.value = '';
      updateDownloadEnabled();
    }

    // ---------- file upload ----------
    async function onFilePicked(ev) {
      const file = ev.target.files && ev.target.files[0];
      if (!file) return;
      try {
        await importShapefileFromFile(file);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[data-export] Shapefile-import:', err);
        setStatus(`Import misslyckades: ${err.message}`, true);
      }
      ev.target.value = '';
    }

    async function importShapefileFromFile(file) {
      setStatus(`Läser ${file.name}…`);
      const buf = new Uint8Array(await file.arrayBuffer());
      const lower = (file.name || '').toLowerCase();
      let shpBytes = null;
      let prjText = null;
      let shpName = file.name;
      if (lower.endsWith('.zip')) {
        const entries = await readZip(buf);
        // Hitta första .shp
        const names = Object.keys(entries);
        const shpKey = names.find((n) => /\.shp$/i.test(n) && !/__MACOSX/.test(n));
        if (!shpKey) throw new Error('Hittade ingen .shp-fil i zippen');
        const base = shpKey.replace(/\.shp$/i, '');
        const prjKey = names.find((n) => n.toLowerCase() === `${base.toLowerCase()}.prj`)
          || names.find((n) => /\.prj$/i.test(n));
        shpBytes = entries[shpKey];
        if (prjKey) prjText = new TextDecoder().decode(entries[prjKey]);
        shpName = shpKey.split('/').pop();
      } else if (lower.endsWith('.shp')) {
        shpBytes = buf;
      } else {
        throw new Error(`Filändelse ${lower.slice(-4)} stöds inte – välj .zip eller .shp`);
      }

      const parsed = readShp(shpBytes);
      if (!parsed.records.length) throw new Error('Filen innehåller inga geometrier');
      let srs = detectSrsFromPrj(prjText);
      let srsSource = srs ? '.prj' : null;
      if (!srs) { srs = detectSrsFromCoords(parsed.records); srsSource = srs ? 'koordinatstorlek' : null; }
      if (!srs) throw new Error('Kunde inte detektera koordinatsystem – inkludera en .prj-fil');

      const mapProj = map.getView().getProjection().getCode();
      // Verifiera att projektionen är registrerad (proj4) – annars throw med tydligt fel
      if (srs !== mapProj && !Origo.ol.proj.get(srs)) {
        throw new Error(`${srs} är inte registrerad i kartan – konvertera filen till EPSG:3006, 4326 eller 3857 först`);
      }

      ensureDrawLayer();
      if (drawInteraction) { map.removeInteraction(drawInteraction); drawInteraction = null; }
      removeModifyInteraction();
      drawSource.clear();
      Object.keys(shapeButtons).forEach((s) => shapeButtons[s].classList.remove('is-active'));

      const feature = shpRecordsToPolygonFeature(parsed.records, srs, mapProj);
      drawSource.addFeature(feature);
      drawnFeature = feature;

      // Zooma till området
      try {
        const ext = feature.getGeometry().getExtent();
        map.getView().fit(ext, { padding: [40, 40, 40, 40], duration: 300 });
      } catch (e) { /* ignore */ }

      ensureModifyInteraction();
      updateDownloadEnabled();
      setStatus(`Importerad: ${shpName} (${srs}, via ${srsSource}). Dra i punkter för att justera.`);
    }

    // ---------- download orchestration ----------
    function progressRow(name) {
      const row = document.createElement('div');
      row.className = 'o-dxp-progress-row';
      row.innerHTML = `<span class="o-dxp-progress-name"></span><span class="o-dxp-progress-state running">…</span>`;
      row.querySelector('.o-dxp-progress-name').textContent = name;
      progressEl.appendChild(row);
      return row;
    }
    function setProgressState(row, text, kind) {
      const st = row.querySelector('.o-dxp-progress-state');
      st.textContent = text;
      st.classList.remove('running', 'ok', 'err');
      st.classList.add(kind);
    }

    async function fetchLayerFeatures(entry, drawnGeomMap, mapProj) {
      const layer = entry.layer;
      const t = entry.type;
      // GeoJSON: hela filen är redan inläst klientsidan, snabbast att filtrera lokalt.
      if (t === 'GEOJSON') {
        try {
          const olFeats = await ensureVectorLoaded(layer, viewer);
          const drawnPolyList = getPolygonList(drawnGeomMap);
          const filtered = olFeats.filter((f) => featureMatchesAny(f, drawnPolyList, activeMode));
          return filtered.map((f) => olFeatureToGeoJsonLike(f, mapProj, targetSrs)).filter(Boolean);
        } catch (e) {
          throw new Error(`Lokala features: ${e.message}`);
        }
      }
      // WFS / WMS – server-side WFS GetFeature (BBOX)
      if (t === 'WMS' || t === 'WFS') {
        try {
          const r = await tryWfs(viewer, layer, drawnGeomMap, mapProj);
          // Servern returnerade EPSG:3006. Filtrera lokalt mot drawnGeomMap (3857-baserad).
          const drawn3006 = transformGeom(drawnGeomMap, mapProj, targetSrs);
          const drawnPolyList = getPolygonList(drawn3006);
          const out = [];
          r.features.forEach((gf) => {
            const obj = geoJsonFeatureToInternal(gf);
            if (!obj) return;
            // Bygg en temp OL-feature i 3006 för att kunna återanvända featureMatches.
            const { Feature } = Origo.ol;
            const Geom = ({
              Point: Origo.ol.geom.Point,
              MultiPoint: Origo.ol.geom.MultiPoint,
              LineString: Origo.ol.geom.LineString,
              MultiLineString: Origo.ol.geom.MultiLineString,
              Polygon: Origo.ol.geom.Polygon,
              MultiPolygon: Origo.ol.geom.MultiPolygon
            })[obj._geomType];
            if (!Geom) return;
            const tmp = new Feature({ geometry: new Geom(obj._geomCoords) });
            if (featureMatchesAny(tmp, drawnPolyList, activeMode)) out.push(obj);
          });
          return out;
        } catch (e) {
          throw new Error(`WFS-fallback misslyckades: ${e.message}`);
        }
      }
      // ArcGIS MapServer / FeatureServer
      if (t === 'AGS_TILE' || t === 'AGS_MAP' || t === 'AGS_FEATURE') {
        try {
          const r = await tryArcGis(viewer, layer, drawnGeomMap, mapProj);
          const drawn3006 = transformGeom(drawnGeomMap, mapProj, targetSrs);
          const drawnPolyList = getPolygonList(drawn3006);
          const out = [];
          r.features.forEach((gf) => {
            const obj = geoJsonFeatureToInternal(gf);
            if (!obj) return;
            const { Feature } = Origo.ol;
            const Geom = ({
              Point: Origo.ol.geom.Point,
              MultiPoint: Origo.ol.geom.MultiPoint,
              LineString: Origo.ol.geom.LineString,
              MultiLineString: Origo.ol.geom.MultiLineString,
              Polygon: Origo.ol.geom.Polygon,
              MultiPolygon: Origo.ol.geom.MultiPolygon
            })[obj._geomType];
            if (!Geom) return;
            const tmp = new Feature({ geometry: new Geom(obj._geomCoords) });
            if (featureMatchesAny(tmp, drawnPolyList, activeMode)) out.push(obj);
          });
          return out;
        } catch (e) {
          throw new Error(`ArcGIS-fråga misslyckades: ${e.message}`);
        }
      }
      throw new Error(`Lagertyp ${t} stöds inte.`);
    }

    async function startDownload() {
      if (!drawnFeature) return;
      const selectedEntries = listedLayers.filter((e) => e.selected && e.exportable);
      if (!selectedEntries.length) { setStatus('Inga exporterbara lager valda.', true); return; }

      downloadBtn.disabled = true;
      clearBtn.disabled = true;
      setStatus('Hämtar och bearbetar…');
      progressEl.innerHTML = '';

      // Drawn geometry som Polygon i mapProj
      const mapProj = map.getView().getProjection().getCode();
      let drawnPoly = drawnFeature.getGeometry().clone();
      if (drawnPoly.getType() === 'Circle') {
        const fromCircle = (Origo.ol.geom.Polygon && Origo.ol.geom.Polygon.fromCircle)
          || Origo.ol.geom.fromCircle;
        drawnPoly = fromCircle(drawnPoly, 64, 0);
      }
      const dpType = drawnPoly.getType();
      if (dpType !== 'Polygon' && dpType !== 'MultiPolygon') {
        setStatus('Det ritade objektet är inte en yta.', true);
        downloadBtn.disabled = false;
        clearBtn.disabled = false;
        return;
      }

      const files = [];
      let totalFeatures = 0;
      // PRJ + CPG (delade)
      const prjText = PRJ[targetSrs] || PRJ['EPSG:3006'];

      for (const entry of selectedEntries) {
        const row = progressRow(entry.layer.get('title') || entry.layer.get('name'));
        try {
          const feats = await fetchLayerFeatures(entry, drawnPoly, mapProj);
          if (!feats.length) {
            setProgressState(row, '0 objekt', 'ok');
            continue;
          }
          const groups = groupByShapeType(feats);
          const attrSpec = entry.layer.get('attributes') || null;
          const baseName = safeFileName(entry.layer.get('name') || entry.layer.get('title') || 'layer');
          let added = 0;
          const writeGroup = (gFeats, suffix) => {
            if (!gFeats.length) return;
            const out = shapefileBytesForGroup(gFeats, attrSpec);
            if (!out) return;
            const fname = suffix ? `${baseName}_${suffix}` : baseName;
            files.push({ name: `${fname}.shp`, data: out.shp });
            files.push({ name: `${fname}.shx`, data: out.shx });
            files.push({ name: `${fname}.dbf`, data: out.dbf });
            files.push({ name: `${fname}.prj`, data: new TextEncoder().encode(prjText) });
            files.push({ name: `${fname}.cpg`, data: new TextEncoder().encode('UTF-8') });
            added += gFeats.length;
          };
          // Avgör suffix: om bara en typ har features behövs ingen suffix
          const counts = {
            point: groups.point.length,
            line: groups.line.length,
            polygon: groups.polygon.length,
            multipoint: groups.multipoint.length
          };
          const used = Object.values(counts).filter((c) => c > 0).length;
          if (used <= 1) {
            // En fil
            writeGroup(groups.point, '');
            writeGroup(groups.multipoint, '');
            writeGroup(groups.line, '');
            writeGroup(groups.polygon, '');
          } else {
            writeGroup(groups.point, 'point');
            writeGroup(groups.multipoint, 'multipoint');
            writeGroup(groups.line, 'line');
            writeGroup(groups.polygon, 'polygon');
          }
          totalFeatures += added;
          setProgressState(row, `${added} objekt`, 'ok');
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[data-export] Lager-fel:', entry.layer.get('name'), err);
          setProgressState(row, err.message || 'fel', 'err');
        }
      }

      if (!files.length) {
        setStatus('Inga features matchade urvalsområdet.', true);
        downloadBtn.disabled = false;
        clearBtn.disabled = false;
        return;
      }

      setStatus(`Bygger zip (${totalFeatures} objekt totalt)…`);
      try {
        const blob = await buildZip(files);
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `geodata_${stamp}.zip`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 5000);
        setStatus(`Klar – ${totalFeatures} objekt nerladdat.`);
      } catch (err) {
        setStatus(`Zip-fel: ${err.message}`, true);
      }
      downloadBtn.disabled = false;
      clearBtn.disabled = false;
    }

    // ---------- open/close ----------
    function activate() {
      if (active) return;
      active = true;
      ensureDrawLayer();
      drawLayer.setVisible(true);
      showPanel();
      button.setState('active');
    }

    function deactivate() {
      if (!active) return;
      active = false;
      if (drawInteraction) { map.removeInteraction(drawInteraction); drawInteraction = null; }
      removeModifyInteraction();
      drawSource && drawSource.clear();
      drawnFeature = null;
      if (fileInput) fileInput.value = '';
      if (drawLayer) drawLayer.setVisible(false);
      hidePanel();
      button.setState('initial');
    }

    function toggle() { if (active) deactivate(); else activate(); }

    return Origo.ui.Component({
      name: 'dataExport',

      onInit() {
        button = Origo.ui.Button({
          cls,
          click: toggle,
          icon,
          tooltipText,
          tooltipPlacement
        });
      },

      onAdd(evt) {
        viewer = evt.target;
        map = viewer.getMap();
        if (!target) target = `${viewer.getMain().getNavigation().getId()}`;

        // Lyssna på lagrens visibilitet så panelens listning hålls aktuell.
        viewer.getLayers().forEach((l) => {
          l.on('change:visible', () => {
            if (active) refreshLayerList();
          });
        });

        this.addComponents([button]);
        this.render();
      },

      render() {
        const el = Origo.ui.dom.html(button.render());
        document.getElementById(target).appendChild(el);
        this.dispatch('render');
      }
    });
  }

  root.DataExport = DataExport;
}(window));
