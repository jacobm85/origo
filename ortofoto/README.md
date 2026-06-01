# Ortofoto-backend

Liten Node/Express-tjänst som låter kartans `ortofoto-download`-plugin söka
Lantmäteriets **STAC-bild**-API för den synliga kartvyn och ladda ner valda
ortofoton (GeoTIFF) som en zip-ström. Lantmäteriets **Basic Auth** läggs på
server-side så att uppgifterna aldrig hamnar i klienten eller i git.

Ersätter QGIS-skripten "utbredningsområden_ortofoto" (skapade ett lager per
flygår) och "årtal_nedladdning_ortofoto" (laddade ner ortofotona för ett valt
år).

## Endpoints

nginx proxar `/api/ortofoto/` hit (bakom inloggningen).

| Metod | Sökväg | Body | Svar |
|-------|--------|------|------|
| POST | `/api/ortofoto/search` | `{"bbox":[väst,syd,öst,nord]}` (WGS84) | slimmad lista av indexrutor: `{id, year, dataHref, dataSize, geometry, …}` |
| POST | `/api/ortofoto/estimate` | `{"items":["href",…]}` | `{count, totalSize}` (HEAD mot varje fil) |
| POST | `/api/ortofoto/download` | `items` (JSON eller form) | `application/zip` (strömmas) |
| GET | `/health` | – | `{ok, hasAuth}` |

## Konfiguration (miljövariabler)

| Variabel | Default | Beskrivning |
|----------|---------|-------------|
| `LM_USER` / `LM_PASS` | – | Gemensam Lantmäteri-inloggning (Basic Auth mot `api.lantmateriet.se` + `dl*.lantmateriet.se`) |
| `STAC_SEARCH_URL` | `https://api.lantmateriet.se/stac-bild/v1/search` | Sök-endpoint |
| `ALLOWED_HOST_SUFFIX` | `.lantmateriet.se` | SSRF-skydd: bara https mot denna domän laddas ner |
| `MAX_FILES` | `100` | Max antal rutor per nedladdning |
| `MAX_BYTES` | `50 GB` | Max total zip-storlek |
| `SEARCH_LIMIT` | `4000` | Max antal rutor per sökning |
| `PORT` | `3003` | Lyssningsport |

Sätt `LM_USER`/`LM_PASS` i projektets `.env` (se `.env.example`) —
checka **inte** in dem. Applicera med `docker compose up -d ortofoto`.

## Säkerhet

* Basic Auth lämnar aldrig servern.
* Endast `https://*.lantmateriet.se` får laddas ner (SSRF-skydd).
* Antal rutor och total storlek begränsas (`MAX_FILES` / `MAX_BYTES`).
* Hela `/api/ortofoto/` ligger bakom kartans inloggning (nginx `auth_request`).

## Noteringar

Ortofoton är stora (ofta ~0,5–1 GB per 2,5 × 2,5 km-ruta). Filerna hämtas en i
taget och strömmas direkt in i zip:en (store-läge, zip64) så minnesåtgången
hålls låg även för stora urval.
