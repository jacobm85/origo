"""Registry of Swedish kommuner with their protocol-source configuration.

Each kommun entry holds:
  - title          : display name in Origo legend
  - lan            : id of the län this kommun belongs to (matches LAN below)
  - centroid       : (lon, lat) WGS84, used as fallback location for the
                     scraped paragraphs since we do not (yet) geocode
                     fastighet -> coordinate
  - source         : optional dict describing where protocols are published.
                     If omitted, the kommun is shown in the legend as a
                     placeholder (empty geojson). Supported source types:
                       - "sitevision_folder" : Luleå-style folder URL that
                         lists all PDFs for one year/nämnd.
                       - "sitevision_listing": single page mixing many
                         nämnders PDFs; filter via filename regex.
                       - "playwright_stockholm_sbn": Stockholm Bygg- och
                         plantjänsten SPA; needs Playwright (Chromium).

Add a kommun by appending an entry and re-running tools/scrape_protokoll.py.
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Län (län-ids used in Origo's group hierarchy)
# ---------------------------------------------------------------------------

LAN: dict[str, str] = {
    "blekinge":         "Blekinge län",
    "dalarna":          "Dalarnas län",
    "gotland":          "Gotlands län",
    "gavleborg":        "Gävleborgs län",
    "halland":          "Hallands län",
    "jamtland":         "Jämtlands län",
    "jonkoping":        "Jönköpings län",
    "kalmar":           "Kalmar län",
    "kronoberg":        "Kronobergs län",
    "norrbotten":       "Norrbottens län",
    "skane":            "Skåne län",
    "stockholm":        "Stockholms län",
    "sodermanland":     "Södermanlands län",
    "uppsala":          "Uppsala län",
    "varmland":         "Värmlands län",
    "vasterbotten":     "Västerbottens län",
    "vasternorrland":   "Västernorrlands län",
    "vastmanland":      "Västmanlands län",
    "vastra_gotaland":  "Västra Götalands län",
    "orebro":           "Örebro län",
    "ostergotland":     "Östergötlands län",
}


# ---------------------------------------------------------------------------
# Kommuner. Add new entries here. The key becomes the Origo layer name slug.
# ---------------------------------------------------------------------------

KOMMUNER: dict[str, dict] = {
    # ----- Norrbottens län (14 kommuner) ----------------------------------
    "arjeplog": {
        "title": "Arjeplog",
        "lan": "norrbotten",
        "centroid": (17.8833, 66.0500),
    },
    "arvidsjaur": {
        "title": "Arvidsjaur",
        "lan": "norrbotten",
        "centroid": (19.1833, 65.5833),
    },
    "boden": {
        "title": "Boden",
        "lan": "norrbotten",
        "centroid": (21.6833, 65.8333),
    },
    "gallivare": {
        "title": "Gällivare",
        "lan": "norrbotten",
        "centroid": (20.6500, 67.1333),
        "source": {
            "type": "sitevision_listing",
            "url": "https://gallivare.se/kommun-och-politik/politik-och-demokrati/moten-och-protokoll",
            "label": "Miljö-, bygg- och räddningsnämnden",
            "filename_pattern": r"(?i)(milj[oö].*bygg|MBR)\b.*protokoll",
        },
    },
    "haparanda": {
        "title": "Haparanda",
        "lan": "norrbotten",
        "centroid": (24.1333, 65.8333),
    },
    "jokkmokk": {
        "title": "Jokkmokk",
        "lan": "norrbotten",
        "centroid": (19.8333, 66.6000),
    },
    "kalix": {
        "title": "Kalix",
        "lan": "norrbotten",
        "centroid": (23.1500, 65.8500),
    },
    "kiruna": {
        "title": "Kiruna",
        "lan": "norrbotten",
        "centroid": (20.2167, 67.8500),
        "source": {
            "type": "sitevision_listing",
            "url": "https://kiruna.se/kommun--demokrati/kommunens-organisation/kallelser-och-protokoll.html",
            "label": "Miljö- och byggnämnden",
            "filename_pattern": r"(?i)(milj[oö].*bygg|\bMOB\b).*protokoll|protokoll.*MOB",
        },
    },
    "lulea": {
        "title": "Luleå",
        "lan": "norrbotten",
        "centroid": (22.1567, 65.5836),
        "source": {
            "type": "sitevision_folder",
            "url": (
                "https://www.lulea.se/kommun--politik/moten-handlingar-och-protokoll.html"
                "?folder=19.597b1ac319bc2615cfd43da"
                "&sv.url=12.2b7bdc7f183d5df682e1c3de"
            ),
            "label": "Miljö- och byggnadsnämnden 2026",
        },
    },
    "pajala": {
        "title": "Pajala",
        "lan": "norrbotten",
        "centroid": (23.3667, 67.2000),
    },
    "pitea": {
        "title": "Piteå",
        "lan": "norrbotten",
        "centroid": (21.4833, 65.3167),
        "source": {
            "type": "sitevision_listing",
            "url": "https://www.pitea.se/invanare/Kommun-politik/politik/Namnder/Samhallsbyggnadsnamnden/Protokoll/",
            "label": "Samhällsbyggnadsnämnden",
            "filename_pattern": r"(?i)protokoll.*sbn|sbn.*protokoll|samh[aä]llsbyggnad",
        },
    },
    "alvsbyn": {
        "title": "Älvsbyn",
        "lan": "norrbotten",
        "centroid": (20.9667, 65.6667),
    },
    "overkalix": {
        "title": "Överkalix",
        "lan": "norrbotten",
        "centroid": (22.8167, 66.3333),
    },
    "overtornea": {
        "title": "Övertorneå",
        "lan": "norrbotten",
        "centroid": (23.6500, 66.3833),
    },

    # ----- Stockholms län -------------------------------------------------
    "stockholm": {
        "title": "Stockholm",
        "lan": "stockholm",
        "centroid": (18.0686, 59.3293),
        "source": {
            "type": "playwright_stockholm_sbn",
            "url": "https://etjanster.stockholm.se/Byggochplantjansten/stadsbyggnadsnamnden",
            "label": "Stadsbyggnadsnämnden",
        },
    },
}


def by_lan() -> dict[str, list[tuple[str, dict]]]:
    """Group kommuner by län. Returns {lan_id: [(kommun_slug, cfg), ...]}."""
    out: dict[str, list[tuple[str, dict]]] = {lid: [] for lid in LAN}
    for slug, cfg in KOMMUNER.items():
        out.setdefault(cfg["lan"], []).append((slug, cfg))
    for lid in out:
        out[lid].sort(key=lambda kv: kv[1]["title"])
    return out
