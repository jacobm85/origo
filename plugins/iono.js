/*!
 * iono — Origo plugin "Jonosfär".
 *
 * Lägger en knapp i höger verktygsmeny. När verktyget är aktivt frågar ett
 * klick på kartan tjänsten Jonosfär Direkt (Lantmäteriet, via nginx-proxyn
 * /proxy/iono/latest) och visar den jonosfäriska variabiliteten (mm) i en
 * färgkodad popup samt en markör på kartan.
 *
 * Bundlad som en enda IIFE — ingen byggning behövs. Exponerar globalen
 * `Iono(options)`. Kräver att `origo.js` laddats först.
 *
 * Inga inloggningsuppgifter finns i denna fil: nginx injicerar Basic Auth mot
 * Lantmäteriet server-side (se IONO_USER / IONO_PASS i docker-compose.yml).
 */
(function (root) {
  if (typeof Origo === 'undefined') {
    // eslint-disable-next-line no-console
    console.error('[iono] Origo-globalen saknas – ladda origo.js före detta skript.');
    return;
  }

  // Färgtrösklar (mm) – samma som ursprungsverktyget.
  function colorFor(mm) {
    if (mm == null || Number.isNaN(mm)) return '#888';
    if (mm > 10) return '#d23c1e';
    if (mm > 3) return '#e08a1e';
    return '#2e9e3f';
  }

  function markerStyleFn(color) {
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
      tooltipPlacement = 'east',
      layerName = 'iono-marker',
      layerTitle = 'Jonosfär'
    } = options;

    const cls = 'o-iono padding-small icon-smaller round light box-shadow';
    let ionoButton;

    let viewer;
    let map;
    let target;
    let layer;
    let source;
    let overlay;
    let popupEl;
    let active = false;
    let clickKey = null;

    function ensureOverlay() {
      if (overlay) return;
      popupEl = document.createElement('div');
      popupEl.className = 'o-iono-popup';
      popupEl.hidden = true;
      overlay = new Origo.ol.Overlay({
        element: popupEl,
        positioning: 'bottom-center',
        offset: [0, -14],
        stopEvent: true
      });
      map.addOverlay(overlay);
    }

    function setMarker(coordinate, color) {
      const { Feature } = Origo.ol;
      const Point = Origo.ol.geom.Point;
      source.clear();
      const feature = new Feature({ geometry: new Point(coordinate) });
      feature.setStyle(markerStyleFn(color));
      source.addFeature(feature);
    }

    function showPopup(coordinate, html) {
      ensureOverlay();
      popupEl.innerHTML = html;
      popupEl.hidden = false;
      overlay.setPosition(coordinate);
    }

    function hidePopup() {
      if (popupEl) { popupEl.hidden = true; popupEl.innerHTML = ''; }
      if (overlay) overlay.setPosition(undefined);
    }

    async function query(coordinate) {
      const proj = map.getView().getProjection();
      const [lon, lat] = Origo.ol.proj.toLonLat(coordinate, proj);
      const latS = lat.toFixed(6);
      const lonS = lon.toFixed(6);

      setMarker(coordinate, '#888');
      showPopup(coordinate, `<div class="o-iono-card"><b>Jonosfär Direkt</b><br>${latS}, ${lonS}<br>Hämtar…</div>`);

      try {
        const res = await fetch(`${endpoint}?lat=${latS}&lon=${lonS}`);
        if (!res.ok) throw new Error(`Tjänsten svarade ${res.status}`);
        const data = await res.json();
        const mm = Number(data.variability);
        const t = data.gpsTime || '';
        const color = colorFor(mm);
        setMarker(coordinate, color);
        showPopup(coordinate, `
          <div class="o-iono-card">
            <button class="o-iono-close" type="button" title="Stäng">&times;</button>
            <b>Jonosfär Direkt</b><br>
            ${latS}, ${lonS}<br>
            <span class="o-iono-value" style="color:${color}">
              ${Number.isFinite(mm) ? `${mm.toFixed(2)} mm` : '–'}
            </span><br>
            <small>${t}</small>
          </div>`);
        const closeBtn = popupEl.querySelector('.o-iono-close');
        if (closeBtn) closeBtn.addEventListener('click', () => { hidePopup(); source.clear(); });
      } catch (err) {
        showPopup(coordinate, `<div class="o-iono-card">Fel vid hämtning: ${err.message}</div>`);
      }
    }

    function onClick(evt) {
      if (!active) return;
      query(evt.coordinate);
    }

    function activate() {
      if (active) return;
      active = true;
      layer.setVisible(true);
      clickKey = map.on('singleclick', onClick);
      ionoButton.setState('active');
    }

    function deactivate() {
      if (!active) return;
      active = false;
      if (clickKey) { map.un('singleclick', onClick); clickKey = null; }
      hidePopup();
      source.clear();
      layer.setVisible(false);
      ionoButton.setState('initial');
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
          properties: {
            name: layerName,
            title: layerTitle,
            queryable: false
          }
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
