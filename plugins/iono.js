/*!
 * iono — Origo plugin "Jonosfär".
 *
 * Lägger en knapp i höger verktygsmeny. När verktyget är aktivt frågar ett
 * klick på kartan tjänsten Jonosfär Direkt (Lantmäteriet, via nginx-proxyn
 * /proxy/iono/latest) och visar den jonosfäriska variabiliteten (mm) i en
 * liten panel samt en färgkodad markör på kartan.
 *
 * Resultatet visas i en fast panel (samma teknik som laserdata-panelen, som
 * bevisligen renderar i den här appen) istället för en OL-overlay, och alla
 * fel skrivs ut både i panelen och i konsolen så att inget "tystnar".
 *
 * Inga inloggningsuppgifter finns i denna fil: nginx/iono-tjänsten injicerar
 * Basic Auth mot Lantmäteriet server-side (IONO_USER / IONO_PASS i compose).
 *
 * Exponerar globalen `Iono(options)`. Kräver att `origo.js` laddats först.
 */
(function (root) {
  if (typeof Origo === 'undefined') {
    // eslint-disable-next-line no-console
    console.error('[iono] Origo-globalen saknas – ladda origo.js före detta skript.');
    return;
  }

  function colorFor(mm) {
    if (mm == null || Number.isNaN(mm)) return '#888';
    if (mm > 10) return '#d23c1e';
    if (mm > 3) return '#e08a1e';
    return '#2e9e3f';
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

  function Iono(options = {}) {
    const {
      endpoint = '/proxy/iono/latest',
      icon = '#fa-signal',
      tooltipText = 'Jonosfär – störning',
      tooltipPlacement = 'east'
    } = options;

    const cls = 'o-iono padding-small icon-smaller round light box-shadow';
    let ionoButton;

    let viewer;
    let map;
    let target;
    let layer;
    let source;
    let active = false;

    // ---- fast resultatpanel (renderas i viewer-elementet) ----
    let panelEl;
    let bodyEl;

    function buildPanel() {
      const el = document.createElement('div');
      el.className = 'o-iono-panel';
      el.innerHTML = `
        <button class="o-iono-close" type="button" title="Stäng">&times;</button>
        <h3 class="o-iono-title">Jonosfär Direkt</h3>
        <div class="o-iono-body"><p class="o-iono-hint">Klicka på kartan för att mäta jonosfärisk störning.</p></div>
      `;
      el.querySelector('.o-iono-close').addEventListener('click', deactivate);
      bodyEl = el.querySelector('.o-iono-body');
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

    function setBody(html) {
      if (bodyEl) bodyEl.innerHTML = html;
    }

    function setMarker(coordinate, color) {
      const { Feature } = Origo.ol;
      const Point = Origo.ol.geom.Point;
      source.clear();
      const f = new Feature({ geometry: new Point(coordinate) });
      f.setStyle(markerStyle(color));
      source.addFeature(f);
    }

    async function query(coordinate) {
      const proj = map.getView().getProjection();
      const lonlat = Origo.ol.proj.toLonLat(coordinate, proj);
      const lon = Number(lonlat[0]).toFixed(6);
      const lat = Number(lonlat[1]).toFixed(6);

      setMarker(coordinate, '#888');
      setBody(`<p>${lat}, ${lon}</p><p class="o-iono-hint">Hämtar…</p>`);

      const url = `${endpoint}?lat=${lat}&lon=${lon}`;
      try {
        const res = await fetch(url, { headers: { Accept: 'application/json' } });
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch (e) { /* icke-JSON svar */ }

        if (!res.ok) {
          const msg = (data && data.error) ? data.error : `HTTP ${res.status}`;
          // eslint-disable-next-line no-console
          console.error('[iono] Fel från proxy:', res.status, text.slice(0, 300));
          setMarker(coordinate, '#888');
          setBody(`<p>${lat}, ${lon}</p><p class="o-iono-err">Fel: ${msg}</p>`);
          return;
        }
        if (!data) {
          setBody(`<p>${lat}, ${lon}</p><p class="o-iono-err">Ogiltigt svar från tjänsten.</p>`);
          return;
        }

        const mm = Number(data.variability);
        const t = data.gpsTime || data.epoch || '';
        const color = colorFor(mm);
        setMarker(coordinate, color);
        setBody(`
          <p>${lat}, ${lon}</p>
          <p class="o-iono-value" style="color:${color}">
            ${Number.isFinite(mm) ? `${mm.toFixed(2)} mm` : '– (ingen mätning)'}
          </p>
          ${t ? `<p class="o-iono-time">${t}</p>` : ''}
        `);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[iono] Nätverksfel mot', url, err);
        setBody(`<p>${lat}, ${lon}</p><p class="o-iono-err">Kunde inte nå tjänsten: ${err.message}</p>`);
      }
    }

    function onClick(evt) {
      if (active) query(evt.coordinate);
    }

    function activate() {
      if (active) return;
      active = true;
      layer.setVisible(true);
      map.on('singleclick', onClick);
      ionoButton.setState('active');
      showPanel();
    }

    function deactivate() {
      if (!active) return;
      active = false;
      map.un('singleclick', onClick);
      source.clear();
      layer.setVisible(false);
      ionoButton.setState('initial');
      hidePanel();
    }

    function toggle() {
      if (active) deactivate();
      else activate();
    }

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
        source = new olSource.Vector();
        layer = new olLayer.Vector({
          source,
          visible: false,
          properties: { name: 'iono-marker', title: 'Jonosfär', queryable: false }
        });
        map.addLayer(layer);

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
