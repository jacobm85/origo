# Sjökortsplotter

Avskalad variant av kartan som bara innehåller **plotterfunktionen** och
**sjökortet från Sjöfartsverket**. Tänkt att köras fristående, till exempel på
en liten burk ombord eller som en egen adress i mobilen.

Den fullständiga kartan med samtliga lager, plugins och backend-tjänster ligger
på grenen [`master`](../../tree/master).

## Vad som ingår

**Plottern** (`plugins/plotter.js`) — knapp i verktygsmenyn:

- Egen position med SOG/COG, noggrannhetscirkel, roterad båtsymbol och
  prediktorlinje N minuter framåt.
- Spårinspelning med paus, live-statistik och sparning. Sparade spår kan
  visas/döljas, döpas om, zoomas till och exporteras som GPX.
- Rutter: klicka ut waypoints i kartan, dra för att justera, bäring och distans
  per ben, spara, vänd, ändra.
- Aktiv navigering mot rutt eller punkt: DTW, BTW, XTE, VMG, TTG och ETA,
  automatiskt waypointbyte vid ankomst samt ankomst- och XTE-larm.
- MOB-knapp, ankarvakt med drivlarm, kurs-upp, följ-mig, nattläge och skärmlås.
- GPX-import/export för spår, rutter och punkter samt JSON-backup.

Spår, rutter, punkter och inställningar sparas i webbläsarens `localStorage` —
ingen serverdel behövs för dem.

**Lager** — sjökortsbakgrunden plus de temalager som är användbara vid
navigering. Allt släckt utom bakgrunden:

| Lager | Grupp |
|---|---|
| Sjökort (Sjöfartsverket) | Bakgrundskartor (standard) |
| OpenStreetMap | Bakgrundskartor (reserv utanför sjökortstäckning) |
| Lotsled och allmän farled | Sjöfart |
| Djupinformationens kvalitet | Sjöfart |
| CATZOC (djupdatats tillförlitlighet) | Sjöfart |
| Felanmälda sjösäkerhetsanordningar | Sjöfart |
| Ufs P- och T-notiser | Sjöfart |

Kartan är i EPSG:3006 (SWEREF 99 TM). Lagren hämtas som WMS 1.3.0 från
`geokatalog.sjofartsverket.se` via nginx-proxyn `/proxy/sjofartsverket/`, som
finns eftersom tjänsterna saknar CORS-headers.

> **Licens:** Sjöfartsverkets capabilities anger *"Licens för användning
> krävs"* för sjökortsbakgrunden, djupdatakvalitet, Ufs P/T-notiser och
> felanmälda sjösäkerhetsanordningar. Kontakt: sma@sjofartsverket.se.

## Kör

```bash
cp .env.example .env      # sätt åtminstone APP_PASSWORD
docker compose up -d --build
```

Kartan ligger sedan på `http://<host>:8080` (styrs av `ORIGO_PORT`).

Stacken är två containrar: `origo` (nginx som serverar den byggda appen) och
`auth` (session-inloggning framför den). Ingen databas, ingen GeoServer.

## HTTPS krävs

Plottern bygger på `navigator.geolocation`, `DeviceOrientationEvent` och Wake
Lock. Alla tre kräver *secure context* — sidan måste serveras över **HTTPS**
eller köras på `localhost`. Över vanlig HTTP nekar mobila webbläsare
positionering helt, och plottern visar då "GPS kräver HTTPS" i stället för att
tyst sluta fungera.

Containern lyssnar bara på port 80; TLS förutsätts termineras av en reverse
proxy framför.

## På telefonen

- Tillåt platsåtkomst när webbläsaren frågar, annars står SOG/COG kvar på `–`.
- **Kompass** måste aktiveras med knappen — iOS kräver en användargest för att
  ge tillgång till magnetometern.
- **Skärm på** innan telefonen läggs undan; en webbsida får inga
  positionsuppdateringar när skärmen är släckt.
- På iOS: Dela → **Lägg till på hemskärmen** ger plottern i helskärm utan
  adressfält.

## Utveckling

```bash
npm ci
npm start          # sass-watch + webpack-dev-server
```

Pluginen är ren JavaScript utan byggsteg — `plugins/plotter.js` kopieras rakt
in i imagen och laddas av `index.html`. Ändringar syns efter en omladdning av
sidan, utan att webpack behöver köras om.
