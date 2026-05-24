-- Schema for the shared, user-editable "Eget lager".
-- Runs once, the first time the postgis container initialises an empty data
-- volume (files in /docker-entrypoint-initdb.d are executed in name order).
--
-- Origo's editor needs ONE geometry type per editable layer, so the layer is
-- split into three tables (areas / lines / points), each published as its own
-- WFS feature type and grouped under "Eget lager" in the map.

CREATE EXTENSION IF NOT EXISTS postgis;

-- Drop the old single-table version (from the first iteration) if present.
DROP TABLE IF EXISTS eget_lager;

CREATE TABLE IF NOT EXISTS eget_yta (
  id           serial PRIMARY KEY,
  rubrik       varchar(100),
  beskrivning  text,
  skapad       timestamptz NOT NULL DEFAULT now(),
  geom         geometry(Polygon, 3857)
);

CREATE TABLE IF NOT EXISTS eget_linje (
  id           serial PRIMARY KEY,
  rubrik       varchar(100),
  beskrivning  text,
  skapad       timestamptz NOT NULL DEFAULT now(),
  geom         geometry(LineString, 3857)
);

CREATE TABLE IF NOT EXISTS eget_punkt (
  id           serial PRIMARY KEY,
  rubrik       varchar(100),
  beskrivning  text,
  skapad       timestamptz NOT NULL DEFAULT now(),
  geom         geometry(Point, 3857)
);

CREATE INDEX IF NOT EXISTS eget_yta_geom_idx   ON eget_yta   USING GIST (geom);
CREATE INDEX IF NOT EXISTS eget_linje_geom_idx ON eget_linje USING GIST (geom);
CREATE INDEX IF NOT EXISTS eget_punkt_geom_idx ON eget_punkt USING GIST (geom);

-- One sample feature per layer (central Stockholm) so the layers aren't empty
-- on first load. Anyone can edit or delete them from the map.
INSERT INTO eget_yta (rubrik, beskrivning, geom)
SELECT 'Exempelyta', 'Exempelområde – rita egna ytor (polygon/rektangel) och lägg till text. Alla kan redigera och ta bort.',
       ST_Transform(ST_GeomFromText('POLYGON((18.03 59.32, 18.12 59.32, 18.12 59.35, 18.03 59.35, 18.03 59.32))', 4326), 3857)
WHERE NOT EXISTS (SELECT 1 FROM eget_yta);

INSERT INTO eget_linje (rubrik, beskrivning, geom)
SELECT 'Exempellinje', 'Exempellinje – rita egna linjer och lägg till text.',
       ST_Transform(ST_GeomFromText('LINESTRING(18.04 59.33, 18.09 59.34, 18.11 59.33)', 4326), 3857)
WHERE NOT EXISTS (SELECT 1 FROM eget_linje);

INSERT INTO eget_punkt (rubrik, beskrivning, geom)
SELECT 'Exempelpunkt', 'Exempelpunkt – rita egna punkter och lägg till text.',
       ST_Transform(ST_GeomFromText('POINT(18.07 59.335)', 4326), 3857)
WHERE NOT EXISTS (SELECT 1 FROM eget_punkt);
