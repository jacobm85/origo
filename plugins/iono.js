/*!
 * iono — Origo plugin "Jonosfär".
 *
 * Knapp i höger verktygsmeny. Visar ett färgat nationellt rutnät (SWEPOS-
 * trafikljus) över jonosfärisk störning som servern bygger på schema, och
 * låter dig klicka på kartan för ett exakt punktvärde. En "Uppdatera"-knapp
 * triggar en ny rutnätsbyggnad på begäran.
 *
 * Färgen (level/color) sätts server-side i iono-tjänsten utifrån "variability",
 * så hela skalan styrs på ett ställe (env i .env). Inga inloggningsuppgifter
 * finns i klienten.
 *
 * Bundlad som en enda IIFE. Exponerar globalen `Iono(options)`. Kräver att
 * `origo.js` laddats först.
 */
(function (root) {
  if (typeof Origo === 'undefined') {
    // eslint-disable-next-line no-console
    console.error('[iono] Origo-globalen saknas – ladda origo.js före detta skript.');
    return;
  }

  function hexToRgba(hex, alpha) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
    if (!m) return `rgba(150,150,150,${alpha})`;
    return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
  }

  function Iono(options = {}) {
    const {
      latestUrl = '/proxy/iono/latest',
      gridUrl = '/proxy/iono/grid',
      refreshUrl = '/proxy/iono/refresh',
      healthUrl = '/proxy/iono/health',
      icon = '#iono-gps',
      tooltipText = 'Jonosfär – störning',
      tooltipPlacement = 'east',
      gridOpacity = 0.5
    } = options;

    const cls = 'o-iono padding-small icon-smaller round light box-shadow';
    let ionoButton;

    let viewer;
    let map;
    let target;
    let active = false;

    let gridLayer;
    let gridSource;
    let markerLayer;
    let markerSource;

    let panelEl;
    let bodyEl;
    let statusEl;

    // ---- grid layer ----
    function buildGridLayer() {
      const { source: olSource, layer: olLayer, style: olStyle } = Origo.ol;
      gridSource = new olSource.Vector();
      gridLayer = new olLayer.Vector({
        source: gridSource,
        opacity: gridOpacity,
        visible: false,
        style: (feature) => {
          const c = feature.get('color') || '#999999';
          if (feature.get('variability') == null) return null; // rita inte tomma celler
          return new olStyle.Style({
            fill: new olStyle.Fill({ color: hexToRgba(c, 0.55) }),
            stroke: new olStyle.Stroke({ color: hexToRgba(c, 0.8), width: 1 })
          });
        },
        properties: { name: 'iono-grid', title: 'Jonosfär', queryable: false, group: 'none' }
      });
      map.addLayer(gridLayer);
      loadGrid();
    }

    // Hämtar rutnäts-GeoJSON (WGS84) och bygger OL-polygoner manuellt,
    // transformerade till kartans projektion via geom.transform. Samma beprövade
    // mönster som ortofoto/laserdata-lagren – OL:s inbyggda GeoJSON-format-
    // reprojektion hamnade fel i EPSG:3006 (påtvingad 'neu'-axelordning), så
    // rutnätet visades i fel projektion.
    async function loadGrid() {
      if (!gridSource) return;
      try {
        const res = await fetch(gridUrl, { headers: { Accept: 'application/json' } });
        if (!res.ok) return;
        const fc = await res.json();
        const { Polygon, MultiPolygon } = Origo.ol.geom;
        const Feature = Origo.ol.Feature;
        const mapProj = map.getView().getProjection();
        const feats = [];
        (fc.features || []).forEach((f) => {
          const g = f.geometry;
          if (!g) return;
          let geom = null;
          if (g.type === 'Polygon') geom = new Polygon(g.coordinates);
          else if (g.type === 'MultiPolygon') geom = new MultiPolygon(g.coordinates);
          if (!geom) return;
          geom.transform('EPSG:4326', mapProj);
          const feat = new Feature({ geometry: geom });
          const p = f.properties || {};
          feat.set('color', p.color);
          feat.set('variability', p.variability);
          feat.set('level', p.level);
          feats.push(feat);
        });
        gridSource.clear();
        gridSource.addFeatures(feats);
      } catch (e) {
        // tyst – rutnätet är en överlagring; klick-funktionen fungerar ändå
      }
    }

    function markerStyle(color) {
      const { Style, Circle, Stroke, Fill } = Origo.ol.style;
      return new Style({
        image: new Circle({
          radius: 8,
          fill: new Fill({ color }),
          stroke: new Stroke({ color: '#fff', width: 2 })
        })
      });
    }

    function setMarker(coordinate, color) {
      const { Feature } = Origo.ol;
      const Point = Origo.ol.geom.Point;
      markerSource.clear();
      const f = new Feature({ geometry: new Point(coordinate) });
      f.setStyle(markerStyle(color));
      markerSource.addFeature(f);
    }

    // ---- panel ----
    function buildPanel() {
      const el = document.createElement('div');
      el.className = 'o-iono-panel';
      el.innerHTML = `
        <button class="o-iono-close" type="button" title="Stäng">&times;</button>
        <h3 class="o-iono-title">Jonosfär</h3>
        <div class="o-iono-legend">
          <span><i style="background:#a6d96a"></i>0–5</span>
          <span><i style="background:#2e9e3f"></i>5–10</span>
          <span><i style="background:#f2c200"></i>10–15</span>
          <span><i style="background:#fdae61"></i>15–20</span>
          <span><i style="background:#e8602c"></i>20–25</span>
          <span><i style="background:#d23c1e"></i>25–30+</span>
        </div>
        <div class="o-iono-legend-unit">Variabilitet (mm)</div>
        <div class="o-iono-body"><p class="o-iono-hint">Klicka på kartan för ett exakt värde.</p></div>
        <div class="o-iono-actions">
          <button class="o-iono-refresh" type="button">Uppdatera rutnätet</button>
        </div>
        <div class="o-iono-status"></div>
      `;
      el.querySelector('.o-iono-close').addEventListener('click', deactivate);
      el.querySelector('.o-iono-refresh').addEventListener('click', refreshNow);
      bodyEl = el.querySelector('.o-iono-body');
      statusEl = el.querySelector('.o-iono-status');
      panelEl = el;
      return el;
    }

    function showPanel() {
      if (!panelEl) buildPanel();
      const host = document.getElementById(viewer.getId()) || document.body;
      if (!panelEl.isConnected) host.appendChild(panelEl);
    }

    function hidePanel() {
      if (panelEl && panelEl.parentNode) panelEl.parentNode.removeChild(panelEl);
    }

    function setBody(html) { if (bodyEl) bodyEl.innerHTML = html; }
    function setStatus(text) { if (statusEl) statusEl.textContent = text || ''; }

    // ---- click query ----
    async function query(coordinate) {
      const proj = map.getView().getProjection();
      const lonlat = Origo.ol.proj.toLonLat(coordinate, proj);
      const lon = Number(lonlat[0]).toFixed(6);
      const lat = Number(lonlat[1]).toFixed(6);

      setMarker(coordinate, '#888');
      setBody(`<p>${lat}, ${lon}</p><p class="o-iono-hint">Hämtar…</p>`);
      try {
        const res = await fetch(`${latestUrl}?lat=${lat}&lon=${lon}`, { headers: { Accept: 'application/json' } });
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch (e) { /* icke-JSON */ }
        if (!res.ok) {
          const msg = (data && data.error) ? data.error : `HTTP ${res.status}`;
          // eslint-disable-next-line no-console
          console.error('[iono] fel från proxy:', res.status, text.slice(0, 300));
          setBody(`<p>${lat}, ${lon}</p><p class="o-iono-err">Fel: ${msg}</p>`);
          return;
        }
        const mm = Number(data.variability);
        const color = data.color || '#888';
        const level = data.level || '';
        const t = data.gpsTime || data.epoch || '';
        setMarker(coordinate, color);
        setBody(`
          <p>${lat}, ${lon}</p>
          <p class="o-iono-value" style="color:${color}">
            ${Number.isFinite(mm) ? `${mm.toFixed(2)} mm` : '–'} ${level ? `<small>(${level})</small>` : ''}
          </p>
          ${t ? `<p class="o-iono-time">${t}</p>` : ''}
        `);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[iono] nätverksfel:', err);
        setBody(`<p>${lat}, ${lon}</p><p class="o-iono-err">Kunde inte nå tjänsten: ${err.message}</p>`);
      }
    }

    function onClick(evt) { if (active) query(evt.coordinate); }

    // ---- refresh on demand ----
    async function getBuiltAt() {
      try {
        const r = await fetch(healthUrl, { headers: { Accept: 'application/json' } });
        const j = await r.json();
        return j.gridBuiltAt || null;
      } catch (e) { return null; }
    }

    async function refreshNow() {
      setStatus('Uppdaterar rutnätet…');
      const before = await getBuiltAt();
      try {
        await fetch(refreshUrl, { headers: { Accept: 'application/json' } });
      } catch (e) {
        setStatus(`Kunde inte starta uppdatering: ${e.message}`);
        return;
      }
      // Polla tills servern byggt om (gridBuiltAt ändras), max ~2 min.
      const deadline = Date.now() + 120000;
      const tick = async () => {
        const now = await getBuiltAt();
        if (now && now !== before) {
          loadGrid();
          setStatus('Rutnätet uppdaterat.');
          return;
        }
        if (Date.now() > deadline) {
          setStatus('Uppdateringen tar längre tid än väntat – prova ladda om strax.');
          return;
        }
        setTimeout(tick, 3000);
      };
      setTimeout(tick, 3000);
    }

    // ---- open / close ----
    function activate() {
      if (active) return;
      active = true;
      if (!gridLayer) buildGridLayer();
      gridLayer.setVisible(true);
      markerLayer.setVisible(true);
      map.on('singleclick', onClick);
      ionoButton.setState('active');
      showPanel();
    }

    function deactivate() {
      if (!active) return;
      active = false;
      map.un('singleclick', onClick);
      if (markerSource) markerSource.clear();
      if (gridLayer) gridLayer.setVisible(false);
      if (markerLayer) markerLayer.setVisible(false);
      ionoButton.setState('initial');
      hidePanel();
    }

    function toggle() { if (active) deactivate(); else activate(); }

    return Origo.ui.Component({
      name: 'iono',

      onInit() {
        ionoButton = Origo.ui.Button({
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
        markerSource = new olSource.Vector();
        markerLayer = new olLayer.Vector({
          source: markerSource,
          visible: false,
          properties: { name: 'iono-marker', title: 'Jonosfär punkt', queryable: false, group: 'none' }
        });
        map.addLayer(markerLayer);

        this.addComponents([ionoButton]);
        this.render();
      },

      render() {
        const el = Origo.ui.dom.html(ionoButton.render());
        document.getElementById(target).appendChild(el);
        this.dispatch('render');
      }
    });
  }

  root.Iono = Iono;
}(window));
