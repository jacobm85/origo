#!/bin/sh
# Renderar klientens runtime-config (config.js) från env-variabler vid
# containerstart. Körs av nginx:alpine-imagen automatiskt eftersom skriptet
# ligger i /docker-entrypoint.d/.
#
# Variabler (sätts i .env):
#   MAP_TITLE         – titel i webbläsarens flik (default: tom = behåll HTML)
#   MAP_FOOTER_TEXT   – text mitt i footern (default: tom = behåll index.json)
set -eu

: "${MAP_TITLE:=}"
: "${MAP_FOOTER_TEXT:=}"

# Escape backslash och citationstecken så värdena inte kan bryta sig ur
# JS-stränglitteralerna i mallen.
escape_js() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}
export MAP_TITLE="$(escape_js "$MAP_TITLE")"
export MAP_FOOTER_TEXT="$(escape_js "$MAP_FOOTER_TEXT")"

TEMPLATE=/etc/templates/app-config/config.js.template
OUTPUT=/usr/share/nginx/html/config.js

if [ ! -f "$TEMPLATE" ]; then
  echo "[render-app-config] saknar mallen $TEMPLATE" >&2
  exit 0
fi

envsubst '${MAP_TITLE} ${MAP_FOOTER_TEXT}' < "$TEMPLATE" > "$OUTPUT"
echo "[render-app-config] skrev $OUTPUT (MAP_TITLE='$MAP_TITLE' MAP_FOOTER_TEXT='$MAP_FOOTER_TEXT')"
