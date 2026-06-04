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

  function Stompunkt(options = {}) {
    const {
      proxyBase = '/proxy/stompunkt',
      icon = '#stompunkt-marker',
      tooltipText = 'Stompunkter',
      tooltipPlacement = 'east',
      // Stompunktsnätet är tätt (≈60 000 punkter). Hämta bara när kartvyns
      // bredd är mindre än så här (meter), annars ber vi användaren zooma in.
      maxViewWidthM = 30000
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
      const { Style, Circle, Fill, Stroke } = Origo.ol.style;
      const gf = feature.get('sp');
      const cat = catOf(gf);
      const color = CATS[cat].color;
      const sel = selectedId && feature.getId() === selectedId;
      return new Style({
        image: new Circle({
          radius: sel ? 8 : 5,
          fill: new Fill({ color }),
          stroke: new Stroke({ color: sel ? '#d6312b' : '#fff', width: sel ? 3 : 1.5 })
        }),
        zIndex: sel ? 30 : 10
      });
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
      }, { hitTolerance: 4 });
      if (!hit) { hidePopup(); return; }
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
        const cat = CATS[catOf(gf)];
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'o-stompunkt-item';
        if (p.stompunktId === selectedId) row.classList.add('is-selected');
        row.innerHTML = `
          <i style="background:${cat.color}"></i>
          <span class="o-stompunkt-item-name">${esc(p.namn || '(namnlös)')}</span>
          <span class="o-stompunkt-item-id">${esc(p.stompunktId || '')}</span>`;
        row.addEventListener('click', () => {
          const c = gf.geometry && gf.geometry.coordinates;
          if (c) {
            map.getView().animate({ center: [c[0], c[1]], duration: 250 });
          }
          selectFeature(gf, null);
          renderList();
        });
        listEl.appendChild(row);
      });
      if (shown.length > 300) {
        const more = document.createElement('div');
        more.className = 'o-stompunkt-more';
        more.textContent = `…och ${shown.length - 300} till. Zooma in eller sök för att begränsa.`;
        listEl.appendChild(more);
      }
    }

    function setStatus(t) { if (statusEl) statusEl.textContent = t || ''; }

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
