#!/bin/sh
# Skapar PostGIS-tabellerna för de egna (redigerbara) lagergrupperna, en
# uppsättning (yta/linje/punkt) per grupp i EGNA_GRUPPER. Körs som en
# engångstjänst vid varje "docker compose up" (till skillnad från db/init/ som
# bara körs på en tom datavolym), så att nya grupper får sina tabeller även i
# en redan befintlig databas.
#
# Namngivningen MÅSTE stämma med geoserver/provision.sh och
# app-config/render-egna-grupper.py:
#   grupp 1  → eget_yta / eget_linje / eget_punkt   (befintliga – data bevaras)
#   grupp i>1→ eget_g{i}_yta / _linje / _punkt
#
# Tom EGNA_GRUPPER = gör ingenting (legacy-tabellerna finns redan via db/init/).
# Idempotent: CREATE TABLE IF NOT EXISTS, ingen befintlig data rörs.
set -eu

: "${EGNA_GRUPPER:=}"
if [ -z "$EGNA_GRUPPER" ]; then
  echo "[eget-db] EGNA_GRUPPER tom – hoppar (legacy-tabeller finns via db/init/)"
  exit 0
fi

export PGPASSWORD="${DB_PASS:-origo}"
PSQL="psql -v ON_ERROR_STOP=1 -h ${DB_HOST:-db} -p ${DB_PORT:-5432} -U ${DB_USER:-origo} -d ${DB_NAME:-origo}"

# Vänta in databasen.
i=0
until $PSQL -c "SELECT 1" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -gt 60 ] && { echo "[eget-db] databasen blev inte klar i tid" >&2; exit 1; }
  sleep 2
done

$PSQL -c "CREATE EXTENSION IF NOT EXISTS postgis;"

OLDIFS=$IFS
IFS=';,'
i=0
for gname in $EGNA_GRUPPER; do
  i=$((i + 1))
  gname=$(printf '%s' "$gname" | sed 's/^ *//;s/ *$//')
  [ -z "$gname" ] && continue
  if [ "$i" = "1" ]; then p="eget"; else p="eget_g${i}"; fi

  $PSQL <<SQL
CREATE TABLE IF NOT EXISTS ${p}_yta   (id serial PRIMARY KEY, rubrik varchar(100), beskrivning text, skapad timestamptz NOT NULL DEFAULT now(), geom geometry(Polygon, 3857));
CREATE TABLE IF NOT EXISTS ${p}_linje (id serial PRIMARY KEY, rubrik varchar(100), beskrivning text, skapad timestamptz NOT NULL DEFAULT now(), geom geometry(LineString, 3857));
CREATE TABLE IF NOT EXISTS ${p}_punkt (id serial PRIMARY KEY, rubrik varchar(100), beskrivning text, skapad timestamptz NOT NULL DEFAULT now(), geom geometry(Point, 3857));
CREATE INDEX IF NOT EXISTS ${p}_yta_geom_idx   ON ${p}_yta   USING GIST (geom);
CREATE INDEX IF NOT EXISTS ${p}_linje_geom_idx ON ${p}_linje USING GIST (geom);
CREATE INDEX IF NOT EXISTS ${p}_punkt_geom_idx ON ${p}_punkt USING GIST (geom);
SQL
  echo "[eget-db] grupp $i ('$gname'): tabeller ${p}_yta / ${p}_linje / ${p}_punkt klara"
done
IFS=$OLDIFS
echo "[eget-db] klart."
