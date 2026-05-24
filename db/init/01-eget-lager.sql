-- Schema for the shared, user-editable "Eget lager" layer.
-- Runs once, the first time the postgis container initialises an empty data
-- volume (files in /docker-entrypoint-initdb.d are executed in name order).

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS eget_lager (
  id           serial PRIMARY KEY,
  rubrik       varchar(100),
  beskrivning  text,
  skapad       timestamptz NOT NULL DEFAULT now(),
  -- Generic geometry so the same layer can hold polygons, rectangles,
  -- points and lines. SRID 3857 matches the map projection (Web Mercator).
  geom         geometry(Geometry, 3857)
);

CREATE INDEX IF NOT EXISTS eget_lager_geom_idx ON eget_lager USING GIST (geom);

-- A sample feature so the layer is not empty on first load (a small area over
-- central Stockholm). Anyone can edit or delete it from the map.
INSERT INTO eget_lager (rubrik, beskrivning, geom)
SELECT
  'Exempel',
  'Exempelområde – rita egna polygoner, rektanglar, punkter eller linjer och lägg till text. Alla kan redigera och ta bort.',
  ST_Transform(
    ST_GeomFromText(
      'POLYGON((18.03 59.32, 18.12 59.32, 18.12 59.35, 18.03 59.35, 18.03 59.32))',
      4326),
    3857)
WHERE NOT EXISTS (SELECT 1 FROM eget_lager);
