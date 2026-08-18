/*!
 * plotter — Origo-plugin "Plotter" (sjökortsplotter för båt).
 *
 * Knapp i verktygsmenyn öppnar en plotterpanel som ger samma grundfunktioner
 * som en fast monterad båtplotter, fast i webbläsaren ovanpå sjökortet:
 *
 *   • Egen position, noggrannhet, fart över grund (SOG) och kurs över grund
 *     (COG) från enhetens GPS (`navigator.geolocation.watchPosition`).
 *     Båtsymbolen roteras efter COG och en prediktorlinje visar var du är om
 *     N minuter med nuvarande fart/kurs.
 *   • Spårinspelning (aktivt spår) med paus, live-statistik och sparning.
 *     Sparade spår kan visas/döljas, döpas om, zoomas till och exporteras
 *     som GPX.
 *   • Rutter: klicka ut waypoints i kartan, dra för att justera, se bäring
 *     och distans per ben, spara, exportera/importera GPX.
 *   • Aktiv navigering längs rutt eller mot en punkt: DTW, BTW, XTE, VMG,
 *     TTG och ETA, automatiskt byte till nästa waypoint vid ankomst samt
 *     ankomst- och XTE-larm.
 *   • Man överbord (MOB): släpper en märkpunkt på nuvarande position och
 *     startar navigering dit.
 *   • Ankarvakt med larm när båten driver utanför angiven radie.
 *   • Kurs-upp, följ-mig-läge, nattläge och skärmlås (Wake Lock) så att
 *     mobilen fungerar som plotter ombord.
 *
 * All navigationsmatematik görs på lon/lat (WGS84-sfär) och är därför
 * oberoende av kartans projektion (EPSG:3006 i den här applikationen).
 * Spår, rutter, punkter och inställningar sparas i webbläsarens localStorage
 * – ingen serverdel behövs.
 *
 * OBS: `navigator.geolocation` och Wake Lock kräver "secure context", dvs.
 * sidan måste serveras över HTTPS (eller köras på localhost). Över vanlig
 * HTTP nekar mobila webbläsare positionering helt.
 *
 * Bundlad som en enda IIFE. Exponerar globalen `Plotter(options)`. Kräver att
 * `origo.js` laddats först. Använder `geo-export.js` för nedladdning om det
 * finns, annars en egen fallback.
 */
(function (root) {
  if (typeof Origo === 'undefined') {
    // eslint-disable-next-line no-console
    console.error('[plotter] Origo-globalen saknas – ladda origo.js före detta skript.');
    return;
  }

  // ============================================================
  // Enheter och sfärisk geodesi
  // ============================================================
  const NM = 1852;              // meter per nautisk mil
  const KN = 3600 / NM;         // m/s → knop
  const ER = 6371008.8;         // jordens medelradie (m)
  const D2R = Math.PI / 180;
  const R2D = 180 / Math.PI;

  /** Storcirkelavstånd i meter mellan två [lon, lat]. */
  function haversine(a, b) {
    const lat1 = a[1] * D2R;
    const lat2 = b[1] * D2R;
    const dLat = lat2 - lat1;
    const dLon = (b[0] - a[0]) * D2R;
    const h = (Math.sin(dLat / 2) ** 2)
      + (Math.cos(lat1) * Math.cos(lat2) * (Math.sin(dLon / 2) ** 2));
    return 2 * ER * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /** Initial bäring i grader (0–360) från a till b. */
  function bearingTo(a, b) {
    const lat1 = a[1] * D2R;
    const lat2 = b[1] * D2R;
    const dLon = (b[0] - a[0]) * D2R;
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = (Math.cos(lat1) * Math.sin(lat2))
      - (Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon));
    return ((Math.atan2(y, x) * R2D) + 360) % 360;
  }

  /** Punkten distM meter bort från a i bäringen brg (grader). */
  function destPoint(a, brg, distM) {
    const d = distM / ER;
    const t = brg * D2R;
    const lat1 = a[1] * D2R;
    const lon1 = a[0] * D2R;
    const lat2 = Math.asin((Math.sin(lat1) * Math.cos(d))
      + (Math.cos(lat1) * Math.sin(d) * Math.cos(t)));
    const lon2 = lon1 + Math.atan2(
      Math.sin(t) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - (Math.sin(lat1) * Math.sin(lat2))
    );
    return [(((lon2 * R2D) + 540) % 360) - 180, lat2 * R2D];
  }

  /**
   * Kursavvikelse (XTE) i meter från storcirkeln from→to till punkten p.
   * Positivt värde = p ligger till höger om kurslinjen.
   */
  function crossTrack(from, to, p) {
    const d13 = haversine(from, p) / ER;
    if (d13 === 0) return 0;
    const t13 = bearingTo(from, p) * D2R;
    const t12 = bearingTo(from, to) * D2R;
    return Math.asin(Math.max(-1, Math.min(1, Math.sin(d13) * Math.sin(t13 - t12)))) * ER;
  }

  /** Skillnad mellan två bäringar, normaliserad till −180…180. */
  function angleDiff(a, b) {
    return (((a - b) + 540) % 360) - 180;
  }

  // ============================================================
  // Formatering (svenska decimaltecken, marina enheter)
  // ============================================================
  function num(v, dec) {
    if (v === null || v === undefined || Number.isNaN(v)) return '–';
    return v.toFixed(dec).replace('.', ',');
  }

  /** Distans i marin form: meter under 200 m, annars nautiska mil. */
  function fmtDist(m) {
    if (m === null || m === undefined || Number.isNaN(m)) return '–';
    if (m < 200) return `${Math.round(m)} m`;
    const nm = m / NM;
    return `${num(nm, nm < 10 ? 2 : 1)} NM`;
  }

  function fmtSpeed(ms) {
    if (ms === null || ms === undefined || Number.isNaN(ms)) return '–';
    return num(ms * KN, 1);
  }

  function fmtBrg(deg) {
    if (deg === null || deg === undefined || Number.isNaN(deg)) return '–';
    return `${String(Math.round(deg) % 360).padStart(3, '0')}°`;
  }

  function fmtCoordPart(v, mode, hemi) {
    const abs = Math.abs(v);
    if (mode === 'dd') return `${num(abs, 5)}° ${hemi}`;
    const d = Math.floor(abs);
    const m = (abs - d) * 60;
    if (mode === 'dms') {
      const mi = Math.floor(m);
      const s = (m - mi) * 60;
      return `${d}° ${String(mi).padStart(2, '0')}′ ${num(s, 1).padStart(4, '0')}″ ${hemi}`;
    }
    return `${d}° ${m.toFixed(3).padStart(6, '0').replace('.', ',')}′ ${hemi}`;
  }

  function fmtPos(lon, lat, mode) {
    return `${fmtCoordPart(lat, mode, lat >= 0 ? 'N' : 'S')}  ${fmtCoordPart(lon, mode, lon >= 0 ? 'E' : 'W')}`;
  }

  function fmtDuration(ms) {
    if (!ms || ms < 0) return '0:00';
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const mi = Math.floor((s % 3600) / 60);
    const se = s % 60;
    if (h) return `${h}:${String(mi).padStart(2, '0')}:${String(se).padStart(2, '0')}`;
    return `${mi}:${String(se).padStart(2, '0')}`;
  }

  function fmtClock(d) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function fmtDate(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${fmtClock(d)}`;
  }

  function stamp(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function safeName(s) {
    return String(s || 'plotter').replace(/[^\wåäöÅÄÖ -]+/g, '').trim().replace(/\s+/g, '-') || 'plotter';
  }

  function uid() {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  }

  function download(blob, filename) {
    if (root.GeoExport && typeof root.GeoExport.download === 'function') {
      root.GeoExport.download(blob, filename);
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 5000);
  }

  // ============================================================
  // GPX-läsning och -skrivning (GPX 1.1)
  // ============================================================
  function gpxTime(ts) { return new Date(ts).toISOString(); }

  function buildGpx({ tracks = [], routes = [], marks = [] }, docName) {
    const out = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="Origo Plotter" xmlns="http://www.topografix.com/GPX/1/1"',
      ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
      ' xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">',
      `<metadata><name>${esc(docName || 'Origo Plotter')}</name><time>${gpxTime(Date.now())}</time></metadata>`];

    marks.forEach((m) => {
      out.push(`<wpt lat="${m.lat.toFixed(7)}" lon="${m.lon.toFixed(7)}">`
        + `<name>${esc(m.name)}</name>`
        + (m.type === 'mob' ? '<sym>Man Overboard</sym>' : '<sym>Waypoint</sym>')
        + (m.created ? `<time>${gpxTime(m.created)}</time>` : '')
        + '</wpt>');
    });

    routes.forEach((r) => {
      out.push(`<rte><name>${esc(r.name)}</name>`);
      r.wps.forEach((w, i) => {
        out.push(`<rtept lat="${w.lat.toFixed(7)}" lon="${w.lon.toFixed(7)}">`
          + `<name>${esc(w.name || `WP${i + 1}`)}</name></rtept>`);
      });
      out.push('</rte>');
    });

    tracks.forEach((t) => {
      out.push(`<trk><name>${esc(t.name)}</name><trkseg>`);
      t.points.forEach((p) => {
        out.push(`<trkpt lat="${p[1].toFixed(7)}" lon="${p[0].toFixed(7)}">`
          + (p[2] ? `<time>${gpxTime(p[2])}</time>` : '')
          + '</trkpt>');
      });
      out.push('</trkseg></trk>');
    });

    out.push('</gpx>');
    return out.join('\n');
  }

  function parseGpx(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('Filen kunde inte tolkas som XML');
    const tagText = (el, tag) => {
      const n = el.getElementsByTagName(tag)[0];
      return n ? n.textContent.trim() : '';
    };
    const ll = (el) => [parseFloat(el.getAttribute('lon')), parseFloat(el.getAttribute('lat'))];

    const marks = Array.from(doc.getElementsByTagName('wpt')).map((w, i) => {
      const c = ll(w);
      return {
        id: uid(),
        name: tagText(w, 'name') || `WPT ${i + 1}`,
        lon: c[0],
        lat: c[1],
        type: /man overboard/i.test(tagText(w, 'sym')) ? 'mob' : 'wp',
        created: Date.parse(tagText(w, 'time')) || Date.now()
      };
    }).filter((m) => Number.isFinite(m.lon) && Number.isFinite(m.lat));

    const routes = Array.from(doc.getElementsByTagName('rte')).map((r, i) => ({
      id: uid(),
      name: tagText(r, 'name') || `Rutt ${i + 1}`,
      created: Date.now(),
      wps: Array.from(r.getElementsByTagName('rtept')).map((p, j) => {
        const c = ll(p);
        return { lon: c[0], lat: c[1], name: tagText(p, 'name') || `WP${j + 1}` };
      }).filter((w) => Number.isFinite(w.lon) && Number.isFinite(w.lat))
    })).filter((r) => r.wps.length >= 2);

    const tracks = Array.from(doc.getElementsByTagName('trk')).map((t, i) => {
      const points = [];
      Array.from(t.getElementsByTagName('trkpt')).forEach((p) => {
        const c = ll(p);
        if (!Number.isFinite(c[0]) || !Number.isFinite(c[1])) return;
        points.push([c[0], c[1], Date.parse(tagText(p, 'time')) || null]);
      });
      return { id: uid(), name: tagText(t, 'name') || `Spår ${i + 1}`, created: Date.now(), points };
    }).filter((t) => t.points.length >= 2);

    return { tracks, routes, marks };
  }

  // ============================================================
  // Ikoner som data-URI (roteras av OpenLayers)
  // ============================================================
  function svgUri(svg) {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  const BOAT_ICON = svgUri('<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">'
    + '<path d="M18 3 L28 31 L18 25.5 L8 31 Z" fill="#0b6efd" stroke="#ffffff" stroke-width="2.4" stroke-linejoin="round"/></svg>');

  const BOAT_ICON_STALE = svgUri('<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">'
    + '<path d="M18 3 L28 31 L18 25.5 L8 31 Z" fill="#8a94a6" stroke="#ffffff" stroke-width="2.4" stroke-linejoin="round"/></svg>');

  const TRACK_COLORS = ['#d6336c', '#1c7ed6', '#2f9e44', '#f08c00', '#7048e8', '#0ca678', '#e8590c'];

  // ============================================================
  // Plugin
  // ============================================================
  function Plotter(options = {}) {
    const {
      icon = '#plotter-helm',
      tooltipText = 'Plotter – GPS, spår och rutter',
      tooltipPlacement = 'east'
    } = options;

    const cls = 'o-plotter padding-small icon-smaller round light box-shadow';
    const STORE_KEY = 'origo-plotter-v1';

    let viewer;
    let map;
    let target;
    let button;
    let active = false;

    // ---- DOM ----
    let panelEl;
    let statusEl;
    const panes = {};
    const tabs = {};
    let fileInput;

    // ---- lager & källor ----
    const src = {};
    const lyr = {};
    let shipFeat;
    let accFeat;
    let predFeat;
    let recFeat;
    let editFeat;
    let editColl;
    let modify;

    // ---- GPS ----
    let watchId = null;
    let fix = null;         // { lon, lat, acc, sog, cog, alt, ts }
    let sogSmooth = null;
    let gpsMsg = 'GPS ej startad';
    let gpsState = 'off';   // off | wait | ok | error
    let compassHdg = null;
    let compassOn = false;

    // ---- inspelning ----
    let rec = null;         // { state, points, startedAt, pausedMs, pauseStart, dist, maxSpeed }

    // ---- ruttredigering ----
    let edit = null;        // { wps: [{lon,lat,name}], editingId }
    let clickMode = null;   // null | 'route' | 'mark'

    // ---- larm ----
    let audioCtx = null;
    const alarmed = { arrival: false, xte: false, anchor: false };
    let wakeLock = null;
    let ticker = null;

    // ---- persistent tillstånd ----
    const defaults = () => ({
      v: 1,
      tracks: [],
      routes: [],
      marks: [],
      nav: null,          // { type:'route'|'mark', routeId|markId, wpIndex }
      anchor: null,       // { lon, lat, radius, set }
      settings: {
        posFormat: 'dm',
        arrivalRadius: 50,
        xteLimit: 50,
        minDist: 8,
        predictMin: 6,
        alarms: true,
        follow: true,
        courseUp: false,
        night: false,
        keepAwake: false
      }
    });

    let store = defaults();

    function persist() {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(store));
      } catch (e) {
        setStatus('Kunde inte spara lokalt (lagringsutrymmet fullt?)', true);
      }
    }

    function restore() {
      try {
        const raw = localStorage.getItem(STORE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return;
        const base = defaults();
        store = Object.assign(base, parsed);
        store.settings = Object.assign(base.settings, parsed.settings || {});
        store.tracks = Array.isArray(parsed.tracks) ? parsed.tracks : [];
        store.routes = Array.isArray(parsed.routes) ? parsed.routes : [];
        store.marks = Array.isArray(parsed.marks) ? parsed.marks : [];
      } catch (e) {
        store = defaults();
      }
    }

    const set = () => store.settings;

    // ============================================================
    // Koordinatkonvertering mot kartans projektion
    // ============================================================
    function toMap(lonlat) {
      return Origo.ol.proj.transform(lonlat, 'EPSG:4326', map.getView().getProjection());
    }

    function toLonLat(coord) {
      return Origo.ol.proj.transform(coord, map.getView().getProjection(), 'EPSG:4326');
    }

    function lineToMap(points) {
      return points.map((p) => toMap([p[0], p[1]]));
    }

    // ============================================================
    // Lager
    // ============================================================
    function buildLayers() {
      const { source: S, layer: L, style: St } = Origo.ol;
      const mk = (name, title, style, zIndex) => {
        src[name] = new S.Vector();
        lyr[name] = new L.Vector({
          source: src[name],
          style,
          zIndex,
          properties: { name: `plotter-${name}`, title, queryable: false, group: 'none' }
        });
        map.addLayer(lyr[name]);
      };

      // Sparade spår
      mk('saved', 'Plotter – sparade spår', (f) => [new St.Style({
        stroke: new St.Stroke({ color: f.get('color') || '#d6336c', width: 3 })
      })], 40);

      // Rutter (sparade + den som redigeras)
      mk('route', 'Plotter – rutter', routeStyle, 42);

      // Punkter / märken / ankare
      mk('mark', 'Plotter – punkter', markStyle, 44);

      // Aktivt spår under inspelning
      mk('rec', 'Plotter – aktivt spår', () => [new St.Style({
        stroke: new St.Stroke({ color: '#e03131', width: 4 })
      })], 46);

      // Egen båt överst
      mk('ship', 'Plotter – egen position', shipStyle, 48);

      const { Feature } = Origo.ol;
      const { LineString, Point } = Origo.ol.geom;

      accFeat = new Feature({ kind: 'accuracy' });
      predFeat = new Feature({ geometry: new LineString([[0, 0], [0, 0]]), kind: 'predictor' });
      shipFeat = new Feature({ geometry: new Point([0, 0]), kind: 'ship' });
      src.ship.addFeatures([accFeat, predFeat, shipFeat]);
      lyr.ship.setVisible(false);

      recFeat = new Feature({ geometry: new LineString([]) });
      src.rec.addFeature(recFeat);

      editColl = new Origo.ol.Collection();
      modify = new Origo.ol.interaction.Modify({ features: editColl });
      modify.on('modifyend', onModifyEnd);
    }

    function shipStyle(feature) {
      const { Style, Icon, Fill, Stroke } = Origo.ol.style;
      const kind = feature.get('kind');
      if (kind === 'accuracy') {
        return [new Style({
          fill: new Fill({ color: 'rgba(11,110,253,0.10)' }),
          stroke: new Stroke({ color: 'rgba(11,110,253,0.45)', width: 1 })
        })];
      }
      if (kind === 'predictor') {
        return [new Style({
          stroke: new Stroke({ color: 'rgba(11,110,253,0.85)', width: 2, lineDash: [6, 5] })
        })];
      }
      const hdg = feature.get('hdg');
      const stale = feature.get('stale');
      return [new Style({
        image: new Icon({
          src: stale ? BOAT_ICON_STALE : BOAT_ICON,
          rotation: (hdg || 0) * D2R,
          rotateWithView: true,
          anchor: [0.5, 0.5]
        })
      })];
    }

    function routeStyle(feature) {
      const { Style, Stroke, Circle, Fill, Text } = Origo.ol.style;
      const kind = feature.get('kind');
      const isActive = feature.get('isActive');
      const isEdit = feature.get('isEdit');
      if (kind === 'route-line') {
        const color = isEdit ? '#f76707' : (isActive ? '#7048e8' : '#495057');
        return [
          new Style({ stroke: new Stroke({ color: 'rgba(255,255,255,0.75)', width: 6 }) }),
          new Style({ stroke: new Stroke({ color, width: 2.5, lineDash: isEdit ? [8, 6] : undefined }) })
        ];
      }
      if (kind === 'route-wp') {
        const isTarget = feature.get('isTarget');
        return [new Style({
          image: new Circle({
            radius: isTarget ? 8 : 6,
            fill: new Fill({ color: isTarget ? '#7048e8' : '#ffffff' }),
            stroke: new Stroke({ color: isTarget ? '#ffffff' : '#495057', width: 2 })
          }),
          text: new Text({
            text: String(feature.get('label') || ''),
            offsetY: -16,
            font: 'bold 11px sans-serif',
            fill: new Fill({ color: '#212529' }),
            stroke: new Stroke({ color: '#ffffff', width: 3 })
          })
        })];
      }
      if (kind === 'nav-leg') {
        return [new Style({
          stroke: new Stroke({ color: '#7048e8', width: 3, lineDash: [10, 6] })
        })];
      }
      return null;
    }

    function markStyle(feature) {
      const { Style, Circle, Fill, Stroke, Text, RegularShape } = Origo.ol.style;
      const kind = feature.get('kind');
      if (kind === 'anchor-circle') {
        return [new Style({
          fill: new Fill({ color: 'rgba(250,176,5,0.10)' }),
          stroke: new Stroke({ color: '#f08c00', width: 2, lineDash: [6, 4] })
        })];
      }
      const isMob = feature.get('type') === 'mob';
      const label = feature.get('name') || '';
      const image = isMob
        ? new RegularShape({
          points: 4,
          radius: 9,
          angle: Math.PI / 4,
          fill: new Fill({ color: '#e03131' }),
          stroke: new Stroke({ color: '#ffffff', width: 2 })
        })
        : new Circle({
          radius: 6,
          fill: new Fill({ color: '#1c7ed6' }),
          stroke: new Stroke({ color: '#ffffff', width: 2 })
        });
      return [new Style({
        image,
        text: new Text({
          text: label,
          offsetY: -16,
          font: '11px sans-serif',
          fill: new Fill({ color: '#212529' }),
          stroke: new Stroke({ color: '#ffffff', width: 3 })
        })
      })];
    }

    // ============================================================
    // GPS
    // ============================================================
    function startGps() {
      if (watchId !== null) return;
      if (!navigator.geolocation) {
        gpsState = 'error';
        gpsMsg = 'Enheten/webbläsaren saknar stöd för positionering.';
        renderInstruments();
        return;
      }
      if (!window.isSecureContext) {
        gpsState = 'error';
        gpsMsg = 'GPS kräver HTTPS. Sidan körs över osäker anslutning.';
        renderInstruments();
        return;
      }
      gpsState = 'wait';
      gpsMsg = 'Söker satelliter …';
      renderInstruments();
      watchId = navigator.geolocation.watchPosition(onFix, onGpsError, {
        enableHighAccuracy: true,
        maximumAge: 1000,
        timeout: 30000
      });
    }

    function stopGps() {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      watchId = null;
      gpsState = 'off';
      gpsMsg = 'GPS stoppad';
    }

    function onGpsError(err) {
      gpsState = 'error';
      if (err.code === 1) gpsMsg = 'Positionering nekad – tillåt platsåtkomst för sidan.';
      else if (err.code === 2) gpsMsg = 'Ingen position tillgänglig.';
      else if (err.code === 3) gpsMsg = 'Tidsgränsen gick ut – ingen fix ännu.';
      else gpsMsg = `GPS-fel: ${err.message || err.code}`;
      renderInstruments();
    }

    function onFix(pos) {
      const c = pos.coords;
      const ts = pos.timestamp || Date.now();
      const lon = c.longitude;
      const lat = c.latitude;

      let sog = Number.isFinite(c.speed) ? c.speed : null;
      let cog = Number.isFinite(c.heading) ? c.heading : null;

      // Enheter utan Doppler-fart (och stillastående enheter) rapporterar
      // null – räkna då fram fart och kurs ur två på varandra följande fixar.
      if ((sog === null || cog === null) && fix) {
        const d = haversine([fix.lon, fix.lat], [lon, lat]);
        const dt = (ts - fix.ts) / 1000;
        if (dt > 0.5 && d > 1.5) {
          if (sog === null) sog = d / dt;
          if (cog === null) cog = bearingTo([fix.lon, fix.lat], [lon, lat]);
        } else if (sog === null) {
          sog = 0;
        }
      }

      sogSmooth = (sogSmooth === null || sog === null) ? sog : (sogSmooth * 0.6) + (sog * 0.4);

      fix = {
        lon,
        lat,
        acc: Number.isFinite(c.accuracy) ? c.accuracy : null,
        alt: Number.isFinite(c.altitude) ? c.altitude : null,
        sog,
        cog,
        ts
      };
      gpsState = 'ok';
      gpsMsg = '';

      drawShip();
      recordPoint();
      applyFollow();
      checkAlarms();
      renderInstruments();
    }

    /** SOG som ska visas/räknas med (utjämnad, aldrig negativ). */
    function speed() {
      const v = sogSmooth !== null ? sogSmooth : (fix ? fix.sog : null);
      return v === null ? null : Math.max(0, v);
    }

    /** Kurs som ritas ut: COG när båten rör sig, annars kompassen. */
    function heading() {
      if (fix && fix.cog !== null && (speed() || 0) > 0.5) return fix.cog;
      if (compassHdg !== null) return compassHdg;
      return fix ? fix.cog : null;
    }

    function drawShip() {
      if (!fix) return;
      const { Point, LineString, Circle: CircleGeom } = Origo.ol.geom;
      const center = toMap([fix.lon, fix.lat]);
      shipFeat.setGeometry(new Point(center));
      shipFeat.set('hdg', heading());
      shipFeat.set('stale', Date.now() - fix.ts > 15000);

      if (fix.acc) accFeat.setGeometry(new CircleGeom(center, fix.acc));
      else accFeat.setGeometry(null);

      const sp = speed();
      const hd = heading();
      if (sp !== null && sp > 0.3 && hd !== null && set().predictMin > 0) {
        const ahead = destPoint([fix.lon, fix.lat], hd, sp * 60 * set().predictMin);
        predFeat.setGeometry(new LineString([center, toMap(ahead)]));
      } else {
        predFeat.setGeometry(new LineString([center, center]));
      }
      lyr.ship.setVisible(true);
    }

    function applyFollow() {
      if (!fix) return;
      const view = map.getView();
      if (set().follow) view.setCenter(toMap([fix.lon, fix.lat]));
      if (set().courseUp) {
        const hd = heading();
        if (hd !== null) view.setRotation(-hd * D2R);
      }
    }

    function onPointerDrag() {
      if (!set().follow) return;
      set().follow = false;
      persist();
      syncToggles();
    }

    // ---- kompass (enhetens magnetometer) ----
    function onOrientation(e) {
      let hdg = null;
      if (typeof e.webkitCompassHeading === 'number') hdg = e.webkitCompassHeading;
      else if (e.absolute && typeof e.alpha === 'number') hdg = (360 - e.alpha) % 360;
      if (hdg === null || Number.isNaN(hdg)) return;
      compassHdg = hdg;
      if (fix) shipFeat.set('hdg', heading());
    }

    async function toggleCompass() {
      if (compassOn) {
        window.removeEventListener('deviceorientationabsolute', onOrientation);
        window.removeEventListener('deviceorientation', onOrientation);
        compassOn = false;
        compassHdg = null;
        syncToggles();
        return;
      }
      try {
        const DOE = window.DeviceOrientationEvent;
        if (DOE && typeof DOE.requestPermission === 'function') {
          const res = await DOE.requestPermission();
          if (res !== 'granted') { setStatus('Kompassen nekades av enheten.', true); return; }
        }
        if ('ondeviceorientationabsolute' in window) {
          window.addEventListener('deviceorientationabsolute', onOrientation);
        } else {
          window.addEventListener('deviceorientation', onOrientation);
        }
        compassOn = true;
        syncToggles();
      } catch (err) {
        setStatus(`Kompassen kunde inte startas: ${err.message}`, true);
      }
    }

    // ---- skärmlås ----
    async function setKeepAwake(on) {
      set().keepAwake = on;
      persist();
      try {
        if (on) {
          if (!navigator.wakeLock) { setStatus('Skärmlås stöds inte i den här webbläsaren.', true); return; }
          wakeLock = await navigator.wakeLock.request('screen');
          wakeLock.addEventListener('release', () => { wakeLock = null; });
        } else if (wakeLock) {
          await wakeLock.release();
          wakeLock = null;
        }
      } catch (err) {
        setStatus(`Skärmlås misslyckades: ${err.message}`, true);
      }
    }

    function onVisibility() {
      if (document.visibilityState === 'visible' && active && set().keepAwake && !wakeLock) setKeepAwake(true);
    }

    // ---- nattläge ----
    function applyNight() {
      const host = document.getElementById(viewer.getId());
      if (host) host.classList.toggle('o-plotter-night', !!(active && set().night));
    }

    // ============================================================
    // Spårinspelning
    // ============================================================
    function recStats() {
      if (!rec) return { dist: 0, elapsed: 0, avg: null, max: 0, n: 0 };
      const now = rec.state === 'paused' ? rec.pauseStart : Date.now();
      const elapsed = Math.max(0, now - rec.startedAt - rec.pausedMs);
      return {
        dist: rec.dist,
        elapsed,
        avg: elapsed > 5000 ? rec.dist / (elapsed / 1000) : null,
        max: rec.maxSpeed,
        n: rec.points.length
      };
    }

    function startRec() {
      rec = {
        state: 'recording',
        points: [],
        startedAt: Date.now(),
        pausedMs: 0,
        pauseStart: 0,
        dist: 0,
        maxSpeed: 0
      };
      recFeat.setGeometry(new Origo.ol.geom.LineString([]));
      if (fix) recordPoint();
      renderTrackPane();
    }

    function pauseRec() {
      if (!rec || rec.state !== 'recording') return;
      rec.state = 'paused';
      rec.pauseStart = Date.now();
      renderTrackPane();
    }

    function resumeRec() {
      if (!rec || rec.state !== 'paused') return;
      rec.pausedMs += Date.now() - rec.pauseStart;
      rec.state = 'recording';
      renderTrackPane();
    }

    function recordPoint() {
      if (!rec || rec.state !== 'recording' || !fix) return;
      const last = rec.points[rec.points.length - 1];
      if (last) {
        const d = haversine([last[0], last[1]], [fix.lon, fix.lat]);
        const dt = fix.ts - last[2];
        // Filtrera bort GPS-brus vid stillaliggande båt: ny punkt krävs
        // antingen tillräckligt lång förflyttning eller en lång tystnad.
        if (d < set().minDist && dt < 60000) return;
        rec.dist += d;
      }
      rec.points.push([fix.lon, fix.lat, fix.ts]);
      const sp = speed();
      if (sp !== null && sp > rec.maxSpeed) rec.maxSpeed = sp;
      recFeat.setGeometry(new Origo.ol.geom.LineString(lineToMap(rec.points)));
      renderTrackPane();
    }

    function saveRec() {
      if (!rec) return;
      if (rec.points.length < 2) {
        setStatus('Spåret innehåller för få punkter för att sparas.', true);
        return;
      }
      const st = recStats();
      const track = {
        id: uid(),
        name: `Spår ${fmtDate(rec.startedAt)}`,
        created: rec.startedAt,
        ended: Date.now(),
        points: rec.points.slice(),
        dist: st.dist,
        elapsed: st.elapsed,
        maxSpeed: st.maxSpeed,
        color: TRACK_COLORS[store.tracks.length % TRACK_COLORS.length],
        visible: true
      };
      store.tracks.unshift(track);
      persist();
      discardRec();
      drawSaved();
      renderTrackPane();
      setStatus(`Spår sparat: ${fmtDist(track.dist)}.`);
    }

    function discardRec() {
      rec = null;
      recFeat.setGeometry(new Origo.ol.geom.LineString([]));
      renderTrackPane();
    }

    function drawSaved() {
      src.saved.clear();
      const { Feature } = Origo.ol;
      const { LineString } = Origo.ol.geom;
      store.tracks.forEach((t) => {
        if (t.visible === false) return;
        const f = new Feature({ geometry: new LineString(lineToMap(t.points)) });
        f.set('color', t.color);
        f.set('trackId', t.id);
        src.saved.addFeature(f);
      });
    }

    // ============================================================
    // Rutter
    // ============================================================
    function newRoute() {
      cancelEdit();
      edit = { wps: [], editingId: null, name: '' };
      clickMode = 'route';
      editFeat = new Origo.ol.Feature({ geometry: new Origo.ol.geom.LineString([]) });
      editFeat.set('kind', 'route-line');
      editFeat.set('isEdit', true);
      editColl.clear();
      editColl.push(editFeat);
      map.addInteraction(modify);
      drawRoutes();
      renderRoutePane();
      setStatus('Klicka i kartan för att lägga till waypoints. Dra en punkt för att flytta, alt+klick tar bort.');
    }

    function editRoute(id) {
      const r = store.routes.find((x) => x.id === id);
      if (!r) return;
      newRoute();
      edit.wps = r.wps.map((w) => ({ lon: w.lon, lat: w.lat, name: w.name }));
      edit.editingId = r.id;
      edit.name = r.name;
      syncEditGeom();
      renderRoutePane();
    }

    function cancelEdit() {
      if (!edit) return;
      edit = null;
      clickMode = null;
      editColl.clear();
      try { map.removeInteraction(modify); } catch (e) { /* ej tillagd */ }
      editFeat = null;
      drawRoutes();
      renderRoutePane();
    }

    function syncEditGeom() {
      if (!editFeat) return;
      editFeat.setGeometry(new Origo.ol.geom.LineString(
        edit.wps.map((w) => toMap([w.lon, w.lat]))
      ));
      drawRoutes();
    }

    function onModifyEnd() {
      if (!edit || !editFeat) return;
      const coords = editFeat.getGeometry().getCoordinates();
      // Modify kan både flytta och infoga punkter. Är antalet oförändrat sitter
      // namnen kvar på sina index; har en punkt tillkommit går indexen isär och
      // vi numrerar om hela rutten i stället för att sätta fel namn på fel punkt.
      const keepNames = coords.length === edit.wps.length;
      edit.wps = coords.map((c, i) => {
        const ll = toLonLat(c);
        const old = keepNames ? edit.wps[i] : null;
        return { lon: ll[0], lat: ll[1], name: (old && old.name) || `WP${i + 1}` };
      });
      drawRoutes();
      renderRoutePane();
    }

    function addWaypoint(coord) {
      if (!edit) return;
      const ll = toLonLat(coord);
      edit.wps.push({ lon: ll[0], lat: ll[1], name: `WP${edit.wps.length + 1}` });
      syncEditGeom();
      renderRoutePane();
    }

    function undoWaypoint() {
      if (!edit || !edit.wps.length) return;
      edit.wps.pop();
      syncEditGeom();
      renderRoutePane();
    }

    function saveRoute() {
      if (!edit || edit.wps.length < 2) {
        setStatus('En rutt behöver minst två waypoints.', true);
        return;
      }
      const suggested = edit.name || `Rutt ${fmtDate(Date.now())}`;
      const name = window.prompt('Namn på rutten', suggested);
      if (name === null) return;
      if (edit.editingId) {
        const r = store.routes.find((x) => x.id === edit.editingId);
        if (r) { r.wps = edit.wps.slice(); r.name = name.trim() || r.name; }
      } else {
        store.routes.unshift({
          id: uid(),
          name: name.trim() || suggested,
          created: Date.now(),
          wps: edit.wps.slice()
        });
      }
      persist();
      cancelEdit();
      setStatus('Rutten sparad.');
    }

    function routeLength(r) {
      let d = 0;
      for (let i = 1; i < r.wps.length; i += 1) {
        d += haversine([r.wps[i - 1].lon, r.wps[i - 1].lat], [r.wps[i].lon, r.wps[i].lat]);
      }
      return d;
    }

    /** Ritar alla synliga rutter, ruttens waypoints och den aktiva navlinjen. */
    function drawRoutes() {
      src.route.clear();
      const { Feature } = Origo.ol;
      const { LineString, Point } = Origo.ol.geom;

      const addRoute = (wps, opts) => {
        if (wps.length >= 2) {
          const line = new Feature({ geometry: new LineString(wps.map((w) => toMap([w.lon, w.lat]))) });
          line.set('kind', 'route-line');
          line.set('isActive', !!opts.isActive);
          line.set('isEdit', !!opts.isEdit);
          src.route.addFeature(line);
        }
        wps.forEach((w, i) => {
          const p = new Feature({ geometry: new Point(toMap([w.lon, w.lat])) });
          p.set('kind', 'route-wp');
          p.set('label', w.name || `WP${i + 1}`);
          p.set('isTarget', opts.targetIndex === i);
          src.route.addFeature(p);
        });
      };

      store.routes.forEach((r) => {
        if (r.visible === false) return;
        if (edit && edit.editingId === r.id) return;
        const isActive = !!(store.nav && store.nav.type === 'route' && store.nav.routeId === r.id);
        addRoute(r.wps, { isActive, targetIndex: isActive ? store.nav.wpIndex : -1 });
      });

      if (edit) addRoute(edit.wps, { isEdit: true, targetIndex: -1 });

      // Aktiv navlinje: från nuvarande position till målpunkten.
      const t = navTarget();
      if (t && fix) {
        const leg = new Feature({
          geometry: new LineString([toMap([fix.lon, fix.lat]), toMap([t.lon, t.lat])])
        });
        leg.set('kind', 'nav-leg');
        src.route.addFeature(leg);
      }
    }

    // ============================================================
    // Punkter / märken / ankare
    // ============================================================
    function addMark(lon, lat, name, type) {
      const m = {
        id: uid(),
        name: name || `Punkt ${store.marks.length + 1}`,
        lon,
        lat,
        type: type || 'wp',
        created: Date.now()
      };
      store.marks.unshift(m);
      persist();
      drawMarks();
      renderMarkPane();
      return m;
    }

    function mob() {
      if (!fix) { setStatus('Ingen GPS-position – MOB kan inte sättas.', true); return; }
      const m = addMark(fix.lon, fix.lat, `MOB ${fmtClock(new Date())}`, 'mob');
      startNavMark(m.id);
      beep(3, 1200);
      setStatus('MAN ÖVERBORD markerad – navigering startad.', true);
    }

    function drawMarks() {
      src.mark.clear();
      const { Feature } = Origo.ol;
      const { Point, Circle: CircleGeom } = Origo.ol.geom;
      store.marks.forEach((m) => {
        const f = new Feature({ geometry: new Point(toMap([m.lon, m.lat])) });
        f.set('kind', 'mark');
        f.set('name', m.name);
        f.set('type', m.type);
        f.set('markId', m.id);
        src.mark.addFeature(f);
      });
      if (store.anchor) {
        const c = toMap([store.anchor.lon, store.anchor.lat]);
        const ring = new Feature({ geometry: new CircleGeom(c, store.anchor.radius) });
        ring.set('kind', 'anchor-circle');
        src.mark.addFeature(ring);
        const pt = new Feature({ geometry: new Point(c) });
        pt.set('kind', 'mark');
        pt.set('name', 'Ankare');
        pt.set('type', 'wp');
        src.mark.addFeature(pt);
      }
    }

    function dropAnchor() {
      if (!fix) { setStatus('Ingen GPS-position – ankarvakten kan inte startas.', true); return; }
      const r = parseFloat(panelEl.querySelector('.o-plt-anchor-radius').value) || 30;
      store.anchor = { lon: fix.lon, lat: fix.lat, radius: r };
      alarmed.anchor = false;
      persist();
      drawMarks();
      renderInstruments();
      setStatus(`Ankarvakt aktiv, radie ${Math.round(r)} m.`);
    }

    function liftAnchor() {
      store.anchor = null;
      alarmed.anchor = false;
      persist();
      drawMarks();
      renderInstruments();
    }

    // ============================================================
    // Navigering
    // ============================================================
    function startNavRoute(id, reverse) {
      const r = store.routes.find((x) => x.id === id);
      if (!r || r.wps.length < 2) return;
      if (reverse) { r.wps = r.wps.slice().reverse(); persist(); }
      // Starta mot den waypoint som ligger närmast om vi har en fix, annars WP2.
      let wpIndex = 1;
      if (fix) {
        let best = Infinity;
        r.wps.forEach((w, i) => {
          if (i === 0) return;
          const d = haversine([fix.lon, fix.lat], [w.lon, w.lat]);
          if (d < best) { best = d; wpIndex = i; }
        });
      }
      store.nav = { type: 'route', routeId: id, wpIndex };
      resetAlarms();
      persist();
      drawRoutes();
      renderAll();
      setStatus(`Navigerar rutt "${r.name}".`);
    }

    function startNavMark(id) {
      store.nav = { type: 'mark', markId: id };
      resetAlarms();
      persist();
      drawRoutes();
      renderAll();
    }

    function stopNav() {
      store.nav = null;
      resetAlarms();
      persist();
      drawRoutes();
      renderAll();
    }

    function resetAlarms() {
      alarmed.arrival = false;
      alarmed.xte = false;
    }

    /** Nuvarande måldestination { lon, lat, name } eller null. */
    function navTarget() {
      const n = store.nav;
      if (!n) return null;
      if (n.type === 'mark') {
        const m = store.marks.find((x) => x.id === n.markId);
        return m ? { lon: m.lon, lat: m.lat, name: m.name } : null;
      }
      const r = store.routes.find((x) => x.id === n.routeId);
      if (!r) return null;
      const w = r.wps[n.wpIndex];
      return w ? { lon: w.lon, lat: w.lat, name: w.name || `WP${n.wpIndex + 1}` } : null;
    }

    /** Startpunkten för aktuellt ben (för XTE) eller null. */
    function navLegStart() {
      const n = store.nav;
      if (!n || n.type !== 'route' || n.wpIndex < 1) return null;
      const r = store.routes.find((x) => x.id === n.routeId);
      if (!r) return null;
      const w = r.wps[n.wpIndex - 1];
      return w ? [w.lon, w.lat] : null;
    }

    /** Beräknar hela navigationsbilden utifrån senaste fix. */
    function navData() {
      const t = navTarget();
      if (!t || !fix) return null;
      const here = [fix.lon, fix.lat];
      const dtw = haversine(here, [t.lon, t.lat]);
      const btw = bearingTo(here, [t.lon, t.lat]);
      const legStart = navLegStart();
      const xte = legStart ? crossTrack(legStart, [t.lon, t.lat], here) : null;
      const sp = speed();
      const cog = fix.cog;
      const vmg = (sp !== null && cog !== null) ? sp * Math.cos(angleDiff(btw, cog) * D2R) : null;

      // Återstående distans längs rutten (nuvarande ben + kvarvarande ben).
      let remaining = dtw;
      const n = store.nav;
      if (n.type === 'route') {
        const r = store.routes.find((x) => x.id === n.routeId);
        if (r) {
          for (let i = n.wpIndex + 1; i < r.wps.length; i += 1) {
            remaining += haversine(
              [r.wps[i - 1].lon, r.wps[i - 1].lat],
              [r.wps[i].lon, r.wps[i].lat]
            );
          }
        }
      }
      const ttg = (vmg !== null && vmg > 0.2) ? (dtw / vmg) * 1000 : null;
      const ttgRoute = (vmg !== null && vmg > 0.2) ? (remaining / vmg) * 1000 : null;
      return { target: t, dtw, btw, xte, vmg, ttg, ttgRoute, remaining };
    }

    function checkAlarms() {
      const d = navData();
      if (d) {
        // Ankomst: byt automatiskt till nästa waypoint i rutten.
        if (d.dtw <= set().arrivalRadius) {
          if (!alarmed.arrival) {
            alarmed.arrival = true;
            if (set().alarms) beep(2, 900);
            setStatus(`Framme vid ${d.target.name}.`);
          }
          const n = store.nav;
          if (n.type === 'route') {
            const r = store.routes.find((x) => x.id === n.routeId);
            if (r && n.wpIndex < r.wps.length - 1) {
              n.wpIndex += 1;
              resetAlarms();
              persist();
              drawRoutes();
            }
          }
        } else {
          alarmed.arrival = false;
        }

        if (d.xte !== null && Math.abs(d.xte) > set().xteLimit) {
          if (!alarmed.xte) {
            alarmed.xte = true;
            if (set().alarms) beep(2, 500);
          }
        } else {
          alarmed.xte = false;
        }
      }

      if (store.anchor && fix) {
        const drift = haversine([store.anchor.lon, store.anchor.lat], [fix.lon, fix.lat]);
        if (drift > store.anchor.radius) {
          if (!alarmed.anchor) {
            alarmed.anchor = true;
            if (set().alarms) beep(5, 1400);
            setStatus(`ANKARLARM – båten är ${Math.round(drift)} m från ankarpunkten.`, true);
          }
        } else {
          alarmed.anchor = false;
        }
      }
      drawRoutes();
    }

    function ensureAudio() {
      if (audioCtx) return audioCtx;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
      return audioCtx;
    }

    function beep(times, freq) {
      const ctx = audioCtx;
      if (!ctx || !set().alarms) return;
      if (ctx.state === 'suspended') ctx.resume();
      for (let i = 0; i < times; i += 1) {
        const t0 = ctx.currentTime + (i * 0.28);
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.25, t0 + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t0);
        osc.stop(t0 + 0.22);
      }
    }

    // ============================================================
    // Panel
    // ============================================================
    function buildPanel() {
      const el = document.createElement('div');
      el.className = 'o-plt-panel';
      el.innerHTML = `
        <div class="o-plt-header">
          <span class="o-plt-dot" title="GPS-status"></span>
          <span class="o-plt-title">Plotter</span>
          <span class="o-plt-hdr-live"></span>
          <button type="button" class="o-plt-min" title="Minimera">–</button>
          <button type="button" class="o-plt-close" title="Stäng">&times;</button>
        </div>
        <div class="o-plt-tabs">
          <button type="button" data-tab="nav" class="is-active">Instrument</button>
          <button type="button" data-tab="track">Spår</button>
          <button type="button" data-tab="route">Rutter</button>
          <button type="button" data-tab="mark">Punkter</button>
          <button type="button" data-tab="set">Inställn.</button>
        </div>
        <div class="o-plt-body">
          <section data-pane="nav" class="is-active">
            <div class="o-plt-gauges">
              <div class="o-plt-gauge o-plt-gauge-big">
                <b class="o-plt-sog">–</b><small>SOG (knop)</small>
              </div>
              <div class="o-plt-gauge o-plt-gauge-big">
                <b class="o-plt-cog">–</b><small>COG</small>
              </div>
            </div>
            <div class="o-plt-kv o-plt-fixinfo"></div>
            <div class="o-plt-navblock"></div>
            <div class="o-plt-toggles">
              <button type="button" data-tgl="follow">Följ mig</button>
              <button type="button" data-tgl="courseUp">Kurs upp</button>
              <button type="button" data-tgl="night">Nattläge</button>
              <button type="button" data-tgl="keepAwake">Skärm på</button>
              <button type="button" data-tgl="compass">Kompass</button>
            </div>
            <div class="o-plt-anchor">
              <div class="o-plt-sub">Ankarvakt</div>
              <div class="o-plt-row">
                <label>Radie <input type="number" class="o-plt-anchor-radius" min="5" max="500" step="5" value="30"> m</label>
                <button type="button" class="o-plt-anchor-drop">Fäll ankare</button>
                <button type="button" class="o-plt-anchor-lift">Lätta ankar</button>
              </div>
              <div class="o-plt-anchor-state"></div>
            </div>
            <button type="button" class="o-plt-mob">MAN ÖVERBORD</button>
          </section>

          <section data-pane="track">
            <div class="o-plt-recbar">
              <button type="button" class="o-plt-rec-start">Spela in</button>
              <button type="button" class="o-plt-rec-pause">Paus</button>
              <button type="button" class="o-plt-rec-save">Spara spår</button>
              <button type="button" class="o-plt-rec-discard">Släng</button>
            </div>
            <div class="o-plt-kv o-plt-recstats"></div>
            <div class="o-plt-sub">Sparade spår</div>
            <div class="o-plt-list o-plt-tracklist"></div>
            <div class="o-plt-row">
              <button type="button" class="o-plt-import" data-what="gpx">Importera GPX</button>
              <button type="button" class="o-plt-export-tracks">Exportera alla spår</button>
            </div>
          </section>

          <section data-pane="route">
            <div class="o-plt-editbar"></div>
            <div class="o-plt-list o-plt-wplist"></div>
            <div class="o-plt-sub">Sparade rutter</div>
            <div class="o-plt-list o-plt-routelist"></div>
            <div class="o-plt-row">
              <button type="button" class="o-plt-import" data-what="gpx">Importera GPX</button>
              <button type="button" class="o-plt-export-routes">Exportera alla rutter</button>
            </div>
          </section>

          <section data-pane="mark">
            <div class="o-plt-row">
              <button type="button" class="o-plt-mark-here">Punkt vid min position</button>
              <button type="button" class="o-plt-mark-click">Punkt via kartklick</button>
            </div>
            <div class="o-plt-list o-plt-marklist"></div>
            <div class="o-plt-row">
              <button type="button" class="o-plt-export-marks">Exportera punkter</button>
            </div>
          </section>

          <section data-pane="set">
            <label class="o-plt-field">Positionsformat
              <select class="o-plt-f" data-key="posFormat">
                <option value="dm">Grader och decimalminuter (58° 07,407′ N)</option>
                <option value="dd">Decimalgrader (58,12345°)</option>
                <option value="dms">Grader, minuter, sekunder</option>
              </select>
            </label>
            <label class="o-plt-field">Ankomstradie (m)
              <input type="number" class="o-plt-f" data-key="arrivalRadius" min="5" max="1000" step="5">
            </label>
            <label class="o-plt-field">XTE-larm vid (m)
              <input type="number" class="o-plt-f" data-key="xteLimit" min="5" max="2000" step="5">
            </label>
            <label class="o-plt-field">Minsta avstånd mellan spårpunkter (m)
              <input type="number" class="o-plt-f" data-key="minDist" min="1" max="200" step="1">
            </label>
            <label class="o-plt-field">Prediktorlinje (minuter framåt)
              <input type="number" class="o-plt-f" data-key="predictMin" min="0" max="60" step="1">
            </label>
            <label class="o-plt-check"><input type="checkbox" class="o-plt-f" data-key="alarms"> Ljudlarm på</label>
            <div class="o-plt-sub">Säkerhetskopia</div>
            <div class="o-plt-row">
              <button type="button" class="o-plt-backup">Exportera allt (JSON)</button>
              <button type="button" class="o-plt-import" data-what="json">Importera JSON</button>
            </div>
            <button type="button" class="o-plt-wipe">Radera alla plotterdata</button>
            <p class="o-plt-note">
              Data sparas lokalt i den här webbläsaren. GPS och skärmlås kräver
              att sidan öppnas över HTTPS.
            </p>
          </section>
        </div>
        <div class="o-plt-status"></div>
        <input type="file" class="o-plt-file" accept=".gpx,.xml,.json" hidden>
      `;

      statusEl = el.querySelector('.o-plt-status');
      fileInput = el.querySelector('.o-plt-file');

      el.querySelector('.o-plt-close').addEventListener('click', deactivate);
      el.querySelector('.o-plt-min').addEventListener('click', () => {
        el.classList.toggle('is-min');
      });

      el.querySelectorAll('.o-plt-tabs button').forEach((b) => {
        tabs[b.dataset.tab] = b;
        b.addEventListener('click', () => showTab(b.dataset.tab));
      });
      el.querySelectorAll('.o-plt-body section').forEach((s) => {
        panes[s.dataset.pane] = s;
      });

      // Ljudkontexten måste skapas från en användargest för att larm ska höras.
      el.addEventListener('click', () => ensureAudio(), { capture: true });

      el.querySelectorAll('.o-plt-toggles button').forEach((b) => {
        b.addEventListener('click', () => onToggle(b.dataset.tgl));
      });

      el.querySelector('.o-plt-mob').addEventListener('click', mob);
      el.querySelector('.o-plt-anchor-drop').addEventListener('click', dropAnchor);
      el.querySelector('.o-plt-anchor-lift').addEventListener('click', liftAnchor);

      el.querySelector('.o-plt-rec-start').addEventListener('click', () => {
        if (!rec) startRec();
        else if (rec.state === 'paused') resumeRec();
      });
      el.querySelector('.o-plt-rec-pause').addEventListener('click', pauseRec);
      el.querySelector('.o-plt-rec-save').addEventListener('click', saveRec);
      el.querySelector('.o-plt-rec-discard').addEventListener('click', () => {
        if (rec && rec.points.length > 1 && !window.confirm('Släng det aktiva spåret utan att spara?')) return;
        discardRec();
      });

      el.querySelector('.o-plt-export-tracks').addEventListener('click', () => exportGpx({ tracks: store.tracks }, 'spar'));
      el.querySelector('.o-plt-export-routes').addEventListener('click', () => exportGpx({ routes: store.routes }, 'rutter'));
      el.querySelector('.o-plt-export-marks').addEventListener('click', () => exportGpx({ marks: store.marks }, 'punkter'));

      el.querySelector('.o-plt-mark-here').addEventListener('click', () => {
        if (!fix) { setStatus('Ingen GPS-position ännu.', true); return; }
        addMark(fix.lon, fix.lat, `Punkt ${fmtClock(new Date())}`);
        setStatus('Punkt sparad.');
      });
      el.querySelector('.o-plt-mark-click').addEventListener('click', () => {
        clickMode = clickMode === 'mark' ? null : 'mark';
        setStatus(clickMode === 'mark' ? 'Klicka i kartan för att placera punkten.' : '');
        renderMarkPane();
      });

      el.querySelectorAll('.o-plt-import').forEach((b) => {
        b.addEventListener('click', () => {
          fileInput.dataset.what = b.dataset.what;
          fileInput.click();
        });
      });
      fileInput.addEventListener('change', onFilePicked);

      el.querySelectorAll('.o-plt-f').forEach((inp) => {
        inp.addEventListener('change', () => {
          const key = inp.dataset.key;
          if (inp.type === 'checkbox') set()[key] = inp.checked;
          else if (inp.type === 'number') set()[key] = parseFloat(inp.value);
          else set()[key] = inp.value;
          persist();
          drawShip();
          renderAll();
        });
      });

      el.querySelector('.o-plt-backup').addEventListener('click', () => {
        const blob = new Blob([JSON.stringify(store, null, 1)], { type: 'application/json' });
        download(blob, `plotter-backup-${stamp(Date.now())}.json`);
      });
      el.querySelector('.o-plt-wipe').addEventListener('click', () => {
        if (!window.confirm('Radera alla spår, rutter och punkter permanent?')) return;
        store = defaults();
        persist();
        cancelEdit();
        discardRec();
        drawSaved();
        drawRoutes();
        drawMarks();
        renderAll();
        setStatus('Alla plotterdata raderade.');
      });

      // Listorna använder delegering: knapparna bär data-act och data-id.
      ['tracklist', 'routelist', 'marklist', 'wplist', 'editbar', 'navblock'].forEach((c) => {
        el.querySelector(`.o-plt-${c}`).addEventListener('click', onListClick);
      });

      if (store.anchor) el.querySelector('.o-plt-anchor-radius').value = store.anchor.radius;

      if (root.PanelDrag) root.PanelDrag.makeDraggable(el, el.querySelector('.o-plt-header'));
      panelEl = el;
      return el;
    }

    function showTab(name) {
      Object.keys(tabs).forEach((k) => tabs[k].classList.toggle('is-active', k === name));
      Object.keys(panes).forEach((k) => panes[k].classList.toggle('is-active', k === name));
      if (panelEl) panelEl.classList.remove('is-min');
    }

    function onToggle(key) {
      if (key === 'compass') { toggleCompass(); return; }
      set()[key] = !set()[key];
      persist();
      if (key === 'night') applyNight();
      if (key === 'keepAwake') setKeepAwake(set().keepAwake);
      if (key === 'courseUp' && !set().courseUp) map.getView().setRotation(0);
      if (key === 'follow' && set().follow) applyFollow();
      syncToggles();
    }

    function syncToggles() {
      if (!panelEl) return;
      panelEl.querySelectorAll('.o-plt-toggles button').forEach((b) => {
        const k = b.dataset.tgl;
        const on = k === 'compass' ? compassOn : !!set()[k];
        b.classList.toggle('is-on', on);
      });
    }

    function setStatus(text, isError) {
      if (!statusEl) return;
      statusEl.textContent = text || '';
      statusEl.classList.toggle('is-error', !!isError);
    }

    // ---- rendering av instrumentpanelen ----
    function renderInstruments() {
      if (!panelEl) return;
      const sp = speed();
      const hd = heading();
      panelEl.querySelector('.o-plt-sog').textContent = fmtSpeed(sp);
      panelEl.querySelector('.o-plt-cog').textContent = fmtBrg(fix ? fix.cog : null);

      const dot = panelEl.querySelector('.o-plt-dot');
      dot.className = `o-plt-dot is-${gpsState}`;
      dot.title = gpsMsg || 'GPS aktiv';

      const live = panelEl.querySelector('.o-plt-hdr-live');
      live.textContent = fix ? `${fmtSpeed(sp)} kn  ${fmtBrg(fix.cog)}` : '';

      const rows = [];
      if (fix) {
        rows.push(['Position', fmtPos(fix.lon, fix.lat, set().posFormat)]);
        rows.push(['Noggrannhet', fix.acc === null ? '–' : `± ${Math.round(fix.acc)} m`]);
        if (fix.alt !== null) rows.push(['Höjd', `${num(fix.alt, 1)} m`]);
        if (compassHdg !== null) rows.push(['Kompass', fmtBrg(compassHdg)]);
        if (hd !== null && fix.cog === null) rows.push(['Riktning', fmtBrg(hd)]);
        const age = Math.round((Date.now() - fix.ts) / 1000);
        rows.push(['Senaste fix', age < 3 ? 'nu' : `${age} s sedan`]);
      } else {
        rows.push(['Status', gpsMsg || 'Väntar på position …']);
      }
      if (gpsState === 'error') rows.push(['GPS', gpsMsg]);
      panelEl.querySelector('.o-plt-fixinfo').innerHTML = kvHtml(rows);

      renderNavBlock();
      renderAnchorState();
      syncToggles();
    }

    function kvHtml(rows) {
      return rows.map((r) => `<div><span>${esc(r[0])}</span><b>${esc(r[1])}</b></div>`).join('');
    }

    function renderNavBlock() {
      const host = panelEl.querySelector('.o-plt-navblock');
      const n = store.nav;
      if (!n) {
        host.innerHTML = '<div class="o-plt-hint">Ingen aktiv navigering. Starta från en rutt eller punkt.</div>';
        return;
      }
      const d = navData();
      const t = navTarget();
      if (!t) { host.innerHTML = '<div class="o-plt-hint">Målet finns inte längre.</div>'; return; }
      if (!d) {
        host.innerHTML = `<div class="o-plt-navhead">Mål: ${esc(t.name)}</div>`
          + '<div class="o-plt-hint">Väntar på GPS-position …</div>'
          + '<div class="o-plt-row"><button type="button" data-act="nav-stop">Avsluta navigering</button></div>';
        return;
      }
      const rows = [
        ['DTW – distans till mål', fmtDist(d.dtw)],
        ['BTW – bäring till mål', fmtBrg(d.btw)],
        // Positiv XTE = båten ligger till höger om kurslinjen, dvs. styr babord tillbaka.
        ['XTE – kursavvikelse', d.xte === null ? '–' : `${Math.round(Math.abs(d.xte))} m, styr ${d.xte > 0 ? 'babord' : 'styrbord'}`],
        ['VMG mot mål', d.vmg === null ? '–' : `${fmtSpeed(d.vmg)} kn`],
        ['TTG – tid till mål', d.ttg === null ? '–' : fmtDuration(d.ttg)],
        ['ETA', d.ttg === null ? '–' : fmtClock(new Date(Date.now() + d.ttg))]
      ];
      if (n.type === 'route') {
        rows.push(['Kvar på rutten', fmtDist(d.remaining)]);
        rows.push(['ETA slutmål', d.ttgRoute === null ? '–' : fmtClock(new Date(Date.now() + d.ttgRoute))]);
      }
      const offTrack = d.xte !== null && Math.abs(d.xte) > set().xteLimit;
      host.innerHTML = `<div class="o-plt-navhead${offTrack ? ' is-warn' : ''}">Mål: ${esc(t.name)}</div>`
        + `<div class="o-plt-kv">${kvHtml(rows)}</div>`
        + '<div class="o-plt-row">'
        + (n.type === 'route' ? '<button type="button" data-act="nav-prev">◀ Föreg. WP</button>'
          + '<button type="button" data-act="nav-next">Nästa WP ▶</button>' : '')
        + '<button type="button" data-act="nav-stop">Avsluta</button></div>';
    }

    function renderAnchorState() {
      const el = panelEl.querySelector('.o-plt-anchor-state');
      if (!store.anchor) { el.textContent = 'Ankarvakten är av.'; el.classList.remove('is-warn'); return; }
      const drift = fix ? haversine([store.anchor.lon, store.anchor.lat], [fix.lon, fix.lat]) : null;
      const out = drift !== null && drift > store.anchor.radius;
      el.textContent = drift === null
        ? `Ankare satt, radie ${Math.round(store.anchor.radius)} m.`
        : `Avstånd till ankarpunkt: ${Math.round(drift)} m av ${Math.round(store.anchor.radius)} m${out ? ' – UTANFÖR!' : ''}`;
      el.classList.toggle('is-warn', !!out);
    }

    // ---- rendering av spårfliken ----
    function renderTrackPane() {
      if (!panelEl) return;
      const st = recStats();
      const state = rec ? rec.state : 'idle';
      panelEl.querySelector('.o-plt-rec-start').textContent = state === 'paused' ? 'Återuppta' : 'Spela in';
      panelEl.querySelector('.o-plt-rec-start').disabled = state === 'recording';
      panelEl.querySelector('.o-plt-rec-pause').disabled = state !== 'recording';
      panelEl.querySelector('.o-plt-rec-save').disabled = !rec || rec.points.length < 2;
      panelEl.querySelector('.o-plt-rec-discard').disabled = !rec;
      panelEl.querySelector('.o-plt-recbar').classList.toggle('is-recording', state === 'recording');

      panelEl.querySelector('.o-plt-recstats').innerHTML = rec ? kvHtml([
        ['Status', state === 'recording' ? 'Spelar in' : 'Pausad'],
        ['Sträcka', fmtDist(st.dist)],
        ['Tid', fmtDuration(st.elapsed)],
        ['Snittfart', st.avg === null ? '–' : `${fmtSpeed(st.avg)} kn`],
        ['Maxfart', `${fmtSpeed(st.max)} kn`],
        ['Punkter', String(st.n)]
      ]) : '<div class="o-plt-hint">Inget aktivt spår. Tryck “Spela in” för att börja logga färden.</div>';

      const list = panelEl.querySelector('.o-plt-tracklist');
      if (!store.tracks.length) {
        list.innerHTML = '<div class="o-plt-hint">Inga sparade spår ännu.</div>';
        return;
      }
      list.innerHTML = store.tracks.map((t) => `
        <div class="o-plt-item">
          <div class="o-plt-item-main">
            <i style="background:${esc(t.color)}"></i>
            <span class="o-plt-item-name">${esc(t.name)}</span>
            <span class="o-plt-item-meta">${fmtDist(t.dist || 0)} · ${fmtDuration(t.elapsed || 0)} · ${t.points.length} p</span>
          </div>
          <div class="o-plt-item-acts">
            <button type="button" data-act="track-vis" data-id="${t.id}">${t.visible === false ? 'Visa' : 'Dölj'}</button>
            <button type="button" data-act="track-zoom" data-id="${t.id}">Zooma</button>
            <button type="button" data-act="track-gpx" data-id="${t.id}">GPX</button>
            <button type="button" data-act="track-rename" data-id="${t.id}">Byt namn</button>
            <button type="button" data-act="track-del" data-id="${t.id}">Ta bort</button>
          </div>
        </div>`).join('');
    }

    // ---- rendering av ruttfliken ----
    function renderRoutePane() {
      if (!panelEl) return;
      const bar = panelEl.querySelector('.o-plt-editbar');
      const wpl = panelEl.querySelector('.o-plt-wplist');

      if (!edit) {
        bar.innerHTML = '<div class="o-plt-row"><button type="button" data-act="route-new">Ny rutt</button></div>'
          + '<div class="o-plt-hint">Skapa en rutt genom att klicka ut waypoints i kartan.</div>';
        wpl.innerHTML = '';
      } else {
        bar.innerHTML = '<div class="o-plt-row">'
          + '<button type="button" data-act="route-undo">Ångra sista</button>'
          + '<button type="button" data-act="route-save">Spara rutt</button>'
          + '<button type="button" data-act="route-cancel">Avbryt</button></div>'
          + `<div class="o-plt-hint">${edit.wps.length} waypoints · total ${fmtDist(legsLength(edit.wps))}. `
          + 'Klicka i kartan för att lägga till, dra för att flytta, alt+klick tar bort.</div>';
        wpl.innerHTML = edit.wps.map((w, i) => {
          const prev = i > 0 ? edit.wps[i - 1] : null;
          const leg = prev
            ? `${fmtBrg(bearingTo([prev.lon, prev.lat], [w.lon, w.lat]))} · ${fmtDist(haversine([prev.lon, prev.lat], [w.lon, w.lat]))}`
            : 'start';
          return `<div class="o-plt-item">
            <div class="o-plt-item-main">
              <span class="o-plt-item-name">${i + 1}. ${esc(w.name || `WP${i + 1}`)}</span>
              <span class="o-plt-item-meta">${esc(leg)} · ${esc(fmtPos(w.lon, w.lat, set().posFormat))}</span>
            </div>
            <div class="o-plt-item-acts">
              <button type="button" data-act="wp-rename" data-id="${i}">Namn</button>
              <button type="button" data-act="wp-del" data-id="${i}">Ta bort</button>
            </div>
          </div>`;
        }).join('');
      }

      const list = panelEl.querySelector('.o-plt-routelist');
      if (!store.routes.length) {
        list.innerHTML = '<div class="o-plt-hint">Inga sparade rutter ännu.</div>';
        return;
      }
      const navId = store.nav && store.nav.type === 'route' ? store.nav.routeId : null;
      list.innerHTML = store.routes.map((r) => `
        <div class="o-plt-item${r.id === navId ? ' is-active' : ''}">
          <div class="o-plt-item-main">
            <span class="o-plt-item-name">${esc(r.name)}</span>
            <span class="o-plt-item-meta">${r.wps.length} WP · ${fmtDist(routeLength(r))}${r.id === navId ? ' · navigerar' : ''}</span>
          </div>
          <div class="o-plt-item-acts">
            <button type="button" data-act="route-nav" data-id="${r.id}">Navigera</button>
            <button type="button" data-act="route-rev" data-id="${r.id}">Vänd</button>
            <button type="button" data-act="route-vis" data-id="${r.id}">${r.visible === false ? 'Visa' : 'Dölj'}</button>
            <button type="button" data-act="route-zoom" data-id="${r.id}">Zooma</button>
            <button type="button" data-act="route-edit" data-id="${r.id}">Ändra</button>
            <button type="button" data-act="route-gpx" data-id="${r.id}">GPX</button>
            <button type="button" data-act="route-del" data-id="${r.id}">Ta bort</button>
          </div>
        </div>`).join('');
    }

    function legsLength(wps) {
      let d = 0;
      for (let i = 1; i < wps.length; i += 1) {
        d += haversine([wps[i - 1].lon, wps[i - 1].lat], [wps[i].lon, wps[i].lat]);
      }
      return d;
    }

    // ---- rendering av punktfliken ----
    function renderMarkPane() {
      if (!panelEl) return;
      const btn = panelEl.querySelector('.o-plt-mark-click');
      btn.classList.toggle('is-on', clickMode === 'mark');
      const list = panelEl.querySelector('.o-plt-marklist');
      if (!store.marks.length) {
        list.innerHTML = '<div class="o-plt-hint">Inga sparade punkter ännu.</div>';
        return;
      }
      const navId = store.nav && store.nav.type === 'mark' ? store.nav.markId : null;
      list.innerHTML = store.marks.map((m) => {
        const d = fix ? ` · ${fmtDist(haversine([fix.lon, fix.lat], [m.lon, m.lat]))} ${fmtBrg(bearingTo([fix.lon, fix.lat], [m.lon, m.lat]))}` : '';
        return `<div class="o-plt-item${m.id === navId ? ' is-active' : ''}${m.type === 'mob' ? ' is-mob' : ''}">
          <div class="o-plt-item-main">
            <span class="o-plt-item-name">${esc(m.name)}</span>
            <span class="o-plt-item-meta">${esc(fmtPos(m.lon, m.lat, set().posFormat))}${esc(d)}</span>
          </div>
          <div class="o-plt-item-acts">
            <button type="button" data-act="mark-nav" data-id="${m.id}">Navigera</button>
            <button type="button" data-act="mark-zoom" data-id="${m.id}">Zooma</button>
            <button type="button" data-act="mark-rename" data-id="${m.id}">Byt namn</button>
            <button type="button" data-act="mark-del" data-id="${m.id}">Ta bort</button>
          </div>
        </div>`;
      }).join('');
    }

    function renderSettings() {
      if (!panelEl) return;
      panelEl.querySelectorAll('.o-plt-f').forEach((inp) => {
        const v = set()[inp.dataset.key];
        if (inp.type === 'checkbox') inp.checked = !!v;
        else inp.value = v;
      });
    }

    function renderAll() {
      renderInstruments();
      renderTrackPane();
      renderRoutePane();
      renderMarkPane();
      renderSettings();
    }

    // ---- knappar i listorna ----
    function onListClick(e) {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const id = b.dataset.id;
      const act = b.dataset.act;

      const track = () => store.tracks.find((t) => t.id === id);
      const route = () => store.routes.find((r) => r.id === id);
      const mark = () => store.marks.find((m) => m.id === id);

      switch (act) {
        case 'track-vis': {
          const t = track(); if (!t) return;
          t.visible = t.visible === false;
          persist(); drawSaved(); renderTrackPane();
          break;
        }
        case 'track-zoom': {
          const t = track(); if (!t) return;
          zoomTo(t.points.map((p) => toMap([p[0], p[1]])));
          break;
        }
        case 'track-gpx': {
          const t = track(); if (!t) return;
          exportGpx({ tracks: [t] }, safeName(t.name));
          break;
        }
        case 'track-rename': {
          const t = track(); if (!t) return;
          const n = window.prompt('Nytt namn på spåret', t.name);
          if (n === null) return;
          t.name = n.trim() || t.name; persist(); renderTrackPane();
          break;
        }
        case 'track-del': {
          const t = track(); if (!t) return;
          if (!window.confirm(`Ta bort spåret "${t.name}"?`)) return;
          store.tracks = store.tracks.filter((x) => x.id !== id);
          persist(); drawSaved(); renderTrackPane();
          break;
        }
        case 'route-new': newRoute(); break;
        case 'route-undo': undoWaypoint(); break;
        case 'route-save': saveRoute(); break;
        case 'route-cancel': cancelEdit(); break;
        case 'route-nav': startNavRoute(id, false); break;
        case 'route-rev': {
          const r = route(); if (!r) return;
          r.wps = r.wps.slice().reverse();
          persist(); drawRoutes(); renderRoutePane();
          setStatus(`Rutten "${r.name}" vänd.`);
          break;
        }
        case 'route-vis': {
          const r = route(); if (!r) return;
          r.visible = r.visible === false;
          persist(); drawRoutes(); renderRoutePane();
          break;
        }
        case 'route-zoom': {
          const r = route(); if (!r) return;
          zoomTo(r.wps.map((w) => toMap([w.lon, w.lat])));
          break;
        }
        case 'route-edit': editRoute(id); break;
        case 'route-gpx': {
          const r = route(); if (!r) return;
          exportGpx({ routes: [r] }, safeName(r.name));
          break;
        }
        case 'route-del': {
          const r = route(); if (!r) return;
          if (!window.confirm(`Ta bort rutten "${r.name}"?`)) return;
          if (store.nav && store.nav.routeId === id) store.nav = null;
          store.routes = store.routes.filter((x) => x.id !== id);
          persist(); drawRoutes(); renderAll();
          break;
        }
        case 'wp-rename': {
          const i = Number(id);
          if (!edit || !edit.wps[i]) return;
          const n = window.prompt('Namn på waypoint', edit.wps[i].name || `WP${i + 1}`);
          if (n === null) return;
          edit.wps[i].name = n.trim() || edit.wps[i].name;
          drawRoutes(); renderRoutePane();
          break;
        }
        case 'wp-del': {
          const i = Number(id);
          if (!edit || !edit.wps[i]) return;
          edit.wps.splice(i, 1);
          syncEditGeom(); renderRoutePane();
          break;
        }
        case 'mark-nav': startNavMark(id); showTab('nav'); break;
        case 'mark-zoom': {
          const m = mark(); if (!m) return;
          map.getView().setCenter(toMap([m.lon, m.lat]));
          break;
        }
        case 'mark-rename': {
          const m = mark(); if (!m) return;
          const n = window.prompt('Nytt namn på punkten', m.name);
          if (n === null) return;
          m.name = n.trim() || m.name; persist(); drawMarks(); renderMarkPane();
          break;
        }
        case 'mark-del': {
          const m = mark(); if (!m) return;
          if (!window.confirm(`Ta bort punkten "${m.name}"?`)) return;
          if (store.nav && store.nav.markId === id) store.nav = null;
          store.marks = store.marks.filter((x) => x.id !== id);
          persist(); drawMarks(); renderAll();
          break;
        }
        case 'nav-stop': stopNav(); break;
        case 'nav-next': stepWaypoint(1); break;
        case 'nav-prev': stepWaypoint(-1); break;
        default: break;
      }
    }

    function stepWaypoint(delta) {
      const n = store.nav;
      if (!n || n.type !== 'route') return;
      const r = store.routes.find((x) => x.id === n.routeId);
      if (!r) return;
      n.wpIndex = Math.max(0, Math.min(r.wps.length - 1, n.wpIndex + delta));
      resetAlarms();
      persist();
      drawRoutes();
      renderAll();
    }

    function zoomTo(coords) {
      if (!coords.length) return;
      let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
      coords.forEach((c) => {
        minX = Math.min(minX, c[0]); maxX = Math.max(maxX, c[0]);
        minY = Math.min(minY, c[1]); maxY = Math.max(maxY, c[1]);
      });
      if (minX === maxX && minY === maxY) {
        map.getView().setCenter([minX, minY]);
        return;
      }
      map.getView().fit([minX, minY, maxX, maxY], { padding: [60, 60, 60, 60], maxZoom: 16, duration: 300 });
    }

    // ---- import/export ----
    function exportGpx(data, name) {
      const has = (data.tracks || []).length + (data.routes || []).length + (data.marks || []).length;
      if (!has) { setStatus('Inget att exportera.', true); return; }
      const xml = buildGpx(data, name);
      download(new Blob([xml], { type: 'application/gpx+xml' }), `${safeName(name)}-${stamp(Date.now())}.gpx`);
    }

    async function onFilePicked(e) {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const text = await file.text();
        if (fileInput.dataset.what === 'json' || /\.json$/i.test(file.name)) {
          const parsed = JSON.parse(text);
          if (!parsed || !Array.isArray(parsed.tracks)) throw new Error('Filen ser inte ut som en plotter-backup');
          store = Object.assign(defaults(), parsed);
          store.settings = Object.assign(defaults().settings, parsed.settings || {});
          persist();
          drawSaved(); drawRoutes(); drawMarks(); renderAll(); applyNight();
          setStatus('Säkerhetskopian importerad.');
          return;
        }
        const g = parseGpx(text);
        const n = g.tracks.length + g.routes.length + g.marks.length;
        if (!n) { setStatus('Hittade inga spår, rutter eller punkter i filen.', true); return; }
        g.tracks.forEach((t, i) => {
          t.color = TRACK_COLORS[(store.tracks.length + i) % TRACK_COLORS.length];
          t.visible = true;
          t.dist = legsLength(t.points.map((p) => ({ lon: p[0], lat: p[1] })));
          const first = t.points[0][2];
          const last = t.points[t.points.length - 1][2];
          t.elapsed = (first && last) ? last - first : 0;
        });
        store.tracks = g.tracks.concat(store.tracks);
        store.routes = g.routes.concat(store.routes);
        store.marks = g.marks.concat(store.marks);
        persist();
        drawSaved(); drawRoutes(); drawMarks(); renderAll();
        setStatus(`Importerade ${g.tracks.length} spår, ${g.routes.length} rutter och ${g.marks.length} punkter.`);
      } catch (err) {
        setStatus(`Kunde inte läsa filen: ${err.message}`, true);
      }
    }

    // ============================================================
    // Kartinteraktion
    // ============================================================
    function onMapClick(evt) {
      if (!active) return;
      // Alt+klick är Modify-interaktionens "ta bort punkt" – lägg inte till en ny.
      if (evt.originalEvent && evt.originalEvent.altKey) return;
      if (clickMode === 'route') { addWaypoint(evt.coordinate); return; }
      if (clickMode === 'mark') {
        const ll = toLonLat(evt.coordinate);
        addMark(ll[0], ll[1], `Punkt ${fmtClock(new Date())}`);
        clickMode = null;
        renderMarkPane();
        setStatus('Punkt sparad.');
      }
    }

    // ============================================================
    // Öppna / stäng
    // ============================================================
    function showPanel() {
      if (!panelEl) buildPanel();
      const host = document.getElementById(viewer.getId()) || document.body;
      if (!panelEl.isConnected) host.appendChild(panelEl);
      if (root.PanelDrag) {
        root.PanelDrag.placeDefault(panelEl, {
          navEl: document.getElementById(target),
          others: ['.o-iono-panel', '.o-bef-panel']
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

      Object.keys(lyr).forEach((k) => lyr[k].setVisible(true));
      lyr.ship.setVisible(!!fix);

      drawSaved();
      drawRoutes();
      drawMarks();
      renderAll();
      applyNight();
      if (set().keepAwake) setKeepAwake(true);

      map.on('singleclick', onMapClick);
      map.on('pointerdrag', onPointerDrag);
      document.addEventListener('visibilitychange', onVisibility);
      startGps();
      // Sekundtickern håller klocka, ETA och "senaste fix" levande även när
      // GPS:en är tyst mellan uppdateringarna.
      ticker = setInterval(() => {
        if (!active) return;
        renderInstruments();
        if (rec) renderTrackPane();
      }, 1000);
    }

    function deactivate() {
      if (!active) return;
      if (rec && rec.points.length > 1
        && !window.confirm('Du har ett aktivt spår som inte är sparat. Stänga ändå?')) return;
      active = false;
      button.setState('initial');
      hidePanel();
      cancelEdit();
      clickMode = null;
      stopGps();
      clearInterval(ticker);
      ticker = null;
      map.un('singleclick', onMapClick);
      map.un('pointerdrag', onPointerDrag);
      document.removeEventListener('visibilitychange', onVisibility);
      if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
      Object.keys(lyr).forEach((k) => lyr[k].setVisible(false));
      const host = document.getElementById(viewer.getId());
      if (host) host.classList.remove('o-plotter-night');
      if (set().courseUp) map.getView().setRotation(0);
    }

    function toggle() { if (active) deactivate(); else activate(); }

    return Origo.ui.Component({
      name: 'plotter',

      onInit() {
        button = Origo.ui.Button({
          cls, click: toggle, icon, tooltipText, tooltipPlacement
        });
      },

      onAdd(evt) {
        viewer = evt.target;
        map = viewer.getMap();
        if (!target) target = `${viewer.getMain().getNavigation().getId()}`;
        restore();
        buildLayers();
        Object.keys(lyr).forEach((k) => lyr[k].setVisible(false));
        this.addComponents([button]);
        this.render();
      },

      render() {
        const el = Origo.ui.dom.html(button.render());
        document.getElementById(target).appendChild(el);
        this.dispatch('render');
      }
    });
  }

  root.Plotter = Plotter;
}(window));
