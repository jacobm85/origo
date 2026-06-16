#!/bin/sh
# Genererar de egna (redigerbara) lagergrupperna i index.json från EGNA_GRUPPER
# vid containerstart. Körs av nginx:alpine-imagen (ligger i /docker-entrypoint.d/).
# Själva omskrivningen görs i Python (render-egna-grupper.py) eftersom JSON-
# manipulation i ren sh är för skört.
set -eu
exec python3 /etc/templates/app-config/render-egna-grupper.py
