/*!
 * ortofoto-download — Origo plugin.
 *
 * Knapp i höger verktygsmeny. Hämtar Lantmäteriets ortofoto-indexrutor (STAC-
 * bild) för den synliga kartvyn via backend-tjänsten. Arbetsflöde:
 *   1. Välj flygår – bara det årets indexrutor ritas (annars överlappar alla år
 *      varandra och går inte att klicka i).
 *   2. Klicka på rutor för att markera (Ctrl/⌘ + dra för flera) – som laserdata.
 *   3. Ladda ner de markerade ortofotona (GeoTIFF) som en zip-ström.
 *
 * Backenden (/api/ortofoto/) injicerar Lantmäteriets Basic Auth server-side.
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

  function platformModifierKeyOnly(mapBrowserEvent) {
    const ev = mapBrowserEvent.originalEvent;
    const isMac = /(Mac|iPod|iPhone|iPad)/.test(navigator.platform || '');
    const modifier = isMac ? ev.metaKey : ev.ctrlKey;
    return modifier && !ev.altKey && !ev.shiftKey;
  }

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
      downloadUrl: `${base}download`,
      yearsUrl: `${base}years`
    };
  }

  function OrtofotoDownload(options = {}) {
    const {
      backendUrl = '/api/ortofoto',
      maxFiles = 100,
      maxBytes = 50 * 1024 * 1024 * 1024,
      icon = '#ortofoto-photo',
      tooltipText = 'Ortofoto – nedladdning',
      tooltipPlacement = 'east',
      layerName = 'ortofoto-index',
      layerTitle = 'Ortofoto indexrutor',
      // Sök inte om kartvyn är bredare än så här (meter, kartans projektion).
      maxSearchSpanMeters = 500000,
      // Över den här totalstorleken strömmas zip:en direkt till disk (gamla
      // form-metoden) i stället för att buffras i minnet med progressbar.
      progressMaxBytes = 4 * 1024 * 1024 * 1024
    } = options;

    const { searchUrl, estimateUrl, downloadUrl, yearsUrl } = deriveUrls(backendUrl);
    const cls = 'o-ortofoto padding-small icon-smaller round light box-shadow';

    let viewer;
    let map;
    let target;
    let layer;
    let source;
    let ortofotoButton;

    let active = false;
    let dragBox = null;
    let searchTimer = null;
    let estimateTimer = null;
    let lastEstimateSize = null;
    let downloadAbort = null;        // AbortController för pågående nedladdning
    let allYears = [];               // alla tillgängliga flygår (från /years, oberoende av zoom)
    let yearsLoaded = false;
    let yearFeatures = [];           // valt års rutor (serverside-filtrerade) – det som ritas
    const yearColors = new Map();    // år -> hexfärg
    let selectedYear = null;         // valt flygår (bara dess rutor ritas)
    const selectedIds = new Set();   // markerade rut-id (ortoId)
    const itemsById = new Map();     // ortoId -> {href, size, year}

    // --- panel ---
    let panelEl;
    let statusEl;
    let yearsEl;
    let countEl;
    let sizeEl;
    let warnEl;
    let downloadBtn;
    let actionsEl;
    let progressEl;
    let progressTextEl;
    let progressBarEl;
    let progressFillEl;
    let cancelBtn;
    let crsSelectEl;
    let fileInputEl;

    function colorForYear(year) {
      if (!yearColors.has(year)) {
        yearColors.set(year, PALETTE[yearColors.size % PALETTE.length]);
      }
      return yearColors.get(year);
    }

    // --- styles (bara valt års rutor ritas) ---
    function styleFn(feature) {
      const { Style, Stroke, Fill, Text } = Origo.ol.style;
      const id = String(feature.get('ortoId'));
      const selected = selectedIds.has(id);
      const color = colorForYear(feature.get('year'));
      return new Style({
        stroke: new Stroke({ color: selected ? 'rgba(200, 60, 30, 1)' : hexToRgba(color, 0.85), width: selected ? 2 : 1 }),
        fill: new Fill({ color: selected ? 'rgba(200, 60, 30, 0.25)' : hexToRgba(color, 0.08) }),
        text: selected ? new Text({
          text: id,
          font: '11px sans-serif',
          fill: new Fill({ color: '#222' }),
          stroke: new Stroke({ color: '#fff', width: 2 }),
          overflow: true
        }) : undefined
      });
    }

    // --- sökning mot backend för aktuell vy ---
    function currentBboxWgs84() {
      const view = map.getView();
      const mapProj = view.getProjection();
      const extent = view.calculateExtent(map.getSize());
      const wgs = Origo.ol.proj.transformExtent(extent, mapProj, 'EPSG:4326');
      return [wgs[0], wgs[1], wgs[2], wgs[3]];
    }

    function viewTooWide() {
      const view = map.getView();
      const mapProj = view.getProjection();
      const extent = view.calculateExtent(map.getSize());
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

    // Hämtar hela flygårs-listan (alla år som finns, oberoende av zoom) en gång.
    async function loadYears() {
      try {
        const res = await fetch(yearsUrl, { headers: { Accept: 'application/json' } });
        const data = await res.json();
        if (!res.ok) throw new Error(data && data.error ? data.error : `Backend svarade ${res.status}`);
        allYears = Array.isArray(data.years) ? data.years.slice() : [];
        yearsLoaded = true;
        renderYears();
        if (selectedYear == null) setStatus('Välj ett flygår nedan.');
      } catch (err) {
        setStatus(`Kunde inte hämta flygår: ${err.message}`, true);
      }
    }

    // På moveend: rita om valt års rutor för den nya vyn. Årslistan är statisk
    // (alla år visas direkt), så inget års-tvång baserat på summan av alla år.
    async function runSearch() {
      if (!active) return;
      if (selectedYear == null) {
        source.clear();
        yearFeatures = [];
        setStatus(yearsLoaded ? 'Välj ett flygår nedan.' : 'Hämtar flygår…');
        renderCount();
        return;
      }
      await fetchYear(selectedYear);
    }

    // Hämtar och ritar ETT flygårs rutor serverside-filtrerat (taget gäller då
    // bara det året). Driver "zooma in"-varningen per år.
    async function fetchYear(year) {
      if (year == null) { yearFeatures = []; drawYear(); renderCount(); return; }
      if (viewTooWide()) {
        source.clear();
        yearFeatures = [];
        setStatus('Zooma in för att visa rutnätet.', true);
        renderCount();
        return;
      }
      const bbox = currentBboxWgs84();
      setStatus(`Hämtar rutor för flygår ${year}…`);
      try {
        const res = await fetch(searchUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bbox, year })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data && data.error ? data.error : `Backend svarade ${res.status}`);
        yearFeatures = data.features || [];
        drawYear();
        if (data.truncated) {
          setStatus(`Flygår ${year}: för många rutor – zooma in för att se alla.`, true);
        } else {
          setStatus(`Flygår ${year}: ${yearFeatures.length} rutor. Klicka för att markera.`);
        }
        renderCount();
      } catch (err) {
        source.clear();
        yearFeatures = [];
        setStatus(`Kunde inte hämta: ${err.message}`);
        renderCount();
      }
    }

    // Bygg OL-geometri direkt ur GeoJSON-koordinaterna (WGS84) och transformera
    // till kartans projektion. Undviker OL:s GeoJSON-format-reprojektion som
    // hamnar fel i EPSG:3006 (påtvingad 'neu'-axelordning).
    function buildGeometry(geojson) {
      const { Polygon, MultiPolygon } = Origo.ol.geom;
      if (!geojson) return null;
      if (geojson.type === 'Polygon') return new Polygon(geojson.coordinates);
      if (geojson.type === 'MultiPolygon') return new MultiPolygon(geojson.coordinates);
      return null;
    }

    // Ritar valt års rutor (yearFeatures, redan serverside-filtrerade på året).
    function drawYear() {
      source.clear();
      const mapProj = map.getView().getProjection();
      const olFeatures = [];
      yearFeatures.forEach((f) => {
        if (!f.geometry || !f.dataHref) return;
        const geom = buildGeometry(f.geometry);
        if (!geom) return;
        geom.transform('EPSG:4326', mapProj);
        const id = String(f.id);
        const feat = new Origo.ol.Feature({ geometry: geom });
        feat.set('ortoId', id);
        feat.set('year', f.year);
        olFeatures.push(feat);
        itemsById.set(id, { href: f.dataHref, size: Number(f.dataSize) || 0, year: f.year });
      });
      source.addFeatures(olFeatures);
    }

    function selectYear(year) {
      if (selectedYear === year) return;
      selectedYear = year;
      // Byte av år = annat urval av rutor; nollställ markeringen.
      selectedIds.clear();
      lastEstimateSize = null;
      renderYears();
      fetchYear(year);
    }

    // --- urval ---
    function toggleId(id) {
      if (!id) return;
      if (selectedIds.has(id)) selectedIds.delete(id);
      else selectedIds.add(id);
    }

    function onSingleClick(evt) {
      if (!active || selectedYear == null) return;
      let hit = null;
      map.forEachFeatureAtPixel(evt.pixel, (f, lyr) => {
        if (lyr === layer && !hit) hit = f;
      });
      if (hit) {
        toggleId(String(hit.get('ortoId')));
        layer.changed();
        onSelectionChange();
      }
    }

    function selectInExtent(extent) {
      source.forEachFeatureIntersectingExtent(extent, (f) => {
        selectedIds.add(String(f.get('ortoId')));
      });
      layer.changed();
      onSelectionChange();
    }

    function selectedHrefs() {
      const hrefs = [];
      selectedIds.forEach((id) => {
        const entry = itemsById.get(id);
        if (entry && entry.href) hrefs.push(entry.href);
      });
      return hrefs;
    }

    function selectedSize() {
      let sum = 0;
      selectedIds.forEach((id) => {
        const entry = itemsById.get(id);
        if (entry) sum += entry.size || 0;
      });
      return sum;
    }

    // --- panel rendering ---
    function setStatus(text, warn) {
      if (!statusEl) return;
      statusEl.textContent = text;
      statusEl.classList.toggle('is-warn', !!warn);
    }
    function showWarn(text) { if (warnEl) { warnEl.hidden = false; warnEl.textContent = text; } }
    function clearWarn() { if (warnEl) { warnEl.hidden = true; warnEl.textContent = ''; } }

    function renderYears() {
      if (!yearsEl) return;
      yearsEl.innerHTML = '';
      if (!allYears.length) {
        yearsEl.innerHTML = `<p class="o-ortofoto-empty">${yearsLoaded ? 'Inga flygår hittades.' : 'Hämtar flygår…'}</p>`;
        return;
      }
      allYears.forEach((year) => {
        const row = document.createElement('label');
        row.className = 'o-ortofoto-year';
        const rb = document.createElement('input');
        rb.type = 'radio';
        rb.name = 'o-ortofoto-year';
        rb.checked = year === selectedYear;
        rb.addEventListener('change', () => { if (rb.checked) selectYear(year); });
        const swatch = document.createElement('span');
        swatch.className = 'o-ortofoto-swatch';
        swatch.style.background = colorForYear(year);
        const text = document.createElement('span');
        text.className = 'o-ortofoto-year-text';
        text.textContent = String(year);
        row.appendChild(rb);
        row.appendChild(swatch);
        row.appendChild(text);
        yearsEl.appendChild(row);
      });
    }

    function renderCount() {
      if (countEl) countEl.textContent = String(selectedIds.size);
      const overCount = selectedIds.size > maxFiles;
      if (sizeEl) {
        if (selectedIds.size === 0) sizeEl.textContent = '—';
        else if (lastEstimateSize != null) sizeEl.textContent = formatBytes(lastEstimateSize);
        else sizeEl.textContent = `≈ ${formatBytes(selectedSize())}`;
      }
      if (overCount) showWarn(`Mer än ${maxFiles} rutor markerade. Minska urvalet.`);
      else if (lastEstimateSize != null && lastEstimateSize > maxBytes) showWarn(`Totalstorlek överskrider ${formatBytes(maxBytes)}.`);
      else clearWarn();
      if (downloadBtn) {
        downloadBtn.disabled = selectedIds.size === 0 || overCount
          || (lastEstimateSize != null && lastEstimateSize > maxBytes);
        downloadBtn.textContent = 'Ladda ner';
      }
    }

    // Fråga backend om exakt totalstorlek (debouncat). Faller annars tillbaka på
    // STAC:ens uppskattade storlek (≈).
    function scheduleEstimate() {
      if (estimateTimer) clearTimeout(estimateTimer);
      lastEstimateSize = null;
      if (selectedIds.size === 0 || selectedIds.size > maxFiles) { renderCount(); return; }
      estimateTimer = setTimeout(async () => {
        const items = selectedHrefs();
        try {
          const res = await fetch(estimateUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items })
          });
          const data = await res.json();
          lastEstimateSize = res.ok ? Number(data.totalSize) : null;
        } catch (e) {
          lastEstimateSize = null;
        }
        renderCount();
      }, 400);
    }

    function onSelectionChange() {
      renderCount();
      scheduleEstimate();
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

    // --- progress UI ---
    function showProgress(text) {
      if (actionsEl) actionsEl.hidden = true;
      if (progressEl) progressEl.hidden = false;
      setProgressIndeterminate(true);
      setProgressText(text || 'Förbereder…', '');
    }
    function hideProgress() {
      if (progressEl) progressEl.hidden = true;
      if (actionsEl) actionsEl.hidden = false;
    }
    function setProgressIndeterminate(on) {
      if (progressBarEl) progressBarEl.classList.toggle('indeterminate', !!on);
      if (on && progressFillEl) progressFillEl.style.width = '40%';
    }
    function setProgress(fraction) {
      setProgressIndeterminate(false);
      if (progressFillEl) progressFillEl.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
    }
    function setProgressText(left, right) {
      if (progressTextEl) progressTextEl.innerHTML = `<span>${left}</span><span>${right || ''}</span>`;
    }

    function saveBlob(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 120000);
    }

    function filenameFromResponse(res, fallback) {
      const cd = res.headers.get('content-disposition') || '';
      const m = /filename="?([^"]+)"?/.exec(cd);
      return (m && m[1]) || fallback;
    }

    // Strömmande nedladdning med progressbar. Servern hämtar ortofotona från
    // Lantmäteriet och paketerar zip:en medan vi läser strömmen och visar hur
    // många byte som kommit av den uppskattade totalen. Buffras i minnet →
    // Blob; för mycket stora zip:ar används form-metoden i stället.
    async function streamDownload(items, total) {
      downloadAbort = new AbortController();
      showProgress('Förbereder på servern (hämtar & paketerar)…');
      let res;
      try {
        res = await fetch(downloadUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items }),
          signal: downloadAbort.signal
        });
      } catch (err) {
        if (err.name === 'AbortError') { hideProgress(); return; }
        throw new Error(`Kunde inte nå servern: ${err.message}`);
      }
      if (!res.ok || !res.body) {
        const txt = await res.text().catch(() => '');
        throw new Error(txt || `Servern svarade ${res.status}`);
      }
      const fname = filenameFromResponse(res, `ortofoto-${Date.now()}.zip`);
      const reader = res.body.getReader();
      const chunks = [];
      let received = 0;
      setProgressText('Laddar ner…', total ? `0 / ${formatBytes(total)}` : '');
      for (;;) {
        let chunk;
        try { chunk = await reader.read(); } catch (err) {
          if (err.name === 'AbortError') { hideProgress(); return; }
          throw err;
        }
        if (chunk.done) break;
        chunks.push(chunk.value);
        received += chunk.value.length;
        if (total > 0) {
          setProgress(received / total);
          setProgressText('Laddar ner…', `${formatBytes(received)} / ${formatBytes(total)}`);
        } else {
          setProgressText('Laddar ner…', formatBytes(received));
        }
      }
      setProgress(1);
      setProgressText('Sparar…', formatBytes(received));
      saveBlob(new Blob(chunks, { type: 'application/zip' }), fname);
      downloadAbort = null;
      hideProgress();
    }

    async function startDownload() {
      const items = selectedHrefs();
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
        const total = Number(data.totalSize) || 0;
        if (sizeEl && total) sizeEl.textContent = formatBytes(total);

        // Mycket stora nedladdningar: strömma direkt till disk (ingen
        // minnesbuffert, ingen progressbar) via form-metoden.
        const streamable = typeof window.ReadableStream !== 'undefined' && !!window.fetch;
        if (!streamable || (total && total > progressMaxBytes)) {
          downloadBtn.textContent = 'Hämtar zip…';
          postFormDownload(items);
          setTimeout(renderCount, 1500);
          return;
        }

        await streamDownload(items, total);
        renderCount();
      } catch (err) {
        hideProgress();
        showWarn(`Kunde inte starta nedladdning: ${err.message}`);
        downloadBtn.disabled = false;
        downloadBtn.textContent = 'Ladda ner';
      }
    }

    function cancelDownload() {
      if (downloadAbort) { try { downloadAbort.abort(); } catch (e) { /* ignore */ } downloadAbort = null; }
      hideProgress();
      renderCount();
    }

    // Markera rutor från en uppladdad fil. Ortofoto markerar per flygår: använder
    // valt år om det finns bland träffarna, annars senaste året i träffarna.
    async function handleUpload(file) {
      if (!root.TileUpload) { setStatus('Uppladdningsmodulen (tile-upload.js) saknas.'); return; }
      const crs = crsSelectEl ? crsSelectEl.value : 'auto';
      const mapProj = map.getView().getProjection();
      setStatus(`Läser ${file.name}…`);
      try {
        const geoms = await root.TileUpload.parse(file, { crs, mapProj });
        if (!geoms.length) { setStatus('Inga geometrier hittades i filen.'); return; }
        setStatus('Söker rutor som geometrierna skär…');
        const { matched, truncated } = await root.TileUpload.matchTiles({ geometries: geoms, mapProj, searchUrl });
        if (!matched.length) { setStatus('Inga rutor träffades i filens område.'); return; }
        const yearsInMatches = Array.from(new Set(matched.map((f) => f.year).filter((y) => y != null)))
          .sort((a, b) => b - a);
        if (selectedYear == null || !yearsInMatches.includes(selectedYear)) {
          selectedYear = yearsInMatches.length ? yearsInMatches[0] : selectedYear;
        }
        let added = 0;
        matched.forEach((f) => {
          if (f.year !== selectedYear || !f.dataHref) return;
          const id = String(f.id);
          itemsById.set(id, { href: f.dataHref, size: Number(f.dataSize) || 0, year: f.year });
          if (!selectedIds.has(id)) { selectedIds.add(id); added += 1; }
        });
        const ext = geoms.reduce((acc, g) => {
          const e = g.getExtent();
          return acc
            ? [Math.min(acc[0], e[0]), Math.min(acc[1], e[1]), Math.max(acc[2], e[2]), Math.max(acc[3], e[3])]
            : e.slice();
        }, null);
        if (ext) map.getView().fit(ext, { padding: [40, 40, 40, 40], maxZoom: 12, duration: 300 });
        renderYears();
        layer.changed();
        onSelectionChange();
        const others = yearsInMatches.filter((y) => y !== selectedYear);
        setStatus(`Flygår ${selectedYear}: ${added} rutor markerade från fil${others.length ? ` (träffar även ${others.join(', ')})` : ''}${truncated ? ' – fler kan finnas' : ''}.`);
      } catch (err) {
        setStatus(`Kunde inte läsa filen: ${err.message}`);
      }
    }

    function clearSelection() {
      selectedIds.clear();
      lastEstimateSize = null;
      layer.changed();
      onSelectionChange();
    }

    function buildPanel() {
      const el = document.createElement('div');
      el.className = 'o-ortofoto-panel';
      el.innerHTML = `
        <button class="o-ortofoto-close" type="button" title="Stäng">&times;</button>
        <h3 class="o-ortofoto-title">Ortofoto – nedladdning</h3>
        <p class="o-ortofoto-hint">
          Panorera/zooma till området. Välj <strong>flygår</strong>, klicka sedan på
          rutor för att markera (<kbd>Ctrl</kbd>/<kbd>&#8984;</kbd> + dra för flera)
          och ladda ner ortofotona (GeoTIFF) som en zip.
        </p>
        <div class="o-ortofoto-upload">
          <label class="o-ortofoto-upload-btn">Markera från fil…
            <input type="file" class="o-ortofoto-file" accept=".csv,.txt,.geojson,.json,.zip,.shp" hidden>
          </label>
          <select class="o-ortofoto-crs" title="Koordinatsystem i filen">
            ${root.TileUpload ? root.TileUpload.crsOptionsHtml() : '<option value="auto">Auto</option>'}
          </select>
        </div>
        <p class="o-ortofoto-status">—</p>
        <div class="o-ortofoto-years"></div>
        <div class="o-ortofoto-row"><span>Valda rutor</span><span class="o-ortofoto-count">0</span></div>
        <div class="o-ortofoto-row"><span>Uppskattad storlek</span><span class="o-ortofoto-size">—</span></div>
        <div class="o-ortofoto-warn" hidden></div>
        <div class="o-ortofoto-actions">
          <button class="o-ortofoto-clear" type="button">Rensa</button>
          <button class="o-ortofoto-download" type="button" disabled>Ladda ner</button>
        </div>
        <div class="o-ortofoto-progress" hidden>
          <p class="o-ortofoto-progress-text"><span>Förbereder…</span><span></span></p>
          <div class="o-ortofoto-bar"><div class="o-ortofoto-bar-fill"></div></div>
          <button class="o-ortofoto-cancel" type="button">Avbryt</button>
        </div>
      `;
      statusEl = el.querySelector('.o-ortofoto-status');
      yearsEl = el.querySelector('.o-ortofoto-years');
      countEl = el.querySelector('.o-ortofoto-count');
      sizeEl = el.querySelector('.o-ortofoto-size');
      warnEl = el.querySelector('.o-ortofoto-warn');
      downloadBtn = el.querySelector('.o-ortofoto-download');
      actionsEl = el.querySelector('.o-ortofoto-actions');
      progressEl = el.querySelector('.o-ortofoto-progress');
      progressTextEl = el.querySelector('.o-ortofoto-progress-text');
      progressBarEl = el.querySelector('.o-ortofoto-bar');
      progressFillEl = el.querySelector('.o-ortofoto-bar-fill');
      cancelBtn = el.querySelector('.o-ortofoto-cancel');
      crsSelectEl = el.querySelector('.o-ortofoto-crs');
      fileInputEl = el.querySelector('.o-ortofoto-file');
      el.querySelector('.o-ortofoto-close').addEventListener('click', close);
      el.querySelector('.o-ortofoto-clear').addEventListener('click', clearSelection);
      downloadBtn.addEventListener('click', startDownload);
      cancelBtn.addEventListener('click', cancelDownload);
      fileInputEl.addEventListener('change', (e) => {
        const f = e.target.files && e.target.files[0];
        e.target.value = '';
        if (f) handleUpload(f);
      });
      if (root.PanelDrag) root.PanelDrag.makeDraggable(el, el.querySelector('.o-ortofoto-title'));
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
      dragBox = new Origo.ol.interaction.DragBox({ condition: platformModifierKeyOnly });
      dragBox.on('boxend', () => selectInExtent(dragBox.getGeometry().getExtent()));
      map.addInteraction(dragBox);
      map.on('singleclick', onSingleClick);
      map.on('moveend', scheduleSearch);
      ortofotoButton.setState('active');
      showPanel();
      if (!yearsLoaded) loadYears();
      runSearch();
    }

    function close() {
      if (!active) return;
      active = false;
      if (dragBox) { map.removeInteraction(dragBox); dragBox = null; }
      map.un('singleclick', onSingleClick);
      map.un('moveend', scheduleSearch);
      if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
      if (downloadAbort) { try { downloadAbort.abort(); } catch (e) { /* ignore */ } downloadAbort = null; }
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
          properties: { name: layerName, title: layerTitle, queryable: false, group: 'none' }
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
