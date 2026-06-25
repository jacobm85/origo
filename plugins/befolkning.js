/*!
 * befolkning — Origo-plugin "Befolkningstäthet".
 *
 * Knapp i höger verktygsmeny öppnar en panel. Användaren ritar ett område
 * (polygon/rektangel/cirkel) eller laddar upp en yta (GeoJSON/KML/KMZ/GPX eller
 * shapefile). Pluginet visar SCB:s rutstatistik "Totalbefolkning 1 km" som ett
 * färgat rutnät och räknar – via backend-tjänsten – ut total befolkning i
 * området genom att summera rutorna och vikta varje ruta efter hur stor andel
 * av rutan området täcker. Summan delas med arean och redovisas som pers/km².
 *
 * Datan laddas ner och lagras lokalt på servern (alltid senaste året). En
 * "Kolla efter nytt data"-knapp triggar en kontroll/uppdatering på begäran.
 *
 * Bundlad som en IIFE. Exponerar globalen `Befolkning(options)`. Kräver att
 * `origo.js` laddats först.
 */
(function (root) {
  if (typeof Origo === 'undefined') {
    // eslint-disable-next-line no-console
    console.error('[befolkning] Origo-globalen saknas – ladda origo.js före detta skript.');
    return;
  }

  // ============================================================
  // ZIP-reader (KMZ + shapefile-zip)
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
  // SHP-reader (Polygon / MultiPolygon)
  // ============================================================
  function ringSignedArea2D(ring) {
    let a = 0;
    for (let i = 0, n = ring.length; i < n; i += 1) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[(i + 1) % n];
      a += (x2 - x1) * (y2 + y1);
    }
    return a;
  }

  function readShp(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (dv.getInt32(0, false) !== 9994) throw new Error('Ogiltig shapefile (file code != 9994)');
    const shapeType = dv.getInt32(32, true);
    const isPolygon = shapeType === 5 || shapeType === 15 || shapeType === 25;
    if (!isPolygon) throw new Error(`Shapefilen är inte polygon (typ ${shapeType}) – ladda upp en yta`);
    const records = [];
    let p = 100;
    while (p + 8 <= buf.length) {
      const contentLength = dv.getInt32(p + 4, false) * 2;
      const recStart = p + 8;
      const recType = dv.getInt32(recStart, true);
      if (recType !== 0) {
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
        records.push({ rings });
      }
      p = recStart + contentLength;
    }
    return records;
  }

  function detectSrsFromPrj(text) {
    if (!text) return null;
    const t = text.toUpperCase();
    const m = t.match(/AUTHORITY\s*\[\s*"EPSG"\s*,\s*"?(\d+)"?\s*\]/);
    if (m) return `EPSG:${m[1]}`;
    if (t.includes('SWEREF99_TM') || t.includes('SWEREF 99 TM') || t.includes('SWEREF99 TM')) return 'EPSG:3006';
    if (t.includes('WEB_MERCATOR') || t.includes('PSEUDO-MERCATOR') || t.includes('PSEUDO_MERCATOR')) return 'EPSG:3857';
    if (t.includes('WGS_1984') || t.includes('WGS 84') || t.includes('WGS84')) return 'EPSG:4326';
    return null;
  }

  function detectSrsFromCoords(records) {
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
    records.forEach((r) => r.rings.forEach((ring) => ring.forEach((c) => {
      if (c[0] < minX) minX = c[0];
      if (c[0] > maxX) maxX = c[0];
      if (c[1] < minY) minY = c[1];
      if (c[1] > maxY) maxY = c[1];
    })));
    if (!Number.isFinite(minX)) return null;
    if (Math.abs(minX) <= 180 && Math.abs(maxX) <= 180 && Math.abs(minY) <= 90 && Math.abs(maxY) <= 90) return 'EPSG:4326';
    if (minX > 100000 && maxX < 1000000 && minY > 6000000 && maxY < 7800000) return 'EPSG:3006';
    if (Math.abs(maxX) > 100000 && Math.abs(minX) < 21000000 && Math.abs(maxY) < 21000000) return 'EPSG:3857';
    return null;
  }

  function shpRecordsToPolygonFeature(records, srcSrs, mapProj) {
    const { Feature } = Origo.ol;
    const { Polygon, MultiPolygon } = Origo.ol.geom;
    const allPolys = [];
    records.forEach((rec) => {
      let current = null;
      rec.rings.forEach((ring) => {
        const area = ringSignedArea2D(ring);
        if (area >= 0 || !current) { current = [ring]; allPolys.push(current); } else { current.push(ring); }
      });
    });
    if (!allPolys.length) throw new Error('Hittade inga polygoner i shapefilen');
    const geom = allPolys.length === 1 ? new Polygon(allPolys[0]) : new MultiPolygon(allPolys);
    if (srcSrs && srcSrs !== mapProj) {
      if (!Origo.ol.proj.get(srcSrs)) {
        throw new Error(`${srcSrs} är inte registrerad – konvertera filen till EPSG:3006/4326/3857 först`);
      }
      geom.transform(srcSrs, mapProj);
    }
    return new Feature({ geometry: geom });
  }

  // ============================================================
  // Plugin
  // ============================================================
  function Befolkning(options = {}) {
    const {
      base = '/proxy/befolkning',
      icon = '#befolkning-people',
      tooltipText = 'Befolkningstäthet',
      tooltipPlacement = 'east',
      gridOpacity = 0.6
    } = options;

    const gridUrl = `${base}/grid`;
    const calcUrl = `${base}/calc`;
    const statusUrl = `${base}/status`;
    const healthUrl = `${base}/health`;
    const refreshUrl = `${base}/refresh`;

    const cls = 'o-befolkning padding-small icon-smaller round light box-shadow';
    let button;
    let viewer;
    let map;
    let target;
    let active = false;

    let panelEl;
    let statusEl;
    let resultEl;
    let dataInfoEl;
    let legendEl;
    let gridToggle;
    let shapeButtons = {};
    let fileInput;

    let drawSource;
    let drawLayer;
    let drawInteraction = null;
    let modifyInteraction = null;
    let drawnFeature = null;

    let gridSource;
    let gridLayer;
    let gridMoveHandler = null;
    let gridDebounce;

    function mapProjCode() { return map.getView().getProjection().getCode(); }

    // ---------- grid layer (SCB 1 km, bbox-laddat) ----------
    function ensureGridLayer() {
      if (gridLayer) return;
      const { source: olSource, layer: olLayer, style: olStyle } = Origo.ol;
      gridSource = new olSource.Vector();
      gridLayer = new olLayer.Vector({
        source: gridSource,
        opacity: gridOpacity,
        visible: false,
        style: (feature) => {
          const c = feature.get('color') || '#888';
          return new olStyle.Style({
            fill: new olStyle.Fill({ color: hexToRgba(c, 0.65) }),
            stroke: new olStyle.Stroke({ color: hexToRgba(c, 0.9), width: 0.5 })
          });
        },
        properties: { name: 'befolkning-grid', title: 'Befolkning 1 km (SCB)', queryable: false, group: 'none' }
      });
      gridLayer.setZIndex(2000);
      map.addLayer(gridLayer);
    }

    function hexToRgba(hex, alpha) {
      const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
      if (!m) return `rgba(150,150,150,${alpha})`;
      return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
    }

    async function loadGridForView() {
      if (!gridSource || !gridLayer.getVisible()) return;
      const view = map.getView();
      const ext = view.calculateExtent(map.getSize());
      // Kartans projektion är SWEREF 99 TM (EPSG:3006); rutnätet ligger i 3006.
      const proj = mapProjCode();
      let e = ext;
      if (proj !== 'EPSG:3006') e = Origo.ol.proj.transformExtent(ext, proj, 'EPSG:3006');
      const bbox = `${e[0]},${e[1]},${e[2]},${e[3]}`;
      try {
        const res = await fetch(`${gridUrl}?bbox=${encodeURIComponent(bbox)}`, { headers: { Accept: 'application/json' } });
        if (!res.ok) { setGridNote('Kunde inte hämta rutnätet.'); return; }
        const fc = await res.json();
        if (fc.tooMany) { gridSource.clear(); setGridNote('Zooma in för att visa rutnätet.'); return; }
        const srcCrs = fc.gridCrs || 'EPSG:3006';
        const { Polygon } = Origo.ol.geom;
        const Feature = Origo.ol.Feature;
        const mp = view.getProjection();
        const feats = [];
        (fc.features || []).forEach((f) => {
          const g = f.geometry;
          if (!g || g.type !== 'Polygon') return;
          const geom = new Polygon(g.coordinates);
          geom.transform(srcCrs, mp);
          const feat = new Feature({ geometry: geom });
          const p = f.properties || {};
          feat.set('color', p.color);
          feat.set('beftotalt', p.beftotalt);
          feat.set('label', p.label);
          feats.push(feat);
        });
        gridSource.clear();
        gridSource.addFeatures(feats);
        setGridNote(feats.length ? '' : 'Inga befolkade rutor i vyn.');
      } catch (err) {
        setGridNote(`Fel: ${err.message}`);
      }
    }

    function setGridNote(text) {
      const el = panelEl && panelEl.querySelector('.o-bef-gridnote');
      if (el) el.textContent = text || '';
    }

    function attachGridHandler() {
      if (gridMoveHandler) return;
      gridMoveHandler = () => {
        clearTimeout(gridDebounce);
        gridDebounce = setTimeout(loadGridForView, 250);
      };
      map.on('moveend', gridMoveHandler);
    }

    function setGridVisible(on) {
      ensureGridLayer();
      gridLayer.setVisible(on);
      if (on) { attachGridHandler(); loadGridForView(); } else { setGridNote(''); }
    }

    // ---------- panel ----------
    function buildPanel() {
      const el = document.createElement('div');
      el.className = 'o-bef-panel';
      el.innerHTML = `
        <div class="o-bef-header">
          <h3>Befolkningstäthet</h3>
          <button type="button" class="o-bef-close" title="Stäng">&times;</button>
        </div>
        <div class="o-bef-body">
          <div class="o-bef-section">
            <label class="o-bef-gridtoggle">
              <input type="checkbox" class="o-bef-grid-cb"> Visa rutnät (SCB 1 km)
            </label>
            <div class="o-bef-legend"></div>
            <div class="o-bef-gridnote"></div>
            <div class="o-bef-datainfo"></div>
            <button type="button" class="o-bef-checkdata">Kolla efter nytt data</button>
          </div>
          <div class="o-bef-section">
            <div class="o-bef-section-title">Välj område</div>
            <div class="o-bef-shape-buttons">
              <button type="button" data-shape="Polygon">Polygon</button>
              <button type="button" data-shape="Box">Rektangel</button>
              <button type="button" data-shape="Circle">Cirkel</button>
            </div>
            <div class="o-bef-upload">
              <button type="button" class="o-bef-upload-btn">… eller ladda upp fil</button>
              <input type="file" class="o-bef-file" accept=".geojson,.json,.kml,.kmz,.gpx,.zip,.shp" hidden>
              <div class="o-bef-upload-hint">
                GeoJSON, KML, KMZ, GPX eller shapefil (<code>.zip</code>/<code>.shp</code>) med en yta.
              </div>
            </div>
            <button type="button" class="o-bef-clear">Rensa</button>
          </div>
          <div class="o-bef-result"></div>
          <div class="o-bef-status"></div>
        </div>
      `;
      el.querySelector('.o-bef-close').addEventListener('click', deactivate);
      statusEl = el.querySelector('.o-bef-status');
      resultEl = el.querySelector('.o-bef-result');
      dataInfoEl = el.querySelector('.o-bef-datainfo');
      legendEl = el.querySelector('.o-bef-legend');
      gridToggle = el.querySelector('.o-bef-grid-cb');
      gridToggle.addEventListener('change', () => setGridVisible(gridToggle.checked));
      el.querySelector('.o-bef-checkdata').addEventListener('click', checkForNewData);
      el.querySelector('.o-bef-clear').addEventListener('click', clearDrawing);

      el.querySelectorAll('.o-bef-shape-buttons button').forEach((b) => {
        shapeButtons[b.dataset.shape] = b;
        b.addEventListener('click', () => setActiveShape(b.dataset.shape));
      });
      fileInput = el.querySelector('.o-bef-file');
      el.querySelector('.o-bef-upload-btn').addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', onFilePicked);

      if (root.PanelDrag) root.PanelDrag.makeDraggable(el, el.querySelector('.o-bef-header'));
      panelEl = el;
      return el;
    }

    function renderLegend(items) {
      if (!legendEl) return;
      if (!items || !items.length) { legendEl.innerHTML = ''; return; }
      legendEl.innerHTML = '<div class="o-bef-legend-title">Invånare per ruta</div>'
        + items.map((it) => `<span><i style="background:${it.color}"></i>${it.label}</span>`).join('');
    }

    function setStatus(text, isError) {
      if (!statusEl) return;
      statusEl.textContent = text || '';
      statusEl.classList.toggle('is-error', !!isError);
    }

    function setDataInfo(st) {
      if (!dataInfoEl) return;
      if (!st || !st.year) { dataInfoEl.textContent = 'Befolkningsdata laddas …'; return; }
      const cnt = (st.count || 0).toLocaleString('sv-SE');
      let txt = `SCB ${st.year} · ${cnt} rutor`;
      if (st.latestYear && !st.upToDate) txt += ` · nyare finns (${st.latestYear})`;
      else if (st.upToDate) txt += ' · senaste';
      dataInfoEl.textContent = txt;
    }

    function showPanel() {
      if (!panelEl) buildPanel();
      const host = document.getElementById(viewer.getId()) || document.body;
      if (!panelEl.isConnected) host.appendChild(panelEl);
      refreshDataInfo();
    }

    function hidePanel() {
      if (panelEl && panelEl.parentNode) panelEl.parentNode.removeChild(panelEl);
    }

    async function refreshDataInfo() {
      try {
        const res = await fetch(healthUrl, { headers: { Accept: 'application/json' } });
        const st = await res.json();
        setDataInfo(st);
        renderLegend(st.legend);
      } catch (e) { /* tyst */ }
    }

    // ---------- "kolla efter nytt data" ----------
    async function checkForNewData() {
      setStatus('Kontrollerar SCB efter nytt data …');
      let st;
      try {
        st = await (await fetch(statusUrl, { headers: { Accept: 'application/json' } })).json();
      } catch (e) {
        setStatus(`Kunde inte nå tjänsten: ${e.message}`, true);
        return;
      }
      setDataInfo(st);
      if (st.upToDate) {
        setStatus(`Redan senaste året (${st.year}).`);
        return;
      }
      setStatus(`Hämtar ${st.latestYear || 'nytt'} från SCB …`);
      try {
        await fetch(refreshUrl, { method: 'POST', headers: { Accept: 'application/json' } });
      } catch (e) {
        setStatus(`Kunde inte starta hämtning: ${e.message}`, true);
        return;
      }
      // Polla health tills året ändras / bygget är klart (max ~3 min).
      const before = st.year;
      const deadline = Date.now() + 180000;
      const tick = async () => {
        let h;
        try { h = await (await fetch(healthUrl, { headers: { Accept: 'application/json' } })).json(); } catch (e) { h = null; }
        if (h && !h.building && h.year && h.year !== before) {
          setDataInfo(h);
          renderLegend(h.legend);
          if (gridLayer && gridLayer.getVisible()) loadGridForView();
          setStatus(`Uppdaterat till ${h.year}.`);
          return;
        }
        if (h && h.lastError && !h.building) { setStatus(`Misslyckades: ${h.lastError}`, true); return; }
        if (Date.now() > deadline) { setStatus('Tar längre tid än väntat – prova igen strax.'); return; }
        setTimeout(tick, 4000);
      };
      setTimeout(tick, 4000);
    }

    // ---------- drawing ----------
    function ensureDrawLayer() {
      if (drawLayer) return;
      const { Style, Stroke, Fill } = Origo.ol.style;
      drawSource = new Origo.ol.source.Vector();
      drawLayer = new Origo.ol.layer.Vector({
        source: drawSource,
        style: new Style({
          stroke: new Stroke({ color: 'rgba(20,90,200,1)', width: 2 }),
          fill: new Fill({ color: 'rgba(20,90,200,0.08)' })
        }),
        properties: { name: 'befolkning-draw', queryable: false, group: 'none' }
      });
      drawLayer.setZIndex(9000);
      map.addLayer(drawLayer);
    }

    function ensureModifyInteraction() {
      if (modifyInteraction || !drawSource) return;
      modifyInteraction = new Origo.ol.interaction.Modify({ source: drawSource });
      modifyInteraction.on('modifyend', () => runCalc());
      map.addInteraction(modifyInteraction);
    }

    function removeModifyInteraction() {
      if (modifyInteraction) { map.removeInteraction(modifyInteraction); modifyInteraction = null; }
    }

    function setActiveShape(shape) {
      ensureDrawLayer();
      Object.keys(shapeButtons).forEach((s) => shapeButtons[s].classList.toggle('is-active', s === shape));
      if (drawInteraction) { map.removeInteraction(drawInteraction); drawInteraction = null; }
      removeModifyInteraction();
      const Draw = Origo.ol.interaction.Draw;
      const createBox = Origo.ol.interaction.createBox || (Draw && Draw.createBox);
      const opts = { source: drawSource };
      if (shape === 'Polygon') opts.type = 'Polygon';
      else if (shape === 'Box') { opts.type = 'Circle'; if (typeof createBox === 'function') opts.geometryFunction = createBox(); } else if (shape === 'Circle') opts.type = 'Circle';
      drawInteraction = new Draw(opts);
      drawInteraction.on('drawstart', () => { drawSource.clear(); drawnFeature = null; });
      drawInteraction.on('drawend', (e) => {
        drawnFeature = e.feature;
        setTimeout(() => {
          if (drawInteraction) { map.removeInteraction(drawInteraction); drawInteraction = null; }
          Object.keys(shapeButtons).forEach((s) => shapeButtons[s].classList.remove('is-active'));
          ensureModifyInteraction();
          runCalc();
        }, 0);
      });
      map.addInteraction(drawInteraction);
      setStatus('Klicka på kartan för att rita.');
    }

    function clearDrawing() {
      if (drawInteraction) { map.removeInteraction(drawInteraction); drawInteraction = null; }
      removeModifyInteraction();
      if (drawSource) drawSource.clear();
      drawnFeature = null;
      Object.keys(shapeButtons).forEach((s) => shapeButtons[s].classList.remove('is-active'));
      if (fileInput) fileInput.value = '';
      if (resultEl) resultEl.innerHTML = '';
      setStatus('');
    }

    // ---------- file upload ----------
    async function onFilePicked(ev) {
      const file = ev.target.files && ev.target.files[0];
      if (!file) return;
      try {
        await importAreaFile(file);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[befolkning] import:', err);
        setStatus(`Import misslyckades: ${err.message}`, true);
      }
      ev.target.value = '';
    }

    async function importAreaFile(file) {
      setStatus(`Läser ${file.name} …`);
      const lower = (file.name || '').toLowerCase();
      const mp = mapProjCode();
      ensureDrawLayer();
      if (drawInteraction) { map.removeInteraction(drawInteraction); drawInteraction = null; }
      removeModifyInteraction();
      drawSource.clear();
      Object.keys(shapeButtons).forEach((s) => shapeButtons[s].classList.remove('is-active'));

      let feature = null;

      if (lower.endsWith('.zip') || lower.endsWith('.shp')) {
        feature = await readShapefileFeature(file, lower, mp);
      } else if (lower.endsWith('.kmz')) {
        const entries = await readZip(new Uint8Array(await file.arrayBuffer()));
        const kmlKey = Object.keys(entries).find((n) => /\.kml$/i.test(n));
        if (!kmlKey) throw new Error('Hittade ingen .kml i KMZ-filen');
        const text = new TextDecoder().decode(entries[kmlKey]);
        feature = featureFromOlFormat(text, 'KML', mp);
      } else if (lower.endsWith('.kml')) {
        feature = featureFromOlFormat(await file.text(), 'KML', mp);
      } else if (lower.endsWith('.gpx')) {
        feature = featureFromOlFormat(await file.text(), 'GPX', mp);
      } else if (lower.endsWith('.geojson') || lower.endsWith('.json')) {
        feature = featureFromOlFormat(await file.text(), 'GeoJSON', mp);
      } else {
        throw new Error('Filtypen stöds inte – välj GeoJSON, KML, KMZ, GPX eller shapefil');
      }

      if (!feature) throw new Error('Hittade ingen yta (Polygon) i filen');
      drawSource.addFeature(feature);
      drawnFeature = feature;
      try {
        map.getView().fit(feature.getGeometry().getExtent(), { padding: [40, 40, 40, 40], duration: 300 });
      } catch (e) { /* ignore */ }
      ensureModifyInteraction();
      setStatus(`Importerad: ${file.name}.`);
      runCalc();
    }

    // OL-format (KML/GPX/GeoJSON) → en (multi)polygon-feature i kartans proj.
    function featureFromOlFormat(text, fmt, mapProj) {
      const Format = Origo.ol.format[fmt];
      if (!Format) throw new Error(`Format ${fmt} saknas`);
      const reader = new Format();
      const opts = { featureProjection: mapProj };
      // KML/GPX är alltid 4326; GeoJSON läser ev. egen crs men defaultar 4326.
      const feats = reader.readFeatures(text, opts);
      const polys = feats.filter((f) => {
        const t = f.getGeometry() && f.getGeometry().getType();
        return t === 'Polygon' || t === 'MultiPolygon';
      });
      if (!polys.length) return null;
      if (polys.length === 1) return polys[0];
      // Slå ihop flera polygoner till en MultiPolygon.
      const { MultiPolygon } = Origo.ol.geom;
      const coords = [];
      polys.forEach((f) => {
        const g = f.getGeometry();
        if (g.getType() === 'Polygon') coords.push(g.getCoordinates());
        else g.getCoordinates().forEach((c) => coords.push(c));
      });
      return new Origo.ol.Feature({ geometry: new MultiPolygon(coords) });
    }

    async function readShapefileFeature(file, lower, mapProj) {
      const buf = new Uint8Array(await file.arrayBuffer());
      let shpBytes = null;
      let prjText = null;
      if (lower.endsWith('.zip')) {
        const entries = await readZip(buf);
        const names = Object.keys(entries);
        const shpKey = names.find((n) => /\.shp$/i.test(n) && !/__MACOSX/.test(n));
        if (!shpKey) throw new Error('Hittade ingen .shp-fil i zippen');
        const baseName = shpKey.replace(/\.shp$/i, '');
        const prjKey = names.find((n) => n.toLowerCase() === `${baseName.toLowerCase()}.prj`)
          || names.find((n) => /\.prj$/i.test(n));
        shpBytes = entries[shpKey];
        if (prjKey) prjText = new TextDecoder().decode(entries[prjKey]);
      } else {
        shpBytes = buf;
      }
      const records = readShp(shpBytes);
      if (!records.length) throw new Error('Filen innehåller inga geometrier');
      let srs = detectSrsFromPrj(prjText) || detectSrsFromCoords(records);
      if (!srs) throw new Error('Kunde inte detektera koordinatsystem – inkludera en .prj-fil');
      return shpRecordsToPolygonFeature(records, srs, mapProj);
    }

    // ---------- beräkning ----------
    function geometryToJson3006() {
      if (!drawnFeature) return null;
      let geom = drawnFeature.getGeometry().clone();
      if (geom.getType() === 'Circle') {
        const fromCircle = (Origo.ol.geom.Polygon && Origo.ol.geom.Polygon.fromCircle) || Origo.ol.geom.fromCircle;
        geom = fromCircle(geom, 96, 0);
      }
      const mp = mapProjCode();
      if (mp !== 'EPSG:3006') geom = geom.clone().transform(mp, 'EPSG:3006');
      const t = geom.getType();
      if (t !== 'Polygon' && t !== 'MultiPolygon') return null;
      return { type: t, coordinates: geom.getCoordinates() };
    }

    async function runCalc() {
      const geom = geometryToJson3006();
      if (!geom) { setStatus('Rita eller ladda upp en yta först.', true); return; }
      setStatus('Beräknar befolkning …');
      if (resultEl) resultEl.innerHTML = '';
      try {
        const res = await fetch(calcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(geom)
        });
        const data = await res.json();
        if (!res.ok) { setStatus(data.error || `HTTP ${res.status}`, true); return; }
        renderResult(data);
        setStatus('');
      } catch (err) {
        setStatus(`Kunde inte beräkna: ${err.message}`, true);
      }
    }

    function renderResult(d) {
      if (!resultEl) return;
      const nf = (n, dec) => Number(n).toLocaleString('sv-SE', { maximumFractionDigits: dec, minimumFractionDigits: dec });
      const pop = nf(d.population, 0);
      const area = nf(d.areaKm2, d.areaKm2 < 10 ? 2 : 1);
      const dens = d.densityPerKm2 != null ? nf(d.densityPerKm2, 1) : '–';
      resultEl.innerHTML = `
        <div class="o-bef-result-main">
          <div class="o-bef-result-pop"><span class="o-bef-num">${pop}</span><span class="o-bef-unit">invånare</span></div>
          <div class="o-bef-result-dens"><span class="o-bef-num">${dens}</span><span class="o-bef-unit">inv/km²</span></div>
        </div>
        <div class="o-bef-result-meta">
          Area ${area} km² · ${d.cellsTouched} rutor (${d.partialCells} delvis) · SCB ${d.year}
        </div>
        <div class="o-bef-result-note">Ytviktad summa: varje 1 km-ruta räknas i proportion till hur stor del av rutan som ligger inom området.</div>
      `;
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
      if (drawSource) drawSource.clear();
      drawnFeature = null;
      if (fileInput) fileInput.value = '';
      if (drawLayer) drawLayer.setVisible(false);
      if (gridLayer) { gridLayer.setVisible(false); }
      if (gridToggle) gridToggle.checked = false;
      hidePanel();
      button.setState('initial');
    }

    function toggle() { if (active) deactivate(); else activate(); }

    return Origo.ui.Component({
      name: 'befolkning',

      onInit() {
        button = Origo.ui.Button({ cls, click: toggle, icon, tooltipText, tooltipPlacement });
      },

      onAdd(evt) {
        viewer = evt.target;
        map = viewer.getMap();
        if (!target) target = `${viewer.getMain().getNavigation().getId()}`;
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

  root.Befolkning = Befolkning;
}(window));
