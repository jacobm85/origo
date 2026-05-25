# Laserdata backend

Node/Express-tjänst som tar emot ett urval av cell-id:n från `laserdata-download`-
pluginet och strömmar en zip med motsvarande LAZ-filer från NAS:en.

| Endpoint | Body | Svar |
|---|---|---|
| `POST /api/laserdata/estimate` | JSON `{"cells":["10C012",…]}` | JSON `{count,totalSize}` eller `{error}` |
| `POST /api/laserdata/download` | JSON eller form `cells=…` | `application/zip` (strömmas) |
| `GET /health` | – | JSON `{ok, mode}` |

I det här projektet körs backenden som tjänsten **`laserdata`** i
`docker-compose.yml`, och nginx proxyar `/api/laserdata/` till den (bakom
inloggningen). Pluginet anropar därför `/api/laserdata` same-origin — ingen
CORS behövs.

## Konfiguration

Två lägen för att hitta LAZ-filerna:

- **Root + mönster** (vanligast): peka `LASERDATA_ROOT` på katalogen och låt
  `LASERDATA_PATTERN` (default `{id}.laz`) avgöra filnamnet.
- **Manifest**: `LASERDATA_MANIFEST` → en JSON-fil som mappar `cell_id` →
  `{path, size}` (för spridda filer eller udda namn).

Allt kan sättas via miljövariabler (så `config.json` behövs inte i container):

| Variabel | Default | Beskrivning |
|---|---|---|
| `PORT` | `3001` | Lyssningsport. |
| `CORS_ORIGIN` | `*` | Behövs ej bakom nginx-proxyn (same-origin). |
| `MAX_BYTES` | `53687091200` (50 GB) | Tak för totalstorlek per nedladdning. |
| `MAX_CELLS` | `200` | Max antal rutor per nedladdning. |
| `LASERDATA_ROOT` | – | Katalog där LAZ-filer ligger (root-läge). |
| `LASERDATA_PATTERN` | `{id}.laz` | Filnamnsmönster med `{id}`. |
| `LASERDATA_MANIFEST` | – | Path till manifest.json (vinner över root). |
| `CONFIG` | `./config.json` | Path till config.json (valfri). |

### Köra fristående (utan Docker)

```powershell
cd laserdata
npm install
copy config.example.json config.json   # redigera "root"
node server.js
```

### Indexrutnät (genereras i klienten)

Pluginet genererar Lantmäteriets officiella **2,5 × 2,5 km-indexrutnät**
(SWEREF 99 TM) direkt i kartan för den synliga vyn — ingen rutnätsfil behövs.
Rutnätet är regelbundet och alignat mot multiplar av 2500 m, och rutans `id`
(= LAZ-filens stam) byggs ur sydvästra hörnet:

```
id = "{N_sv/100}_{E_sv/100}_25"
```

Exempel: SV-hörn E=650000, N=6997500 → `69975_6500_25`, vilket matchar
Lantmäteriets filnamn `69975_6500_25.laz`. Backenden hittar då filen med
default-mönstret `{id}.laz`.

> Officiella rutorna finns även som öppna data (shapefile) om du vill
> verifiera: Lantmäteriet → Produktsupport → Indexrutor → `index_2_5km.zip`.

Era LAZ-filer på NAS:en måste alltså heta `<id>.laz` (t.ex.
`69975_6500_25.laz`). Ligger de med andra namn/på spridda platser: använd
manifest-läget (`LASERDATA_MANIFEST`) och mappa `id → {path, size}`.

## Säkerhet

- Cell-id valideras mot `^[A-Za-z0-9_.-]+$` — inga slash, `..` eller tomma.
- Resolverad path måste stanna under `root` (`path.relative` + check).
- Body begränsas till 1 MB; `maxBytes`/`maxCells` skyddar mot extrema begäran.
- Ge containern läsbehörighet bara på den NAS-katalog som behövs.
