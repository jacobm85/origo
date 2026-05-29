/*!
 * ortofoto-download — Origo plugin.
 *
 * Knapp i höger verktygsmeny. Hämtar Lantmäteriets ortofoto-indexrutor (STAC-
 * bild) för den synliga kartvyn via backend-tjänsten, ritar rutorna färgade per
 * flygår, låter användaren bocka i vilka årtal som ska laddas ner och hämtar
 * motsvarande ortofoton (GeoTIFF) som en zip-ström.
 *
 * Ersätter QGIS-skripten "utbredningsområden" (skapar lager per år) och
 * "årtal_nedladdning" (laddar ner ortofotona för valt år). Backenden
 * (/api/ortofoto/) injicerar Lantmäteriets Basic Auth server-side.
 *
 * Bundlad som en enda IIFE (ingen byggning behövs). Exponerar globalen
 * `OrtofotoDownload(options)`. Kräver att `origo.js` laddats först.
 */
(function (root) {
  if (typeof Origo === 'undefined') {
    // eslint-disable-next-line no-console
    console.error('[ortofoto-download] Origo-globalen saknas – ladda origo.js före detta skript.');
    return;
  }

  // Distinkt färgpalett som årtalen mappas mot (cyklas vid behov).
  const PALETTE = [
    '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4',
    '#f032e6', '#bfef45', '#fabed4', '#469990', '#9a6324', '#800000',
    '#808000', '#000075', '#a9a9a9', '#ffe119'
  ];

  function formatBytes(bytes) {
    if (!bytes || bytes < 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let n = bytes;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
    let digits = 0;
    if (n < 10) digits = 2;
    else if (n < 100) digits = 1;
    return `${n.toFixed(digits)} ${units[i]}`;
  }

  function hexToRgba(hex, alpha) {
    const h = hex.replace('#', '');
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function deriveUrls(backendBase) {
    const base = backendBase.replace(/\/?$/, '/');
    return {
      searchUrl: `${base}search`,
      estimateUrl: `${base}estimate`,
      downloadUrl: `${base}download`
    };
  }

  function OrtofotoDownload(options = {}) {
    const {
      backendUrl = '/api/ortofoto',
      maxFiles = 100,
      maxBytes = 50 * 1024 * 1024 * 1024,
      icon = '#fa-picture-o',
      tooltipText = 'Ortofoto – nedladdning',
      tooltipPlacement = 'east',
      layerName = 'ortofoto-index',
      layerTitle = 'Ortofoto indexrutor',
      // Sök inte om kartvyn är bredare än så här (meter, kartans projektion).
      maxSearchSpanMeters = 60000
    } = options;

    const { searchUrl, estimateUrl, downloadUrl } = deriveUrls(backendUrl);
    const cls = 'o-ortofoto padding-small icon-smaller round light box-shadow';

    let viewer;
    let map;
    let target;
    let layer;
    let source;
    let ortofotoButton;

    let active = false;
    let searchTimer = null;
    let lastFeatures = [];          // slimmade features från senaste sökning
    const yearColors = new Map();   // år -> hexfärg
    const selectedYears = new Set();

    // --- panel ---
    let panelEl;
    let statusEl;
    let yearsEl;
    let countEl;
    let sizeEl;
    let warnEl;
    let downloadBtn;

    function colorForYear(year) {
      if (!yearColors.has(year)) {
        yearColors.set(year, PALETTE[yearColors.size % PALETTE.length]);
      }
      return yearColors.get(year);
    }

    // --- styles ---
    function styleFn(feature) {
      const { Style, Stroke, Fill } = Origo.ol.style;
      const year = feature.get('year');
      const color = colorForYear(year);
      const selected = selectedYears.has(year);
      return new Style({
        stroke: new Stroke({ color: hexToRgba(color, selected ? 1 : 0.7), width: selected ? 2 : 1 }),
        fill: new Fill({ color: hexToRgba(color, selected ? 0.28 : 0.05) })
      });
    }

    // --- sökning mot backend för aktuell vy ---
    function currentBboxWgs84() {
      const view = map.getView();
      const mapProj = view.getProjection();
      const extent = view.calculateExtent(map.getSize());
      const wgs = Origo.ol.proj.transformExtent(extent, mapProj, 'EPSG:4326');
      return { bbox: [wgs[0], wgs[1], wgs[2], wgs[3]], extent };
    }

    function viewTooWide() {
      const view = map.getView();
      const mapProj = view.getProjection();
      const extent = view.calculateExtent(map.getSize());
      // I metriska projektioner (3857/3006) är detta meter; annars grov uppskattning.
      const widthUnits = extent[2] - extent[0];
      const heightUnits = extent[3] - extent[1];
      const isMetric = mapProj.getUnits ? mapProj.getUnits() === 'm' : true;
      if (!isMetric) return false;
      return Math.max(widthUnits, heightUnits) > maxSearchSpanMeters;
    }

    function scheduleSearch() {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(runSearch, 350);
    }

    async function runSearch() {
      if (!active) return;
      if (viewTooWide()) {
        source.clear();
        lastFeatures = [];
        setStatus('Zooma in för att hämta indexrutor.');
        renderYears();
        renderCount();
        return;
      }
      const { bbox } = currentBboxWgs84();
      setStatus('Hämtar indexrutor…');
      try {
        const res = await fetch(searchUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bbox })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data && data.error ? data.error : `Backend svarade ${res.status}`);
        lastFeatures = data.features || [];
        drawFeatures(lastFeatures);
        // Behåll markerade år som fortfarande finns; markera inget nytt automatiskt.
        const present = new Set(lastFeatures.map((f) => f.year));
        Array.from(selectedYears).forEach((y) => { if (!present.has(y)) selectedYears.delete(y); });
        const truncated = data.truncated ? ' (max antal nått – zooma in för fler)' : '';
        setStatus(`${lastFeatures.length} rutor, ${(data.years || []).length} årtal${truncated}.`);
        renderYears();
        renderCount();
      } catch (err) {
        source.clear();
        lastFeatures = [];
        setStatus(`Kunde inte hämta: ${err.message}`);
        renderYears();
        renderCount();
      }
    }

    // Bygg OL-geometri direkt ur GeoJSON-koordinaterna (WGS84) och transformera
    // till kartans projektion. Undviker beroende på Origo.ol.format.
    function buildGeometry(geojson) {
      const { Polygon, MultiPolygon } = Origo.ol.geom;
      if (!geojson) return null;
      if (geojson.type === 'Polygon') return new Polygon(geojson.coordinates);
      if (geojson.type === 'MultiPolygon') return new MultiPolygon(geojson.coordinates);
      return null;
    }

    function drawFeatures(features) {
      source.clear();
      const mapProj = map.getView().getProjection();
      const olFeatures = [];
      features.forEach((f) => {
        if (!f.geometry || !f.dataHref) return;
        const geom = buildGeometry(f.geometry);
        if (!geom) return;
        geom.transform('EPSG:4326', mapProj);
        const feat = new Origo.ol.Feature({ geometry: geom });
        feat.set('year', f.year);
        feat.set('dataHref', f.dataHref);
        feat.set('dataSize', f.dataSize);
        feat.set('ortoId', f.id);
        olFeatures.push(feat);
      });
      source.addFeatures(olFeatures);
    }

    // --- urval / beräkning ---
    function selectedItems() {
      return lastFeatures.filter((f) => selectedYears.has(f.year) && f.dataHref);
    }

    function selectedSize() {
      return selectedItems().reduce((sum, f) => sum + (Number(f.dataSize) || 0), 0);
    }

    function yearCounts() {
      const counts = new Map();
      lastFeatures.forEach((f) => counts.set(f.year, (counts.get(f.year) || 0) + 1));
      return counts;
    }

    // --- panel rendering ---
    function setStatus(text) { if (statusEl) statusEl.textContent = text; }
    function showWarn(text) { if (warnEl) { warnEl.hidden = false; warnEl.textContent = text; } }
    function clearWarn() { if (warnEl) { warnEl.hidden = true; warnEl.textContent = ''; } }

    function renderYears() {
      if (!yearsEl) return;
      const counts = yearCounts();
      const years = Array.from(counts.keys()).filter((y) => y != null).sort((a, b) => b - a);
      yearsEl.innerHTML = '';
      if (years.length === 0) {
        yearsEl.innerHTML = '<p class="o-ortofoto-empty">Inga rutor i vyn.</p>';
        return;
      }
      years.forEach((year) => {
        const row = document.createElement('label');
        row.className = 'o-ortofoto-year';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = selectedYears.has(year);
        cb.addEventListener('change', () => {
          if (cb.checked) selectedYears.add(year); else selectedYears.delete(year);
          layer.changed();
          renderCount();
        });
        const swatch = document.createElement('span');
        swatch.className = 'o-ortofoto-swatch';
        swatch.style.background = colorForYear(year);
        const text = document.createElement('span');
        text.className = 'o-ortofoto-year-text';
        text.textContent = `${year} (${counts.get(year)} rutor)`;
        row.appendChild(cb);
        row.appendChild(swatch);
        row.appendChild(text);
        yearsEl.appendChild(row);
      });
    }

    function renderCount() {
      const items = selectedItems();
      const size = selectedSize();
      if (countEl) countEl.textContent = String(items.length);
      if (sizeEl) sizeEl.textContent = items.length ? `≈ ${formatBytes(size)}` : '—';
      const overCount = items.length > maxFiles;
      if (overCount) showWarn(`Mer än ${maxFiles} rutor markerade. Minska urvalet.`);
      else if (size > maxBytes) showWarn(`Totalstorlek överskrider ${formatBytes(maxBytes)}.`);
      else clearWarn();
      if (downloadBtn) {
        downloadBtn.disabled = items.length === 0 || overCount || size > maxBytes;
        downloadBtn.textContent = 'Ladda ner';
      }
    }

    function postFormDownload(items) {
      const iframeName = `o-ortofoto-dl-${Date.now()}`;
      const iframe = document.createElement('iframe');
      iframe.name = iframeName;
      iframe.style.display = 'none';
      document.body.appendChild(iframe);

      const form = document.createElement('form');
      form.method = 'POST';
      form.action = downloadUrl;
      form.enctype = 'application/x-www-form-urlencoded';
      form.target = iframeName;
      form.style.display = 'none';

      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'items';
      input.value = JSON.stringify(items);
      form.appendChild(input);

      document.body.appendChild(form);
      form.submit();

      setTimeout(() => {
        if (form.parentNode) form.parentNode.removeChild(form);
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      }, 1800000);
    }

    async function startDownload() {
      const items = selectedItems().map((f) => f.dataHref);
      if (items.length === 0) return;
      clearWarn();
      downloadBtn.disabled = true;
      downloadBtn.textContent = 'Validerar…';
      try {
        const res = await fetch(estimateUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items })
        });
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch (e) { data = { error: text }; }
        if (!res.ok) throw new Error(data && data.error ? data.error : `Backend svarade ${res.status}`);
        if (data.totalSize != null && sizeEl) sizeEl.textContent = formatBytes(Number(data.totalSize));
        downloadBtn.textContent = 'Hämtar zip…';
        postFormDownload(items);
        setTimeout(renderCount, 2000);
      } catch (err) {
        showWarn(`Kunde inte starta nedladdning: ${err.message}`);
        downloadBtn.disabled = false;
        downloadBtn.textContent = 'Ladda ner';
      }
    }

    function selectAllYears() {
      yearCounts().forEach((_, year) => { if (year != null) selectedYears.add(year); });
      renderYears();
      layer.changed();
      renderCount();
    }

    function clearSelection() {
      selectedYears.clear();
      renderYears();
      layer.changed();
      renderCount();
    }

    function buildPanel() {
      const el = document.createElement('div');
      el.className = 'o-ortofoto-panel';
      el.innerHTML = `
        <button class="o-ortofoto-close" type="button" title="Stäng">&times;</button>
        <h3 class="o-ortofoto-title">Ortofoto – nedladdning</h3>
        <p class="o-ortofoto-hint">
          Panorera/zooma till området. Bocka i de flygår du vill ha och ladda ner
          ortofotona (GeoTIFF) som en zip.
        </p>
        <p class="o-ortofoto-status">—</p>
        <div class="o-ortofoto-years"></div>
        <div class="o-ortofoto-row"><span>Valda rutor</span><span class="o-ortofoto-count">0</span></div>
        <div class="o-ortofoto-row"><span>Uppskattad storlek</span><span class="o-ortofoto-size">—</span></div>
        <div class="o-ortofoto-warn" hidden></div>
        <div class="o-ortofoto-actions">
          <button class="o-ortofoto-all" type="button">Alla år</button>
          <button class="o-ortofoto-clear" type="button">Rensa</button>
          <button class="o-ortofoto-download" type="button" disabled>Ladda ner</button>
        </div>
      `;
      statusEl = el.querySelector('.o-ortofoto-status');
      yearsEl = el.querySelector('.o-ortofoto-years');
      countEl = el.querySelector('.o-ortofoto-count');
      sizeEl = el.querySelector('.o-ortofoto-size');
      warnEl = el.querySelector('.o-ortofoto-warn');
      downloadBtn = el.querySelector('.o-ortofoto-download');
      el.querySelector('.o-ortofoto-close').addEventListener('click', close);
      el.querySelector('.o-ortofoto-all').addEventListener('click', selectAllYears);
      el.querySelector('.o-ortofoto-clear').addEventListener('click', clearSelection);
      downloadBtn.addEventListener('click', startDownload);
      panelEl = el;
      return el;
    }

    function showPanel() {
      if (!panelEl) buildPanel();
      const host = document.getElementById(viewer.getId()) || document.body;
      if (!panelEl.isConnected) host.appendChild(panelEl);
      renderYears();
      renderCount();
    }

    function hidePanel() {
      if (panelEl && panelEl.parentNode) panelEl.parentNode.removeChild(panelEl);
    }

    // --- open / close ---
    function open() {
      if (active) return;
      active = true;
      layer.setVisible(true);
      map.on('moveend', scheduleSearch);
      ortofotoButton.setState('active');
      showPanel();
      runSearch();
    }

    function close() {
      if (!active) return;
      active = false;
      map.un('moveend', scheduleSearch);
      if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
      source.clear();
      layer.setVisible(false);
      ortofotoButton.setState('initial');
      hidePanel();
    }

    function toggle() { if (active) close(); else open(); }

    return Origo.ui.Component({
      name: 'ortofotoDownload',

      onInit() {
        ortofotoButton = Origo.ui.Button({
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

        const { source: olSource, layer: olLayer } = Origo.ol;
        source = new olSource.Vector();
        layer = new olLayer.Vector({
          source,
          style: styleFn,
          visible: false,
          properties: { name: layerName, title: layerTitle, queryable: false }
        });
        map.addLayer(layer);

        this.addComponents([ortofotoButton]);
        this.render();
      },

      render() {
        const el = Origo.ui.dom.html(ortofotoButton.render());
        document.getElementById(target).appendChild(el);
        this.dispatch('render');
      }
    });
  }

  root.OrtofotoDownload = OrtofotoDownload;
}(window));
