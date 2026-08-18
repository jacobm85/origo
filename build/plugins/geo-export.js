/*!
 * geo-export — delade exportskrivare för Origo-plugins.
 *
 * Ren-JS-skrivare (inga beroenden, ingen byggning) för att skapa nedladdnings-
 * filer i webbläsaren:
 *   - ZIP (STORED + DEFLATE via CompressionStream)
 *   - Punkt-shapefil (.shp/.shx/.dbf) + .prj/.cpg
 *   - CSV (UTF-8 med BOM, ; som avgränsare → öppnas direkt i svensk Excel)
 *   - KML / KMZ (WGS84) med metadata i ballongtext
 *
 * Exponerar globalen `GeoExport`. Används i första hand av stompunkt-pluginet
 * (data-export.js har sin egen, äldre kopia av zip/shapefil-koden och rörs ej).
 *
 * En "punkt" till shapefil/CSV/KML beskrivs som:
 *   { coord: [x, y], z: <höjd|null>, props: { kolumn: värde, … } }
 * där coord redan ligger i mål-koordinatsystemet (för KML alltid WGS84 [lon,lat]).
 */
(function (root) {
  // ============================================================
  // CRC-32 (IEEE 802.3)
  // ============================================================
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // ============================================================
  // ZIP-writer
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
    const time = ((dt.getHours() & 0x1F) << 11) | ((dt.getMinutes() & 0x3F) << 5)
      | ((Math.floor(dt.getSeconds() / 2)) & 0x1F);
    const date = (((dt.getFullYear() - 1980) & 0x7F) << 9) | (((dt.getMonth() + 1) & 0x0F) << 5)
      | (dt.getDate() & 0x1F);
    return { time, date };
  }
  // files: [{ name, data: Uint8Array }]
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
      if (deflated && deflated.length < usize) { comp = deflated; method = 8; }
      const csize = comp.length;
      const lfh = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(lfh.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(8, method, true);
      lv.setUint16(10, time, true);
      lv.setUint16(12, date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, csize, true);
      lv.setUint32(22, usize, true);
      lv.setUint16(26, nameBytes.length, true);
      lfh.set(nameBytes, 30);
      local.push(lfh, comp);
      const cdh = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cdh.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(10, method, true);
      cv.setUint16(12, time, true);
      cv.setUint16(14, date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, csize, true);
      cv.setUint32(24, usize, true);
      cv.setUint16(28, nameBytes.length, true);
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
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, cdOffset, true);
    const parts = local.concat(central, [eocd]);
    const total = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(total);
    let p = 0;
    for (const part of parts) { out.set(part, p); p += part.length; }
    return new Blob([out], { type: 'application/zip' });
  }

  // ============================================================
  // DBF (dBase III) – fältinferens + encoder (UTF-8 + .cpg)
  // ============================================================
  function asciiSlug(s) {
    return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
  }
  function uniqDbfFieldName(raw, used) {
    let base = asciiSlug(raw || 'F').slice(0, 10);
    if (!base) base = 'F';
    let n = base;
    let i = 2;
    while (used.has(n.toUpperCase())) {
      const suffix = String(i);
      n = base.slice(0, Math.max(1, 10 - suffix.length)) + suffix;
      i += 1;
    }
    used.add(n.toUpperCase());
    return n;
  }
  // rows: [{ kol: värde }]  (ordningen tas från första raden + alla nycklar)
  function inferDbfFields(rows, order) {
    const keys = order && order.length ? order.slice() : [];
    const seen = new Set(keys);
    rows.forEach((r) => Object.keys(r).forEach((k) => { if (!seen.has(k)) { seen.add(k); keys.push(k); } }));
    const used = new Set();
    return keys.map((key) => {
      let allNum = true;
      let hasVal = false;
      let maxStr = 1;
      let maxInt = 1;
      let maxDec = 0;
      rows.forEach((r) => {
        const v = r[key];
        if (v === undefined || v === null || v === '') return;
        hasVal = true;
        if (typeof v === 'number' && Number.isFinite(v)) {
          const s = String(v);
          const dot = s.indexOf('.');
          if (dot >= 0) { maxInt = Math.max(maxInt, dot); maxDec = Math.max(maxDec, s.length - dot - 1); }
          else maxInt = Math.max(maxInt, s.length);
        } else {
          allNum = false;
          maxStr = Math.max(maxStr, new TextEncoder().encode(String(v)).length);
        }
      });
      let type = 'C';
      let length = 1;
      let dec = 0;
      if (!hasVal) { type = 'C'; length = 1; }
      else if (allNum) {
        type = 'N';
        dec = Math.min(maxDec, 6);
        length = Math.min(19, maxInt + (dec > 0 ? 1 + dec : 0) + 1);
      } else { type = 'C'; length = Math.min(254, Math.max(1, maxStr)); }
      return { key, dbfName: uniqDbfFieldName(key, used), type, length, dec };
    });
  }
  function dbfEncodeValue(field, v, encoder) {
    const pad = (s, n, left) => (s.length >= n ? s.slice(0, n)
      : (left ? ' '.repeat(n - s.length) + s : s + ' '.repeat(n - s.length)));
    if (v === undefined || v === null || v === '') return new Uint8Array(field.length).fill(0x20);
    if (field.type === 'N') {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n)) return encoder.encode(pad('', field.length, true));
      let s = field.dec > 0 ? n.toFixed(field.dec) : String(Math.trunc(n));
      if (s.length > field.length) s = s.slice(0, field.length);
      return encoder.encode(pad(s, field.length, true));
    }
    let bytes = encoder.encode(String(v));
    if (bytes.length > field.length) bytes = bytes.slice(0, field.length);
    if (bytes.length < field.length) {
      const out = new Uint8Array(field.length);
      out.set(bytes);
      out.fill(0x20, bytes.length);
      return out;
    }
    return bytes;
  }
  function buildDbf(rows, fields) {
    const encoder = new TextEncoder();
    const headerSize = 32 + fields.length * 32 + 1;
    const recordSize = 1 + fields.reduce((s, f) => s + f.length, 0);
    const total = headerSize + rows.length * recordSize + 1;
    const buf = new Uint8Array(total);
    const dv = new DataView(buf.buffer);
    const now = new Date();
    buf[0] = 0x03;
    buf[1] = now.getFullYear() % 100;
    buf[2] = now.getMonth() + 1;
    buf[3] = now.getDate();
    dv.setUint32(4, rows.length, true);
    dv.setUint16(8, headerSize, true);
    dv.setUint16(10, recordSize, true);
    let p = 32;
    fields.forEach((f) => {
      const nb = new Uint8Array(11);
      nb.set(encoder.encode(f.dbfName).slice(0, 10));
      buf.set(nb, p);
      buf[p + 11] = f.type.charCodeAt(0);
      buf[p + 16] = f.length;
      buf[p + 17] = f.dec;
      p += 32;
    });
    buf[p] = 0x0D;
    p += 1;
    rows.forEach((r) => {
      buf[p] = 0x20;
      p += 1;
      fields.forEach((f) => { buf.set(dbfEncodeValue(f, r[f.key], encoder), p); p += f.length; });
    });
    buf[p] = 0x1A;
    return buf;
  }

  // ============================================================
  // Punkt-shapefil (.shp + .shx), shape-typ 1 (Point)
  // points: [{ coord: [x, y] }]
  // ============================================================
  function buildPointShpShx(points) {
    const recContent = (4 + 16) / 2;            // type + 2 doubles, i 16-bit ord
    const shpSize = 100 + points.length * (8 + recContent * 2);
    const shxSize = 100 + points.length * 8;
    const shp = new Uint8Array(shpSize);
    const shx = new Uint8Array(shxSize);
    const dvShp = new DataView(shp.buffer);
    const dvShx = new DataView(shx.buffer);
    const gb = [Infinity, Infinity, -Infinity, -Infinity];
    points.forEach((pt) => {
      const c = pt.coord;
      if (c[0] < gb[0]) gb[0] = c[0];
      if (c[1] < gb[1]) gb[1] = c[1];
      if (c[0] > gb[2]) gb[2] = c[0];
      if (c[1] > gb[3]) gb[3] = c[1];
    });
    if (!points.length) { gb[0] = gb[1] = gb[2] = gb[3] = 0; }
    const writeHeader = (dv, size16) => {
      dv.setInt32(0, 9994, false);
      dv.setInt32(24, size16, false);
      dv.setInt32(28, 1000, true);
      dv.setInt32(32, 1, true);
      dv.setFloat64(36, gb[0], true);
      dv.setFloat64(44, gb[1], true);
      dv.setFloat64(52, gb[2], true);
      dv.setFloat64(60, gb[3], true);
    };
    writeHeader(dvShp, shpSize / 2);
    writeHeader(dvShx, shxSize / 2);
    let off = 100;
    let shxOff = 100;
    points.forEach((pt, i) => {
      dvShp.setInt32(off, i + 1, false);
      dvShp.setInt32(off + 4, recContent, false);
      dvShp.setInt32(off + 8, 1, true);
      dvShp.setFloat64(off + 12, pt.coord[0], true);
      dvShp.setFloat64(off + 20, pt.coord[1], true);
      dvShx.setInt32(shxOff, off / 2, false);
      dvShx.setInt32(shxOff + 4, recContent, false);
      shxOff += 8;
      off += 8 + recContent * 2;
    });
    return { shp, shx };
  }

  // Bygg .shp/.shx/.dbf för en uppsättning punkter med attribut.
  // points: [{ coord:[x,y], props:{...} }]; fieldOrder: valfri kolumnordning.
  function buildPointShapefile(points, fieldOrder) {
    const { shp, shx } = buildPointShpShx(points);
    const rows = points.map((p) => p.props || {});
    const fields = inferDbfFields(rows, fieldOrder);
    const dbf = buildDbf(rows, fields);
    return { shp, shx, dbf };
  }

  // ============================================================
  // PRJ (ESRI WKT) för EPSG:3006/3007–3018/4326
  // ============================================================
  // SWEREF 99 lokala zoner: central meridian per EPSG-kod, false_easting 150000.
  const SWEREF_LOCAL = {
    3007: { lon: 12, name: '12_00' }, 3008: { lon: 13.5, name: '13_30' },
    3009: { lon: 15, name: '15_00' }, 3010: { lon: 16.5, name: '16_30' },
    3011: { lon: 18, name: '18_00' }, 3012: { lon: 14.25, name: '14_15' },
    3013: { lon: 15.75, name: '15_45' }, 3014: { lon: 17.25, name: '17_15' },
    3015: { lon: 18.75, name: '18_45' }, 3016: { lon: 20.25, name: '20_15' },
    3017: { lon: 21.75, name: '21_45' }, 3018: { lon: 23.25, name: '23_15' }
  };
  function swerefLocalWkt(lon, name) {
    return `PROJCS["SWEREF99_${name}",GEOGCS["GCS_SWEREF99",DATUM["D_SWEREF99",`
      + 'SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],'
      + 'UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],'
      + 'PARAMETER["False_Easting",150000.0],PARAMETER["False_Northing",0.0],'
      + `PARAMETER["Central_Meridian",${lon}],PARAMETER["Scale_Factor",1.0],`
      + 'PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]';
  }
  const PRJ = {
    'EPSG:3006': 'PROJCS["SWEREF99_TM",GEOGCS["GCS_SWEREF99",DATUM["D_SWEREF99",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",15.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]',
    'EPSG:4326': 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]'
  };
  Object.keys(SWEREF_LOCAL).forEach((code) => {
    PRJ[`EPSG:${code}`] = swerefLocalWkt(SWEREF_LOCAL[code].lon, SWEREF_LOCAL[code].name);
  });
  function prjFor(code) { return PRJ[code] || PRJ['EPSG:3006']; }

  // ============================================================
  // CSV (UTF-8 + BOM, ; avgränsare)
  // ============================================================
  function csvCell(v) {
    if (v === undefined || v === null) return '';
    let s = String(v);
    if (/[";\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
    return s;
  }
  // headers: [str]; rows: [{header: value}]
  function buildCsv(headers, rows) {
    const lines = [headers.map(csvCell).join(';')];
    rows.forEach((r) => lines.push(headers.map((h) => csvCell(r[h])).join(';')));
    const text = `﻿${lines.join('\r\n')}\r\n`;
    return new TextEncoder().encode(text);
  }

  // ============================================================
  // KML / KMZ (WGS84). placemarks: [{ name, lon, lat, alt, rows:[[k,v]] }]
  // ============================================================
  function kmlEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]
    ));
  }
  function buildKml(placemarks, docName) {
    const parts = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>',
      `<name>${kmlEsc(docName || 'Export')}</name>`];
    placemarks.forEach((pm) => {
      const tableRows = (pm.rows || []).filter((r) => r[1] != null && r[1] !== '')
        .map((r) => `<tr><th style="text-align:left;padding-right:8px;color:#666">${kmlEsc(r[0])}</th>`
          + `<td>${kmlEsc(r[1])}</td></tr>`).join('');
      const desc = `<![CDATA[<table>${tableRows}</table>]]>`;
      const z = (pm.alt != null && Number.isFinite(pm.alt)) ? ` ${pm.alt}` : ' 0';
      parts.push('<Placemark>',
        `<name>${kmlEsc(pm.name || '')}</name>`,
        `<description>${desc}</description>`,
        `<Point><coordinates>${pm.lon},${pm.lat}${z}</coordinates></Point>`,
        '</Placemark>');
    });
    parts.push('</Document></kml>');
    return new TextEncoder().encode(parts.join('\n'));
  }
  async function buildKmz(placemarks, docName) {
    const kml = buildKml(placemarks, docName);
    return buildZip([{ name: 'doc.kml', data: kml }]);
  }

  // ============================================================
  // Nedladdning
  // ============================================================
  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 5000);
  }

  root.GeoExport = {
    buildZip,
    buildPointShapefile,
    buildCsv,
    buildKml,
    buildKmz,
    prjFor,
    PRJ,
    download
  };
}(window));
