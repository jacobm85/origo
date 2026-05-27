/*!
 * drone-flights — Origo plugin.
 *
 * Klickbart datalager över utförda drönarflygningar (DLB-export). Varje
 * flygning ritas som en cirkel vid startpunkten vars radie följer flygningens
 * verkliga omfattning (Max Distance) men aldrig blir mindre än några pixlar —
 * så syns de som prickar utzoomat och växer till flygområdets storlek när man
 * zoomar in. Färgkodad per år, filtrerbar per år, klick ger detaljer.
 *
 * Datat laddas från en GeoJSON (default flightdata/drone-flights.geojson) som
 * genereras ur CSV:n med tools/flights_csv_to_geojson.py. Filen innehåller
 * persondata och hålls utanför git (mappen flightdata/ monteras in i containern).
 *
 * Bundlad som en IIFE. Exponerar globalen `DroneFlights(options)`. Kräver
 * att `origo.js` laddats först.
 */
(function (root) {
  if (typeof Origo === 'undefined') {
    // eslint-disable-next-line no-console
    console.error('[drone-flights] Origo-globalen saknas – ladda origo.js före detta skript.');
    return;
  }

  const PALETTE = ['#4e79a7', '#59a14f', '#f28e2b', '#e15759', '#b07aa1', '#76b7b2', '#edc948', '#9c755f'];

  function hexToRgba(hex, a) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
    if (!m) return `rgba(120,120,120,${a})`;
    return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
  }

  function fmtArea(sqm) {
    if (!sqm || sqm <= 0) return '–';
    if (sqm >= 10000) return `${(sqm / 10000).toFixed(2)} ha`;
    return `${Math.round(sqm)} m²`;
  }

  function fmtDist(m) {
    if (m == null) return '–';
    if (m >= 1000) return `${(m / 1000).toFixed(2)} km`;
    return `${Math.round(m)} m`;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    ));
  }

  function DroneFlights(options = {}) {
    const {
      dataUrl = 'flightdata/drone-flights.geojson',
      icon = '#drone-top',
      tooltipText = 'Drönarflygningar',
      tooltipPlacement = 'east',
      minPx = 5,      // minsta radie i pixlar (alltid synlig)
      maxPx = 350,    // tak så GPS-utliggare inte fyller skärmen
      layerOpacity = 0.85,
      // Contingency-buffert (m). Finns inte i loggdatat (kräver hastighet) –
      // null => antagande max(10, 0.5 × höjd AGL). Sätt ett tal för fast värde.
      contingencyBufferM = null,
      zones = true    // rita SORA-zoner (flygområde + buffertar) vid klick
    } = options;

    const cls = 'o-flights padding-small icon-smaller round light box-shadow';
    let flightsButton;

    let viewer;
    let map;
    let target;
    let active = false;
    let loaded = false;

    let layer;
    let source;
    let overlay;
    let popupEl;
    let zonesLayer;
    let zonesSource;

    const activeYears = new Set();
    const yearColor = {};
    const yearCount = {};
    let years = [];

    let panelEl;
    let countEl;
    let statusEl;

    function colorForYear(y) { return yearColor[y] || '#888888'; }

    // ---- load features (points; circle is drawn by the style) ----
    async function load() {
      if (loaded) return;
      setStatus('Laddar flygningar…');
      let data;
      try {
        const res = await fetch(dataUrl, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = await res.json();
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[drone-flights] kunde inte ladda', dataUrl, e);
        setStatus(`Kunde inte ladda data: ${e.message}`);
        return;
      }

      const mapProj = map.getView().getProjection();
      const Point = Origo.ol.geom.Point;
      const Feature = Origo.ol.Feature;
      const transform = Origo.ol.proj.transform;
      const feats = [];
      (data.features || []).forEach((gf) => {
        const c = gf.geometry && gf.geometry.coordinates;
        if (!c) return;
        const props = gf.properties || {};
        const f = new Feature({ geometry: new Point(transform([c[0], c[1]], 'EPSG:4326', mapProj)) });
        f.setProperties(props);
        feats.push(f);
        const y = props.year;
        if (y != null) yearCount[y] = (yearCount[y] || 0) + 1;
      });

      years = Object.keys(yearCount).map(Number).sort((a, b) => a - b);
      years.forEach((y, i) => { yearColor[y] = PALETTE[i % PALETTE.length]; activeYears.add(y); });

      source.addFeatures(feats);
      loaded = true;
      buildPanelBody();
      setStatus(`${feats.length} flygningar.`);
      layer.changed();
    }

    // Radien sätts i pixlar utifrån verklig Max Distance och aktuell upplösning,
    // men klampas så att den alltid syns (minPx) och inte skenar (maxPx).
    function styleFn(feature, resolution) {
      const y = feature.get('year');
      if (!activeYears.has(y)) return null;
      const md = Number(feature.get('maxDistanceM')) || 0;
      const proj = map.getView().getProjection();
      const coord = feature.getGeometry().getCoordinates();
      const mPerPx = Origo.ol.proj.getPointResolution(proj, resolution, coord) || resolution;
      let rpx = md / mPerPx;
      if (!Number.isFinite(rpx) || rpx < minPx) rpx = minPx;
      if (rpx > maxPx) rpx = maxPx;
      const color = colorForYear(y);
      const { Style, Circle, Stroke, Fill } = Origo.ol.style;
      return new Style({
        image: new Circle({
          radius: rpx,
          fill: new Fill({ color: hexToRgba(color, 0.4) }),
          stroke: new Stroke({ color: hexToRgba(color, 0.95), width: 1.25 })
        })
      });
    }

    function visibleCount() {
      return years.reduce((sum, y) => sum + (activeYears.has(y) ? (yearCount[y] || 0) : 0), 0);
    }

    // ---- popup ----
    function ensureOverlay() {
      if (overlay) return;
      popupEl = document.createElement('div');
      popupEl.className = 'o-flights-popup';
      overlay = new Origo.ol.Overlay({
        element: popupEl,
        positioning: 'bottom-center',
        offset: [0, -8],
        stopEvent: true,
        autoPan: { animation: { duration: 200 } }
      });
      map.addOverlay(overlay);
    }

    function detailHtml(p) {
      const rows = [
        ['Datum', p.date],
        ['År', p.year],
        ['Projekt', p.project],
        ['Kund', p.customer],
        ['Plats', p.location],
        ['Uppdrag', p.mission],
        ['Typ', p.flightType || p.operation],
        ['Pilot', p.pilot],
        ['Drönare', [p.droneBrand, p.droneModel].filter(Boolean).join(' ') || p.droneName],
        ['Flygtid', p.duration],
        ['Yta', fmtArea(Number(p.areaSqm))],
        ['Max avstånd', fmtDist(Number(p.maxDistanceM))],
        ['Max höjd (AGL)', p.maxAltAGL != null ? `${Math.round(p.maxAltAGL)} m` : '–'],
        ['Org', p.org]
      ].filter((r) => r[1] !== '' && r[1] != null);
      const body = rows.map((r) => `<tr><th>${esc(r[0])}</th><td>${esc(r[1])}</td></tr>`).join('');
      const notes = p.notes ? `<p class="o-flights-notes">${esc(p.notes)}</p>` : '';
      return `<button class="o-flights-pop-close" type="button" title="Stäng">&times;</button>
        <h4 style="border-color:${colorForYear(p.year)}">Flygning ${esc(p.flightNo || '')}</h4>
        <table>${body}</table>${notes}`;
    }

    // ---- SORA-zoner (approximation ur summeringsdatat) ----
    // Flygområde = cirkel med radie = Max Distance (m) (faller tillbaka på ytan).
    // Ground risk buffer enligt 1:1-regeln (= max höjd AGL). Contingency-bufferten
    // saknas i datat (kräver hastighet) och är ett antagande.
    function contingency(h) {
      if (contingencyBufferM != null) return Number(contingencyBufferM) || 0;
      return Math.max(10, 0.5 * (Number(h) || 0));
    }

    function flightRadius(p) {
      let r = Number(p.maxDistanceM) || 0;
      if (!(r > 0) || r > 50000) {            // saknas/orimligt -> härled ur ytan
        const a = Number(p.areaSqm) || 0;
        r = (a > 0 && a < 1e9) ? Math.sqrt(a / Math.PI) : 0;
      }
      return r > 0 ? r : 50;                  // minsta synliga
    }

    function circleRing(lon, lat, radiusM, mapProj, n) {
      const transform = Origo.ol.proj.transform;
      const dLat = radiusM / 111320;
      const dLon = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
      const ring = [];
      const steps = n || 72;
      for (let i = 0; i <= steps; i += 1) {
        const a = (2 * Math.PI * i) / steps;
        ring.push(transform([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)], 'EPSG:4326', mapProj));
      }
      return ring;
    }

    function zoneStyle(kind) {
      const { Style, Fill, Stroke } = Origo.ol.style;
      const def = {
        grb: ['rgba(214,40,30,0.10)', 'rgba(200,30,20,0.95)', [6, 5]],
        cont: ['rgba(240,150,30,0.12)', 'rgba(220,130,0,0.95)', [4, 4]],
        fg: ['rgba(60,120,220,0.18)', 'rgba(30,80,200,0.95)', null]
      }[kind];
      return new Style({
        fill: new Fill({ color: def[0] }),
        stroke: new Stroke({ color: def[1], width: 1.5, lineDash: def[2] || undefined })
      });
    }

    function dotStyle(color) {
      const { Style, Circle, Fill, Stroke } = Origo.ol.style;
      return new Style({ image: new Circle({ radius: 5, fill: new Fill({ color }), stroke: new Stroke({ color: '#fff', width: 1.5 }) }) });
    }

    function clearZones() { if (zonesSource) zonesSource.clear(); }

    function drawZones(feature) {
      if (!zones || !zonesSource) return;
      const { Feature } = Origo.ol;
      const Polygon = Origo.ol.geom.Polygon;
      const LineString = Origo.ol.geom.LineString;
      const Point = Origo.ol.geom.Point;
      const transform = Origo.ol.proj.transform;
      const toLonLat = Origo.ol.proj.toLonLat;
      const mapProj = map.getView().getProjection();
      zonesSource.clear();
      const p = feature.getProperties();
      const center = feature.getGeometry().getCoordinates();
      const ll = toLonLat(center, mapProj);
      const lon = ll[0];
      const lat = ll[1];
      const rFg = flightRadius(p);
      const h = Number(p.maxAltAGL) || 0;
      const rCont = rFg + contingency(h);
      const rGrb = rCont + (h > 0 ? h : 0);
      // yttersta zonen först så inre ritas ovanpå
      [['grb', rGrb], ['cont', rCont], ['fg', rFg]].forEach((z) => {
        const f = new Feature({ geometry: new Polygon([circleRing(lon, lat, z[1], mapProj)]) });
        f.setStyle(zoneStyle(z[0]));
        zonesSource.addFeature(f);
      });
      // flygväg start -> landning (rak linje; verklig bana finns ej i datat)
      const lLat = Number(p.landLat);
      const lLon = Number(p.landLon);
      if (Number.isFinite(lLat) && Number.isFinite(lLon) && !(lLat === 0 && lLon === 0)) {
        const land = transform([lLon, lLat], 'EPSG:4326', mapProj);
        const { Style, Stroke } = Origo.ol.style;
        const line = new Feature({ geometry: new LineString([center, land]) });
        line.setStyle(new Style({ stroke: new Stroke({ color: 'rgba(30,30,30,0.9)', width: 2, lineDash: [2, 6] }) }));
        zonesSource.addFeature(line);
        const lf = new Feature({ geometry: new Point(land) });
        lf.setStyle(dotStyle('#c0392b'));
        zonesSource.addFeature(lf);
      }
      const to = new Feature({ geometry: new Point(center) });
      to.setStyle(dotStyle('#2e7d32'));
      zonesSource.addFeature(to);
    }

    function onClick(evt) {
      if (!active) return;
      let hit = null;
      map.forEachFeatureAtPixel(evt.pixel, (f, lyr) => {
        if (lyr === layer && !hit) hit = f;
      }, { hitTolerance: 3 });
      if (!hit) { if (overlay) overlay.setPosition(undefined); clearZones(); return; }
      ensureOverlay();
      popupEl.innerHTML = detailHtml(hit.getProperties());
      popupEl.querySelector('.o-flights-pop-close').addEventListener('click', () => { overlay.setPosition(undefined); clearZones(); });
      overlay.setPosition(evt.coordinate);
      drawZones(hit);
    }

    // ---- panel ----
    function buildPanel() {
      const el = document.createElement('div');
      el.className = 'o-flights-panel';
      const zonesLegend = zones ? `
        <div class="o-flights-zones">
          <div class="o-flights-zones-title">Flygzoner (visas vid klick)</div>
          <span><i style="background:rgba(60,120,220,0.5);border-color:rgba(30,80,200,0.95)"></i>Flygområde</span>
          <span><i style="background:rgba(240,150,30,0.5);border-color:rgba(220,130,0,0.95)"></i>Contingency</span>
          <span><i style="background:rgba(214,40,30,0.5);border-color:rgba(200,30,20,0.95)"></i>Ground risk buffer</span>
          <p class="o-flights-zones-note">Approximation ur loggdata: flygområde = Max&nbsp;Distance, ground&nbsp;risk = höjd&nbsp;AGL (1:1), contingency = antagande. Verklig bana/yta finns ej i exporten.</p>
        </div>` : '';
      el.innerHTML = `
        <button class="o-flights-close" type="button" title="Stäng">&times;</button>
        <h3 class="o-flights-title">Drönarflygningar</h3>
        <div class="o-flights-years"></div>
        <div class="o-flights-count"></div>
        ${zonesLegend}
        <div class="o-flights-status"></div>
      `;
      el.querySelector('.o-flights-close').addEventListener('click', deactivate);
      countEl = el.querySelector('.o-flights-count');
      statusEl = el.querySelector('.o-flights-status');
      panelEl = el;
      return el;
    }

    function buildPanelBody() {
      if (!panelEl) return;
      const wrap = panelEl.querySelector('.o-flights-years');
      wrap.innerHTML = '';
      years.forEach((y) => {
        const id = `o-flights-y-${y}`;
        const row = document.createElement('label');
        row.className = 'o-flights-year';
        row.htmlFor = id;
        row.innerHTML = `
          <input type="checkbox" id="${id}" checked>
          <i style="background:${colorForYear(y)}"></i>
          <span>${y}</span><span class="o-flights-ycount">${yearCount[y]}</span>`;
        row.querySelector('input').addEventListener('change', (e) => {
          if (e.target.checked) activeYears.add(y); else activeYears.delete(y);
          layer.changed();
          updateCount();
        });
        wrap.appendChild(row);
      });
      updateCount();
    }

    function updateCount() {
      if (countEl) countEl.textContent = `Visar ${visibleCount()} flygningar`;
    }

    function setStatus(t) { if (statusEl) statusEl.textContent = t || ''; }

    function showPanel() {
      if (!panelEl) buildPanel();
      const host = document.getElementById(viewer.getId()) || document.body;
      if (!panelEl.isConnected) host.appendChild(panelEl);
    }

    function hidePanel() {
      if (panelEl && panelEl.parentNode) panelEl.parentNode.removeChild(panelEl);
    }

    // ---- open/close ----
    function activate() {
      if (active) return;
      active = true;
      layer.setVisible(true);
      map.on('singleclick', onClick);
      flightsButton.setState('active');
      showPanel();
      load();
    }

    function deactivate() {
      if (!active) return;
      active = false;
      map.un('singleclick', onClick);
      if (overlay) overlay.setPosition(undefined);
      clearZones();
      layer.setVisible(false);
      flightsButton.setState('initial');
      hidePanel();
    }

    function toggle() { if (active) deactivate(); else activate(); }

    return Origo.ui.Component({
      name: 'droneFlights',

      onInit() {
        flightsButton = Origo.ui.Button({
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
          opacity: layerOpacity,
          visible: false,
          style: styleFn,
          properties: { name: 'drone-flights', title: 'Drönarflygningar', queryable: false }
        });
        map.addLayer(layer);

        // Lager för den klickade flygningens SORA-zoner (ovanpå punktlagret).
        zonesSource = new olSource.Vector();
        zonesLayer = new olLayer.Vector({
          source: zonesSource,
          properties: { name: 'drone-zones', title: 'Drönarzoner', queryable: false }
        });
        map.addLayer(zonesLayer);

        this.addComponents([flightsButton]);
        this.render();
      },

      render() {
        const el = Origo.ui.dom.html(flightsButton.render());
        document.getElementById(target).appendChild(el);
        this.dispatch('render');
      }
    });
  }

  root.DroneFlights = DroneFlights;
}(window));
