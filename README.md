[![License](https://img.shields.io/badge/license-BSD2-blue.svg?style=flat-square)](https://github.com/origo-map/origo/blob/master/LICENSE.txt)

# Origo — anpassad webbkarta

En fork av [Origo](https://github.com/origo-map/origo) (ramverk för webbkartor baserat på OpenLayers) med ett antal svenska geodatalager förkonfigurerade,
ett filtreringspanel-UI, en CORS-proxy via nginx och Python-scrapers som genererar GeoJSON-lager
från externa API:er och webbsidor.

## Kom igång

Förutsättningar: **Docker Desktop** (eller Docker Engine + Compose).
Allt — Origos egna byggsteg, nginx, proxyn och statiskt innehåll — är paketerat i en multi-stage Dockerfile.

```bash
git clone https://github.com/jacobm85/origo.git
cd origo
docker compose up -d --build
```

Öppna sedan <http://localhost:8080>.

* Stoppa: `docker compose down`
* Se loggar: `docker compose logs -f`
* Bygg om utan cache: `docker compose build --no-cache`

Vill du byta extern port, ändra `"8080:80"` i `docker-compose.yml` till t.ex. `"80:80"`.

## Kartlager

Lagren är konfigurerade i `index.json` (källa) och kopieras till `build/index.json` vid bygget.

| Lager | Typ | Källa | Default |
|---|---|---|---|
| OpenStreetMap | OSM bakgrund | tile.openstreetmap.org | Synligt |
| **Länsstyrelsen-ärenden** | GeoJSON (cluster) | scrapad från diarium.lansstyrelsen.se | Synligt |
| **Avverkningsanmälningar (Skogsstyrelsen)** | AGS\_FEATURE (vector) | geodpags.skogsstyrelsen.se | Synligt |
| SMHI Istjocklek sjöar | GeoJSON (parameter 7) | opendata-download-hydroobs.smhi.se | Dolt |
| SMHI Snödensitet | GeoJSON (parameter 9) | opendata-download-hydroobs.smhi.se | Dolt |
| Tillstånd för prospektering och gruvbrytning | WMS | maps3.sgu.se (`inspire:AM.ProspectingAndMiningPermitArea`) | Dolt |
| Mineralrättigheter | WMS (3 sublager kombinerade) | maps3.sgu.se (`MRR:…`) | Dolt |
| Täkter (NACE B) | WMS | ext-geodata-ows.lansstyrelsen.se (`inspire_pf`) | Dolt |
| Avfallsdeponier | WMS | ext-geodata-ows.lansstyrelsen.se (`inspire_am`) | Dolt |
| Miljöförvaltningsanläggningar | WMS | ext-geodata-ows.lansstyrelsen.se (`inspire_us`) | Dolt |
| Miljögifter, analysresultat och provplatser | WMS | maps3.sgu.se (`grundvatten:…`) | Dolt |
| Hydrogeologi | WMS (2 aquifer-sublager) | maps3.sgu.se | Dolt |
| **EBH – Bekräftat förorenade områden** | WMS | ext-geodata-nationella-visning.lansstyrelsen.se | Dolt |
| **EBH – Potentiellt förorenade områden** | WMS | ext-geodata-nationella-visning.lansstyrelsen.se | Dolt |
| **Vindkraftverk – under handläggning (land)** | WMS | Vindbrukskollen (Länsstyrelsen) | Dolt |
| **Vindkraftverk – beviljade (land)** | WMS | Vindbrukskollen | Dolt |
| **Vindkraft – projekteringsområden (land)** | WMS | Vindbrukskollen | Dolt |
| **Havsbaserad vindkraft – pågående processer** | WMS (samråd + ansökan + undersökningar) | Vindbrukskollen | Dolt |
| **Skyddade områden (Naturvårdsregistret)** | WMS | geodata.naturvardsverket.se | Dolt |
| **Natura 2000** | WMS | geodata.naturvardsverket.se | Dolt |
| **Vattenskyddsområden** | WMS | geodata.naturvardsverket.se | Dolt |
| **Fastighetsindelning (Lantmäteriet)** | WMS *(kräver token)* | apimanager.lantmateriet.se | Dolt |
| **Trafikverket pågående vägprojekt** | GeoJSON (snapshot) *(kräver API-nyckel)* | api.trafikinfo.trafikverket.se | Dolt |

Tänd/släck lagren via legend-kontrollen (vänster sidopanel). Alla lager är klickbara — popup visar attribut för den feature som klickas.

## Filterpanelen

Top-höger på kartan finns en panel med två sektioner:

* **Avverkningsanmälningar** — klientsidig filtrering på Ärendeår, Ändamål och Inkomstdatum.
  Filtren kombineras (AND) och appliceras via en OL-stilfunktion (icke-matchande features ritas inte).
* **Prospektering & gruvbrytning** — serversidig filtrering på `designation_period_begin`.
  Datumintervallet skickas som `CQL_FILTER` i WMS-anropet och servern returnerar bara matchande tillstånd.

Övriga SGU-lager (MRR och Miljögifter grundvatten) går *inte* att datumfiltrera serversidan: SGU exponerar
fältnamnen i visnings-templaten ("Valid from", "Senaste Provdatum") men de underliggande SQL-vy-kolumnerna
heter något annat och servern accepterar inte CQL på display-namnen. WFS DescribeFeatureType är
avstängd på `maps3.sgu.se`, så det går inte att enumera kolumnerna utifrån.

## Ladda ner geodata (shapefile-export)

Knappen **Ladda ner geodata** i höger verktygsmeny öppnar ett urvalsverktyg där du:

1. **Väljer lager** – panelen listar de lager som är tända i lagerlistan. Bocka av de du inte vill ha med.
2. **Ritar urvalsområde** – välj Polygon, Rektangel eller Cirkel och rita på kartan,
   *eller* ladda upp en befintlig shapefil (`.zip` med .shp+.prj eller en lös `.shp`).
   Koordinatsystemet detekteras automatiskt från `.prj` (eller från koordinaternas
   storleksordning om .prj saknas). Efter ritning/import kan du dra i punkterna för
   att justera området.
3. **Väljer urvalsläge** – *Innanför området* (features helt inom ytan) eller *Skär området* (features som berörs).
4. **Klickar "Ladda ner .zip"** – varje kartlager paketeras som en egen shapefile (`.shp + .shx + .dbf + .prj + .cpg`) i en zip.

Filerna är i **SWEREF 99 TM (EPSG:3006)**, attributnamnen följer DBF III-begränsningen
(10 tecken, ASCII). Lager med blandade geometrityper delas upp på suffix `_point`/`_line`/`_polygon`.

Datat hämtas på olika sätt per lagertyp:

| Lagertyp | Källa för export |
|---|---|
| `GEOJSON` | Klient-cache (filen är fullt inläst) |
| `WMS`, `WFS` | Server-WFS `GetFeature` med BBOX (Geoserver/QGIS-server) |
| `AGS_FEATURE`, `AGS_TILE` | ArcGIS REST `/query` med urvalsgeometri |
| `OSM`, `XYZ`, `WMTS` | *(bakgrundskartor – exkluderas)* |

För WMS-lager där servern inte exponerar WFS (t.ex. Lantmäteriet) markeras lagret med
felmeddelande i progress-listan men exporten fortsätter med övriga lager.

Allt sker klient-sidan — shapefile, DBF, PRJ, CPG och ZIP genereras i webbläsaren (komprimering
via `CompressionStream` om webbläsaren stöder det, annars STORED).

## Eget lager (delad redigering)

**Eget lager** är en grupp med tre delade, redigerbara lager — **Ytor** (polygon/rektangel),
**Linjer** och **Punkter** — där vem som helst kan rita in geometrier, lägga till rubrik och
beskrivning, samt redigera och ta bort andras objekt. Allt sparas server-sidan så att alla ser
samma innehåll.

Det är tre lager och inte ett, eftersom Origos editor kräver **ett geometrislag per redigerbart
lager** (att blanda polygon/linje/punkt i samma lager fungerar inte — punkter och linjer förkastas).

Till skillnad från övriga lager kräver detta en backend — ren klientsideritning skulle bara
sparas lokalt i din egen webbläsare. Lösningen använder Origos inbyggda **editor**-kontroll mot
**WFS-T**, med **GeoServer** + **PostGIS** som lagring. Allt körs via `docker compose`:

| Tjänst | Roll |
|---|---|
| `db` | PostGIS. Tabellerna `eget_yta`/`eget_linje`/`eget_punkt` skapas av `db/init/01-eget-lager.sql` vid första start. |
| `geoserver` | Publicerar `eget:eget_yta` / `eget_linje` / `eget_punkt` över WFS-T. Data i en namngiven volym. |
| `geoserver-provision` | **Engångsjobb** som skapar workspace, datastore, de tre lagren och öppnar anonym läs/skriv via GeoServers REST-API (`geoserver/provision.sh`). Det avslutas med exit 0 när det är klart — det är meningen, inte en krasch. |
| `origo` | nginx proxar `/proxy/geoserver/` → `geoserver:8080` (WFS-T POST tillåts). |

Starta allt:

```bash
docker compose up -d --build
```

> **Om du körde en tidigare version:** DB-schemat och provisioneringen har ändrats. Init-skripten
> körs bara mot en tom volym, så återskapa volymerna en gång: `docker compose down -v` följt av
> `docker compose up -d --build`. (Detta raderar ev. testdata.)

Provisioneringen väntar på att GeoServer ska bli redo och kör sedan klart (kolla med
`docker compose logs geoserver-provision` — ska sluta med "Provisioning complete"). Kontrollera att
`origo-geoserver` fortsätter köra med `docker compose ps`. Därefter:

1. Öppna kartan — gruppen **Eget lager** (Ytor/Linjer/Punkter) är på som standard.
2. Klicka på penn-knappen (redigera) i verktygsraden och välj vilket lager du vill rita i.
3. Rita en geometri (Ytor erbjuder Polygon och Rektangel via rit-verktygsmenyn).
4. Fyll i Rubrik/Beskrivning i formuläret. Ändringar sparas automatiskt (`autoSave`) via WFS-T.
5. Klicka ett befintligt objekt i redigeringsläge för att ändra eller ta bort det.

**Behörighet:** provisioneringen öppnar anonym läs- *och* skrivåtkomst i GeoServer
(`*.*.r=*`, `*.*.w=*`) så att redigering fungerar utan inloggning. Det passar ett internt/betrott
nät. Exponeras kartan publikt bör du låsa skrivning bakom autentisering (ta bort `*.*.w=*`-regeln
i GeoServer och lägg t.ex. auth i nginx-proxyn). Byt också GeoServers admin-lösenord
(`GEOSERVER_ADMIN_PASSWORD` i `docker-compose.yml`) och DB-lösenordet.

> Origos editor i den här versionen erbjuder rit-verktygen Polygon, Rektangel, Punkt och Linje
> (ingen fristående cirkel). Rektangel läggs till på Ytor-lagret via editor-kontrollens
> `"drawTools": { "Polygon": ["box"] }` i `index.json`.

## CORS-proxy och API-nycklar

GetMap-bilder fungerar utan CORS (`<img>`-laddning), men `GetFeatureInfo` skickas som XHR och kräver
`Access-Control-Allow-Origin`. De flesta svenska geodata-endpoints exponerar inte CORS-headers.
Lösning: `nginx.conf.template` reverse-proxar dem och injicerar `Access-Control-Allow-Origin: *`:

| Proxyväg | Pekar mot |
|---|---|
| `/proxy/sgu/` | `maps3.sgu.se/geoserver/` |
| `/proxy/lst/` | `ext-geodata-ows.lansstyrelsen.se/` |
| `/proxy/lst-ebh/` | `ext-geodata-nationella-visning.lansstyrelsen.se/.../EBH_EXT/` |
| `/proxy/lst-vbk/` | `ext-geodata-applikationer.lansstyrelsen.se/.../Vindbrukskollen/` |
| `/proxy/nv/` | `geodata.naturvardsverket.se/geoserver/` |
| `/proxy/lantmateriet/` | `apimanager.lantmateriet.se/` *(injicerar Authorization-header)* |
| `/proxy/geoserver/` | `geoserver:8080/geoserver/` *(intern tjänst; WFS-T för Eget lager)* |

### Lantmäteriets OAuth2-token

Lantmäteriets WMS-tjänster kräver `Authorization: Bearer <token>`. Tokenet sätts som env-variabel
direkt i `docker-compose.yml` (alternativt via `docker compose run -e LM_BEARER_TOKEN=...`):

```yaml
services:
  origo:
    environment:
      LM_BEARER_TOKEN: "din-lantmateriet-oauth2-token"
```

nginx-imagen kör automatiskt `envsubst` på `nginx.conf.template` vid containerstart och fyller
i `${LM_BEARER_TOKEN}` i `Authorization`-headern. **Tokenet skickas aldrig till klienten** —
webbläsaren ser bara `/proxy/lantmateriet/...`-vägar.

För Lantmäteriets API-portal (`https://apimanager.lantmateriet.se/store/`) loggar du in, registrerar
en klient-applikation, prenumererar på den/de WMS-tjänster du vill använda och genererar en
OAuth2 Bearer Token (Client Credentials flow). Tokenet har begränsad giltighetstid — när det
upphör att fungera, generera ett nytt och starta om containern.

### Trafikverkets projektkatalog (ingen nyckel)

Trafikverket har två separata API:er:

* **Datautbytesportal/Datex** (`api.trafikinfo.trafikverket.se`) — kräver registrering + API-nyckel.
  Använd den om du vill ha t.ex. realtidstrafikdata, broar, kameror eller historisk NVDB-data.
* **Webbsajtens projekt-API** (`www.trafikverket.se/api/projects`) — drivs av deras CMS och kräver
  ingen nyckel. Returnerar exakt samma projektlista som visas under "Våra projekt" på trafikverket.se.

Vi använder den **publika webbsajtens API** för pågående projekt (väg, järnväg, gång- och cykelväg
och sjöfart). Inga nycklar behövs.

## Uppdatera scraper-datat

Tre lager är "snapshots" — committade GeoJSON-filer som genereras av Python-skript i `tools/`.
Kör skripten när du vill ha färska data. Inga externa Python-bibliotek behövs (endast stdlib);
Python 3.10+ rekommenderas.

### Länsstyrelsen-ärenden

Skraparen fyller i sökformuläret på <https://diarium.lansstyrelsen.se/Default.aspx> för varje
av de 21 länsstyrelserna (servern accepterar inte "alla län" i ett anrop), paginerar resultaten,
geokodar Postort → Kommun mot en inbyggd tabell och skriver `data/lansstyrelsen.geojson`.

**Default-sökning** matchar precis det användaren tidigare gjorde manuellt:

* Status = `Handläggning`
* Ärenderubrik innehåller `vattenverksamhet`
* Inkommet fr.o.m. = `2026-01-01`

Kör med default-parametrar:

```powershell
py tools/scrape_lansstyrelsen.py
```

Eller med egna kriterier:

```powershell
# Andra rubriken (t.ex. täktverksamhet)
py tools/scrape_lansstyrelsen.py --title "taktverksamhet"

# Ändra datumintervall
py tools/scrape_lansstyrelsen.py --date-from 2025-06-01 --date-to 2026-05-31

# Bara vissa län (ID från COUNTIES-listan i skriptet)
py tools/scrape_lansstyrelsen.py --counties 12,10,2

# Status "Beslutat" istället
py tools/scrape_lansstyrelsen.py --status Beslutat
```

Alla flaggor:

| Flagga | Default | Beskrivning |
|---|---|---|
| `--status` | `Handläggning` | `Handläggning` \| `Beslutat` \| `Avslutat` |
| `--title` | `vattenverksamhet` | Substring-sökning på ärenderubrik |
| `--date-from` | `2026-01-01` | Inkommet fr.o.m. (YYYY-MM-DD) |
| `--date-to` | `""` | Inkommet t.o.m. (YYYY-MM-DD), tomt = ingen övre gräns |
| `--counties` | alla | Komma-separerade diary-ID:n, t.ex. `12,9,10` |
| `--output` | `data/lansstyrelsen.geojson` | Output-path |
| `--max-pages` | `50` | Säkerhetskap per län |

Efter körning, kopiera till `build/data/` och committa:

```powershell
Copy-Item data/lansstyrelsen.geojson build/data/lansstyrelsen.geojson -Force
git add data/lansstyrelsen.geojson build/data/lansstyrelsen.geojson
git commit -m "Refresh Lansstyrelsen snapshot"
git push
```

**Geokodning:** Postort slås upp först, sedan Kommun, mot dictionaryt `COORDS` överst i skriptet.
Om någon Postort/Kommun saknas skrivs en varningslista till stderr — lägg in koordinaten i `COORDS`
och kör om.

### SMHI hydroobs (Istjocklek + Snödensitet)

```powershell
py tools/scrape_smhi_hydroobs.py
```

Hämtar parameter 7 (istjocklek, cm) och parameter 9 (vatteninnehåll/snö, mm) från
opendata-download-hydroobs.smhi.se och skriver `data/smhi_istjocklek.geojson` resp.
`data/smhi_snodensitet.geojson`. Stationerna har redan WGS84-koordinater så ingen
geokodning behövs.

Annan parameter eller output:

```powershell
py tools/scrape_smhi_hydroobs.py --parameter 8 --output data/smhi_param8.geojson
```

Kopiera + committa precis som ovan.

### Trafikverket pågående projekt

```powershell
py tools/scrape_trafikverket.py
Copy-Item data/trafikverket_projekt.geojson build/data/trafikverket_projekt.geojson -Force
```

Hämtar alla projekt under "Våra projekt" på trafikverket.se (väg, järnväg, gång- och cykelväg,
sjöfart) genom att paginera `https://www.trafikverket.se/api/projects` (25 per sida, ~22 sidor).
Koordinaterna kommer i SWEREF99 TM (EPSG:3006) och konverteras till WGS84 i ren Python via
inverse transverse Mercator. Ingen API-nyckel behövs.

Punkter där underliggande projektet saknar geometri (t.ex. nationella program utan specifik
plats) hoppas över; projekt med flera koordinater (rutter) blir flera punkter.

## Bygg om efter ändringar

```bash
git pull
docker compose up -d --build
```

Det multi-stage-bygger (Node → webpack → nginx) och startar om containern. Tar ~2-3 minuter första gången.

## Projektstruktur

```
.
├── docker-compose.yml          # Container-orkestrering (port 8080 → 80, API-nycklar som env)
├── Dockerfile                  # Multi-stage: node:lts-alpine bygger, nginx:alpine serverar
├── nginx.conf.template         # Statisk serving + CORS-proxy + token-injicering (envsubst)
├── index.html                  # Filterpanel-UI + bootstrap av Origo-viewer
├── index.json                  # Lager- och stilkonfiguration (källa)
├── build/                      # Bundlad output som nginx serverar
│   ├── index.html              # Pekar på origo.min.js
│   ├── index.json              # Kopia av rot-konfigen
│   └── data/                   # GeoJSON-snapshots
├── data/                       # GeoJSON-snapshots (källa, kopieras till build/ vid build)
│   ├── lansstyrelsen.geojson
│   ├── smhi_istjocklek.geojson
│   ├── smhi_snodensitet.geojson
│   └── trafikverket_projekt.geojson
└── tools/                      # Python-scrapers
    ├── scrape_lansstyrelsen.py
    ├── scrape_smhi_hydroobs.py
    └── scrape_trafikverket.py
```

## Origo-grunderna

Detta projekt är en fork. Origos egen dokumentation finns på
<https://origo-map.github.io/origo-documentation/latest/>. För lokal utveckling utan Docker
(om du vill ändra Origos kärna eller stilar), följ den ordinarie Origo-instruktionen:
`npm install && npm start` på <http://localhost:9966>.

## Licens

BSD 2-clause — se [LICENSE.txt](LICENSE.txt).
