/*!
 * map-links — Origo plugin ("Kartlänkar").
 *
 * Knapp i höger verktygsmeny. Visar ett hårkors mitt i kartvyn; panorera
 * kartan så att hårkorset sitter på den plats du vill länka till. Panelen
 * visar platsens koordinat (SWEREF 99 TM + lat/long) och länkar som öppnar
 * platsen i externa karttjänster – i första hand Google Street View, som
 * hoppar till närmaste gatubild från punkten.
 *
 * Bundlad som en enda IIFE (ingen byggning behövs). Exponerar globalen
 * `MapLinks(options)`. Kräver att `origo.js` laddats först; använder
 * `PanelDrag` (panel-drag.js) om den finns.
 */
(function (root) {
  if (typeof Origo === 'undefined') {
    // eslint-disable-next-line no-console
    console.error('[map-links] Origo-globalen saknas – ladda origo.js före detta skript.');
    return;
  }

  function MapLinks(options = {}) {
    const {
      icon = '#fa-bullseye',
      tooltipText = 'Kartlänkar',
      tooltipPlacement = 'east'
    } = options;

    const cls = 'o-map-links padding-small icon-smaller round light box-shadow';

    let viewer;
    let map;
    let target;
    let mapProj;
    let mlButton;

    let active = false;
    let crosshairEl;
    let lonlat = null; // [lon, lat] för aktuell mittpunkt

    // panel-element
    let panelEl;
    let swerefEl;
    let lonlatEl;

    function currentLonLat() {
      const center = map.getView().getCenter();
      if (!center) return null;
      const ll = Origo.ol.proj.transform(center, mapProj, 'EPSG:4326');
      return { center, lon: ll[0], lat: ll[1] };
    }

    function updateReadout() {
      const c = currentLonLat();
      if (!c) return;
      lonlat = [c.lon, c.lat];
      if (swerefEl) swerefEl.textContent = `${Math.round(c.center[0])}, ${Math.round(c.center[1])}`;
      if (lonlatEl) lonlatEl.textContent = `${c.lat.toFixed(6)}, ${c.lon.toFixed(6)}`;
    }

    function openStreetView() {
      if (!lonlat) return;
      const [lon, lat] = lonlat;
      const url = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lon}`;
      window.open(url, '_blank', 'noopener');
    }

    function openGoogleMaps() {
      if (!lonlat) return;
      const [lon, lat] = lonlat;
      const url = `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
      window.open(url, '_blank', 'noopener');
    }

    // ---------- hårkors ----------
    function showCrosshair() {
      const el = map.getTargetElement && map.getTargetElement();
      if (!el) return;
      if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
      if (!crosshairEl) {
        crosshairEl = document.createElement('div');
        crosshairEl.className = 'o-mlinks-crosshair';
        crosshairEl.innerHTML = `
          <svg viewBox="0 0 48 48" aria-hidden="true">
            <g class="o-mlinks-cross-arms">
              <line x1="24" y1="2" x2="24" y2="16"/>
              <line x1="24" y1="32" x2="24" y2="46"/>
              <line x1="2" y1="24" x2="16" y2="24"/>
              <line x1="32" y1="24" x2="46" y2="24"/>
              <circle cx="24" cy="24" r="9"/>
            </g>
            <circle class="o-mlinks-cross-dot" cx="24" cy="24" r="1.7"/>
          </svg>`;
      }
      if (!crosshairEl.isConnected) el.appendChild(crosshairEl);
    }
    function hideCrosshair() {
      if (crosshairEl && crosshairEl.parentNode) crosshairEl.parentNode.removeChild(crosshairEl);
    }

    // ---------- panel ----------
    const svgExternal = '<svg viewBox="0 0 512 512" aria-hidden="true"><path d="M320 0c-17.7 0-32 14.3-32 32s14.3 32 32 32h82.7L201.4 265.4c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0L448 109.3V192c0 17.7 14.3 32 32 32s32-14.3 32-32V32c0-17.7-14.3-32-32-32H320zM80 32C35.8 32 0 67.8 0 112V432c0 44.2 35.8 80 80 80H400c44.2 0 80-35.8 80-80V320c0-17.7-14.3-32-32-32s-32 14.3-32 32V432c0 8.8-7.2 16-16 16H80c-8.8 0-16-7.2-16-16V112c0-8.8 7.2-16 16-16H192c17.7 0 32-14.3 32-32s-14.3-32-32-32H80z"/></svg>';

    function buildPanel() {
      const el = document.createElement('div');
      el.className = 'o-mlinks-panel';
      el.innerHTML = `
        <button class="o-mlinks-close" type="button" title="Stäng">&times;</button>
        <h3 class="o-mlinks-title">Kartlänkar</h3>
        <p class="o-mlinks-hint">
          Sikta hårkorset mitt i kartan på en plats genom att panorera kartan,
          och öppna platsen i en extern karttjänst.
        </p>
        <div class="o-mlinks-coord"><span>SWEREF 99 TM</span><span class="o-mlinks-sweref">–</span></div>
        <div class="o-mlinks-coord"><span>Lat, long</span><span class="o-mlinks-lonlat">–</span></div>
        <div class="o-mlinks-links">
          <button class="o-mlinks-link o-mlinks-streetview" type="button">${svgExternal}<span>Google Street View</span></button>
          <button class="o-mlinks-link o-mlinks-gmaps" type="button">${svgExternal}<span>Google Maps</span></button>
        </div>
      `;
      swerefEl = el.querySelector('.o-mlinks-sweref');
      lonlatEl = el.querySelector('.o-mlinks-lonlat');
      el.querySelector('.o-mlinks-close').addEventListener('click', close);
      el.querySelector('.o-mlinks-streetview').addEventListener('click', openStreetView);
      el.querySelector('.o-mlinks-gmaps').addEventListener('click', openGoogleMaps);
      if (root.PanelDrag) root.PanelDrag.makeDraggable(el, el.querySelector('.o-mlinks-title'));
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
          others: ['.o-laserdata-panel', '.o-ortofoto-panel', '.o-hp-panel']
        });
      }
    }

    function hidePanel() {
      if (panelEl && panelEl.parentNode) panelEl.parentNode.removeChild(panelEl);
    }

    // ---------- öppna / stäng ----------
    function open() {
      if (active) return;
      active = true;
      showCrosshair();
      map.on('moveend', updateReadout);
      mlButton.setState('active');
      showPanel();
      updateReadout();
    }

    function close() {
      if (!active) return;
      active = false;
      map.un('moveend', updateReadout);
      hideCrosshair();
      mlButton.setState('initial');
      hidePanel();
    }

    function toggle() { if (active) close(); else open(); }

    return Origo.ui.Component({
      name: 'mapLinks',

      onInit() {
        mlButton = Origo.ui.Button({
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
        mapProj = map.getView().getProjection();
        if (!target) target = `${viewer.getMain().getNavigation().getId()}`;
        this.addComponents([mlButton]);
        this.render();
      },

      render() {
        const el = Origo.ui.dom.html(mlButton.render());
        document.getElementById(target).appendChild(el);
        this.dispatch('render');
      }
    });
  }

  root.MapLinks = MapLinks;
}(window));
