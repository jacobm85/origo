/*!
 * stompunkt — Origo plugin ("Stompunkter").
 *
 * Redovisar och hjälper dig hitta stompunkter i de nationella referensnäten i
 * plan och höjd, precis som Lantmäteriets e-tjänst "Hitta stompunkt"
 * (https://stompunkt.lantmateriet.se/). Datat är öppna data (CC0) och hämtas
 * ur Digitalt geodetiskt arkiv.
 *
 * Knapp i höger verktygsmeny. När lagret är på hämtas stompunkterna för den
 * aktuella kartvyn (du måste zooma in en bit – nätet är tätt) och ritas som
 * färgkodade punkter (höjd / plan / övrigt). Panelen listar punkterna i vyn,
 * du kan filtrera per nät, söka på namn/ID och slå på förstörda punkter. Klick
 * på en punkt (i kartan eller listan) hämtar fullständiga uppgifter
 * (koordinater, mätmetod, kvalitet, lägesbeskrivning, markering, punktskiss).
 *
 * Anropar e-tjänstens öppna REST-API via nginx-proxyn /proxy/stompunkt/:
 *   POST /proxy/stompunkt/api/filter?includeForstorda=<bool>  (bbox -> punkter)
 *   POST /proxy/stompunkt/api/id?srid=3006                     (id[] -> detaljer)
 * Koordinater i SWEREF 99 TM (EPSG:3006) = kartans projektion, ingen transform.
 *
 * Bundlad som en IIFE (ingen byggning behövs). Exponerar globalen
 * `Stompunkt(options)`. Kräver att `origo.js` laddats först; använder
 * `PanelDrag` (panel-drag.js) om den finns.
 */
(function (root) {
  if (typeof Origo === 'undefined') {
    // eslint-disable-next-line no-console
    console.error('[stompunkt] Origo-globalen saknas – ladda origo.js före detta skript.');
    return;
  }

  // Nätkategorier ur properties.stomnat.natNamn → färg, etikett och symbol.
  const CATS = {
    hojd: { label: 'Höjd', color: '#2c6fbb' },
    plan: { label: 'Plan', color: '#e8862f' },
    ovrig: { label: 'Övrigt', color: '#3d9a5a' }
  };

  function catOf(feature) {
    const n = ((feature.properties && feature.properties.stomnat
      && feature.properties.stomnat.natNamn) || '').toLowerCase();
    if (n.indexOf('höjd') !== -1 || n.indexOf('hojd') !== -1) return 'hojd';
    if (n.indexOf('plan') !== -1) return 'plan';
    return 'ovrig';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    ));
  }

  // Lägesbeskrivningar från arkivet innehåller ibland literala <br>. Escapa
  // allt annat men behåll radbrytningarna.
  function escMultiline(s) {
    return esc(s).replace(/&lt;br\s*\/?&gt;/gi, '<br>');
  }

  function fmtNum(v, dec) {
    if (v == null || v === '' || Number.isNaN(Number(v))) return null;
    return Number(v).toLocaleString('sv-SE', {
      minimumFractionDigits: dec, maximumFractionDigits: dec
    });
  }

  // Mål-koordinatsystem som kan väljas vid nedladdning. SWEREF 99 TM + lokala
  // zoner + WGS84 (alla registrerade i index.json proj4Defs).
  const CRS_OPTIONS = [
    ['EPSG:3006', 'SWEREF 99 TM'],
    ['EPSG:3007', 'SWEREF 99 12 00'],
    ['EPSG:3008', 'SWEREF 99 13 30'],
    ['EPSG:3009', 'SWEREF 99 15 00'],
    ['EPSG:3010', 'SWEREF 99 16 30'],
    ['EPSG:3011', 'SWEREF 99 18 00'],
    ['EPSG:3012', 'SWEREF 99 14 15'],
    ['EPSG:3013', 'SWEREF 99 15 45'],
    ['EPSG:3014', 'SWEREF 99 17 15'],
    ['EPSG:3015', 'SWEREF 99 18 45'],
    ['EPSG:3016', 'SWEREF 99 20 15'],
    ['EPSG:3017', 'SWEREF 99 21 45'],
    ['EPSG:3018', 'SWEREF 99 23 15'],
    ['EPSG:4326', 'WGS 84 (lat/lon)']
  ];

  function Stompunkt(options = {}) {
    const {
      proxyBase = '/proxy/stompunkt',
      icon = '#stompunkt-marker',
      tooltipText = 'Stompunkter',
      tooltipPlacement = 'east',
      // Stompunktsnätet är tätt (≈60 000 punkter). Hämta bara när kartvyns
      // bredd är mindre än så här (meter), annars ber vi användaren zooma in.
      maxViewWidthM = 30000,
      // Tak för antal punkter per nedladdning (PDF = ett anrop/punkt).
      maxExport = 200,
      // Antal samtidiga detalj-/PDF-anrop.
      fetchConcurrency = 5
    } = options;

    const cls = 'o-stompunkt padding-small icon-smaller round light box-shadow';

    let viewer;
    let map;
    let target;
    let spButton;

    let active = false;
    let layer;
    let source;

    let panelEl;
    let listEl;
    let countEl;
    let statusEl;
    let searchEl;
    let forstordaEl;

    // nedladdnings-sektionen
    let dlCrsEl;
    let dlFmtEls = {};
    let dlBtn;
    let dlProgressEl;
    let exporting = false;

    // urval för nedladdning: markerade stompunktId (kvarstår även när man panorerar)
    const exportSel = new Set();
    let markMode = false;            // klick i kartan markerar i stället för att öppna detalj
    let markToggleEl;
    let markCountEl;

    let popupEl;

    let features = [];                 // light-features i aktuell vy (rådata)
    let searchText = '';
    const enabledCats = { hojd: true, plan: true, ovrig: true };
    let includeForstorda = false;
    const detailCache = {};            // stompunktId -> heavy-feature
    let selectedId = null;
    let reqSeq = 0;                    // race-skydd för moveend-hämtningar

    // ---------- API ----------
    async function apiFilter(extent, signalSeq) {
      const [west, south, east, north] = extent;
      const body = {
        geometri: {
          type: 'Polygon',
          crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::3006' } },
          coordinates: [[
            [west, north], [west, south], [east, south], [east, north], [west, north]
          ]]
        },
        buffer: 0
      };
      const url = `${proxyBase}/api/filter?includeForstorda=${includeForstorda ? 'true' : 'false'}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (signalSeq !== reqSeq) return null;   // en nyare begäran har hunnit före
      return (data && data.features) || [];
    }

    async function apiDetail(id) {
      if (detailCache[id]) return detailCache[id];
      const res = await fetch(`${proxyBase}/api/id?srid=3006`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify([id])
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const f = data && data.features && data.features[0];
      if (f) detailCache[id] = f;
      return f;
    }

    // ---------- hämta för aktuell vy ----------
    function viewWidth() {
      const ext = map.getView().calculateExtent(map.getSize());
      return ext[2] - ext[0];
    }

    async function refresh() {
      if (!active) return;
      if (viewWidth() > maxViewWidthM) {
        features = [];
        source.clear();
        renderList();
        setStatus('Zooma in för att visa stompunkter.');
        return;
      }
      reqSeq += 1;
      const seq = reqSeq;
      setStatus('Hämtar stompunkter…');
      const ext = map.getView().calculateExtent(map.getSize());
      let feats;
      try {
        feats = await apiFilter(ext, seq);
      } catch (e) {
        if (seq !== reqSeq) return;
        // eslint-disable-next-line no-console
        console.error('[stompunkt] kunde inte hämta', e);
        setStatus(`Kunde inte hämta: ${e.message}`);
        return;
      }
      if (feats == null) return;       // föråldrad begäran
      features = feats;
      drawFeatures();
      renderList();
    }

    let refreshTimer = null;
    function scheduleRefresh() {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refresh, 300);
    }

    // ---------- karta ----------
    function visible(f) {
      if (!enabledCats[catOf(f)]) return false;
      if (searchText) {
        const p = f.properties || {};
        const hay = `${p.namn || ''} ${p.stompunktId || ''}`.toLowerCase();
        if (hay.indexOf(searchText) === -1) return false;
      }
      return true;
    }

    function drawFeatures() {
      const Feature = Origo.ol.Feature;
      const Point = Origo.ol.geom.Point;
      source.clear();
      const olFeats = [];
      features.forEach((gf) => {
        if (!visible(gf)) return;
        const c = gf.geometry && gf.geometry.coordinates;
        if (!c) return;
        const f = new Feature({ geometry: new Point([c[0], c[1]]) });
        f.set('sp', gf);
        f.setId(gf.properties && gf.properties.stompunktId);
        olFeats.push(f);
      });
      source.addFeatures(olFeats);
    }

    function styleFn(feature) {
      const { Style, RegularShape, Circle, Fill, Stroke } = Origo.ol.style;
      const gf = feature.get('sp');
      const cat = catOf(gf);
      const color = CATS[cat].color;
      const id = feature.getId();
      const sel = selectedId && id === selectedId;
      const marked = exportSel.has(id);
      const styles = [];
      // Markerad för nedladdning → röd ring runt punkten.
      if (marked) {
        styles.push(new Style({
          image: new Circle({
            radius: 14,
            fill: new Fill({ color: 'rgba(232, 18, 58, 0.14)' }),
            stroke: new Stroke({ color: '#e8123a', width: 2.5 })
          }),
          zIndex: 25
        }));
      }
      // Geodetisk triangelsymbol (likt Lantmäteriets karta), större än de gamla
      // prickarna. RegularShape med tre hörn → liksidig triangel med spetsen upp.
      styles.push(new Style({
        image: new RegularShape({
          points: 3,
          radius: sel ? 13 : 9,
          angle: 0,
          fill: new Fill({ color }),
          stroke: new Stroke({ color: sel ? '#d6312b' : '#fff', width: sel ? 3 : 2 })
        }),
        zIndex: sel ? 30 : 10
      }));
      return styles;
    }

    // ---------- detaljpopup ----------
    function ensurePopup() {
      if (popupEl) return;
      popupEl = document.createElement('div');
      popupEl.className = 'o-stompunkt-popup';
      popupEl.style.display = 'none';
      const host = document.getElementById(viewer.getId()) || document.body;
      host.appendChild(popupEl);
    }

    function makeDraggable(handle) {
      handle.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.o-stompunkt-pop-close')) return;
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

    function hidePopup() {
      if (popupEl) popupEl.style.display = 'none';
      if (selectedId) { selectedId = null; if (layer) layer.changed(); }
    }

    function detailHtml(f) {
      const p = f.properties || {};
      const c = (f.geometry && f.geometry.coordinates) || [];
      const cat = CATS[catOf(f)];
      const rows = [];
      const add = (k, v) => { if (v != null && v !== '') rows.push([k, v]); };

      add('Typ', p.typ);
      add('Kategori', p.kategori);
      add('Nät', p.stomnat && p.stomnat.natNamn);
      add('Nordlig (N)', fmtNum(c[1], 3));
      add('Östlig (E)', fmtNum(c[0], 3));
      add('Höjd (H)', c[2] != null ? `${fmtNum(c[2], 4)} m` : null);
      if (p.mbHojd) {
        add('Höjd – ursprung', p.mbHojd.ursprung);
        add('Höjd – mätmetod', p.mbHojd.matmetod);
        add('Höjd – mätår', p.mbHojd.matningDatum);
        add('Höjd – kvalitetsklass', p.mbHojd.kvalitetKlass);
        add('Höjd – lägesosäkerhet', p.mbHojd.lagesosakerhet != null
          ? `${fmtNum(p.mbHojd.lagesosakerhet, 3)} m` : null);
      }
      if (p.mbPlan && (p.mbPlan.ursprung || p.mbPlan.lagesosakerhet != null)) {
        add('Plan – ursprung', p.mbPlan.ursprung);
        add('Plan – lägesosäkerhet', p.mbPlan.lagesosakerhet != null
          ? `${fmtNum(p.mbPlan.lagesosakerhet, 3)} m` : null);
      }
      if (p.markering) {
        add('Markering', [p.markering.markeringTyp, p.markering.material, p.markering.underlag]
          .filter(Boolean).join(', '));
      }
      if (p.historik) {
        add('Återfunnen', p.historik.aterfunnen);
        add('Förstörd', p.historik.forstord);
      }
      add('Kommun', p.kommun);
      add('Län', p.lan);
      add('ID', p.stompunktId);

      const tbody = rows.map((r) => (
        `<tr><th>${esc(r[0])}</th><td>${esc(r[1])}</td></tr>`
      )).join('');

      let beskr = '';
      const lages = (p.anmarkning || []).filter((a) => a && a.anmarkningText);
      if (lages.length) {
        beskr = `<div class="o-stompunkt-beskr">${lages.map((a) => (
          `<div><span class="o-stompunkt-beskr-typ">${esc(a.anmarkningTyp || 'anmärkning')}</span>${escMultiline(a.anmarkningText)}</div>`
        )).join('')}</div>`;
      }

      let bild = '';
      const imgs = (p.bild || []).filter(Boolean);
      if (imgs.length) {
        bild = `<div class="o-stompunkt-skiss">${imgs.map((u) => (
          `<a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="Punktskiss" loading="lazy"></a>`
        )).join('')}</div>`;
      }

      return `
        <button class="o-stompunkt-pop-close" type="button" title="Stäng">&times;</button>
        <h4 style="border-color:${cat.color}">${esc(p.namn || 'Stompunkt')}</h4>
        <table>${tbody}</table>
        ${beskr}
        ${bild}`;
    }

    async function showDetail(id, pixel) {
      ensurePopup();
      selectedId = id;
      if (layer) layer.changed();
      popupEl.innerHTML = '<div class="o-stompunkt-loading">Hämtar uppgifter…</div>';
      popupEl.style.display = 'block';
      placePopup(pixel);
      let f;
      try {
        f = await apiDetail(id);
      } catch (e) {
        popupEl.innerHTML = `<button class="o-stompunkt-pop-close" type="button" title="Stäng">&times;</button><div class="o-stompunkt-loading">Kunde inte hämta uppgifter: ${esc(e.message)}</div>`;
        wirePopup();
        return;
      }
      if (selectedId !== id) return;   // användaren bytte punkt under tiden
      if (!f) {
        popupEl.innerHTML = '<button class="o-stompunkt-pop-close" type="button" title="Stäng">&times;</button><div class="o-stompunkt-loading">Inga uppgifter hittades.</div>';
      } else {
        popupEl.innerHTML = detailHtml(f);
      }
      placePopup(pixel);
      wirePopup();
    }

    function placePopup(pixel) {
      const host = popupEl.offsetParent || popupEl.parentNode;
      const hw = (host && host.clientWidth) || window.innerWidth;
      const hh = (host && host.clientHeight) || window.innerHeight;
      const w = popupEl.offsetWidth || 300;
      const ht = popupEl.offsetHeight || 240;
      let left = (pixel ? pixel[0] : 60) + 14;
      let top = (pixel ? pixel[1] : 60) + 14;
      left = Math.max(8, Math.min(left, hw - w - 8));
      top = Math.max(8, Math.min(top, hh - ht - 8));
      popupEl.style.right = 'auto';
      popupEl.style.left = `${left}px`;
      popupEl.style.top = `${top}px`;
    }

    function wirePopup() {
      const close = popupEl.querySelector('.o-stompunkt-pop-close');
      if (close) close.addEventListener('click', hidePopup);
      const h4 = popupEl.querySelector('h4');
      if (h4) makeDraggable(h4);
    }

    function selectFeature(gf, pixel) {
      const id = gf.properties && gf.properties.stompunktId;
      if (!id) return;
      showDetail(id, pixel);
    }

    function onClick(evt) {
      if (!active) return;
      let hit = null;
      map.forEachFeatureAtPixel(evt.pixel, (f, lyr) => {
        if (lyr === layer && !hit) hit = f;
      }, { hitTolerance: 6 });
      if (!hit) { if (!markMode) hidePopup(); return; }
      if (markMode) {
        toggleMark(hit.getId());
        return;
      }
      selectFeature(hit.get('sp'), evt.pixel);
    }

    // ---------- panel ----------
    function buildPanel() {
      const el = document.createElement('div');
      el.className = 'o-stompunkt-panel';
      const catRows = Object.keys(CATS).map((k) => (
        `<label class="o-stompunkt-cat" title="${esc(CATS[k].label)}">
          <input type="checkbox" data-cat="${k}" checked>
          <i style="background:${CATS[k].color}"></i><span>${esc(CATS[k].label)}</span>
        </label>`
      )).join('');
      el.innerHTML = `
        <button class="o-stompunkt-close" type="button" title="Stäng">&times;</button>
        <h3 class="o-stompunkt-title">Stompunkter</h3>
        <p class="o-stompunkt-hint">
          Stompunkter i nationella referensnäten (plan &amp; höjd). Öppna data
          från Lantmäteriets arkiv. Zooma in för att visa punkter i kartvyn.
        </p>
        <input class="o-stompunkt-search" type="search" placeholder="Sök på namn eller ID i vyn…">
        <div class="o-stompunkt-cats">${catRows}</div>
        <label class="o-stompunkt-forstorda">
          <input type="checkbox" class="o-stompunkt-forstorda-cb"> Visa förstörda punkter
        </label>
        <div class="o-stompunkt-count"></div>
        <div class="o-stompunkt-list"></div>
        <div class="o-stompunkt-status"></div>
        <details class="o-stompunkt-dl" open>
          <summary>Ladda ner stompunkter</summary>
          <div class="o-stompunkt-dl-body">
            <div class="o-stompunkt-dl-mark">
              <button type="button" class="o-stompunkt-mark-toggle">Markera i kartan</button>
              <span class="o-stompunkt-mark-count">inga markerade</span>
              <button type="button" class="o-stompunkt-mark-clear" title="Rensa markering">Rensa</button>
            </div>
            <label class="o-stompunkt-dl-row">
              <span>Koordinatsystem</span>
              <select class="o-stompunkt-dl-crs">
                ${CRS_OPTIONS.map(([c, n]) => `<option value="${c}">${esc(n)}</option>`).join('')}
              </select>
            </label>
            <div class="o-stompunkt-dl-fmts">
              <label><input type="checkbox" data-fmt="csv" checked> CSV</label>
              <label><input type="checkbox" data-fmt="shp" checked> SHP</label>
              <label><input type="checkbox" data-fmt="kmz"> KMZ</label>
              <label><input type="checkbox" data-fmt="pdf"> PDF (LM:s protokoll)</label>
            </div>
            <button type="button" class="o-stompunkt-dl-btn">Ladda ner</button>
            <div class="o-stompunkt-dl-progress"></div>
            <div class="o-stompunkt-dl-hint">
              Bocka för punkter i listan eller klicka "Markera i kartan" och klicka
              på punkterna. Utan markering laddas alla i vyn ner (max ${maxExport}).
              PDF = Lantmäteriets officiella punktprotokoll, ett per punkt.
            </div>
          </div>
        </details>
      `;
      el.querySelector('.o-stompunkt-close').addEventListener('click', deactivate);
      countEl = el.querySelector('.o-stompunkt-count');
      statusEl = el.querySelector('.o-stompunkt-status');
      listEl = el.querySelector('.o-stompunkt-list');
      searchEl = el.querySelector('.o-stompunkt-search');
      forstordaEl = el.querySelector('.o-stompunkt-forstorda-cb');

      searchEl.addEventListener('input', () => {
        searchText = searchEl.value.trim().toLowerCase();
        drawFeatures();
        renderList();
      });
      el.querySelectorAll('.o-stompunkt-cat input').forEach((cb) => {
        cb.addEventListener('change', () => {
          enabledCats[cb.dataset.cat] = cb.checked;
          drawFeatures();
          renderList();
        });
      });
      forstordaEl.addEventListener('change', () => {
        includeForstorda = forstordaEl.checked;
        refresh();
      });

      dlCrsEl = el.querySelector('.o-stompunkt-dl-crs');
      dlProgressEl = el.querySelector('.o-stompunkt-dl-progress');
      dlBtn = el.querySelector('.o-stompunkt-dl-btn');
      dlFmtEls = {};
      el.querySelectorAll('.o-stompunkt-dl-fmts input[data-fmt]').forEach((cb) => {
        dlFmtEls[cb.dataset.fmt] = cb;
      });
      dlBtn.addEventListener('click', runExport);
      markToggleEl = el.querySelector('.o-stompunkt-mark-toggle');
      markCountEl = el.querySelector('.o-stompunkt-mark-count');
      markToggleEl.addEventListener('click', () => setMarkMode(!markMode));
      el.querySelector('.o-stompunkt-mark-clear').addEventListener('click', clearMarks);
      updateExportUi();

      if (root.PanelDrag) root.PanelDrag.makeDraggable(el, el.querySelector('.o-stompunkt-title'));
      panelEl = el;
      return el;
    }

    function renderList() {
      if (!listEl) return;
      const shown = features.filter(visible);
      if (countEl) countEl.textContent = `${shown.length} stompunkter i vyn`;
      listEl.innerHTML = '';
      shown.slice(0, 300).forEach((gf) => {
        const p = gf.properties || {};
        const id = p.stompunktId || '';
        const cat = CATS[catOf(gf)];
        const row = document.createElement('div');
        row.className = 'o-stompunkt-item';
        if (id === selectedId) row.classList.add('is-selected');
        row.innerHTML = `
          <input type="checkbox" class="o-stompunkt-mark-cb" title="Markera för nedladdning" ${exportSel.has(id) ? 'checked' : ''}>
          <i style="background:${cat.color}"></i>
          <span class="o-stompunkt-item-name">${esc(p.namn || '(namnlös)')}</span>
          <span class="o-stompunkt-item-id">${esc(id)}</span>`;
        const cb = row.querySelector('.o-stompunkt-mark-cb');
        cb.dataset.id = id;
        cb.addEventListener('click', (e) => e.stopPropagation());
        cb.addEventListener('change', () => setMarked(id, cb.checked));
        const nameEl = row.querySelector('.o-stompunkt-item-name');
        const idEl = row.querySelector('.o-stompunkt-item-id');
        [nameEl, idEl, row.querySelector('i')].forEach((elm) => {
          elm.style.cursor = 'pointer';
          elm.addEventListener('click', () => {
            const c = gf.geometry && gf.geometry.coordinates;
            if (c) map.getView().animate({ center: [c[0], c[1]], duration: 250 });
            selectFeature(gf, null);
            renderList();
          });
        });
        listEl.appendChild(row);
      });
      if (shown.length > 300) {
        const more = document.createElement('div');
        more.className = 'o-stompunkt-more';
        more.textContent = `…och ${shown.length - 300} till. Zooma in eller sök för att begränsa.`;
        listEl.appendChild(more);
      }
      updateExportUi();
    }

    function setStatus(t) { if (statusEl) statusEl.textContent = t || ''; }

    // ---------- nedladdning / export ----------
    function setDlProgress(t, warn) {
      if (!dlProgressEl) return;
      dlProgressEl.textContent = t || '';
      dlProgressEl.classList.toggle('is-warn', !!warn);
    }

    // Markering för nedladdning
    function afterSelChange() {
      if (layer) layer.changed();
      syncListChecks();
      updateExportUi();
    }
    function setMarked(id, on) {
      if (!id) return;
      if (on) exportSel.add(id); else exportSel.delete(id);
      afterSelChange();
    }
    function toggleMark(id) { if (id) setMarked(id, !exportSel.has(id)); }
    function clearMarks() { exportSel.clear(); afterSelChange(); }
    function syncListChecks() {
      if (!listEl) return;
      listEl.querySelectorAll('.o-stompunkt-mark-cb').forEach((cb) => {
        cb.checked = exportSel.has(cb.dataset.id);
      });
    }
    function setMarkMode(on) {
      markMode = on;
      if (markToggleEl) markToggleEl.classList.toggle('is-active', markMode);
      const el = map.getTargetElement && map.getTargetElement();
      if (el) el.style.cursor = markMode ? 'crosshair' : '';
      if (markMode) hidePopup();
    }
    function updateExportUi() {
      const n = exportSel.size;
      if (markCountEl) markCountEl.textContent = n ? `${n} markerade` : 'inga markerade';
      if (dlBtn) {
        const shown = features.filter(visible).length;
        dlBtn.textContent = n ? `Ladda ner ${n} markerade` : `Ladda ner alla i vyn (${shown})`;
      }
    }

    function numericSrid(code) { return parseInt(String(code).split(':')[1], 10); }

    // Hämta nästlat värde utan att krascha på saknade objekt.
    function g(obj, path) {
      let cur = obj;
      for (let i = 0; i < path.length; i += 1) {
        if (cur == null) return undefined;
        cur = cur[path[i]];
      }
      return cur;
    }

    function round(v, d) {
      const n = Number(v);
      return (v == null || v === '' || !Number.isFinite(n)) ? null : Number(n.toFixed(d));
    }

    function safeName(s) {
      return String(s == null ? '' : s).replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'punkt';
    }

    // Bygg ett export-record (attribut + koordinater i målsystemet + WGS84 för KML).
    function pointRecord(f, targetCode) {
      const p = f.properties || {};
      const c = (f.geometry && f.geometry.coordinates) || [];
      const E0 = c[0];
      const N0 = c[1];
      const H = c.length > 2 ? c[2] : null;
      const transform = Origo.ol.proj.transform;
      const xy = targetCode === 'EPSG:3006' ? [E0, N0] : transform([E0, N0], 'EPSG:3006', targetCode);
      const lonlat = targetCode === 'EPSG:4326' ? xy : transform([E0, N0], 'EPSG:3006', 'EPSG:4326');
      const dec = targetCode === 'EPSG:4326' ? 8 : 3;

      const beskr = (p.anmarkning || []).filter((a) => a && a.anmarkningText)
        .map((a) => `${a.anmarkningTyp ? `${a.anmarkningTyp}: ` : ''}${a.anmarkningText}`)
        .join(' | ').replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim();
      const markering = [g(p, ['markering', 'markeringTyp']), g(p, ['markering', 'material']),
        g(p, ['markering', 'underlag'])].filter(Boolean).join(', ');

      // Ordnade kolumner (P/N/E/H främst), används för CSV och .dbf.
      const props = {
        Punkt: p.namn || '',
        ID: p.stompunktId || '',
        Nat: g(p, ['stomnat', 'natNamn']) || '',
        Typ: p.typ || '',
        Kategori: p.kategori || '',
        N: round(xy[1], dec),
        E: round(xy[0], dec),
        H: round(H, 4),
        CRS: targetCode,
        H_metod: g(p, ['mbHojd', 'matmetod']) || '',
        H_kvalitet: g(p, ['mbHojd', 'kvalitetKlass']) || '',
        H_osaker: round(g(p, ['mbHojd', 'lagesosakerhet']), 3),
        Plan_kval: g(p, ['mbPlan', 'kvalitetKlass']) || '',
        Plan_osaker: round(g(p, ['mbPlan', 'lagesosakerhet']), 3),
        Markering: markering,
        Kommun: p.kommun || '',
        Lan: p.lan || '',
        Beskrivning: beskr
      };
      return {
        props,
        coord: [xy[0], xy[1]],
        name: p.namn || p.stompunktId || 'Stompunkt',
        id: p.stompunktId || '',
        lonlat,
        alt: round(H, 3)
      };
    }

    const EXPORT_HEADERS = ['Punkt', 'ID', 'Nat', 'Typ', 'Kategori', 'N', 'E', 'H', 'CRS',
      'H_metod', 'H_kvalitet', 'H_osaker', 'Plan_kval', 'Plan_osaker', 'Markering',
      'Kommun', 'Lan', 'Beskrivning'];

    // Kör asynkrona jobb med en begränsning på antal samtidiga.
    async function mapLimit(items, limit, fn, onProgress) {
      const out = new Array(items.length);
      let idx = 0;
      let done = 0;
      async function worker() {
        while (idx < items.length) {
          const i = idx;
          idx += 1;
          try { out[i] = await fn(items[i], i); } catch (e) { out[i] = null; }
          done += 1;
          if (onProgress) onProgress(done);
        }
      }
      const n = Math.min(limit, items.length) || 1;
      await Promise.all(Array.from({ length: n }, worker));
      return out;
    }

    async function fetchPdf(id, sridNum) {
      const url = `${proxyBase}/export/pdf/${encodeURIComponent(id)}?srid=${sridNum}`;
      const res = await fetch(url, { headers: { Accept: 'application/pdf' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    }

    async function runExport() {
      if (exporting) return;
      if (!root.GeoExport) { setDlProgress('Exportmodulen (geo-export.js) saknas.', true); return; }
      const GE = root.GeoExport;
      const fmts = Object.keys(dlFmtEls).filter((k) => dlFmtEls[k].checked);
      if (!fmts.length) { setDlProgress('Välj minst ett format.', true); return; }
      const targetCode = dlCrsEl.value;
      // Markerade punkter om några finns, annars alla i vyn.
      const ids = (exportSel.size
        ? Array.from(exportSel)
        : features.filter(visible).map((gf) => gf.properties && gf.properties.stompunktId))
        .filter(Boolean);
      if (!ids.length) { setDlProgress('Markera punkter, eller zooma in så att punkter visas i vyn.', true); return; }
      const capped = ids.length > maxExport;
      const list = ids.slice(0, maxExport);

      exporting = true;
      dlBtn.disabled = true;
      try {
        // 1) full metadata per punkt (detalj-API, srid 3006 – cachas)
        setDlProgress(`Hämtar uppgifter 0/${list.length}…`);
        const details = await mapLimit(list, fetchConcurrency,
          (id) => apiDetail(id),
          (d) => setDlProgress(`Hämtar uppgifter ${d}/${list.length}…`));
        const recs = details.filter(Boolean).map((f) => pointRecord(f, targetCode));
        if (!recs.length) { setDlProgress('Kunde inte hämta uppgifter för punkterna.', true); return; }

        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        const files = [];

        if (fmts.indexOf('csv') !== -1) {
          files.push({ name: `stompunkter_${stamp}.csv`, data: GE.buildCsv(EXPORT_HEADERS, recs.map((r) => r.props)) });
        }
        if (fmts.indexOf('shp') !== -1) {
          const out = GE.buildPointShapefile(recs.map((r) => ({ coord: r.coord, props: r.props })), EXPORT_HEADERS);
          const enc = new TextEncoder();
          const base = `stompunkter_${stamp}`;
          files.push({ name: `${base}.shp`, data: out.shp });
          files.push({ name: `${base}.shx`, data: out.shx });
          files.push({ name: `${base}.dbf`, data: out.dbf });
          files.push({ name: `${base}.prj`, data: enc.encode(GE.prjFor(targetCode)) });
          files.push({ name: `${base}.cpg`, data: enc.encode('UTF-8') });
        }
        if (fmts.indexOf('kmz') !== -1) {
          const kmz = await GE.buildKmz(recs.map((r) => ({
            name: r.name, lon: r.lonlat[0], lat: r.lonlat[1], alt: r.alt,
            rows: EXPORT_HEADERS.map((h) => [h, r.props[h]])
          })), 'Stompunkter');
          files.push({ name: `stompunkter_${stamp}.kmz`, data: new Uint8Array(await kmz.arrayBuffer()) });
        }
        if (fmts.indexOf('pdf') !== -1) {
          // PDF-protokollet använder plana koordinater; WGS84 → fall tillbaka på 3006.
          const sridNum = targetCode === 'EPSG:4326' ? 3006 : numericSrid(targetCode);
          const usedNames = {};
          setDlProgress(`Hämtar PDF 0/${recs.length}…`);
          const pdfs = await mapLimit(recs, fetchConcurrency,
            (r) => fetchPdf(r.id, sridNum).then((data) => ({ r, data })),
            (d) => setDlProgress(`Hämtar PDF ${d}/${recs.length}…`));
          pdfs.filter(Boolean).forEach(({ r, data }) => {
            let nm = `${safeName(r.name)}_${safeName(r.id)}`;
            if (usedNames[nm]) { usedNames[nm] += 1; nm = `${nm}_${usedNames[nm]}`; } else usedNames[nm] = 1;
            files.push({ name: `pdf/${nm}.pdf`, data });
          });
        }

        if (!files.length) { setDlProgress('Inget att ladda ner.', true); return; }
        setDlProgress('Bygger zip…');
        const blob = await GE.buildZip(files);
        GE.download(blob, `stompunkter_${stamp}.zip`);
        setDlProgress(`Klar – ${recs.length} punkter${capped ? ` (begränsat till ${maxExport})` : ''}.`);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[stompunkt] export', err);
        setDlProgress(`Fel vid nedladdning: ${err.message}`, true);
      } finally {
        exporting = false;
        dlBtn.disabled = false;
      }
    }

    function showPanel() {
      if (!panelEl) buildPanel();
      const host = document.getElementById(viewer.getId()) || document.body;
      if (!panelEl.isConnected) host.appendChild(panelEl);
      if (root.PanelDrag) {
        root.PanelDrag.placeDefault(panelEl, {
          navEl: document.getElementById(target),
          others: ['.o-laserdata-panel', '.o-ortofoto-panel', '.o-hp-panel', '.o-mlinks-panel']
        });
      }
    }

    function hidePanel() {
      if (panelEl && panelEl.parentNode) panelEl.parentNode.removeChild(panelEl);
    }

    // ---------- öppna / stäng ----------
    function activate() {
      if (active) return;
      active = true;
      layer.setVisible(true);
      map.on('moveend', scheduleRefresh);
      map.on('singleclick', onClick);
      spButton.setState('active');
      showPanel();
      refresh();
    }

    function deactivate() {
      if (!active) return;
      active = false;
      if (markMode) setMarkMode(false);
      exportSel.clear();
      map.un('moveend', scheduleRefresh);
      map.un('singleclick', onClick);
      hidePopup();
      source.clear();
      layer.setVisible(false);
      spButton.setState('initial');
      hidePanel();
    }

    function toggle() { if (active) deactivate(); else activate(); }

    return Origo.ui.Component({
      name: 'stompunkt',

      onInit() {
        spButton = Origo.ui.Button({
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
          style: styleFn,
          properties: { name: 'stompunkter', title: 'Stompunkter', queryable: false }
        });
        map.addLayer(layer);

        this.addComponents([spButton]);
        this.render();
      },

      render() {
        const el = Origo.ui.dom.html(spButton.render());
        document.getElementById(target).appendChild(el);
        this.dispatch('render');
      }
    });
  }

  root.Stompunkt = Stompunkt;
}(window));
