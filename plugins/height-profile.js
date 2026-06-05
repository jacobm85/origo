/*!
 * height-profile — Origo plugin.
 *
 * Knapp i höger verktygsmeny. Låter användaren skapa en höjdprofil längs en
 * linje på tre sätt:
 *   1. Rita en linje direkt i kartan.
 *   2. Klicka och välja en redan ritad linje i valfritt vektorlager
 *      (t.ex. "eget lager").
 *   3. Ladda upp en egen geometri (koordinatlista / GeoJSON / shape-fil) som
 *      läggs i ett lokalt klientlager och kan profileras.
 *
 * Höjderna hämtas från Lantmäteriets "Markhöjd Direkt" (1 m markhöjdmodell).
 * Tjänsten tar emot en GeoJSON-geometri och svarar med samma geometri där varje
 * koordinat fått ett Z-värde. API:t ligger bakom OAuth2 (WSO2) — anropet går via
 * proxyn /proxy/lm-hojd/ → lm-oauth-sidecaren, som lägger på en Bearer-token
 * (hämtad ur LM_OAUTH_KEY/LM_OAUTH_SECRET, samma OAuth2-uppsättning som
 * Fastighetsindelnings-WMS:en) och vidarebefordrar till runtime-gatewayen
 * api.lantmateriet.se. (Basic Auth funkar INTE mot detta API.)
 *
 * Linjen sampelförtätas (jämnt avstånd + alla brytpunkter) innan den skickas
 * så att man kan dra muspekaren över diagrammet och läsa av höjden längs hela
 * sträckan. Punkten under muspekaren markeras även ut på kartan.
 *
 * Bundlad som en enda IIFE (ingen byggning behövs). Exponerar globalen
 * `HeightProfile(options)`. Kräver att `origo.js` laddats först, och använder
 * `TileUpload` (tile-upload.js) för filuppladdning samt `PanelDrag`
 * (panel-drag.js) för att kunna flytta panelen.
 */
(function (root) {
  if (typeof Origo === 'undefined') {
    // eslint-disable-next-line no-console
    console.error('[height-profile] Origo-globalen saknas – ladda origo.js före detta skript.');
    return;
  }

  function fmtMeters(m) {
    if (m == null || Number.isNaN(m)) return '–';
    if (Math.abs(m) >= 1000) return `${(m / 1000).toFixed(2)} km`;
    return `${m.toFixed(m < 10 ? 1 : 0)} m`;
  }

  function fmtElev(z) {
    if (z == null || Number.isNaN(z)) return '–';
    return `${z.toFixed(1)} m`;
  }

  function HeightProfile(options = {}) {
    const {
      // POST hit (GeoJSON-geometri) → feature med Z. Går via OAuth2-proxyn
      // (/proxy/lm-hojd/ → lm-oauth-sidecaren → api.lantmateriet.se). Resursen är
      // markhojd/v1/hojd (API-kontext "markhojd/v1", resurs "/hojd"); det gamla
      // "hojd/v1" är på väg att fasas ut och prenumerationen gäller markhojd.
      backendUrl = '/proxy/lm-hojd/distribution/produkter/markhojd/v1/hojd',
      // CRS-namn som Markhöjd Direkt förväntar sig i geometrins crs-medlem.
      // Kartan är EPSG:3006, koordinatordning [easting, northing].
      crsName = 'urn:ogc:def:crs:EPSG::3006',
      // Mål-avstånd (m) mellan sampel längs linjen. Faktiskt avstånd blir
      // max(spacing, längd / maxSamples) så långa linjer inte spränger taket.
      sampleSpacing = 25,
      maxSamples = 600,
      // Punkter per anrop mot tjänsten (batchas för att undvika för stora hit).
      batchSize = 150,
      icon = '#hp-profile',
      tooltipText = 'Höjdprofil',
      tooltipPlacement = 'east'
    } = options;

    const cls = 'o-height-profile padding-small icon-smaller round light box-shadow';

    let viewer;
    let map;
    let target;
    let mapProj;
    let hpButton;

    let active = false;
    let mode = null;             // 'draw' | 'select' | null
    let drawInteraction = null;
    let modifyInteraction = null;

    // Lager: linjen som profileras + hover-markör, samt uppladdade geometrier.
    let lineSource;
    let lineLayer;
    let markerSource;
    let markerLayer;
    let uploadSource;
    let uploadLayer;

    let activeFeature = null;    // feature i lineLayer som profileras
    let profile = null;          // [{ d, x, y, z }]
    let profileTotal = 0;
    let profileSeq = 0;          // körnings-id så gamla svar kan ignoreras
    let abortCtrl = null;

    // --- panel-element ---
    let panelEl;
    let statusEl;
    let chartEl;          // <svg> i popup-panelen
    let readoutEl;
    let statsEl;
    let crsSelectEl;
    let toolBtns = {};
    let displayBtns = {};

    // 'popup' = litet diagram i panelen, 'dock' = brett diagram i kartans nederkant
    let displayMode = 'popup';
    let dockEl;
    let dockChart;
    let dockReadout;

    // ---------- stilar ----------
    function lineStyle() {
      const { Style, Stroke } = Origo.ol.style;
      return new Style({ stroke: new Stroke({ color: 'rgba(176, 64, 32, 0.95)', width: 3 }) });
    }
    function markerStyle() {
      const { Style, Circle, Stroke, Fill } = Origo.ol.style;
      return new Style({
        image: new Circle({
          radius: 6,
          fill: new Fill({ color: 'rgba(176, 64, 32, 1)' }),
          stroke: new Stroke({ color: '#fff', width: 2 })
        })
      });
    }
    function uploadStyle() {
      const { Style, Stroke, Fill, Circle } = Origo.ol.style;
      return new Style({
        stroke: new Stroke({ color: 'rgba(40, 90, 160, 0.95)', width: 2 }),
        fill: new Fill({ color: 'rgba(40, 90, 160, 0.10)' }),
        image: new Circle({ radius: 4, fill: new Fill({ color: 'rgba(40, 90, 160, 0.95)' }) })
      });
    }

    function setStatus(text, warn) {
      if (!statusEl) return;
      statusEl.textContent = text || '';
      statusEl.classList.toggle('is-warn', !!warn);
    }

    // ---------- geometri → sampel ----------
    function dist(a, b) {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      return Math.sqrt(dx * dx + dy * dy);
    }

    // Plattar ut en linjegeometri till en lista av brytpunkter [[x,y], …].
    function lineVertices(geom) {
      const t = geom.getType();
      const verts = [];
      if (t === 'LineString') {
        geom.getCoordinates().forEach((c) => verts.push([c[0], c[1]]));
      } else if (t === 'MultiLineString') {
        geom.getCoordinates().forEach((part) => part.forEach((c) => verts.push([c[0], c[1]])));
      }
      return verts;
    }

    // Jämnt fördelade sampel längs linjen + start/slut. Returnerar [{x,y,d}].
    function densify(verts) {
      if (verts.length < 2) return verts.map((v) => ({ x: v[0], y: v[1], d: 0 }));
      let total = 0;
      for (let i = 0; i < verts.length - 1; i += 1) total += dist(verts[i], verts[i + 1]);
      if (total === 0) return [{ x: verts[0][0], y: verts[0][1], d: 0 }];
      const step = Math.max(sampleSpacing, total / maxSamples);
      const samples = [{ x: verts[0][0], y: verts[0][1], d: 0 }];
      let dcum = 0;
      let nextAt = step;
      for (let i = 0; i < verts.length - 1; i += 1) {
        const a = verts[i];
        const b = verts[i + 1];
        const seg = dist(a, b);
        if (seg === 0) continue;
        while (nextAt <= dcum + seg + 1e-6) {
          const t = (nextAt - dcum) / seg;
          samples.push({ x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, d: nextAt });
          nextAt += step;
        }
        dcum += seg;
      }
      const last = verts[verts.length - 1];
      if (samples[samples.length - 1].d < total - 1e-6) {
        samples.push({ x: last[0], y: last[1], d: total });
      }
      return samples;
    }

    // ---------- Markhöjd Direkt ----------
    async function fetchElevations(samples, signal) {
      // Skicka batchvis som MultiPoint; svaret är en feature med samma
      // koordinater där tredje elementet är höjden. nodatavalue = saknas.
      const out = new Array(samples.length).fill(null);
      for (let start = 0; start < samples.length; start += batchSize) {
        const slice = samples.slice(start, start + batchSize);
        const body = {
          type: 'MultiPoint',
          crs: { type: 'name', properties: { name: crsName } },
          coordinates: slice.map((s) => [s.x, s.y])
        };
        const res = await fetch(backendUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body),
          signal
        });
        if (res.status === 401 || res.status === 403) {
          throw new Error('Saknar behörighet mot Markhöjd Direkt (OAuth2: kontrollera LM_OAUTH_KEY/LM_OAUTH_SECRET och att appen prenumererar på höjd-API:t).');
        }
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          throw new Error(txt ? `Tjänsten svarade ${res.status}: ${txt.slice(0, 140)}` : `Tjänsten svarade ${res.status}`);
        }
        const data = await res.json();
        const coords = (data && data.geometry && data.geometry.coordinates) || [];
        const noData = data && data.properties && typeof data.properties.nodatavalue === 'number'
          ? data.properties.nodatavalue : null;
        for (let i = 0; i < slice.length; i += 1) {
          const c = coords[i];
          let z = (c && c.length > 2) ? c[2] : null;
          if (z != null && noData != null && z === noData) z = null;
          out[start + i] = z;
        }
      }
      return out;
    }

    async function computeProfile(geom) {
      const verts = lineVertices(geom);
      if (verts.length < 2) {
        setStatus('Ingen linje med minst två punkter hittades.', true);
        return;
      }
      const samples = densify(verts);
      const seq = ++profileSeq;
      if (abortCtrl) { try { abortCtrl.abort(); } catch (e) { /* ignore */ } }
      abortCtrl = new AbortController();
      setStatus(`Hämtar höjder för ${samples.length} punkter…`);
      clearChart();
      try {
        const zs = await fetchElevations(samples, abortCtrl.signal);
        if (seq !== profileSeq) return; // en nyare körning har tagit över
        profile = samples.map((s, i) => ({ d: s.d, x: s.x, y: s.y, z: zs[i] }));
        profileTotal = samples[samples.length - 1].d;
        const valid = profile.filter((p) => p.z != null);
        if (!valid.length) {
          setStatus('Tjänsten gav inga höjdvärden för linjen (utanför täckning?).', true);
          return;
        }
        renderChart();
        renderStats();
        const gaps = profile.length - valid.length;
        setStatus(`Höjdprofil klar – ${valid.length} punkter${gaps ? `, ${gaps} utan data` : ''}. Dra muspekaren över diagrammet.`);
      } catch (err) {
        if (err.name === 'AbortError') return;
        setStatus(err.message || 'Kunde inte hämta höjder.', true);
      } finally {
        if (seq === profileSeq) abortCtrl = null;
      }
    }

    // ---------- diagram ----------
    const SVGNS = 'http://www.w3.org/2000/svg';
    let chartScale = null; // { padL, padR, padT, padB, W, H, x(d), y(z), zMin, zMax }

    // Vilket diagram (popup-panel eller nedre split) som ritas och hovras.
    function currentChart() {
      return displayMode === 'dock'
        ? { svg: dockChart, readout: dockReadout }
        : { svg: chartEl, readout: readoutEl };
    }

    function clearSvg(svg) { if (svg) while (svg.firstChild) svg.removeChild(svg.firstChild); }

    function clearChart() {
      clearSvg(chartEl);
      clearSvg(dockChart);
      if (readoutEl) readoutEl.style.display = 'none';
      if (dockReadout) dockReadout.style.display = 'none';
      chartScale = null;
      hideMarker();
    }

    function svgEl(name, attrs) {
      const el = document.createElementNS(SVGNS, name);
      Object.keys(attrs || {}).forEach((k) => el.setAttribute(k, attrs[k]));
      return el;
    }

    function renderChart() {
      const svg = currentChart().svg;
      if (!svg || !profile) return;
      clearSvg(svg);
      const rect = svg.getBoundingClientRect();
      const W = Math.max(220, Math.round(rect.width) || 320);
      const H = Math.max(110, Math.round(rect.height) || 160);
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      const padL = 44;
      const padR = 10;
      const padT = 10;
      const padB = 20;

      const valid = profile.filter((p) => p.z != null);
      let zMin = Math.min(...valid.map((p) => p.z));
      let zMax = Math.max(...valid.map((p) => p.z));
      if (zMin === zMax) { zMin -= 1; zMax += 1; }
      const vpad = (zMax - zMin) * 0.08;
      zMin -= vpad;
      zMax += vpad;
      const total = profileTotal || 1;

      const xOf = (d) => padL + (d / total) * (W - padL - padR);
      const yOf = (z) => padT + (1 - (z - zMin) / (zMax - zMin)) * (H - padT - padB);
      chartScale = { padL, padR, padT, padB, W, H, xOf, yOf, zMin, zMax, total };

      // vågräta rutnätslinjer + höjd-etiketter (fler i det breda läget)
      const rows = displayMode === 'dock' ? 4 : 2;
      for (let i = 0; i <= rows; i += 1) {
        const z = zMin + ((zMax - zMin) * i) / rows;
        const y = yOf(z);
        svg.appendChild(svgEl('line', { class: 'o-hp-grid', x1: padL, y1: y, x2: W - padR, y2: y }));
        const tick = svgEl('text', { class: 'o-hp-tick', x: padL - 5, y: y + 3, 'text-anchor': 'end' });
        tick.textContent = `${z.toFixed(0)}`;
        svg.appendChild(tick);
      }

      // y-axel + x-axel
      svg.appendChild(svgEl('line', { class: 'o-hp-axis', x1: padL, y1: padT, x2: padL, y2: H - padB }));
      svg.appendChild(svgEl('line', { class: 'o-hp-axis', x1: padL, y1: H - padB, x2: W - padR, y2: H - padB }));

      // sträck-etiketter (fler mellansteg i det breda läget)
      const xticks = displayMode === 'dock' ? 5 : 1;
      for (let i = 0; i <= xticks; i += 1) {
        const d = (total * i) / xticks;
        const anchor = i === 0 ? 'start' : (i === xticks ? 'end' : 'middle');
        const t = svgEl('text', { class: 'o-hp-tick', x: xOf(d), y: H - 6, 'text-anchor': anchor });
        t.textContent = i === 0 ? '0' : fmtMeters(d);
        svg.appendChild(t);
      }

      // fylld area + linje (hoppa över luckor utan data)
      const areaPath = buildAreaPath(xOf, yOf, H - padB);
      if (areaPath) svg.appendChild(svgEl('path', { class: 'o-hp-area', d: areaPath }));
      let linePath = '';
      let penDown = false;
      profile.forEach((p) => {
        if (p.z == null) { penDown = false; return; }
        const x = xOf(p.d);
        const y = yOf(p.z);
        linePath += `${penDown ? ' L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
        penDown = true;
      });
      svg.appendChild(svgEl('path', { class: 'o-hp-line', d: linePath }));

      // hover-grupp (dold tills muspekaren är över diagrammet eller linjen)
      const guide = svgEl('line', { class: 'o-hp-guide', x1: 0, y1: padT, x2: 0, y2: H - padB });
      guide.style.display = 'none';
      guide.setAttribute('data-role', 'guide');
      svg.appendChild(guide);
      const dot = svgEl('circle', { class: 'o-hp-dot', r: 4, cx: 0, cy: 0 });
      dot.style.display = 'none';
      dot.setAttribute('data-role', 'dot');
      svg.appendChild(dot);
    }

    // Sammanhängande fylld area under kurvan (per data-segment).
    function buildAreaPath(xOf, yOf, baseY) {
      if (!profile) return '';
      let path = '';
      let seg = [];
      const flush = () => {
        if (seg.length < 2) { seg = []; return; }
        path += `${path ? ' ' : ''}M${xOf(seg[0].d).toFixed(1)},${baseY.toFixed(1)}`;
        seg.forEach((p) => { path += ` L${xOf(p.d).toFixed(1)},${yOf(p.z).toFixed(1)}`; });
        path += ` L${xOf(seg[seg.length - 1].d).toFixed(1)},${baseY.toFixed(1)} Z`;
        seg = [];
      };
      profile.forEach((p) => { if (p.z == null) flush(); else seg.push(p); });
      flush();
      return path;
    }

    function sampleAtDistance(d) {
      if (!profile || !profile.length) return null;
      // närmaste sampel (profilen är sorterad på d)
      let lo = 0;
      let hi = profile.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (profile[mid].d < d) lo = mid + 1; else hi = mid;
      }
      const cand = [profile[lo], profile[lo - 1]].filter(Boolean);
      cand.sort((a, b) => Math.abs(a.d - d) - Math.abs(b.d - d));
      return cand[0];
    }

    // Markera ett sampel i det aktiva diagrammet + på kartan.
    function highlightSample(s) {
      const ch = currentChart();
      const svg = ch.svg;
      if (!svg || !chartScale || !s) return;
      const gx = chartScale.xOf(s.d);
      const guide = svg.querySelector('[data-role="guide"]');
      const dot = svg.querySelector('[data-role="dot"]');
      if (guide) { guide.setAttribute('x1', gx); guide.setAttribute('x2', gx); guide.style.display = ''; }
      if (dot && s.z != null) {
        dot.setAttribute('cx', gx);
        dot.setAttribute('cy', chartScale.yOf(s.z));
        dot.style.display = '';
      } else if (dot) {
        dot.style.display = 'none';
      }
      if (ch.readout) {
        ch.readout.innerHTML = `<b>${fmtElev(s.z)}</b> · ${fmtMeters(s.d)}`;
        ch.readout.style.display = '';
        const wrapRect = svg.parentNode.getBoundingClientRect();
        const left = (gx / chartScale.W) * wrapRect.width;
        ch.readout.style.left = `${Math.min(wrapRect.width - 8, Math.max(8, left))}px`;
        const topPx = (s.z != null ? chartScale.yOf(s.z) : chartScale.padT) / chartScale.H * wrapRect.height;
        ch.readout.style.top = `${Math.max(0, topPx - 6)}px`;
      }
      showMarker(s.x, s.y);
    }

    function hideHover() {
      [chartEl, dockChart].forEach((svg) => {
        if (!svg) return;
        const g = svg.querySelector('[data-role="guide"]');
        const d = svg.querySelector('[data-role="dot"]');
        if (g) g.style.display = 'none';
        if (d) d.style.display = 'none';
      });
      if (readoutEl) readoutEl.style.display = 'none';
      if (dockReadout) dockReadout.style.display = 'none';
      hideMarker();
    }

    function onChartMove(evt) {
      if (!chartScale || !profile) return;
      const svg = evt.currentTarget;
      const rect = svg.getBoundingClientRect();
      const px = (evt.clientX - rect.left) * (chartScale.W / rect.width);
      const { padL, padR, W, total } = chartScale;
      const frac = Math.min(1, Math.max(0, (px - padL) / (W - padL - padR)));
      highlightSample(sampleAtDistance(frac * total));
    }

    function onChartLeave() { hideHover(); }

    // Närmaste profilpunkt till en kartkoordinat (planärt avstånd).
    function sampleNearestToCoord(coord) {
      if (!profile || !profile.length) return null;
      let best = null;
      let bestD = Infinity;
      for (let i = 0; i < profile.length; i += 1) {
        const p = profile[i];
        const dx = p.x - coord[0];
        const dy = p.y - coord[1];
        const dd = dx * dx + dy * dy;
        if (dd < bestD) { bestD = dd; best = p; }
      }
      return best ? { sample: best, dist: Math.sqrt(bestD) } : null;
    }

    // Muspekare över linjen i kartan → visa motsvarande läge i profilen.
    function onMapPointerMove(evt) {
      if (!active || !profile || evt.dragging) return;
      const near = sampleNearestToCoord(evt.coordinate);
      if (!near) return;
      const res = map.getView().getResolution() || 1;
      if (near.dist > res * 14) { hideHover(); return; }
      highlightSample(near.sample);
    }

    function showMarker(x, y) {
      if (!markerSource) return;
      let f = markerSource.getFeatures()[0];
      const Point = Origo.ol.geom.Point;
      if (!f) {
        f = new Origo.ol.Feature({ geometry: new Point([x, y]) });
        markerSource.addFeature(f);
      } else {
        f.getGeometry().setCoordinates([x, y]);
      }
    }
    function hideMarker() {
      if (markerSource) markerSource.clear();
    }

    function renderStats() {
      if (!statsEl || !profile) return;
      const valid = profile.filter((p) => p.z != null);
      if (!valid.length) { statsEl.innerHTML = ''; return; }
      const zs = valid.map((p) => p.z);
      const zMin = Math.min(...zs);
      const zMax = Math.max(...zs);
      let gain = 0;
      let loss = 0;
      for (let i = 1; i < profile.length; i += 1) {
        const a = profile[i - 1].z;
        const b = profile[i].z;
        if (a == null || b == null) continue;
        const dz = b - a;
        if (dz > 0) gain += dz; else loss -= dz;
      }
      statsEl.innerHTML = `
        <div class="o-hp-stat"><span>Längd</span><span>${fmtMeters(profileTotal)}</span></div>
        <div class="o-hp-stat"><span>Lägsta</span><span>${fmtElev(zMin)}</span></div>
        <div class="o-hp-stat"><span>Högsta</span><span>${fmtElev(zMax)}</span></div>
        <div class="o-hp-stat"><span>Stigning</span><span>+${gain.toFixed(0)} m</span></div>
        <div class="o-hp-stat"><span>Fall</span><span>-${loss.toFixed(0)} m</span></div>
        <div class="o-hp-stat"><span>Skillnad</span><span>${(zMax - zMin).toFixed(1)} m</span></div>
      `;
      if (dockEl) {
        const ds = dockEl.querySelector('.o-hp-dock-stats');
        if (ds) ds.textContent = `${fmtMeters(profileTotal)}  ·  ${fmtElev(zMin)}–${fmtElev(zMax)}  ·  +${gain.toFixed(0)} / -${loss.toFixed(0)} m`;
      }
    }

    // ---------- nedre split-screen-profil ----------
    const DOCK_H = 210;
    let dockResizeHandler = null;

    // Krymp kart-elementet så profilen får nederdelen (riktig split, inte overlay).
    function applySplit(on) {
      const el = map.getTargetElement && map.getTargetElement();
      if (!el) return;
      const pos = getComputedStyle(el).position;
      if (on) {
        if (pos === 'absolute' || pos === 'fixed') el.style.bottom = `${DOCK_H}px`;
        else el.style.height = `calc(100% - ${DOCK_H}px)`;
      } else {
        el.style.bottom = '';
        el.style.height = '';
      }
      requestAnimationFrame(() => map.updateSize());
    }

    function buildDock() {
      const el = document.createElement('div');
      el.className = 'o-hp-dock';
      el.innerHTML = `
        <div class="o-hp-dock-head">
          <span class="o-hp-dock-title">Höjdprofil</span>
          <span class="o-hp-dock-stats"></span>
          <span class="o-hp-dock-spacer"></span>
          <button class="o-hp-dock-pop" type="button" title="Visa som liten popup">Popup</button>
          <button class="o-hp-dock-close" type="button" title="Stäng">&times;</button>
        </div>
        <div class="o-hp-chart-wrap">
          <svg class="o-hp-chart" preserveAspectRatio="none"></svg>
          <div class="o-hp-readout" style="display:none"></div>
        </div>
      `;
      dockChart = el.querySelector('.o-hp-chart');
      dockReadout = el.querySelector('.o-hp-readout');
      dockChart.addEventListener('pointermove', onChartMove);
      dockChart.addEventListener('pointerleave', onChartLeave);
      el.querySelector('.o-hp-dock-pop').addEventListener('click', () => setDisplayMode('popup'));
      el.querySelector('.o-hp-dock-close').addEventListener('click', close);
      dockEl = el;
      return el;
    }

    function showDock() {
      if (!dockEl) buildDock();
      const el = map.getTargetElement && map.getTargetElement();
      const parent = (el && el.parentNode) || document.getElementById(viewer.getId()) || document.body;
      if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
      if (!dockEl.isConnected) parent.appendChild(dockEl);
      applySplit(true);
      if (!dockResizeHandler) {
        dockResizeHandler = () => { map.updateSize(); if (profile && displayMode === 'dock') renderChart(); };
        window.addEventListener('resize', dockResizeHandler);
      }
    }

    function hideDock() {
      applySplit(false);
      if (dockEl && dockEl.parentNode) dockEl.parentNode.removeChild(dockEl);
      if (dockResizeHandler) { window.removeEventListener('resize', dockResizeHandler); dockResizeHandler = null; }
    }

    function setDisplayMode(m) {
      displayMode = m;
      Object.keys(displayBtns).forEach((k) => displayBtns[k] && displayBtns[k].classList.toggle('is-active', k === m));
      if (panelEl) panelEl.classList.toggle('o-hp-mode-dock', m === 'dock');
      if (m === 'dock') showDock(); else hideDock();
      hideHover();
      if (profile) { setTimeout(() => { renderChart(); renderStats(); }, 0); }
    }

    // ---------- linjekällor: rita / välj / ladda upp ----------
    function setActiveLineGeometry(geom) {
      lineSource.clear();
      activeFeature = new Origo.ol.Feature({ geometry: geom });
      lineSource.addFeature(activeFeature);
      computeProfile(geom);
    }

    function setMode(next) {
      // avaktivera ev. ritläge
      if (drawInteraction) { map.removeInteraction(drawInteraction); drawInteraction = null; }
      if (modifyInteraction) { map.removeInteraction(modifyInteraction); modifyInteraction = null; }
      mode = (mode === next) ? null : next;
      Object.keys(toolBtns).forEach((k) => toolBtns[k] && toolBtns[k].classList.toggle('is-active', k === mode));

      if (mode === 'draw') {
        startDraw();
        setStatus('Klicka i kartan för att rita linjen. Dubbelklicka för att avsluta.');
      } else if (mode === 'select') {
        setStatus('Klicka på en linje i kartan för att profilera den.');
      } else {
        setStatus('');
      }
    }

    function startDraw() {
      const Draw = Origo.ol.interaction.Draw;
      lineSource.clear();
      activeFeature = null;
      drawInteraction = new Draw({ source: lineSource, type: 'LineString', style: lineStyle() });
      drawInteraction.on('drawstart', () => { lineSource.clear(); });
      drawInteraction.on('drawend', (e) => {
        activeFeature = e.feature;
        setTimeout(() => {
          if (drawInteraction) { map.removeInteraction(drawInteraction); drawInteraction = null; }
          // tillåt justering av brytpunkterna → räkna om vid ändring
          modifyInteraction = new Origo.ol.interaction.Modify({ source: lineSource });
          modifyInteraction.on('modifyend', () => {
            if (activeFeature) computeProfile(activeFeature.getGeometry());
          });
          map.addInteraction(modifyInteraction);
          mode = null;
          Object.keys(toolBtns).forEach((k) => toolBtns[k] && toolBtns[k].classList.remove('is-active'));
        }, 0);
        computeProfile(e.feature.getGeometry());
      });
      map.addInteraction(drawInteraction);
    }

    // Klick i kartan i "välj"-läge: plocka översta linje-feature.
    function onMapClick(evt) {
      if (!active || mode !== 'select') return;
      let hit = null;
      map.forEachFeatureAtPixel(evt.pixel, (f, lyr) => {
        if (hit || lyr === lineLayer || lyr === markerLayer) return;
        const g = f.getGeometry && f.getGeometry();
        if (!g) return;
        const t = g.getType();
        if (t === 'LineString' || t === 'MultiLineString') hit = f;
      }, { hitTolerance: 6 });
      if (!hit) { setStatus('Ingen linje där. Klicka direkt på en linje.', true); return; }
      setActiveLineGeometry(hit.getGeometry().clone());
    }

    async function handleUpload(file) {
      if (!root.TileUpload) { setStatus('Uppladdningsmodulen (tile-upload.js) saknas.', true); return; }
      const crs = crsSelectEl ? crsSelectEl.value : 'auto';
      setStatus(`Läser ${file.name}…`);
      try {
        const geoms = await root.TileUpload.parse(file, { crs, mapProj });
        if (!geoms.length) { setStatus('Inga geometrier hittades i filen.', true); return; }
        // lägg ALLA geometrier i det lokala klientlagret
        const added = geoms.map((g) => new Origo.ol.Feature({ geometry: g }));
        uploadSource.addFeatures(added);
        uploadLayer.setVisible(true);
        // passa in vyn på det uppladdade
        const ext = uploadSource.getExtent();
        if (ext && Number.isFinite(ext[0])) {
          map.getView().fit(ext, { padding: [40, 40, 40, 40], maxZoom: 16, duration: 300 });
        }
        // profilera första linjen om någon finns
        const lines = geoms.filter((g) => {
          const t = g.getType();
          return t === 'LineString' || t === 'MultiLineString';
        });
        if (lines.length) {
          setActiveLineGeometry(lines[0].clone());
          setStatus(`${geoms.length} geometri(er) inlagda. ${lines.length > 1 ? 'Klickade på första linjen – välj en annan med "Välj linje".' : 'Profilerar linjen.'}`);
          // sätt välj-läge så att fler linjer kan väljas direkt
          mode = 'select';
          Object.keys(toolBtns).forEach((k) => toolBtns[k] && toolBtns[k].classList.toggle('is-active', k === 'select'));
        } else {
          setStatus(`${geoms.length} geometri(er) inlagda, men ingen linje att profilera. Rita eller välj en linje.`, true);
        }
      } catch (err) {
        setStatus(`Kunde inte läsa filen: ${err.message}`, true);
      }
    }

    function clearAll() {
      profile = null;
      profileTotal = 0;
      activeFeature = null;
      if (abortCtrl) { try { abortCtrl.abort(); } catch (e) { /* ignore */ } abortCtrl = null; }
      lineSource && lineSource.clear();
      clearChart();
      if (statsEl) statsEl.innerHTML = '';
      setStatus('');
    }

    // ---------- panel ----------
    function buildPanel() {
      const el = document.createElement('div');
      el.className = 'o-hp-panel';
      el.innerHTML = `
        <button class="o-hp-close" type="button" title="Stäng">&times;</button>
        <h3 class="o-hp-title">Höjdprofil</h3>
        <p class="o-hp-hint">
          Skapa en höjdprofil längs en linje. Höjder från Lantmäteriets
          markhöjdmodell (Markhöjd Direkt). Dra muspekaren över diagrammet för
          att läsa av höjden – punkten visas även i kartan.
        </p>
        <div class="o-hp-tools">
          <button class="o-hp-tool" data-mode="draw" type="button">Rita linje</button>
          <button class="o-hp-tool" data-mode="select" type="button">Välj linje</button>
          <label class="o-hp-tool o-hp-upload-btn">Ladda upp…
            <input type="file" class="o-hp-file" accept=".csv,.txt,.geojson,.json,.zip,.shp" hidden>
          </label>
        </div>
        <div class="o-hp-crs-row">
          <span>Filens koordinatsystem</span>
          <select class="o-hp-crs" title="Koordinatsystemet som den uppladdade filens koordinater är i">
            ${root.TileUpload ? root.TileUpload.crsOptionsHtml() : '<option value="auto">Auto</option>'}
          </select>
        </div>
        <div class="o-hp-display">
          <span>Visning:</span>
          <button class="o-hp-disp is-active" data-display="popup" type="button">Popup</button>
          <button class="o-hp-disp" data-display="dock" type="button">Nederkant</button>
        </div>
        <p class="o-hp-status"></p>
        <div class="o-hp-chart-wrap">
          <svg class="o-hp-chart" preserveAspectRatio="none"></svg>
          <div class="o-hp-readout" style="display:none"></div>
        </div>
        <div class="o-hp-stats"></div>
        <div class="o-hp-actions">
          <button class="o-hp-clear" type="button">Rensa</button>
        </div>
      `;
      statusEl = el.querySelector('.o-hp-status');
      chartEl = el.querySelector('.o-hp-chart');
      readoutEl = el.querySelector('.o-hp-readout');
      statsEl = el.querySelector('.o-hp-stats');
      crsSelectEl = el.querySelector('.o-hp-crs');
      toolBtns = {
        draw: el.querySelector('.o-hp-tool[data-mode="draw"]'),
        select: el.querySelector('.o-hp-tool[data-mode="select"]')
      };
      displayBtns = {
        popup: el.querySelector('.o-hp-disp[data-display="popup"]'),
        dock: el.querySelector('.o-hp-disp[data-display="dock"]')
      };
      displayBtns.popup.addEventListener('click', () => setDisplayMode('popup'));
      displayBtns.dock.addEventListener('click', () => setDisplayMode('dock'));
      toolBtns.draw.addEventListener('click', () => setMode('draw'));
      toolBtns.select.addEventListener('click', () => setMode('select'));
      el.querySelector('.o-hp-close').addEventListener('click', close);
      el.querySelector('.o-hp-clear').addEventListener('click', clearAll);
      const fileInput = el.querySelector('.o-hp-file');
      fileInput.addEventListener('change', (e) => {
        const f = e.target.files && e.target.files[0];
        e.target.value = '';
        if (f) handleUpload(f);
      });
      // hover på diagrammet
      chartEl.addEventListener('pointermove', onChartMove);
      chartEl.addEventListener('pointerleave', onChartLeave);

      if (root.PanelDrag) root.PanelDrag.makeDraggable(el, el.querySelector('.o-hp-title'));
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
          others: ['.o-laserdata-panel', '.o-ortofoto-panel']
        });
      }
      // rita om diagrammet när panelen fått sin bredd
      if (profile) setTimeout(() => { renderChart(); }, 0);
    }

    function hidePanel() {
      if (panelEl && panelEl.parentNode) panelEl.parentNode.removeChild(panelEl);
    }

    // ---------- öppna / stäng ----------
    function open() {
      if (active) return;
      active = true;
      lineLayer.setVisible(true);
      markerLayer.setVisible(true);
      map.on('singleclick', onMapClick);
      map.on('pointermove', onMapPointerMove);
      hpButton.setState('active');
      showPanel();
      if (displayMode === 'dock') setDisplayMode('dock');
    }

    function close() {
      if (!active) return;
      active = false;
      mode = null;
      if (drawInteraction) { map.removeInteraction(drawInteraction); drawInteraction = null; }
      if (modifyInteraction) { map.removeInteraction(modifyInteraction); modifyInteraction = null; }
      if (abortCtrl) { try { abortCtrl.abort(); } catch (e) { /* ignore */ } abortCtrl = null; }
      map.un('singleclick', onMapClick);
      map.un('pointermove', onMapPointerMove);
      hideMarker();
      hideDock();
      lineLayer.setVisible(false);
      markerLayer.setVisible(false);
      hpButton.setState('initial');
      hidePanel();
    }

    function toggle() { if (active) close(); else open(); }

    return Origo.ui.Component({
      name: 'heightProfile',

      onInit() {
        hpButton = Origo.ui.Button({
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

        const { source: olSource, layer: olLayer } = Origo.ol;
        uploadSource = new olSource.Vector();
        uploadLayer = new olLayer.Vector({
          source: uploadSource,
          style: uploadStyle(),
          visible: false,
          properties: { name: 'o-hp-uploads', title: 'Egna geometrier (höjdprofil)', queryable: false, group: 'none' }
        });
        lineSource = new olSource.Vector();
        lineLayer = new olLayer.Vector({
          source: lineSource,
          style: lineStyle(),
          visible: false,
          properties: { name: 'o-hp-line', queryable: false, group: 'none' }
        });
        markerSource = new olSource.Vector();
        markerLayer = new olLayer.Vector({
          source: markerSource,
          style: markerStyle(),
          visible: false,
          properties: { name: 'o-hp-marker', queryable: false, group: 'none' }
        });
        uploadLayer.setZIndex(8990);
        lineLayer.setZIndex(9000);
        markerLayer.setZIndex(9010);
        map.addLayer(uploadLayer);
        map.addLayer(lineLayer);
        map.addLayer(markerLayer);

        this.addComponents([hpButton]);
        this.render();
      },

      render() {
        const el = Origo.ui.dom.html(hpButton.render());
        document.getElementById(target).appendChild(el);
        this.dispatch('render');
      }
    });
  }

  root.HeightProfile = HeightProfile;
}(window));
