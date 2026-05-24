#!/bin/sh
# One-shot GeoServer provisioning: create the "eget" workspace, a PostGIS
# datastore pointing at the db service, and publish the eget_lager layer.
# Idempotent - re-running it just gets 401/409s on things that already exist,
# which are ignored. Runs from the geoserver-provision service in compose.
set -eu

: "${GS_URL:=http://geoserver:8080/geoserver}"
: "${GS_USER:=admin}"
: "${GS_PASS:=geoserver}"
: "${DB_HOST:=db}"
: "${DB_PORT:=5432}"
: "${DB_NAME:=origo}"
: "${DB_USER:=origo}"
: "${DB_PASS:=origo}"

AUTH="-u ${GS_USER}:${GS_PASS}"
XML="-H Content-type:text/xml"

echo "Waiting for GeoServer REST at ${GS_URL} ..."
i=0
until curl -sf -o /dev/null $AUTH "${GS_URL}/rest/about/version.xml"; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    echo "GeoServer did not become ready in time" >&2
    exit 1
  fi
  sleep 5
done
echo "GeoServer is up."

# 1) Workspace (201 created, or 409 if it already exists)
curl -s -o /dev/null -w "workspace: %{http_code}\n" $AUTH $XML -XPOST \
  -d "<workspace><name>eget</name></workspace>" \
  "${GS_URL}/rest/workspaces" || true

# 2) PostGIS datastore
curl -s -o /dev/null -w "datastore: %{http_code}\n" $AUTH $XML -XPOST -d "
<dataStore>
  <name>eget_pg</name>
  <connectionParameters>
    <entry key=\"host\">${DB_HOST}</entry>
    <entry key=\"port\">${DB_PORT}</entry>
    <entry key=\"database\">${DB_NAME}</entry>
    <entry key=\"user\">${DB_USER}</entry>
    <entry key=\"passwd\">${DB_PASS}</entry>
    <entry key=\"dbtype\">postgis</entry>
    <entry key=\"schema\">public</entry>
    <entry key=\"Expose primary keys\">true</entry>
  </connectionParameters>
</dataStore>" \
  "${GS_URL}/rest/workspaces/eget/datastores" || true

# 3) Publish the feature type (declares SRS and computes the native bounds)
curl -s -o /dev/null -w "featuretype: %{http_code}\n" $AUTH $XML -XPOST -d "
<featureType>
  <name>eget_lager</name>
  <nativeName>eget_lager</nativeName>
  <srs>EPSG:3857</srs>
  <enabled>true</enabled>
</featureType>" \
  "${GS_URL}/rest/workspaces/eget/datastores/eget_pg/featuretypes" || true

# 4) Open read+write on all layers for everyone (no login). GeoServer would
#    otherwise reject anonymous WFS-T transactions. Suitable for a trusted /
#    internal network - lock this down if the map is exposed publicly.
curl -s -o /dev/null -w "acl read:  %{http_code}\n" $AUTH -H "Content-type:application/json" -XPOST \
  -d '{"*.*.r":"*"}' "${GS_URL}/rest/security/acl/layers" || true
curl -s -o /dev/null -w "acl write: %{http_code}\n" $AUTH -H "Content-type:application/json" -XPOST \
  -d '{"*.*.w":"*"}' "${GS_URL}/rest/security/acl/layers" || true

echo "Provisioning complete. Layer eget:eget_lager should now be available via WFS."
