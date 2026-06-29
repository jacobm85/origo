#!/bin/sh
# data-refresh — regenererar kartans data-lager på schema och skriver till
# /app/data, som Origo serverar via bind-mounten ./data. Tanken är att samla all
# periodisk datahämtning (TED-upphandlingar, Länsstyrelsens vattenverksamhet,
# Försvarsmaktens riksintressen, slutförvaring, SCB-areal, …) på ett ställe i
# stället för att baka in dem i origo-imagen och bygga om.
#
# Varje generator körs isolerat (|| true) så att ett fel i en inte stoppar de
# andra. Skripten ligger read-only i /app/tools; utdata hamnar i /app/data.
#
# Konfiguration via miljövariabler:
#   REFRESH_INTERVAL_HOURS  intervall mellan körningar (default 24)
#   TED_FROM_YEAR           äldsta publiceringsår för TED-upphandlingar (default 2021)
#   RUN_ON_START            "false" = hoppa över första körningen vid start
set -u

INTERVAL_HOURS="${REFRESH_INTERVAL_HOURS:-24}"
TED_FROM_YEAR="${TED_FROM_YEAR:-2021}"
RUN_ON_START="${RUN_ON_START:-true}"

cd /app || exit 1

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

run_all() {
  log "TED – upphandlingar mätning/GIS …"
  node tools/build_ted_upphandlingar.mjs --from-year "$TED_FROM_YEAR" || log "  TED misslyckades"

  log "LFV – geografiska UAS-zoner (drönare) …"
  node tools/build_dronzoner_lfv.mjs || log "  dronzoner misslyckades"

  log "LFV – luftrum för drönare (CTR/TIZ, ATZ, restriktioner, flygplatser …) …"
  node tools/build_dronare_luftrum_lfv.mjs || log "  dronare-luftrum misslyckades"

  log "Länsstyrelsen – vattenverksamhet …"
  python3 tools/scrape_lansstyrelsen.py || log "  lansstyrelsen misslyckades"

  log "Försvarsmakten – riksintressen …"
  python3 tools/build_forsvarsmakten_riksintressen.py || log "  forsvarsmakten misslyckades"

  log "Slutförvaring – riksintresse …"
  python3 tools/build_slutforvaring_riksintresse.py || log "  slutforvaring misslyckades"

  log "SCB – riksintresse-areal per kommun …"
  python3 tools/build_riksintresse_areal.py || log "  scb misslyckades"

  # --- Fler källor (avstängda by default) -------------------------------------
  # Aktivera genom att avkommentera. Notera krav:
  #   * Trafikverket: kräver API-nyckel (se scrape_trafikverket.py).
  #   * SMHI hydroobs / power_layers: tunga (Overpass m.m.), men endast stdlib.
  #   * Mötesprotokoll (data/protokoll): kräver Playwright + webbläsare och körs
  #     INTE i den här lätta containern – lägg i en egen Playwright-baserad job.
  # python3 tools/scrape_smhi_hydroobs.py   || log "  smhi misslyckades"
  # python3 tools/build_power_layers.py     || log "  power misslyckades"
}

if [ "$RUN_ON_START" != "false" ]; then
  log "=== Startkörning ==="
  run_all
  log "=== Startkörning klar ==="
fi

while true; do
  log "Sover ${INTERVAL_HOURS}h till nästa uppdatering."
  sleep "$(( INTERVAL_HOURS * 3600 ))"
  log "=== Uppdatering startar ==="
  run_all
  log "=== Uppdatering klar ==="
done
