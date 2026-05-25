/*!
 * laserdata-download — Origo plugin.
 *
 * Knapp i höger verktygsmeny. Genererar Lantmäteriets officiella
 * 2,5 × 2,5 km-indexrutnät (SWEREF 99 TM) för den synliga kartvyn, låter
 * användaren markera rutor (klick / Ctrl-dra) och laddar ner motsvarande
 * LAZ-filer som en zip via backend-tjänsten.
 *
 * Rutnätet är regelbundet och alignat mot multiplar av 2500 m. Rutans id
 * (= LAZ-filens stam) byggs ur sydvästra hörnet som `{N/100}_{E/100}_25`,
 * t.ex. SV-hörn E=650000, N=6997500 → "69975_6500_25" (matchar Lantmäteriets
 * filnamn 69975_6500_25.laz). Eftersom hela Sverige är ~165 000 rutor renderas
 * bara rutorna i aktuell vy, och först när man zoomat in tillräckligt.
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
    if (/\/download\/?$/.test(backendBase)) {
      return {
        downloadUrl: backendBase,
        estimateUrl: backendBase.replace(/\/download(\/?)$/, '/estimate$1')
      };
    }
    const base = backendBase.replace(/\/?$/, '/');
    return { downloadUrl: `${base}download`, estimateUrl: `${base}estimate` };
  }

  function LaserdataDownload(options = {}) {
    const {
      backendUrl = '/api/laserdata',
      estimateUrl: estimateUrlOverride,
      cellIdAttribute = 'cell_id',
      maxBytes = 50 * 1024 * 1024 * 1024,
      maxCells = 200,
      icon = '#fa-download',
      tooltipText = 'Laserdata – nedladdning',
      tooltipPlacement = 'east',
      layerName = 'laserdata-grid',
      layerTitle = 'Laserdata rutnät',
      gridProjection = 'EPSG:3006',
      cellSize = 2500,
      // Rendera inte rutnätet när fler än så här många rutor skulle synas.
      maxRenderedCells = 2500
    } = options;

    const { downloadUrl, estimateUrl: derivedEstimate } = deriveUrls(backendUrl);
    const estimateUrl = estimateUrlOverride || derivedEstimate;
    const cls = 'o-laserdata padding-small icon-smaller round light box-shadow';

    let viewer;
    let map;
    let target;
    let layer;
    let source;
    let laserdataButton;

    const selectedIds = new Set();
    let active = false;
    let dragBox = null;
    let estimateTimer = null;
    let lastEstimateSize = null;

    // --- panel ---
    let panelEl;
    let countEl;
    let sizeEl;
    let warnEl;
    let downloadBtn;

    function idFor(eSW, nSW) {
      return `${nSW / 100}_${eSW / 100}_${cellSize / 100}`;
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
          text: String(feature.get(cellIdAttribute) || ''),
          font: '11px sans-serif',
          fill: new Fill({ color: '#222' }),
          stroke: new Stroke({ color: '#fff', width: 2 })
        })
      });
    }

    // Lager-stilfunktion: avgör utseende per ruta utifrån selectedIds. Det gör
    // att markeringen överlever när rutnätet regenereras vid panorering/zoom.
    function styleFn(feature) {
      return selectedIds.has(String(feature.get(cellIdAttribute)))
        ? selectedStyle(feature)
        : defaultStyle();
    }

    // --- grid generation for current view ---
    function rebuildGrid() {
      if (!active) return;
      const view = map.getView();
      const mapProj = view.getProjection();
      const extent = view.calculateExtent(map.getSize());
      const ext = Origo.ol.proj.transformExtent(extent, mapProj, gridProjection);
      const minE = ext[0];
      const minN = ext[1];
      const maxE = ext[2];
      const maxN = ext[3];

      const e0 = Math.floor(minE / cellSize) * cellSize;
      const n0 = Math.floor(minN / cellSize) * cellSize;
      const cols = Math.ceil((maxE - e0) / cellSize);
      const rows = Math.ceil((maxN - n0) / cellSize);

      source.clear();

      if (cols * rows > maxRenderedCells || cols <= 0 || rows <= 0) {
        showWarn('Zooma in för att visa rutnätet.');
        return;
      }
      clearWarn();

      const Polygon = Origo.ol.geom.Polygon;
      const Feature = Origo.ol.Feature;
      const feats = [];
      for (let e = e0; e < maxE; e += cellSize) {
        for (let n = n0; n < maxN; n += cellSize) {
          const ring = [[e, n], [e + cellSize, n], [e + cellSize, n + cellSize], [e, n + cellSize], [e, n]];
          const geom = new Polygon([ring]);
          geom.transform(gridProjection, mapProj);
          const f = new Feature({ geometry: geom });
          f.set(cellIdAttribute, idFor(e, n));
          feats.push(f);
        }
      }
      source.addFeatures(feats);
    }

    // --- selection ---
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
        toggleId(String(hit.get(cellIdAttribute)));
        layer.changed();
        onSelectionChange();
      }
    }

    function selectInExtent(extent) {
      source.forEachFeatureIntersectingExtent(extent, (f) => {
        selectedIds.add(String(f.get(cellIdAttribute)));
      });
      layer.changed();
      onSelectionChange();
    }

    // --- panel state ---
    function showWarn(text) { if (warnEl) { warnEl.hidden = false; warnEl.textContent = text; } }
    function clearWarn() { if (warnEl) { warnEl.hidden = true; warnEl.textContent = ''; } }

    function renderCount() {
      if (countEl) countEl.textContent = String(selectedIds.size);
      const overCount = selectedIds.size > maxCells;
      if (sizeEl) sizeEl.textContent = lastEstimateSize == null ? '—' : formatBytes(lastEstimateSize);
      if (overCount) showWarn(`Mer än ${maxCells} rutor markerade. Minska urvalet.`);
      else if (lastEstimateSize != null && lastEstimateSize > maxBytes) showWarn(`Totalstorlek överskrider ${formatBytes(maxBytes)}.`);
      else clearWarn();
      if (downloadBtn) {
        downloadBtn.disabled = selectedIds.size === 0 || overCount
          || (lastEstimateSize != null && lastEstimateSize > maxBytes);
        downloadBtn.textContent = 'Ladda ner';
      }
    }

    // Fråga backend om totalstorlek (debouncat). Misslyckas tyst → visar "—".
    function scheduleEstimate() {
      if (estimateTimer) clearTimeout(estimateTimer);
      lastEstimateSize = null;
      if (selectedIds.size === 0) { renderCount(); return; }
      estimateTimer = setTimeout(async () => {
        const ids = Array.from(selectedIds);
        try {
          const res = await fetch(estimateUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cells: ids })
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

    function postFormDownload(ids) {
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
      input.name = 'cells';
      input.value = JSON.stringify(ids);
      form.appendChild(input);

      document.body.appendChild(form);
      form.submit();

      setTimeout(() => {
        if (form.parentNode) form.parentNode.removeChild(form);
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      }, 120000);
    }

    async function startDownload() {
      const ids = Array.from(selectedIds);
      if (ids.length === 0) return;
      clearWarn();
      downloadBtn.disabled = true;
      downloadBtn.textContent = 'Validerar…';
      try {
        const res = await fetch(estimateUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cells: ids })
        });
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch (e) { data = { error: text }; }
        if (!res.ok) throw new Error(data && data.error ? data.error : `Backend svarade ${res.status}`);
        downloadBtn.textContent = 'Hämtar zip…';
        postFormDownload(ids);
        setTimeout(renderCount, 1500);
      } catch (err) {
        showWarn(`Kunde inte starta nedladdning: ${err.message}`);
        downloadBtn.disabled = false;
        downloadBtn.textContent = 'Ladda ner';
      }
    }

    function clearSelection() {
      selectedIds.clear();
      layer.changed();
      onSelectionChange();
    }

    function buildPanel() {
      const el = document.createElement('div');
      el.className = 'o-laserdata-panel';
      el.innerHTML = `
        <button class="o-laserdata-close" type="button" title="Stäng">&times;</button>
        <h3 class="o-laserdata-title">Laserdata – nedladdning</h3>
        <p class="o-laserdata-hint">
          Klicka på rutor för att markera. Håll <kbd>Ctrl</kbd>/<kbd>&#8984;</kbd> + dra för flera.
          Zooma in tills rutnätet visas.
        </p>
        <div class="o-laserdata-row"><span>Valda rutor</span><span class="o-laserdata-count">0</span></div>
        <div class="o-laserdata-row"><span>Uppskattad storlek</span><span class="o-laserdata-size">—</span></div>
        <div class="o-laserdata-warn" hidden></div>
        <div class="o-laserdata-actions">
          <button class="o-laserdata-clear" type="button">Rensa</button>
          <button class="o-laserdata-download" type="button" disabled>Ladda ner</button>
        </div>
      `;
      countEl = el.querySelector('.o-laserdata-count');
      sizeEl = el.querySelector('.o-laserdata-size');
      warnEl = el.querySelector('.o-laserdata-warn');
      downloadBtn = el.querySelector('.o-laserdata-download');
      el.querySelector('.o-laserdata-close').addEventListener('click', close);
      el.querySelector('.o-laserdata-clear').addEventListener('click', clearSelection);
      downloadBtn.addEventListener('click', startDownload);
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
      map.on('moveend', rebuildGrid);
      laserdataButton.setState('active');
      showPanel();
      rebuildGrid();
    }

    function close() {
      if (!active) return;
      active = false;
      if (dragBox) { map.removeInteraction(dragBox); dragBox = null; }
      map.un('singleclick', onSingleClick);
      map.un('moveend', rebuildGrid);
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
          properties: { name: layerName, title: layerTitle, queryable: false }
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
