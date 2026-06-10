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

  function formatDuration(sec) {
    if (!sec || sec <= 0) return '—';
    if (sec < 90) return `≈ ${Math.max(1, Math.round(sec))} s`;
    const min = Math.round(sec / 60);
    if (min < 60) return `≈ ${min} min`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `≈ ${h} h ${m} min` : `≈ ${h} h`;
  }

  // Mål-koordinatsystem för konverteringen: SWEREF 99 TM + de lokala zonerna.
  // Återanvänder TileUpload:s CRS-lista (filtrerad till EPSG:3006–3018), med en
  // inbyggd fallback om modulen inte laddats.
  function swerefTargetOptionsHtml() {
    const fallback = [
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
      { code: 'EPSG:3018', label: 'SWEREF 99 23 15' }
    ];
    const list = (root.TileUpload && root.TileUpload.CRS_LIST
      ? root.TileUpload.CRS_LIST.filter((c) => /^EPSG:30(0[6-9]|1[0-8])$/.test(c.code))
      : fallback);
    return (list.length ? list : fallback)
      .map((c) => `<option value="${c.code}">${c.label}</option>`).join('');
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
      progressMaxBytes = 4 * 1024 * 1024 * 1024,
      // Grov uppskattning av TOTAL väntetid vid konvertering (nedladdning från
      // LM + reprojektion + zip), per produkt: sekunder per ruta + sekunder per
      // GB. Kalibrerat mot mätning: 1 punktmolnsruta ≈ 0,25 GB tog ~10 min
      // (PDAL på COPC är tungt och LM:s nedladdningsgateway är långsam). Lutar
      // medvetet mot att hellre överskatta. Justera vid behov.
      convertRates = {
        'dsm-skoglig-copc': { perTileSec: 60, perGbSec: 2000 }, // punktmoln (PDAL, klart långsammast)
        'dtm-cog': { perTileSec: 10, perGbSec: 120 },           // markhöjdmodell (raster, gdalwarp)
        default: { perTileSec: 30, perGbSec: 300 }
      }
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
    // Vald årgång: 'latest' = nyaste skanningen per ruta, annars ett årtal (str).
    let currentYear = 'latest';

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
    let yearSelectEl;
    let convertCheckEl;
    let convertBoxEl;
    let convertCrsEl;
    let convertTimeEl;

    // Konverterings-val: om kryssrutan är ikryssad reprojiceras rutorna till
    // valt lokalt SWEREF server-side innan de zippas.
    function convertActive() { return !!(convertCheckEl && convertCheckEl.checked); }
    function targetCrs() { return convertActive() && convertCrsEl ? convertCrsEl.value : null; }

    // Grov uppskattning av konverteringstiden för aktuellt urval (sekunder).
    function estimateConvertSeconds() {
      const n = selectedIds.size;
      if (!n) return 0;
      const bytes = (lastEstimateSize != null) ? lastEstimateSize : selectedSize();
      const gb = bytes / (1024 * 1024 * 1024);
      const rate = convertRates[currentCollection] || convertRates.default;
      return n * rate.perTileSec + gb * rate.perGbSec;
    }

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
          body: JSON.stringify({
            bbox,
            collection: currentCollection,
            year: currentYear === 'latest' ? undefined : currentYear
          })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data && data.error ? data.error : `Backend svarade ${res.status}`);
        const feats = data.features || [];
        drawFeatures(feats);
        populateYears(data.years || []);
        const truncated = data.truncated ? ' (max antal nått – zooma in för fler)' : '';
        const yrLabel = currentYear === 'latest' ? 'nyaste per ruta' : `årgång ${currentYear}`;
        setStatus(`${feats.length} rutor i vyn${truncated} · ${yrLabel}. Klicka för att markera.`);
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
        // Kom ihåg href/storlek/skanningsår så markeringen kan laddas ner även efter panorering.
        itemsById.set(id, { href: f.dataHref, size: Number(f.dataSize) || 0, year: String(f.datetime || '').slice(0, 4) });
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
      if (convertTimeEl) {
        convertTimeEl.textContent = (convertActive() && selectedIds.size)
          ? formatDuration(estimateConvertSeconds()) : '—';
      }
      if (downloadBtn) {
        downloadBtn.disabled = selectedIds.size === 0 || overCount
          || (lastEstimateSize != null && lastEstimateSize > maxBytes);
        downloadBtn.textContent = convertActive() ? 'Ladda ner & konvertera' : 'Ladda ner';
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

    function postFormDownload(items, crs) {
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

      if (crs) {
        const crsInput = document.createElement('input');
        crsInput.type = 'hidden';
        crsInput.name = 'crs';
        crsInput.value = crs;
        form.appendChild(crsInput);
      }

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
    async function streamDownload(items, total, crs) {
      downloadAbort = new AbortController();
      showProgress(crs
        ? 'Förbereder på servern (hämtar, konverterar & paketerar)…'
        : 'Förbereder på servern (hämtar & paketerar)…');
      let res;
      try {
        res = await fetch(downloadUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(crs ? { items, crs } : { items }),
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
      const crs = targetCrs();
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
          postFormDownload(items, crs);
          setTimeout(renderCount, 1500);
          return;
        }

        await streamDownload(items, total, crs);
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
      currentYear = 'latest';
      if (yearSelectEl) yearSelectEl.value = 'latest';
      selectedIds.clear();
      itemsById.clear();
      lastEstimateSize = null;
      source.clear();
      onSelectionChange();
      runSearch();
    }

    // Byt årgång ('latest' = nyaste per ruta, annars ett årtal). Rensar
    // markeringen så att inte rutor från olika år blandas oavsiktligt.
    function changeYear(year) {
      const y = year || 'latest';
      if (y === currentYear) return;
      currentYear = y;
      selectedIds.clear();
      lastEstimateSize = null;
      source.clear();
      onSelectionChange();
      runSearch();
    }

    // Fyll årsväljaren med "Senaste per ruta" + de årtal som finns i vyn. Behåll
    // alltid det valda året som alternativ även om vyn just nu saknar det.
    function populateYears(years) {
      if (!yearSelectEl) return;
      const set = new Set(years || []);
      if (currentYear !== 'latest') set.add(currentYear);
      const sorted = [...set].filter(Boolean).sort().reverse();
      yearSelectEl.innerHTML = ['<option value="latest">Senaste per ruta</option>']
        .concat(sorted.map((y) => `<option value="${y}">${y}</option>`)).join('');
      yearSelectEl.value = currentYear;
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
        <div class="o-laserdata-row o-laserdata-year-row">
          <span>Årgång</span>
          <select class="o-laserdata-year"><option value="latest">Senaste per ruta</option></select>
        </div>
        <p class="o-laserdata-hint">
          Panorera/zooma till området tills rutorna visas. Klicka på rutor för att
          markera. Håll <kbd>Ctrl</kbd>/<kbd>&#8984;</kbd> + dra för flera.
        </p>
        <div class="o-laserdata-upload">
          <button type="button" class="o-laserdata-upload-toggle">Markera från fil…</button>
          <div class="o-laserdata-upload-box" hidden>
            <label class="o-laserdata-crs-label">Koordinatsystem för <b>uppladdad fil</b>
              <small>(inte för nedladdningen)</small>
              <select class="o-laserdata-crs" title="Koordinatsystemet som filens koordinater är i – inte det data du laddar ner">
                ${root.TileUpload ? root.TileUpload.crsOptionsHtml() : '<option value="auto">Auto</option>'}
              </select>
            </label>
            <label class="o-laserdata-upload-btn">Välj fil…
              <input type="file" class="o-laserdata-file" accept=".csv,.txt,.geojson,.json,.zip,.shp" hidden>
            </label>
          </div>
        </div>
        <p class="o-laserdata-status">—</p>
        <div class="o-laserdata-row"><span>Valda rutor</span><span class="o-laserdata-count">0</span></div>
        <div class="o-laserdata-row"><span>Uppskattad storlek</span><span class="o-laserdata-size">—</span></div>
        <div class="o-laserdata-convert">
          <label class="o-laserdata-convert-toggle">
            <input type="checkbox" class="o-laserdata-convert-check">
            <span>Konvertera till lokalt SWEREF</span>
          </label>
          <div class="o-laserdata-convert-box" hidden>
            <label class="o-laserdata-convert-crs-label">Koordinatsystem (mål)
              <select class="o-laserdata-convert-crs">${swerefTargetOptionsHtml()}</select>
            </label>
            <div class="o-laserdata-row"><span>Uppskattad väntetid</span><span class="o-laserdata-convert-time">—</span></div>
            <p class="o-laserdata-convert-note">Grov uppskattning av total väntetid (nedladdning + reprojektion på servern + zip). Punktmoln tar betydligt längre tid än markhöjdmodell.</p>
          </div>
        </div>
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
      const uploadBox = el.querySelector('.o-laserdata-upload-box');
      el.querySelector('.o-laserdata-upload-toggle').addEventListener('click', () => {
        uploadBox.toggleAttribute('hidden', !uploadBox.hasAttribute('hidden'));
      });
      productSelectEl = el.querySelector('.o-laserdata-product');
      if (productSelectEl) productSelectEl.addEventListener('change', () => changeProduct(productSelectEl.value));
      yearSelectEl = el.querySelector('.o-laserdata-year');
      if (yearSelectEl) yearSelectEl.addEventListener('change', () => changeYear(yearSelectEl.value));
      convertCheckEl = el.querySelector('.o-laserdata-convert-check');
      convertBoxEl = el.querySelector('.o-laserdata-convert-box');
      convertCrsEl = el.querySelector('.o-laserdata-convert-crs');
      convertTimeEl = el.querySelector('.o-laserdata-convert-time');
      if (convertCheckEl) convertCheckEl.addEventListener('change', () => {
        if (convertBoxEl) convertBoxEl.toggleAttribute('hidden', !convertCheckEl.checked);
        renderCount();
      });
      if (convertCrsEl) convertCrsEl.addEventListener('change', renderCount);
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
      if (root.PanelDrag) {
        root.PanelDrag.placeDefault(panelEl, {
          navEl: document.getElementById(target),
          others: ['.o-ortofoto-panel']
        });
      }
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
