# Laserdata backend

Node/Express-tjänst som söker Lantmäteriets **STAC-höjd**-API för kartvyn och
strömmar valda laserdata-rutor (punktmoln, LAZ/COPC) som en zip. Hämtar alltså
data **direkt från Lantmäteriet** – ingen lokal NAS behövs längre. Speglar
ortofoto-backenden; OAuth2-token (eller Basic Auth) injiceras server-side så att uppgifterna aldrig
hamnar i klienten eller i git.

STAC: `https://api.lantmateriet.se/stac-hojd/v1/` — collection
`dsm-skoglig-copc` ("Laserdata Skog"), asset `data` (`.copc.laz` på
`dl*.lantmateriet.se`). Behörigheten ligger på samma Geotorget-konto som
ortofoto/jonosfär (`LM_USER`/`LM_PASS`).

| Endpoint | Body | Svar |
|---|---|---|
| `POST /api/laserdata/search` | JSON `{"bbox":[w,s,e,n],"limit"?}` | slimmad FeatureCollection `{count,features[]}` |
| `POST /api/laserdata/estimate` | JSON `{"items":["href",…]}` | JSON `{count,totalSize}` eller `{error}` |
| `POST /api/laserdata/download` | JSON eller form `items=…` | `application/zip` (strömmas) |
| `GET /health` | – | JSON `{ok, hasAuth}` |

I det här projektet körs backenden som tjänsten **`laserdata`** i
`docker-compose.yml`, och nginx proxyar `/api/laserdata/` till den (bakom
inloggningen). Pluginet anropar därför `/api/laserdata` same-origin — ingen
CORS behövs.

## Konfiguration (miljövariabler)

Autentisering – två sätt (STAC-höjd erbjuder båda). OAuth2 föredras om
nycklarna är satta, annars Basic:

| Variabel | Default | Beskrivning |
|---|---|---|
| `LM_OAUTH_KEY` / `LM_OAUTH_SECRET` | – | OAuth2 consumer key + secret (client credentials). Byts mot en kortlivad Bearer-token som cachas/förnyas. |
| `LM_OAUTH_TOKEN_URL` | `https://apimanager.lantmateriet.se/oauth2/token` | Token-endpoint. |
| `LM_OAUTH_SCOPE` | – | Valfri scope (lämna tom om den inte krävs). |
| `LM_USER` / `LM_PASS` | – | Basic Auth – används om OAuth2-nycklar saknas. |
| `STAC_SEARCH_URL` | `https://api.lantmateriet.se/stac-hojd/v1/search` | STAC-sökendpoint. |
| `STAC_COLLECTION` | `dsm-skoglig-copc` | Collection att söka i. |
| `ALLOWED_HOST_SUFFIX` | `.lantmateriet.se` | SSRF-skydd: bara dessa hostar får laddas ner. |
| `MAX_FILES` | `200` | Max antal rutor per nedladdning. |
| `MAX_BYTES` | `53687091200` (50 GB) | Tak för totalstorlek per nedladdning. |
| `PORT` | `3001` | Lyssningsport. |
| `CORS_ORIGIN` | `*` | Behövs ej bakom nginx-proxyn (same-origin). |

### Köra fristående (utan Docker)

```powershell
cd laserdata
npm install
$env:LM_USER="..."; $env:LM_PASS="..."
node server.js
```

### Urval i klienten

Pluginet `laserdata-download` söker STAC för den synliga vyn, ritar rutornas
fotavtryck och låter användaren markera rutor (klick / Ctrl-dra). Vid
nedladdning skickas de markerade rutornas asset-URL:er till `download`, som
strömmar dem till en zip.

## Säkerhet

- Bara `https` mot `*.lantmateriet.se` får laddas ner (SSRF-skydd i `isAllowedUrl`).
- Body begränsas till 4 MB; `MAX_FILES`/`MAX_BYTES` skyddar mot extrema begäran.
- OAuth2-token/Basic Auth läggs på server-side; uppgifterna lämnar aldrig containern.
