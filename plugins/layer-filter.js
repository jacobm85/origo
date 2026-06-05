/*!
 * layer-filter — Origo plugin ("Filtrera lager").
 *
 * Generiskt attributfilter för kartans lager, inspirerat av SigtunaGIS
 * ek-filter-plugin (origo-filter-etuna) men anpassat efter den här kartans
 * blandade lageruppsättning. Knapp i höger verktygsmeny öppnar en dragbar panel
 * där du väljer ett tänt lager och filtrerar på dess attribut.
 *
 * Filtreringen sker på det sätt som passar varje lager:
 *   - Vektorlager (WFS / GEOJSON / AGS_FEATURE): klient-sida. Icke-matchande
 *     features stilas bort (style → null) i den laddade vyn. Attribut och värden
 *     läses direkt ur de inlästa objekten.
 *   - WMS (GeoServer/OGC): server-sida via CQL_FILTER. Attributnamnen hämtas
 *     med DescribeFeatureType (WFS). Lyckas det inte (t.ex. ren ArcGIS-WMS eller
 *     Lantmäteriets WMS) markeras lagret som ej attributfiltrerbart.
 *   - Raster/bakgrund (AGS_TILE / WMTS / OSM / XYZ): listas inte.
 *
 * Två lager har skräddarsydda kontroller i stället för det generiska gränssnittet:
 *   - Avverkningsanmalan_Skogsstyrelsen: år / ändamål / inkomstdatum (klient-sida).
 *   - sgu-prospekteringstillstand: begäransdatum (server-sida CQL).
 *
 * Bundlad som en IIFE (ingen byggning behövs). Exponerar globalen
 * `LayerFilter(options)`. Kräver att `origo.js` laddats först; använder
 * `PanelDrag` (panel-drag.js) om den finns.
 */
(function (root) {
  if (typeof Origo === 'undefined') {
    // eslint-disable-next-line no-console
    console.error('[layer-filter] Origo-globalen saknas – ladda origo.js före detta skript.');
    return;
  }

  // Lagertyper som kan filtreras klient-sida (vektor med inlästa features).
  const VECTOR_TYPES = ['WFS', 'GEOJSON', 'AGS_FEATURE'];

  // Operatorer som erbjuds i det generiska gränssnittet.
  const OPERATORS = [
    { value: '=', label: '= (lika med)' },
    { value: '<>', label: '≠ (skild från)' },
    { value: '<', label: '< (mindre än)' },
    { value: '<=', label: '≤' },
    { value: '>', label: '> (större än)' },
    { value: '>=', label: '≥' },
    { value: 'like', label: 'innehåller' },
    { value: 'between', label: 'mellan (a, b)' }
  ];

  // Attribut som aldrig ska erbjudas (geometri-/internfält).
  const DEFAULT_EXCLUDED_ATTRS = [
    'geometry', 'geom', 'the_geom', 'boundedBy', 'bbox', 'shape', 'SHAPE', 'GEOMETRY'
  ];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    ));
  }

  function isNumericStr(v) {
    if (v === null || v === undefined || v === '') return false;
    const n = Number(v);
    return !Number.isNaN(n) && Number.isFinite(n);
  }

  function toIsoDate(ms) {
    const d = new Date(ms);
    const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function parseDateInputMs(value, endOfDay) {
    if (!value) return null;
    const parts = value.split('-');
    if (parts.length !== 3) return null;
    const y = Number(parts[0]);
    const m = Number(parts[1]) - 1;
    const d = Number(parts[2]);
    return endOfDay
      ? new Date(y, m, d, 23, 59, 59, 999).getTime()
      : new Date(y, m, d, 0, 0, 0, 0).getTime();
  }

  // Jämför ett feature-värde mot ett villkorsvärde enligt operatorn (klient-sida).
  function compareValue(raw, op, value) {
    if (op === 'like') {
      return String(raw == null ? '' : raw).toLowerCase().includes(String(value).toLowerCase());
    }
    if (op === 'between') {
      const bounds = String(value).split(',').map((s) => s.trim()).filter((s) => s !== '');
      if (bounds.length !== 2) return true;
      const lo = compareValue(raw, '>=', bounds[0]);
      const hi = compareValue(raw, '<=', bounds[1]);
      return lo && hi;
    }
    let a;
    let b;
    if (isNumericStr(value) && isNumericStr(raw)) {
      a = Number(raw);
      b = Number(value);
    } else {
      a = String(raw == null ? '' : raw).toLowerCase();
      b = String(value).toLowerCase();
    }
    switch (op) {
      case '=': return a === b;
      case '<>': return a !== b;
      case '<': return a < b;
      case '<=': return a <= b;
      case '>': return a > b;
      case '>=': return a >= b;
      default: return true;
    }
  }

  // Bygg ett CQL-fragment för ett villkor (server-sida WMS).
  function rowToCql(attr, op, value) {
    const q = (v) => (isNumericStr(v) ? `${Number(v)}` : `'${String(v).replace(/'/g, "''")}'`);
    if (op === 'like') {
      return `${attr} ILIKE '%${String(value).replace(/'/g, "''")}%'`;
    }
    if (op === 'between') {
      const bounds = String(value).split(',').map((s) => s.trim()).filter((s) => s !== '');
      if (bounds.length !== 2) return '';
      return `${attr} BETWEEN ${q(bounds[0])} AND ${q(bounds[1])}`;
    }
    return `${attr} ${op} ${q(value)}`;
  }

  function LayerFilter(options = {}) {
    const {
      icon = '#filter-funnel',
      tooltipText = 'Filtrera lager',
      tooltipPlacement = 'west',
      excludedLayers = [],
      excludedAttributes = []
    } = options;
    const excludedAttrSet = new Set(DEFAULT_EXCLUDED_ATTRS.concat(excludedAttributes));

    const cls = 'o-layer-filter padding-small icon-smaller round light box-shadow';

    let viewer;
    let map;
    let target;
    let button;

    let panelEl;
    let layerSelectEl;
    let contentEl;
    let clearAllEl;
    let badgeEl;

    let active = false;

    // Lagernamn → klient-predikat (feature → bool). Frånvaro = inget filter.
    const clientPredicates = {};
    // Lagernamn med aktivt filter (klient eller server).
    const filtered = new Set();

    // ---------- lagerinspektion ----------
    function layerType(layer) {
      return String(layer.get('type') || '').toUpperCase();
    }

    function isVector(layer) {
      return VECTOR_TYPES.includes(layerType(layer));
    }

    function isWms(layer) {
      return layerType(layer) === 'WMS';
    }

    function isFilterable(layer) {
      if (!layer || excludedLayers.includes(layer.get('name'))) return false;
      return isVector(layer) || isWms(layer);
    }

    // Tända, filtrerbara lager (det man ser är det man filtrerar).
    function getCandidateLayers() {
      return viewer.getLayers()
        .filter((l) => isFilterable(l) && l.get('visible'))
        .sort((a, b) => String(a.get('title') || a.get('name'))
          .localeCompare(String(b.get('title') || b.get('name')), 'sv'));
    }

    // Klustrade lager (layerType: cluster) har en Cluster-källa vars getFeatures()
    // returnerar KLUSTER-features (egenskap "features"), inte de riktiga punkterna.
    // Plocka ut den underliggande punktkällan så attribut/värden/filtrering ser
    // de verkliga objekten.
    function clusterSourceOf(layer) {
      const s = layer.getSource && layer.getSource();
      return (s && typeof s.getSource === 'function' && s.getSource()) ? s : null;
    }
    function innerSource(layer) {
      const cs = clusterSourceOf(layer);
      return cs ? cs.getSource() : (layer.getSource && layer.getSource());
    }
    // Alla punkt-features (även om ett klusterfilter just nu döljer en del).
    function allFeatures(layer) {
      const stashed = layer.get('_lfAllFeatures');
      if (stashed) return stashed;
      const src = innerSource(layer);
      return (src && src.getFeatures && src.getFeatures()) || [];
    }

    function getVectorAttributes(layer) {
      const feats = allFeatures(layer);
      const geomKey = feats[0] && feats[0].getGeometryName ? feats[0].getGeometryName() : 'geometry';
      const keys = new Set();
      feats.forEach((f) => {
        (f.getKeys ? f.getKeys() : Object.keys(f.getProperties())).forEach((k) => {
          if (k === geomKey || excludedAttrSet.has(k)) return;
          keys.add(k);
        });
      });
      return Array.from(keys).sort((a, b) => a.localeCompare(b, 'sv'));
    }

    function getDistinctValues(layer, attr, cap) {
      const feats = allFeatures(layer);
      const set = new Set();
      for (let i = 0; i < feats.length; i += 1) {
        const v = feats[i].get(attr);
        if (v !== undefined && v !== null && v !== '') set.add(String(v));
        if (set.size > cap) return null;
      }
      return Array.from(set).sort((a, b) => a.localeCompare(b, 'sv', { numeric: true }));
    }

    function describeUrl(layer) {
      const src = viewer.getSource(layer.get('sourceName'));
      if (!src || !src.url) return null;
      let base = src.url;
      if (/\/wms$/i.test(base)) base = `${base.slice(0, -3)}wfs`;
      const sep = base.includes('?') ? '&' : '?';
      return `${base}${sep}service=WFS&version=1.1.0&request=DescribeFeatureType`
        + `&typeName=${encodeURIComponent(layer.get('name'))}&outputFormat=application/json`;
    }

    async function getWmsAttributes(layer) {
      const url = describeUrl(layer);
      if (!url) return null;
      try {
        const res = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!res.ok) return null;
        const data = await res.json();
        const props = data && data.featureTypes && data.featureTypes[0]
          && data.featureTypes[0].properties;
        if (!Array.isArray(props)) return null;
        return props
          .filter((p) => p.name && !/^gml:|Geometry|Point|Line|Polygon|Surface|Curve/i.test(String(p.type || '')))
          .filter((p) => !excludedAttrSet.has(p.name))
          .map((p) => p.name);
      } catch (e) {
        return null;
      }
    }

    // ---------- applicera / rensa filter ----------
    function markFiltered(layer, on) {
      const name = layer.get('name');
      if (on) filtered.add(name); else filtered.delete(name);
      updateBadge();
      updateLayerOption(layer);
      updateClearAll();
    }

    // Klusterfilter: filtrera de underliggande punkterna (kluster-stilen ser bara
    // klusterobjekt, så style→null fungerar inte). Snapshot:a hela uppsättningen
    // en gång och behåll bara matchande i kluster-källan.
    function applyClusterFilter(layer, predicate) {
      const cs = clusterSourceOf(layer);
      if (!cs) return;
      const inner = cs.getSource();
      if (!layer.get('_lfAllFeatures')) layer.set('_lfAllFeatures', inner.getFeatures().slice());
      const all = layer.get('_lfAllFeatures');
      const keep = predicate ? all.filter(predicate) : all;
      inner.clear();
      inner.addFeatures(keep);
    }
    function clearClusterFilter(layer) {
      const all = layer.get('_lfAllFeatures');
      if (!all) return;
      const inner = innerSource(layer);
      inner.clear();
      inner.addFeatures(all);
      layer.set('_lfAllFeatures', undefined);
    }

    function setClientPredicate(layer, predicate) {
      const name = layer.get('name');
      const isClustered = !!clusterSourceOf(layer);
      if (predicate) {
        clientPredicates[name] = predicate;
        if (isClustered) {
          applyClusterFilter(layer, predicate);
        } else if (!layer.get('_lfWrapped')) {
          const orig = layer.getStyle();
          layer.set('_lfOrigStyle', orig);
          layer.set('_lfWrapped', true);
          layer.setStyle((feature, resolution) => {
            const pred = clientPredicates[name];
            if (pred && !pred(feature)) return null;
            const o = layer.get('_lfOrigStyle');
            return typeof o === 'function' ? o(feature, resolution) : o;
          });
        }
        markFiltered(layer, true);
      } else {
        delete clientPredicates[name];
        if (isClustered) clearClusterFilter(layer);
        markFiltered(layer, false);
      }
      if (layer.changed) layer.changed();
    }

    function setWmsCql(layer, cql) {
      const source = layer.getSource();
      if (!source || typeof source.updateParams !== 'function') return;
      source.updateParams({ CQL_FILTER: cql || undefined });
      markFiltered(layer, !!cql);
    }

    function clearLayerFilter(layer) {
      if (isVector(layer)) setClientPredicate(layer, null);
      else if (isWms(layer)) setWmsCql(layer, null);
    }

    function clearAllFilters() {
      Array.from(filtered).forEach((name) => {
        const layer = viewer.getLayer(name);
        if (layer) clearLayerFilter(layer);
      });
      if (panelEl && layerSelectEl) renderContent(layerSelectEl.value);
    }

    // ---------- UI-hjälpare ----------
    function buildOptionsHtml(values, selected, allLabel) {
      let html = allLabel ? `<option value="">${esc(allLabel)}</option>` : '';
      values.forEach((v) => {
        const val = esc(v);
        html += `<option value="${val}"${String(selected) === String(v) ? ' selected' : ''}>${val}</option>`;
      });
      return html;
    }

    function updateBadge() {
      if (!badgeEl) return;
      const n = filtered.size;
      badgeEl.textContent = n;
      badgeEl.style.display = n > 0 ? 'block' : 'none';
    }

    function updateClearAll() {
      if (!clearAllEl) return;
      clearAllEl.textContent = `Rensa alla filter (${filtered.size})`;
      clearAllEl.classList.toggle('is-shown', filtered.size > 0);
    }

    function updateLayerOption(layer) {
      if (!layerSelectEl) return;
      const name = layer.get('name');
      const opt = layerSelectEl.querySelector(`option[value="${CSS.escape(name)}"]`);
      if (!opt) return;
      const title = layer.get('title') || name;
      opt.textContent = filtered.has(name) ? `● ${title}` : title;
    }

    // ---------- generiskt gränssnitt (rader: attribut/operator/värde) ----------
    function renderGeneric(layer, attributes, mode) {
      // mode: 'client' (vektor) eller 'wms' (server-CQL)
      contentEl.innerHTML = '';
      if (!attributes || attributes.length === 0) {
        const msg = document.createElement('div');
        msg.className = 'o-lfilter-msg is-warn';
        msg.textContent = mode === 'client'
          ? 'Inga attribut hittades. Tänd lagret och zooma in så att objekt läses in, och välj lagret igen.'
          : 'Det här lagret stödjer inte attributfiltrering här (inga WFS-attribut kunde hämtas).';
        contentEl.appendChild(msg);
        return;
      }

      const logicWrap = document.createElement('div');
      logicWrap.className = 'o-lfilter-logic';
      logicWrap.innerHTML = 'Matcha <select class="o-lfilter-logicsel">'
        + '<option value="AND">alla villkor</option>'
        + '<option value="OR">något villkor</option></select>';
      const logicSel = logicWrap.querySelector('select');

      const rowsWrap = document.createElement('div');
      rowsWrap.className = 'o-lfilter-rows';

      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'o-lfilter-add';
      addBtn.textContent = '+ Lägg till villkor';

      const footer = document.createElement('div');
      footer.className = 'o-lfilter-footer';
      footer.innerHTML = '<button type="button" class="o-lfilter-apply">Filtrera</button>'
        + '<button type="button" class="o-lfilter-reset">Rensa</button>'
        + '<span class="o-lfilter-count"></span>';
      const applyBtn = footer.querySelector('.o-lfilter-apply');
      const resetBtn = footer.querySelector('.o-lfilter-reset');
      const countEl = footer.querySelector('.o-lfilter-count');

      const attrOptions = attributes.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join('');
      const opOptions = OPERATORS.map((o) => `<option value="${o.value}">${esc(o.label)}</option>`).join('');
      let datalistSeq = 0;

      function refreshDatalist(row) {
        if (mode !== 'client') return;
        const attr = row.querySelector('.o-lfilter-attr').value;
        const input = row.querySelector('.o-lfilter-val');
        const list = row.querySelector('datalist');
        const values = getDistinctValues(layer, attr, 500);
        list.innerHTML = values
          ? values.map((v) => `<option value="${esc(v)}"></option>`).join('') : '';
        input.setAttribute('list', list.id);
      }

      function addRow() {
        datalistSeq += 1;
        const listId = `o-lfilter-dl-${Date.now()}-${datalistSeq}`;
        const row = document.createElement('div');
        row.className = 'o-lfilter-row';
        row.innerHTML = `
          <select class="o-lfilter-attr">${attrOptions}</select>
          <div class="o-lfilter-opval">
            <select class="o-lfilter-op">${opOptions}</select>
            <input class="o-lfilter-val" type="text" placeholder="värde" list="${listId}">
            <datalist id="${listId}"></datalist>
          </div>
          <button type="button" class="o-lfilter-rm" title="Ta bort villkor">×</button>`;
        rowsWrap.appendChild(row);
        row.querySelector('.o-lfilter-attr').addEventListener('change', () => refreshDatalist(row));
        row.querySelector('.o-lfilter-rm').addEventListener('click', () => {
          if (rowsWrap.children.length > 1) row.remove();
          else {
            row.querySelector('.o-lfilter-val').value = '';
          }
          updateLogicVisibility();
        });
        refreshDatalist(row);
        updateLogicVisibility();
        return row;
      }

      function updateLogicVisibility() {
        logicWrap.style.display = rowsWrap.children.length > 1 ? 'flex' : 'none';
      }

      function collectRows() {
        return Array.from(rowsWrap.children).map((row) => ({
          attr: row.querySelector('.o-lfilter-attr').value,
          op: row.querySelector('.o-lfilter-op').value,
          value: row.querySelector('.o-lfilter-val').value.trim()
        })).filter((r) => r.value !== '');
      }

      function updateCount() {
        if (mode !== 'client') { countEl.textContent = ''; return; }
        const feats = allFeatures(layer);
        const pred = clientPredicates[layer.get('name')];
        const shown = pred ? feats.filter(pred).length : feats.length;
        countEl.textContent = feats.length ? `Visar ${shown} av ${feats.length}` : 'Inga objekt i vyn';
      }

      function apply() {
        const rows = collectRows();
        const logic = logicSel.value;
        if (mode === 'client') {
          if (!rows.length) {
            setClientPredicate(layer, null);
          } else {
            const predicate = (feature) => {
              const res = rows.map((r) => compareValue(feature.get(r.attr), r.op, r.value));
              return logic === 'AND' ? res.every(Boolean) : res.some(Boolean);
            };
            setClientPredicate(layer, predicate);
          }
          updateCount();
        } else {
          const parts = rows.map((r) => rowToCql(r.attr, r.op, r.value)).filter(Boolean);
          setWmsCql(layer, parts.length ? parts.join(` ${logic} `) : null);
        }
      }

      applyBtn.addEventListener('click', apply);
      resetBtn.addEventListener('click', () => {
        while (rowsWrap.children.length > 1) rowsWrap.lastChild.remove();
        const first = rowsWrap.firstChild;
        first.querySelector('.o-lfilter-attr').selectedIndex = 0;
        first.querySelector('.o-lfilter-op').selectedIndex = 0;
        first.querySelector('.o-lfilter-val').value = '';
        refreshDatalist(first);
        clearLayerFilter(layer);
        updateLogicVisibility();
        updateCount();
      });
      addBtn.addEventListener('click', addRow);

      contentEl.appendChild(logicWrap);
      contentEl.appendChild(rowsWrap);
      contentEl.appendChild(addBtn);
      contentEl.appendChild(footer);

      addRow();
      updateCount();

      // Räkna om när nya features läses in (panning/zoom på vektorlager).
      if (mode === 'client') {
        const src = layer.getSource();
        const onChange = () => { if (contentEl.contains(footer)) updateCount(); };
        src.on('featuresloadend', onChange);
        src.on('addfeature', onChange);
      }
    }

    // ---------- skräddarsydda gränssnitt ----------
    function renderAvverkning(layer) {
      const yearField = 'ArendeAr';
      const purposeField = 'Andamal';
      const dateField = 'Inkomdatum';

      contentEl.innerHTML = `
        <div class="o-lfilter-msg">Skräddarsytt filter. Filtrerar de avverkningsanmälningar som lästs in i kartvyn.</div>
        <div class="o-lfilter-field"><label>Ärendeår</label>
          <select class="o-av-year"><option value="all">Alla år</option></select></div>
        <div class="o-lfilter-field"><label>Ändamål</label>
          <select class="o-av-purpose"><option value="all">Alla ändamål</option></select></div>
        <div class="o-lfilter-field"><label>Inkomstdatum</label>
          <div class="o-lfilter-daterange">
            <input type="date" class="o-av-from" aria-label="Från datum"><span>–</span>
            <input type="date" class="o-av-to" aria-label="Till datum"></div></div>
        <div class="o-lfilter-footer">
          <button type="button" class="o-lfilter-reset o-av-reset">Återställ</button>
          <span class="o-lfilter-count o-av-count"></span></div>`;

      const yearSel = contentEl.querySelector('.o-av-year');
      const purposeSel = contentEl.querySelector('.o-av-purpose');
      const fromInput = contentEl.querySelector('.o-av-from');
      const toInput = contentEl.querySelector('.o-av-to');
      const countEl = contentEl.querySelector('.o-av-count');

      let selectedYear = 'all';
      let selectedPurpose = 'all';
      let dateFromMs = null;
      let dateToMs = null;
      let dateInit = false;

      function matches(feature) {
        if (selectedYear !== 'all' && Number(feature.get(yearField)) !== Number(selectedYear)) return false;
        if (selectedPurpose !== 'all' && feature.get(purposeField) !== selectedPurpose) return false;
        const raw = feature.get(dateField);
        if (raw !== undefined && raw !== null && raw !== '') {
          const ts = Number(raw);
          if (!Number.isNaN(ts)) {
            if (dateFromMs !== null && ts < dateFromMs) return false;
            if (dateToMs !== null && ts > dateToMs) return false;
          }
        } else if (dateFromMs !== null || dateToMs !== null) {
          return false;
        }
        return true;
      }

      function applyPredicate() {
        const noFilter = selectedYear === 'all' && selectedPurpose === 'all'
          && dateFromMs === null && dateToMs === null;
        setClientPredicate(layer, noFilter ? null : matches);
      }

      function refresh() {
        const feats = (layer.getSource() && layer.getSource().getFeatures()) || [];
        const years = new Set();
        const purposes = new Set();
        let minDate = Infinity;
        let maxDate = -Infinity;
        let shown = 0;
        feats.forEach((f) => {
          const y = f.get(yearField);
          if (y !== undefined && y !== null && y !== '') years.add(Number(y));
          const p = f.get(purposeField);
          if (p !== undefined && p !== null && p !== '') purposes.add(p);
          const ts = Number(f.get(dateField));
          if (!Number.isNaN(ts) && ts > 0) {
            if (ts < minDate) minDate = ts;
            if (ts > maxDate) maxDate = ts;
          }
          if (matches(f)) shown += 1;
        });
        yearSel.innerHTML = `<option value="all">Alla år</option>${
          buildOptionsHtml(Array.from(years).sort((a, b) => b - a), selectedYear)}`;
        purposeSel.innerHTML = `<option value="all">Alla ändamål</option>${
          buildOptionsHtml(Array.from(purposes).sort((a, b) => a.localeCompare(b, 'sv')), selectedPurpose)}`;
        if (minDate !== Infinity && maxDate !== -Infinity) {
          const minIso = toIsoDate(minDate);
          const maxIso = toIsoDate(maxDate);
          [fromInput, toInput].forEach((el) => { el.min = minIso; el.max = maxIso; });
          if (!dateInit) { fromInput.value = minIso; toInput.value = maxIso; dateInit = true; }
        }
        countEl.textContent = feats.length ? `Visar ${shown} av ${feats.length}` : 'Zooma in för att hämta data';
      }

      yearSel.addEventListener('change', () => { selectedYear = yearSel.value; applyPredicate(); refresh(); });
      purposeSel.addEventListener('change', () => { selectedPurpose = purposeSel.value; applyPredicate(); refresh(); });
      fromInput.addEventListener('change', () => { dateFromMs = parseDateInputMs(fromInput.value, false); applyPredicate(); refresh(); });
      toInput.addEventListener('change', () => { dateToMs = parseDateInputMs(toInput.value, true); applyPredicate(); refresh(); });
      contentEl.querySelector('.o-av-reset').addEventListener('click', () => {
        selectedYear = 'all'; selectedPurpose = 'all';
        dateFromMs = null; dateToMs = null; dateInit = false;
        fromInput.value = ''; toInput.value = '';
        applyPredicate(); refresh();
      });

      const src = layer.getSource();
      src.on('featuresloadend', refresh);
      src.on('addfeature', refresh);
      refresh();
    }

    function renderProspektering(layer) {
      const field = 'designation_period_begin';
      contentEl.innerHTML = `
        <div class="o-lfilter-msg">Skräddarsytt filter. Filtrerar på begäransdatum server-sida (CQL) – gäller hela datamängden.</div>
        <div class="o-lfilter-field"><label>Begäransdatum</label>
          <div class="o-lfilter-daterange">
            <input type="date" class="o-pr-from" aria-label="Från datum"><span>–</span>
            <input type="date" class="o-pr-to" aria-label="Till datum"></div></div>
        <div class="o-lfilter-footer">
          <button type="button" class="o-lfilter-reset o-pr-reset">Återställ</button></div>`;

      const fromInput = contentEl.querySelector('.o-pr-from');
      const toInput = contentEl.querySelector('.o-pr-to');

      function apply() {
        const parts = [];
        if (fromInput.value) parts.push(`${field} >= '${fromInput.value}T00:00:00Z'`);
        if (toInput.value) parts.push(`${field} <= '${toInput.value}T23:59:59Z'`);
        setWmsCql(layer, parts.length ? parts.join(' AND ') : null);
      }

      fromInput.addEventListener('change', apply);
      toInput.addEventListener('change', apply);
      contentEl.querySelector('.o-pr-reset').addEventListener('click', () => {
        fromInput.value = ''; toInput.value = ''; apply();
      });
    }

    const SPECIAL = {
      Avverkningsanmalan_Skogsstyrelsen: renderAvverkning,
      'sgu-prospekteringstillstand': renderProspektering
    };

    // ---------- innehåll per valt lager ----------
    async function renderContent(layerName) {
      contentEl.innerHTML = '';
      if (!layerName) return;
      const layer = viewer.getLayer(layerName);
      if (!layer) return;

      if (SPECIAL[layerName]) {
        SPECIAL[layerName](layer);
        return;
      }

      if (isVector(layer)) {
        renderGeneric(layer, getVectorAttributes(layer), 'client');
        return;
      }

      if (isWms(layer)) {
        const loading = document.createElement('div');
        loading.className = 'o-lfilter-msg';
        loading.textContent = 'Hämtar attribut…';
        contentEl.appendChild(loading);
        const attrs = await getWmsAttributes(layer);
        // Kontrollera att lagret fortfarande är valt innan vi ritar.
        if (layerSelectEl.value !== layerName) return;
        renderGeneric(layer, attrs, 'wms');
      }
    }

    function renderLayerSelect() {
      const current = layerSelectEl.value;
      const layers = getCandidateLayers();
      layerSelectEl.innerHTML = `<option value="">Välj lager…</option>${
        layers.map((l) => {
          const name = l.get('name');
          const title = l.get('title') || name;
          const label = filtered.has(name) ? `● ${title}` : title;
          return `<option value="${esc(name)}">${esc(label)}</option>`;
        }).join('')}`;
      // Behåll valet om lagret fortfarande finns i listan.
      if (current && layerSelectEl.querySelector(`option[value="${CSS.escape(current)}"]`)) {
        layerSelectEl.value = current;
      } else if (current) {
        renderContent('');
      }
    }

    // ---------- panel ----------
    function buildPanel() {
      const el = document.createElement('div');
      el.className = 'o-lfilter-panel';
      el.innerHTML = `
        <button class="o-lfilter-close" type="button" title="Stäng">&times;</button>
        <h3 class="o-lfilter-title">Filtrera lager</h3>
        <p class="o-lfilter-hint">Välj ett tänt lager och filtrera på dess attribut. Vektorlager filtreras i kartvyn, WMS-lager (där det stöds) filtreras mot hela datamängden.</p>
        <select class="o-lfilter-layer"><option value="">Välj lager…</option></select>
        <button type="button" class="o-lfilter-clearall">Rensa alla filter (0)</button>
        <div class="o-lfilter-content"></div>`;

      el.querySelector('.o-lfilter-close').addEventListener('click', deactivate);
      layerSelectEl = el.querySelector('.o-lfilter-layer');
      contentEl = el.querySelector('.o-lfilter-content');
      clearAllEl = el.querySelector('.o-lfilter-clearall');

      layerSelectEl.addEventListener('change', () => renderContent(layerSelectEl.value));
      clearAllEl.addEventListener('click', clearAllFilters);

      if (root.PanelDrag) root.PanelDrag.makeDraggable(el, el.querySelector('.o-lfilter-title'));
      panelEl = el;
      renderLayerSelect();
      updateClearAll();
      return el;
    }

    function showPanel() {
      if (!panelEl) buildPanel();
      const host = document.getElementById(viewer.getId()) || document.body;
      if (!panelEl.isConnected) host.appendChild(panelEl);
      renderLayerSelect();
      if (root.PanelDrag) {
        root.PanelDrag.placeDefault(panelEl, {
          navEl: document.getElementById(target),
          others: ['.o-stompunkt-panel', '.o-laserdata-panel', '.o-ortofoto-panel', '.o-hp-panel', '.o-mlinks-panel']
        });
      }
    }

    function hidePanel() {
      if (panelEl && panelEl.parentNode) panelEl.parentNode.removeChild(panelEl);
    }

    function activate() {
      if (active) return;
      active = true;
      button.setState('active');
      showPanel();
    }

    function deactivate() {
      if (!active) return;
      active = false;
      button.setState('initial');
      hidePanel();
    }

    function toggle() { if (active) deactivate(); else activate(); }

    return Origo.ui.Component({
      name: 'layerfilter',

      onInit() {
        button = Origo.ui.Button({
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

        this.addComponents([button]);
        this.render();

        // Håll lagerlistan i synk när lager tänds/släcks.
        viewer.getLayers().forEach((layer) => {
          if (!layer.get('_lfVisListener')) {
            layer.set('_lfVisListener', true);
            layer.on('change:visible', () => { if (panelEl) renderLayerSelect(); });
          }
        });
      },

      render() {
        const elHtml = Origo.ui.dom.html(button.render());
        document.getElementById(target).appendChild(elHtml);
        // Lägg på en badge som räknar aktiva filter.
        const btnEl = document.getElementById(button.getId());
        if (btnEl) {
          btnEl.style.position = 'relative';
          badgeEl = document.createElement('span');
          badgeEl.className = 'o-lfilter-badge';
          badgeEl.style.display = 'none';
          btnEl.appendChild(badgeEl);
        }
        this.dispatch('render');
      }
    });
  }

  root.LayerFilter = LayerFilter;
}(window));
