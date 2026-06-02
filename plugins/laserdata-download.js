/*!
 * laserdata-download — Origo plugin.
 *
 * Knapp i höger verktygsmeny. Hämtar Lantmäteriets laserdata-rutor (punktmoln,
 * LAZ/COPC) DIREKT från deras STAC-höjd-API för den synliga kartvyn via backend-
 * tjänsten, ritar rutornas fotavtryck, låter användaren markera rutor
 * (klick / Ctrl-dra) och laddar ner motsvarande LAZ-filer som en zip-ström.
 *
 * Ersätter den tidigare NAS-baserade varianten (lokalt genererat indexrutnät +
 * filuppslag mot monterad katalog). Backenden (/api/laserdata/) injicerar
 * Lantmäteriets Basic Auth server-side – samma Geotorget-konto som ortofoto.
 *
 * Bundlad som en enda IIFE (ingen byggning behövs). Exponerar globalen
 * `LaserdataDownload(options)`. Kräver att `origo.js` laddats först.
 */
(function (root) {
  if (typeof Origo === 'undefined') {
    // eslint-disable-next-line no-console
    console.error('[laserdata-download] Origo-globalen saknas – ladda origo.js före detta skript.');
    return;
  }

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

  function deriveUrls(backendBase) {
    const base = backendBase.replace(/\/?$/, '/');
    return {
      searchUrl: `${base}search`,
      estimateUrl: `${base}estimate`,
      downloadUrl: `${base}download`
    };
  }

  function LaserdataDownload(options = {}) {
    const {
      backendUrl = '/api/laserdata',
      maxFiles = 200,
      maxBytes = 50 * 1024 * 1024 * 1024,
      icon = '#fa-download',
      tooltipText = 'Höjddata – nedladdning',
      tooltipPlacement = 'east',
      layerName = 'laserdata-grid',
      layerTitle = 'Höjddata rutnät',
      // Produkter att kunna ladda ner (samma höjd-rutnät via STAC). Måste finnas
      // i backendens allowlist (LASERDATA_COLLECTIONS).
      products = [
        { collection: 'dsm-skoglig-copc', label: 'Laserdata (punktmoln, LAZ)' },
        { collection: 'dtm-cog', label: 'Markhöjdmodell (1 m, GeoTIFF)' }
      ],
      // Sök inte om kartvyn är bredare än så här (meter, kartans projektion).
      // Högre värde = rutnätet visas redan vid mer utzoomat läge (fler rutor
      // hämtas/ritas; begränsas av backendens SEARCH_LIMIT, så vid mycket vida
      // vyer kan rutnätet bli avkortat för de finmaskiga produkterna).
      maxSearchSpanMeters = 500000,
      // Över den här totalstorleken strömmas zip:en direkt till disk (gamla
      // form-metoden) i stället för att buffras i minnet med progressbar.
      progressMaxBytes = 4 * 1024 * 1024 * 1024
    } = options;

    const { searchUrl, estimateUrl, downloadUrl } = deriveUrls(backendUrl);
    const cls = 'o-laserdata padding-small icon-smaller round light box-shadow';

    let viewer;
    let map;
    let target;
    let layer;
    let source;
    let laserdataButton;

    let active = false;
    let dragBox = null;
    let searchTimer = null;
    let estimateTimer = null;
    let lastEstimateSize = null;
    let downloadAbort = null;   // AbortController för pågående nedladdning
    let currentCollection = (products[0] && products[0].collection) || undefined;

    // Markeringen lever på rut-id (STAC item-id) så att den överlever när
    // rutorna ritas om vid panorering/zoom. itemsById ackumulerar id → {href,
    // size} över sökningar så att redan markerade rutor kan laddas ner även om
    // man pannat bort från dem.
    const selectedIds = new Set();
    const itemsById = new Map();

    // --- panel ---
    let panelEl;
    let statusEl;
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
    let productSelectEl;

    // --- styles ---
    function defaultStyle() {
      const { Style, Stroke, Fill } = Origo.ol.style;
      return new Style({
        stroke: new Stroke({ color: 'rgba(40, 90, 160, 0.9)', width: 1 }),
        fill: new Fill({ color: 'rgba(40, 90, 160, 0.05)' })
      });
    }

    function selectedStyle(feature) {
      const { Style, Stroke, Fill, Text } = Origo.ol.style;
      return new Style({
        stroke: new Stroke({ color: 'rgba(200, 60, 30, 1)', width: 2 }),
        fill: new Fill({ color: 'rgba(200, 60, 30, 0.25)' }),
        text: new Text({
          text: String(feature.get('laserId') || ''),
          font: '11px sans-serif',
          fill: new Fill({ color: '#222' }),
          stroke: new Stroke({ color: '#fff', width: 2 }),
          overflow: true
        })
      });
    }

    function styleFn(feature) {
      return selectedIds.has(String(feature.get('laserId')))
        ? selectedStyle(feature)
        : defaultStyle();
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

    async function runSearch() {
      if (!active) return;
      if (viewTooWide()) {
        source.clear();
        setStatus('Zooma in för att visa rutnätet.', true);
        return;
      }
      const bbox = currentBboxWgs84();
      setStatus('Hämtar rutor…');
      try {
        const res = await fetch(searchUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bbox, collection: currentCollection })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data && data.error ? data.error : `Backend svarade ${res.status}`);
        drawFeatures(data.features || []);
        const truncated = data.truncated ? ' (max antal nått – zooma in för fler)' : '';
        setStatus(`${(data.features || []).length} rutor i vyn${truncated}. Klicka för att markera.`);
      } catch (err) {
        source.clear();
        setStatus(`Kunde inte hämta: ${err.message}`);
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
        const id = String(f.id);
        const feat = new Origo.ol.Feature({ geometry: geom });
        feat.set('laserId', id);
        olFeatures.push(feat);
        // Kom ihåg href/storlek så markeringen kan laddas ner även efter panorering.
        itemsById.set(id, { href: f.dataHref, size: Number(f.dataSize) || 0 });
      });
      source.addFeatures(olFeatures);
    }

    // --- urval / beräkning ---
    function toggleId(id) {
      if (!id) return;
      if (selectedIds.has(id)) selectedIds.delete(id);
      else selectedIds.add(id);
    }

    function onSingleClick(evt) {
      if (!active) return;
      let hit = null;
      map.forEachFeatureAtPixel(evt.pixel, (f, lyr) => {
        if (lyr === layer && !hit) hit = f;
      });
      if (hit) {
        toggleId(String(hit.get('laserId')));
        layer.changed();
        onSelectionChange();
      }
    }

    function selectInExtent(extent) {
      source.forEachFeatureIntersectingExtent(extent, (f) => {
        selectedIds.add(String(f.get('laserId')));
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

    // Fråga backend om exakt totalstorlek (debouncat). Misslyckas tyst →
    // faller tillbaka på STAC:ens uppskattade storlek (≈).
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
      const iframeName = `o-laserdata-dl-${Date.now()}`;
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

    // Strömmande nedladdning med progressbar. Servern hämtar filerna från
    // Lantmäteriet och paketerar zip:en medan vi läser strömmen och visar
    // hur många byte som kommit av den uppskattade totalen. Buffras i minnet
    // → Blob; för mycket stora zip:ar används form-metoden i stället.
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
      const fname = filenameFromResponse(res, `laserdata-${Date.now()}.zip`);
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

    // Markera rutor från en uppladdad fil (koordinatlista/GeoJSON/.shp).
    async function handleUpload(file) {
      if (!root.TileUpload) { setStatus('Uppladdningsmodulen (tile-upload.js) saknas.'); return; }
      const crs = crsSelectEl ? crsSelectEl.value : 'auto';
      const mapProj = map.getView().getProjection();
      setStatus(`Läser ${file.name}…`);
      try {
        const geoms = await root.TileUpload.parse(file, { crs, mapProj });
        if (!geoms.length) { setStatus('Inga geometrier hittades i filen.'); return; }
        setStatus('Söker rutor som geometrierna skär…');
        const { matched, truncated } = await root.TileUpload.matchTiles({ geometries: geoms, mapProj, searchUrl, collection: currentCollection });
        let added = 0;
        matched.forEach((f) => {
          if (!f.dataHref) return;
          const id = String(f.id);
          itemsById.set(id, { href: f.dataHref, size: Number(f.dataSize) || 0 });
          if (!selectedIds.has(id)) { selectedIds.add(id); added += 1; }
        });
        // Visa området så de markerade rutorna ritas.
        const ext = geoms.reduce((acc, g) => {
          const e = g.getExtent();
          return acc
            ? [Math.min(acc[0], e[0]), Math.min(acc[1], e[1]), Math.max(acc[2], e[2]), Math.max(acc[3], e[3])]
            : e.slice();
        }, null);
        if (ext) map.getView().fit(ext, { padding: [40, 40, 40, 40], maxZoom: 12, duration: 300 });
        layer.changed();
        onSelectionChange();
        setStatus(`${matched.length} rutor träffades${added !== matched.length ? ` (${added} nya)` : ''}${truncated ? ' – fler kan finnas, dela upp området' : ''}.`);
      } catch (err) {
        setStatus(`Kunde inte läsa filen: ${err.message}`);
      }
    }

    // Byt produkt (laserdata ↔ markhöjdmodell). Rensar markeringen eftersom
    // rut-id och fil-URL:er är produktspecifika, och söker om för vyn.
    function changeProduct(collection) {
      if (!collection || collection === currentCollection) return;
      currentCollection = collection;
      selectedIds.clear();
      itemsById.clear();
      lastEstimateSize = null;
      source.clear();
      onSelectionChange();
      runSearch();
    }

    function clearSelection() {
      selectedIds.clear();
      lastEstimateSize = null;
      layer.changed();
      onSelectionChange();
    }

    function buildPanel() {
      const el = document.createElement('div');
      el.className = 'o-laserdata-panel';
      const productOptions = products
        .map((p, i) => `<option value="${p.collection}"${i === 0 ? ' selected' : ''}>${p.label}</option>`)
        .join('');
      el.innerHTML = `
        <button class="o-laserdata-close" type="button" title="Stäng">&times;</button>
        <h3 class="o-laserdata-title">Höjddata – nedladdning</h3>
        <div class="o-laserdata-row o-laserdata-product-row">
          <span>Produkt</span>
          <select class="o-laserdata-product">${productOptions}</select>
        </div>
        <p class="o-laserdata-hint">
          Panorera/zooma till området tills rutorna visas. Klicka på rutor för att
          markera. Håll <kbd>Ctrl</kbd>/<kbd>&#8984;</kbd> + dra för flera.
        </p>
        <div class="o-laserdata-upload">
          <label class="o-laserdata-upload-btn">Markera från fil…
            <input type="file" class="o-laserdata-file" accept=".csv,.txt,.geojson,.json,.zip,.shp" hidden>
          </label>
          <select class="o-laserdata-crs" title="Koordinatsystem i filen">
            <option value="EPSG:3006" selected>SWEREF 99 TM</option>
            <option value="EPSG:4326">WGS84 lon/lat</option>
            <option value="auto">Auto</option>
          </select>
        </div>
        <p class="o-laserdata-status">—</p>
        <div class="o-laserdata-row"><span>Valda rutor</span><span class="o-laserdata-count">0</span></div>
        <div class="o-laserdata-row"><span>Uppskattad storlek</span><span class="o-laserdata-size">—</span></div>
        <div class="o-laserdata-warn" hidden></div>
        <div class="o-laserdata-actions">
          <button class="o-laserdata-clear" type="button">Rensa</button>
          <button class="o-laserdata-download" type="button" disabled>Ladda ner</button>
        </div>
        <div class="o-laserdata-progress" hidden>
          <p class="o-laserdata-progress-text"><span>Förbereder…</span><span></span></p>
          <div class="o-laserdata-bar"><div class="o-laserdata-bar-fill"></div></div>
          <button class="o-laserdata-cancel" type="button">Avbryt</button>
        </div>
      `;
      statusEl = el.querySelector('.o-laserdata-status');
      countEl = el.querySelector('.o-laserdata-count');
      sizeEl = el.querySelector('.o-laserdata-size');
      warnEl = el.querySelector('.o-laserdata-warn');
      downloadBtn = el.querySelector('.o-laserdata-download');
      actionsEl = el.querySelector('.o-laserdata-actions');
      progressEl = el.querySelector('.o-laserdata-progress');
      progressTextEl = el.querySelector('.o-laserdata-progress-text');
      progressBarEl = el.querySelector('.o-laserdata-bar');
      progressFillEl = el.querySelector('.o-laserdata-bar-fill');
      cancelBtn = el.querySelector('.o-laserdata-cancel');
      crsSelectEl = el.querySelector('.o-laserdata-crs');
      fileInputEl = el.querySelector('.o-laserdata-file');
      productSelectEl = el.querySelector('.o-laserdata-product');
      if (productSelectEl) productSelectEl.addEventListener('change', () => changeProduct(productSelectEl.value));
      el.querySelector('.o-laserdata-close').addEventListener('click', close);
      el.querySelector('.o-laserdata-clear').addEventListener('click', clearSelection);
      downloadBtn.addEventListener('click', startDownload);
      cancelBtn.addEventListener('click', cancelDownload);
      fileInputEl.addEventListener('change', (e) => {
        const f = e.target.files && e.target.files[0];
        e.target.value = '';
        if (f) handleUpload(f);
      });
      if (root.PanelDrag) root.PanelDrag.makeDraggable(el, el.querySelector('.o-laserdata-title'));
      panelEl = el;
      return el;
    }

    function showPanel() {
      if (!panelEl) buildPanel();
      const host = document.getElementById(viewer.getId()) || document.body;
      if (!panelEl.isConnected) host.appendChild(panelEl);
      renderCount();
    }

    function hidePanel() {
      if (panelEl && panelEl.parentNode) panelEl.parentNode.removeChild(panelEl);
    }

    // --- open / close tool ---
    function open() {
      if (active) return;
      active = true;
      layer.setVisible(true);
      dragBox = new Origo.ol.interaction.DragBox({ condition: platformModifierKeyOnly });
      dragBox.on('boxend', () => selectInExtent(dragBox.getGeometry().getExtent()));
      map.addInteraction(dragBox);
      map.on('singleclick', onSingleClick);
      map.on('moveend', scheduleSearch);
      laserdataButton.setState('active');
      showPanel();
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
      laserdataButton.setState('initial');
      hidePanel();
    }

    function toggle() { if (active) close(); else open(); }

    return Origo.ui.Component({
      name: 'laserdataDownload',

      onInit() {
        laserdataButton = Origo.ui.Button({
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

        this.addComponents([laserdataButton]);
        this.render();
      },

      render() {
        const el = Origo.ui.dom.html(laserdataButton.render());
        document.getElementById(target).appendChild(el);
        this.dispatch('render');
      }
    });
  }

  root.LaserdataDownload = LaserdataDownload;
}(window));
