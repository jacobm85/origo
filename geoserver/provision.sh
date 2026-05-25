#!/bin/sh
# One-shot GeoServer provisioning for the shared "Eget lager":
#   - workspace "eget"
#   - PostGIS datastore pointing at the db service
#   - three feature types (eget_yta / eget_linje / eget_punkt)
#   - anonymous read+write so login-free editing works
# Idempotent: things that already exist return 409 and are ignored.
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
JSON="-H Content-type:application/json"

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

# 3) Publish the three feature types (declares SRS, computes native bounds)
publish() {
  resp=$(curl -s -w "\n%{http_code}" $AUTH $XML -XPOST -d "
<featureType>
  <name>$1</name>
  <nativeName>$1</nativeName>
  <srs>EPSG:3857</srs>
  <enabled>true</enabled>
</featureType>" \
    "${GS_URL}/rest/workspaces/eget/datastores/eget_pg/featuretypes")
  code=$(printf '%s' "$resp" | tail -1)
  body=$(printf '%s' "$resp" | head -n -1)
  echo "featuretype $1: $code"
  [ "$code" = "201" ] || [ "$code" = "409" ] || echo "  ERROR body: $body"
}
publish eget_yta
publish eget_linje
publish eget_punkt

# 4) Open read+write on all layers for everyone (no login). GeoServer would
#    otherwise reject anonymous WFS-T transactions. POST creates the rule;
#    if it already exists (409) PUT updates it to "*". Lock this down if the
#    map is exposed on an untrusted network.
for rule in '"*.*.r":"*"' '"*.*.w":"*"'; do
  curl -s -o /dev/null -w "acl POST {$rule}: %{http_code}\n" $AUTH $JSON -XPOST \
    -d "{$rule}" "${GS_URL}/rest/security/acl/layers" || true
  curl -s -o /dev/null -w "acl PUT  {$rule}: %{http_code}\n" $AUTH $JSON -XPUT \
    -d "{$rule}" "${GS_URL}/rest/security/acl/layers" || true
done

echo "Provisioning complete. Layers eget:eget_yta / eget_linje / eget_punkt should now be available via WFS."
