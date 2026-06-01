import proj4 from 'proj4';
import { register } from 'ol/proj/proj4';
import { get as getOlProjection, addProjection } from 'ol/proj';
import olProjection from 'ol/proj/Projection';

// Projektioner vars officiella axelordning är nord,öst (lat/lon-lik). För dem
// måste OpenLayers veta att axelordningen är 'neu' så att bbox/koordinater
// vänds rätt i WMS 1.3.0 och i WFS/GML – annars hamnar t.ex. GeoServer-WMS-
// lager fel i EPSG:3006 (orsaken till att det tidigare SWEREF-försöket revs).
// Vi rör INTE proj4:s transform-ordning (som förblir öst,nord), så kartvyn,
// geometrier och center/extent fortsätter använda [E, N] precis som vanligt –
// exakt som OpenLayers inbyggda EPSG:4326 (också 'neu') hanteras.
const NEU_AXIS_PROJECTIONS = ['EPSG:3006'];

// Ersätt en registrerad projektion med en likadan men med axisOrientation
// 'neu'. ol/proj/Projection saknar setAxisOrientation, så vi bygger om den och
// lägger tillbaka den i registret. proj4-transformerna är nycklade på koden och
// fortsätter fungera oförändrat.
const forceNeuAxisOrientation = function forceNeuAxisOrientation(code) {
  const existing = getOlProjection(code);
  if (!existing || existing.getAxisOrientation() === 'neu') {
    return existing;
  }
  const neu = new olProjection({
    code,
    units: existing.getUnits(),
    extent: existing.getExtent(),
    worldExtent: existing.getWorldExtent(),
    global: existing.isGlobal(),
    metersPerUnit: existing.getMetersPerUnit(),
    axisOrientation: 'neu'
  });
  addProjection(neu);
  return neu;
};

const registerProjections = function registerProjections(proj4Defs) {
  if (proj4Defs && proj4) {
    proj4Defs.forEach((def) => {
      proj4.defs(def.code, def.projection);
    });
  }
  register(proj4);
  NEU_AXIS_PROJECTIONS.forEach(forceNeuAxisOrientation);
};

const getUnits = function getUnits(projectionCode) {
  if (projectionCode === 'EPSG:3857') {
    return 'm';
  } else if (projectionCode === 'EPSG:4326') {
    return 'degrees';
  }
  const units = proj4.defs(projectionCode) ? proj4.defs(projectionCode).units : undefined;
  return units;
};

const Projection = function Projection({
  projectionCode,
  projectionExtent
} = {}) {
  if (!projectionCode) {
    return null;
  }
  // Återanvänd den registrerade instansen för projektioner med påtvingad
  // 'neu'-axelordning så att kartvyn OCH WMS/WFS-källorna delar samma
  // axelorientering (wms.js använder viewer.getProjection()-instansen, medan
  // WFS slår upp projektionen via koden i registret).
  const registered = getOlProjection(projectionCode);
  if (registered && registered.getAxisOrientation() === 'neu' && NEU_AXIS_PROJECTIONS.includes(projectionCode)) {
    if (projectionExtent) {
      registered.setExtent(projectionExtent);
    }
    return registered;
  }
  return new olProjection({
    code: projectionCode,
    extent: projectionExtent,
    units: getUnits(projectionCode)
  });
};

export default {
  Projection,
  registerProjections
};
