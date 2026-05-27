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
      layerOpacity = 0.9,
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
    let popupEl;
    let zoneFeatures = [];

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
      const Feature = Origo.ol.Feature;
      const Polygon = Origo.ol.geom.Polygon;
      const feats = [];
      (data.features || []).forEach((gf) => {
        const c = gf.geometry && gf.geometry.coordinates;
        if (!c) return;
        const props = gf.properties || {};
        props.toLon = c[0];
        props.toLat = c[1];
        const ll = landingLonLat(props);
        // Flygväg som yta: korridor längs start->landning, halvbredd vald så
        // ytan ≈ loggad Area (faller tillbaka på Max Distance / default).
        const ring = lineBufferRing(c[0], c[1], ll[0], ll[1], flightRadius(props), mapProj, 20);
        const f = new Feature({ geometry: new Polygon([ring]) });
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

    // Flygväg-ytan fylls i årsfärg. Zon-features har egen stil.
    function styleFn(feature) {
      if (feature.get('_zone')) return null;
      const y = feature.get('year');
      if (!activeYears.has(y)) return null;
      const color = colorForYear(y);
      const { Style, Stroke, Fill } = Origo.ol.style;
      return new Style({
        fill: new Fill({ color: hexToRgba(color, 0.35) }),
        stroke: new Stroke({ color: hexToRgba(color, 0.95), width: 1 })
      });
    }

    function visibleCount() {
      return years.reduce((sum, y) => sum + (activeYears.has(y) ? (yearCount[y] || 0) : 0), 0);
    }

    // ---- popup (flyttbar, fritt placerad ruta) ----
    function ensurePopup() {
      if (popupEl) return;
      popupEl = document.createElement('div');
      popupEl.className = 'o-flights-popup o-flights-popup-float';
      popupEl.style.display = 'none';
      const host = document.getElementById(viewer.getId()) || document.body;
      host.appendChild(popupEl);
    }

    function makeDraggable(handle) {
      handle.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.o-flights-pop-close')) return;
        const r = popupEl.getBoundingClientRect();
        const pr = popupEl.offsetParent
          ? popupEl.offsetParent.getBoundingClientRect() : { left: 0, top: 0 };
        const ox = r.left - pr.left;
        const oy = r.top - pr.top;
        const sx = e.clientX;
        const sy = e.clientY;
        const mv = (ev) => {
          popupEl.style.right = 'auto';
          popupEl.style.left = `${ox + ev.clientX - sx}px`;
          popupEl.style.top = `${oy + ev.clientY - sy}px`;
        };
        const up = () => {
          document.removeEventListener('pointermove', mv);
          document.removeEventListener('pointerup', up);
        };
        document.addEventListener('pointermove', mv);
        document.addEventListener('pointerup', up);
      });
    }

    function hidePopup() { if (popupEl) popupEl.style.display = 'none'; }

    function showPopup(html, pixel) {
      ensurePopup();
      popupEl.innerHTML = html;
      popupEl.style.display = 'block';
      const host = popupEl.offsetParent || popupEl.parentNode;
      const hw = (host && host.clientWidth) || window.innerWidth;
      const hh = (host && host.clientHeight) || window.innerHeight;
      const w = popupEl.offsetWidth || 270;
      const ht = popupEl.offsetHeight || 200;
      let left = (pixel ? pixel[0] : 40) + 14;
      let top = (pixel ? pixel[1] : 40) + 14;
      left = Math.max(8, Math.min(left, hw - w - 8));
      top = Math.max(8, Math.min(top, hh - ht - 8));
      popupEl.style.right = 'auto';
      popupEl.style.left = `${left}px`;
      popupEl.style.top = `${top}px`;
      const close = popupEl.querySelector('.o-flights-pop-close');
      if (close) close.addEventListener('click', () => { hidePopup(); clearZones(); });
      const h4 = popupEl.querySelector('h4');
      if (h4) makeDraggable(h4);
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
    // Flygväg-ytan = korridor längs start->landning. Halvbredden väljs så att
    // ytan ≈ loggad Area. Ground risk buffer enligt 1:1-regeln (= höjd AGL).
    // Contingency saknas i datat (kräver hastighet) och är ett antagande.
    function contingency(h) {
      if (contingencyBufferM != null) return Number(contingencyBufferM) || 0;
      return Math.max(10, 0.5 * (Number(h) || 0));
    }

    function landingLonLat(p) {
      const lLat = Number(p.landLat);
      const lLon = Number(p.landLon);
      if (Number.isFinite(lLat) && Number.isFinite(lLon) && !(lLat === 0 && lLon === 0)) {
        return [lLon, lLat];
      }
      return [Number(p.toLon), Number(p.toLat)];   // ingen landning -> = start
    }

    function legLength(p) {
      const b = landingLonLat(p);
      const lat0 = ((Number(p.toLat) + b[1]) / 2) * (Math.PI / 180);
      const dx = (b[0] - Number(p.toLon)) * 111320 * Math.cos(lat0);
      const dy = (b[1] - Number(p.toLat)) * 111320;
      return Math.hypot(dx, dy);
    }

    // Halvbredd på korridoren: löser π·r² + 2·L·r = Area för r (stadium-yta).
    function flightRadius(p) {
      const a = Number(p.areaSqm) || 0;
      if (a > 0 && a < 1e9) {
        const L = legLength(p);
        return Math.max(5, (-L + Math.sqrt(L * L + Math.PI * a)) / Math.PI);
      }
      const md = Number(p.maxDistanceM) || 0;
      if (md > 0 && md <= 50000) return md;
      return 50;
    }

    // Stadium-formad buffert (korridor) runt linjen A→B med halvcirkel-ändar.
    // Räknas i lokala meter och transformeras till kartprojektionen. Vid A≈B
    // blir det en cirkel (flygning utan separat landningspunkt).
    function lineBufferRing(aLon, aLat, bLon, bLat, radiusM, mapProj, steps) {
      const transform = Origo.ol.proj.transform;
      const lat0 = (aLat + bLat) / 2;
      const mPerLon = 111320 * Math.cos((lat0 * Math.PI) / 180) || 1;
      const mPerLat = 111320;
      const ax = aLon * mPerLon;
      const ay = aLat * mPerLat;
      const bx = bLon * mPerLon;
      const by = bLat * mPerLat;
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy);
      const n = steps || 32;
      const pts = [];
      if (len < 1) {
        for (let i = 0; i <= 2 * n; i += 1) {
          const a = (Math.PI * i) / n;
          pts.push([ax + radiusM * Math.cos(a), ay + radiusM * Math.sin(a)]);
        }
      } else {
        const px = -dy / len;             // enhetsnormal (vänster)
        const py = dx / len;
        const angB = Math.atan2(py, px);
        const angA = angB + Math.PI;
        for (let i = 0; i <= n; i += 1) { // halvcirkel runt B (framåt)
          const t = angB - (Math.PI * i) / n;
          pts.push([bx + radiusM * Math.cos(t), by + radiusM * Math.sin(t)]);
        }
        for (let i = 0; i <= n; i += 1) { // halvcirkel runt A (bakåt)
          const t = angA - (Math.PI * i) / n;
          pts.push([ax + radiusM * Math.cos(t), ay + radiusM * Math.sin(t)]);
        }
      }
      return pts.map((q) => transform([q[0] / mPerLon, q[1] / mPerLat], 'EPSG:4326', mapProj));
    }

    // Buffertfärger: neutralt grått (ljust ytterst -> mörkare innerst) så de
    // aldrig krockar med årsfärgen på flygväg-ytan. Ritas under ytan (zIndex<0).
    function zoneStyle(kind) {
      const { Style, Fill, Stroke } = Origo.ol.style;
      const def = {
        grb: ['rgba(120,120,120,0.16)', 'rgba(110,110,110,0.7)', [6, 5], -20],
        cont: ['rgba(90,90,90,0.20)', 'rgba(80,80,80,0.8)', [4, 4], -10]
      }[kind];
      return new Style({
        fill: new Fill({ color: def[0] }),
        stroke: new Stroke({ color: def[1], width: 1, lineDash: def[2] || undefined }),
        zIndex: def[3]
      });
    }

    function dotStyle(color, z) {
      const { Style, Circle, Fill, Stroke } = Origo.ol.style;
      return new Style({
        image: new Circle({ radius: 4, fill: new Fill({ color }), stroke: new Stroke({ color: '#fff', width: 1.5 }) }),
        zIndex: z || 22
      });
    }

    function clearZones() {
      if (!source) return;
      zoneFeatures.forEach((f) => { try { source.removeFeature(f); } catch (e) { /* redan borta */ } });
      zoneFeatures = [];
    }

    // Ritar buffertarna (contingency + ground risk) runt en redan ritad
    // flygväg-yta, samt centrumlinje och start/landningsmarkörer.
    function drawZones(feature) {
      if (!zones || !source) return;
      const { Feature } = Origo.ol;
      const Polygon = Origo.ol.geom.Polygon;
      const LineString = Origo.ol.geom.LineString;
      const Point = Origo.ol.geom.Point;
      const transform = Origo.ol.proj.transform;
      const { Style, Stroke } = Origo.ol.style;
      const mapProj = map.getView().getProjection();
      clearZones();
      const p = feature.getProperties();
      const aLon = Number(p.toLon);
      const aLat = Number(p.toLat);
      const b = landingLonLat(p);
      const bLon = b[0];
      const bLat = b[1];
      const haveLanding = !(bLon === aLon && bLat === aLat);
      const rFg = flightRadius(p);
      const h = Number(p.maxAltAGL) || 0;
      const rCont = rFg + contingency(h);
      const rGrb = rCont + (h > 0 ? h : 0);
      const add = (f) => { f.set('_zone', true); source.addFeature(f); zoneFeatures.push(f); };
      // contingency + ground risk buffer (under ytan)
      [['grb', rGrb], ['cont', rCont]].forEach((z) => {
        const f = new Feature({ geometry: new Polygon([lineBufferRing(aLon, aLat, bLon, bLat, z[1], mapProj)]) });
        f.setStyle(zoneStyle(z[0]));
        add(f);
      });
      // centrumlinje + markörer ovanpå
      const start = transform([aLon, aLat], 'EPSG:4326', mapProj);
      const yearCol = hexToRgba(colorForYear(p.year), 1);
      if (haveLanding) {
        const end = transform([bLon, bLat], 'EPSG:4326', mapProj);
        const line = new Feature({ geometry: new LineString([start, end]) });
        line.setStyle([
          new Style({ stroke: new Stroke({ color: 'rgba(255,255,255,0.9)', width: 4.5 }), zIndex: 20 }),
          new Style({ stroke: new Stroke({ color: yearCol, width: 2.5 }), zIndex: 21 })
        ]);
        add(line);
        const ef = new Feature({ geometry: new Point(end) });
        ef.setStyle(dotStyle('#c0392b', 22));   // landning (röd)
        add(ef);
      }
      const sf = new Feature({ geometry: new Point(start) });
      sf.setStyle(dotStyle('#2e7d32', 22));      // start (grön)
      add(sf);
    }

    function onClick(evt) {
      if (!active) return;
      let hit = null;
      map.forEachFeatureAtPixel(evt.pixel, (f, lyr) => {
        if (lyr === layer && !hit && !f.get('_zone')) hit = f;
      }, { hitTolerance: 3 });
      if (!hit) { hidePopup(); clearZones(); return; }
      drawZones(hit);
      showPopup(detailHtml(hit.getProperties()), evt.pixel);
    }

    // ---- panel ----
    function buildPanel() {
      const el = document.createElement('div');
      el.className = 'o-flights-panel';
      const zonesLegend = zones ? `
        <div class="o-flights-zones">
          <div class="o-flights-zones-title">Flygväg & buffert (visas vid klick)</div>
          <span><i class="o-flights-zline"></i>Flygväg (färg per år)</span>
          <span><i style="background:rgba(70,70,70,0.4)"></i>Flygområde</span>
          <span><i style="background:rgba(95,95,95,0.3)"></i>Contingency</span>
          <span><i style="background:rgba(120,120,120,0.22)"></i>Ground risk buffer</span>
          <p class="o-flights-zones-note">Buffert längs flygvägen (start→landning). Approximation ur loggdata: flygområde = Max&nbsp;Distance, ground&nbsp;risk = höjd&nbsp;AGL (1:1), contingency = antagande. Verklig bana finns ej i exporten.</p>
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
      hidePopup();
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
