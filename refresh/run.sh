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
# Två kadenser:
#   * SNABB grupp (tidskänslig luftrumsdata: NOTAM, AIP SUP, TRA/CBA, tillfälliga
#     områden m.m.) körs ofta – default varje timme.
#   * LÅNGSAM grupp (AIRAC-stabil / sällan-ändrad data: TED, UAS-zoner,
#     Länsstyrelsen, Försvarsmakten, slutförvaring, SCB) körs sällan – default
#     var 24:e timme. Den snabba loopen driver klockan; den långsamma triggas när
#     tillräckligt lång tid gått sedan förra långsamma körningen.
#
# Konfiguration via miljövariabler:
#   REFRESH_FAST_MINUTES    intervall för snabba (tidskänsliga) lager (default 60)
#   REFRESH_INTERVAL_HOURS  intervall för långsamma lager (default 24)
#   TED_FROM_YEAR           äldsta publiceringsår för TED-upphandlingar (default 2021)
#   RUN_ON_START            "false" = hoppa över första körningen vid start
set -u

FAST_MINUTES="${REFRESH_FAST_MINUTES:-60}"
SLOW_HOURS="${REFRESH_INTERVAL_HOURS:-24}"
TED_FROM_YEAR="${TED_FROM_YEAR:-2021}"
RUN_ON_START="${RUN_ON_START:-true}"

cd /app || exit 1

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

# Tidskänsliga lager – hämtas från LFV:s öppna WFS och ändras löpande.
run_fast() {
  log "LFV – aktiva NOTAM (drönare) …"
  node tools/build_dronare_notam.mjs || log "  dronare-notam misslyckades"

  log "LFV – luftrum för drönare (CTR/TIZ, ATZ, TMA, militärt, restriktioner, AIP SUP, TRA/CBA, tillfälliga …) …"
  node tools/build_dronare_luftrum_lfv.mjs || log "  dronare-luftrum misslyckades"
}

# Sällan-ändrad data.
run_slow() {
  log "TED – upphandlingar mätning/GIS …"
  node tools/build_ted_upphandlingar.mjs --from-year "$TED_FROM_YEAR" || log "  TED misslyckades"

  log "LFV – geografiska UAS-zoner (drönare) …"
  node tools/build_dronzoner_lfv.mjs || log "  dronzoner misslyckades"

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

last_slow=0
if [ "$RUN_ON_START" != "false" ]; then
  log "=== Startkörning (snabb + långsam) ==="
  run_fast
  run_slow
  last_slow="$(date -u +%s)"
  log "=== Startkörning klar ==="
fi

while true; do
  log "Sover ${FAST_MINUTES} min till nästa snabba uppdatering."
  sleep "$(( FAST_MINUTES * 60 ))"

  log "=== Snabb uppdatering (tidskänsligt) ==="
  run_fast
  log "=== Snabb uppdatering klar ==="

  now="$(date -u +%s)"
  if [ "$(( now - last_slow ))" -ge "$(( SLOW_HOURS * 3600 ))" ]; then
    log "=== Långsam uppdatering (sällan-ändrat) ==="
    run_slow
    last_slow="$now"
    log "=== Långsam uppdatering klar ==="
  fi
done
