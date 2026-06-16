#!/bin/sh
# Fyller i inloggningsskärmens text från env-variabler vid containerstart.
# Körs av nginx:alpine-imagen automatiskt (ligger i /docker-entrypoint.d/).
#
# Variabler (sätts i .env):
#   LOGIN_TITLE     – rubrik + fliktitel på inloggningssidan (default: Origo)
#   LOGIN_SUBTITLE  – valfri underrubrik under titeln (default: tom = döljs)
#
# login.html innehåller platshållarna __LOGIN_TITLE__ och __LOGIN_SUBTITLE__.
# Skriptet är idempotent: efter substitutionen finns inga platshållare kvar, så
# en omstart av samma container gör ingenting. Ändrar du värdet kör du
# `docker compose up -d` som återskapar containern (färsk login.html ur imagen).
set -eu

: "${LOGIN_TITLE:=Origo}"
: "${LOGIN_SUBTITLE:=}"

FILE=/usr/share/nginx/html/login.html
[ -f "$FILE" ] || { echo "[render-login] saknar $FILE" >&2; exit 0; }

# Escapea sed-specialtecken (& / \) i värdena så de inte bryter substitutionen.
esc() { printf '%s' "$1" | sed -e 's/[&/\\]/\\&/g'; }
T="$(esc "$LOGIN_TITLE")"
S="$(esc "$LOGIN_SUBTITLE")"

sed -i -e "s/__LOGIN_TITLE__/${T}/g" -e "s/__LOGIN_SUBTITLE__/${S}/g" "$FILE"
echo "[render-login] LOGIN_TITLE='$LOGIN_TITLE' LOGIN_SUBTITLE='$LOGIN_SUBTITLE'"
