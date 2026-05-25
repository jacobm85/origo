/*!
 * laserdata-download — Origo plugin.
 *
 * Markera rutor i ett indexrutnät (Lantmäteriets laserdata) och ladda ner
 * motsvarande LAZ-filer som en zip från backend-tjänsten.
 *
 * Bundlad som en enda IIFE (ingen separat webpack-byggning behövs). Exponerar
 * globalen `LaserdataDownload(options)`. Kräver att `origo.js` laddats först.
 * Källan ligger i origo-map/barebone-plugin-layout i projektets historik.
 */
(function (root) {
  if (typeof Origo === 'undefined') {
    // eslint-disable-next-line no-console
    console.error('[laserdata-download] Origo-globalen saknas – ladda origo.js före detta skript.');
    return;
  }

  // ---------------------------------------------------------------- style ----
  function defaultGridStyle() {
    const { Style, Stroke, Fill } = Origo.ol.style;
    return new Style({
      stroke: new Stroke({ color: 'rgba(40, 90, 160, 0.9)', width: 1 }),
      fill: new Fill({ color: 'rgba(40, 90, 160, 0.05)' })
    });
  }

  function selectedGridStyleFn(idAttribute) {
    const { Style, Stroke, Fill, Text } = Origo.ol.style;
    return (feature) => new Style({
      stroke: new Stroke({ color: 'rgba(200, 60, 30, 1)', width: 2 }),
      fill: new Fill({ color: 'rgba(200, 60, 30, 0.25)' }),
      text: new Text({
        text: String(feature.get(idAttribute) != null ? feature.get(idAttribute) : ''),
        font: '11px sans-serif',
        fill: new Fill({ color: '#222' }),
        stroke: new Stroke({ color: '#fff', width: 2 })
      })
    });
  }

  // ------------------------------------------------------------ selection ----
  function platformModifierKeyOnly(mapBrowserEvent) {
    const ev = mapBrowserEvent.originalEvent;
    const isMac = /(Mac|iPod|iPhone|iPad)/.test(navigator.platform || '');
    const modifier = isMac ? ev.metaKey : ev.ctrlKey;
    return modifier && !ev.altKey && !ev.shiftKey;
  }

  function Selection({
    map,
    layer,
    idAttribute,
    filesizeAttribute,
    selectedStyleFn,
    onChange
  }) {
    const DragBox = Origo.ol.interaction.DragBox;
    const source = layer.getSource();
    const selected = new Map();
    let active = false;
    let dragBox = null;
    let clickListener = null;

    function emit() {
      let totalSize = 0;
      selected.forEach((f) => { totalSize += Number(f.get(filesizeAttribute)) || 0; });
      onChange({
        count: selected.size,
        totalSize,
        ids: Array.from(selected.keys())
      });
    }

    function setSelected(feature, on) {
      const raw = feature.get(idAttribute);
      if (raw == null) return;
      const id = String(raw);
      if (on) {
        if (selected.has(id)) return;
        selected.set(id, feature);
        feature.setStyle(selectedStyleFn(feature));
      } else {
        if (!selected.has(id)) return;
        selected.delete(id);
        feature.setStyle(undefined);
      }
    }

    function toggleFeature(feature) {
      const id = String(feature.get(idAttribute));
      setSelected(feature, !selected.has(id));
    }

    function onSingleClick(evt) {
      if (!active) return;
      let hit = null;
      map.forEachFeatureAtPixel(evt.pixel, (f, lyr) => {
        if (lyr === layer && !hit) hit = f;
      });
      if (hit) {
        toggleFeature(hit);
        emit();
      }
    }

    function activate() {
      if (active) return;
      active = true;
      layer.setVisible(true);

      dragBox = new DragBox({ condition: platformModifierKeyOnly });
      dragBox.on('boxend', () => {
        const extent = dragBox.getGeometry().getExtent();
        source.forEachFeatureIntersectingExtent(extent, (f) => setSelected(f, true));
        emit();
      });
      map.addInteraction(dragBox);

      clickListener = onSingleClick;
      map.on('singleclick', clickListener);
    }

    function deactivate() {
      if (!active) return;
      active = false;
      if (dragBox) { map.removeInteraction(dragBox); dragBox = null; }
      if (clickListener) { map.un('singleclick', clickListener); clickListener = null; }
      layer.setVisible(false);
    }

    function clear() {
      selected.forEach((f) => f.setStyle(undefined));
      selected.clear();
      emit();
    }

    return {
      activate,
      deactivate,
      clear,
      isActive: () => active,
      getIds: () => Array.from(selected.keys()),
      getCount: () => selected.size
    };
  }

  // ---------------------------------------------------------------- panel ----
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

  function Panel({
    selection,
    backendUrl,
    estimateUrlOverride,
    maxBytes,
    maxCells,
    onClose
  }) {
    const { downloadUrl, estimateUrl: derivedEstimate } = deriveUrls(backendUrl);
    const estimateUrl = estimateUrlOverride || derivedEstimate;

    let panelRoot = null;
    let countEl;
    let sizeEl;
    let warnEl;
    let downloadBtn;
    let lastStats = { count: 0, totalSize: 0 };

    function showWarn(text) {
      warnEl.hidden = false;
      warnEl.textContent = text;
    }

    function clearWarn() {
      warnEl.hidden = true;
      warnEl.textContent = '';
    }

    function update(stats) {
      lastStats = stats;
      if (!panelRoot) return;
      countEl.textContent = String(stats.count);
      sizeEl.textContent = formatBytes(stats.totalSize);
      const overSize = stats.totalSize > maxBytes;
      const overCount = stats.count > maxCells;
      const empty = stats.count === 0;
      if (overSize) showWarn(`Totalstorlek överskrider ${formatBytes(maxBytes)}. Minska urvalet.`);
      else if (overCount) showWarn(`Mer än ${maxCells} rutor markerade. Minska urvalet.`);
      else clearWarn();
      downloadBtn.disabled = empty || overSize || overCount;
      downloadBtn.textContent = 'Ladda ner';
    }

    function postFormDownload(ids) {
      // Form-POST i en gömd iframe så webbläsaren strömmar zip:en direkt till
      // disk istället för att buffra den i JS-minnet. Backend-fel landar i
      // iframe:n (osynlig) utan att ersätta användarens sida.
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
      const ids = selection.getIds();
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
        if (!res.ok) {
          const msg = data && data.error ? data.error : `Backend svarade ${res.status}`;
          throw new Error(msg);
        }
        downloadBtn.textContent = 'Hämtar zip…';
        postFormDownload(ids);
        setTimeout(() => update(lastStats), 1500);
      } catch (err) {
        showWarn(`Kunde inte starta nedladdning: ${err.message}`);
        downloadBtn.disabled = false;
        downloadBtn.textContent = 'Ladda ner';
      }
    }

    function build() {
      const el = document.createElement('div');
      el.className = 'o-laserdata-panel';
      el.innerHTML = `
        <button class="o-laserdata-close" type="button" title="Stäng">&times;</button>
        <h3 class="o-laserdata-title">Laserdata – nedladdning</h3>
        <p class="o-laserdata-hint">
          Klicka på rutor för att markera. Håll <kbd>Ctrl</kbd>/<kbd>&#8984;</kbd> + dra för flera.
        </p>
        <div class="o-laserdata-row"><span>Valda rutor</span><span class="o-laserdata-count">0</span></div>
        <div class="o-laserdata-row"><span>Uppskattad storlek</span><span class="o-laserdata-size">0 B</span></div>
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
      el.querySelector('.o-laserdata-close').addEventListener('click', () => onClose());
      el.querySelector('.o-laserdata-clear').addEventListener('click', () => selection.clear());
      downloadBtn.addEventListener('click', startDownload);
      panelRoot = el;
      return el;
    }

    function show(parent) {
      if (!panelRoot) build();
      if (!panelRoot.isConnected) parent.appendChild(panelRoot);
      update(lastStats);
    }

    function hide() {
      if (panelRoot && panelRoot.parentNode) panelRoot.parentNode.removeChild(panelRoot);
    }

    return { show, hide, update };
  }

  // ----------------------------------------------------------- component ----
  function LaserdataDownload(options = {}) {
    const {
      gridUrl = 'data/laserdata-grid.geojson',
      backendUrl = '/api/laserdata',
      estimateUrl,
      cellIdAttribute = 'cell_id',
      filesizeAttribute = 'filesize',
      maxBytes = 50 * 1024 * 1024 * 1024,
      maxCells = 200,
      icon = '#fa-download',
      tooltipText = 'Laserdata – nedladdning',
      tooltipPlacement = 'east',
      layerName = 'laserdata-grid',
      layerTitle = 'Laserdata rutnät',
      dataProjection = 'EPSG:3006'
    } = options;

    const cls = 'o-laserdata padding-small icon-smaller round light box-shadow';
    let laserdataButton;

    let viewer;
    let map;
    let target;
    let layer;
    let selection;
    let panel;

    function open() {
      layer.setVisible(true);
      selection.activate();
      const host = document.getElementById(viewer.getId()) || document.body;
      panel.show(host);
    }

    function close() {
      selection.deactivate();
      panel.hide();
    }

    function toggle() {
      if (selection && selection.isActive()) close();
      else open();
    }

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

        const { source: olSource, layer: olLayer, format: olFormat } = Origo.ol;

        const source = new olSource.Vector({
          url: gridUrl,
          format: new olFormat.GeoJSON({
            dataProjection,
            featureProjection: map.getView().getProjection()
          })
        });

        layer = new olLayer.Vector({
          source,
          style: defaultGridStyle(),
          visible: false,
          properties: {
            name: layerName,
            title: layerTitle,
            queryable: false
          }
        });
        map.addLayer(layer);

        selection = Selection({
          map,
          layer,
          idAttribute: cellIdAttribute,
          filesizeAttribute,
          selectedStyleFn: selectedGridStyleFn(cellIdAttribute),
          onChange: (stats) => { if (panel) panel.update(stats); }
        });

        panel = Panel({
          selection,
          backendUrl,
          estimateUrlOverride: estimateUrl,
          maxBytes,
          maxCells,
          onClose: close
        });

        this.addComponents([laserdataButton]);
        this.render();
      },

      render() {
        const htmlString = laserdataButton.render();
        const el = Origo.ui.dom.html(htmlString);
        document.getElementById(target).appendChild(el);
        this.dispatch('render');
      }
    });
  }

  root.LaserdataDownload = LaserdataDownload;
}(window));
