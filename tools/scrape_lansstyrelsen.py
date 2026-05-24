#!/usr/bin/env python3
"""Scrape Lansstyrelsen's diarium search result and emit a GeoJSON layer.

Each case is geocoded by looking up its Kommun first, then falling back to
Postort, against a built-in table of Swedish municipality centres. When both
list columns are empty the kommun is derived from the case title (rubrik) and,
failing that, from the case detail page (CaseInfo.aspx). Cases that still
cannot be geocoded are skipped (and reported as a warning).

Re-run this script whenever you want a fresh snapshot. The output is written
to data/lansstyrelsen.geojson (committed to the repo and loaded by Origo).
"""

from __future__ import annotations

import argparse
import html
import json
import random
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.cookiejar import CookieJar
from pathlib import Path

SEARCH_FORM_URL = "https://diarium.lansstyrelsen.se/Default.aspx"
RESULT_URL_BASE = "https://diarium.lansstyrelsen.se"
CASE_INFO_URL = "https://diarium.lansstyrelsen.se/Case/CaseInfo.aspx?caseID="

OUTPUT_PATH = Path(__file__).resolve().parent.parent / "data" / "lansstyrelsen.geojson"

USER_AGENT = "origo-diarium-scraper/2.0 (+https://github.com/jacobm85/origo)"

GRIDVIEW_TARGET = "ctl00$SearchPlaceHolder$caseGridView"

# All 21 Lansstyrelser, ordered alphabetically by name as in the form dropdown.
COUNTIES: list[tuple[str, str]] = [
    ("9",  "Blekinge"),
    ("16", "Dalarna"),
    ("8",  "Gotland"),
    ("17", "Gavleborg"),
    ("11", "Halland"),
    ("19", "Jamtland"),
    ("6",  "Jonkoping"),
    ("22", "Kalmar"),
    ("7",  "Kronoberg"),
    ("21", "Norrbotten"),
    ("10", "Skane"),
    ("2",  "Stockholm"),
    ("4",  "Sodermanland"),
    ("3",  "Uppsala"),
    ("13", "Varmland"),
    ("20", "Vasterbotten"),
    ("18", "Vasternorrland"),
    ("15", "Vastmanland"),
    ("12", "Vastra Gotaland"),
    ("14", "Orebro"),
    ("5",  "Ostergotland"),
]

# Approximate WGS84 centre coordinates [lon, lat] for Swedish kommuner and a
# handful of common postorter that do not share a name with their kommun.
# Source: well-known public reference values rounded to 4 decimals.
COORDS: dict[str, tuple[float, float]] = {
    # Vastra Gotaland (49 kommuner)
    "ale": (12.0833, 57.9333),
    "alingsas": (12.5333, 57.9333),
    "bengtsfors": (12.2333, 59.0333),
    "bollebygd": (12.5667, 57.6667),
    "boras": (12.9400, 57.7200),
    "dals-ed": (11.9333, 58.9333),
    "essunga": (12.7667, 58.1833),
    "falkoping": (13.5500, 58.1667),
    "farjestaden": (12.7833, 58.0667),
    "farjelanda": (11.9833, 58.4167),
    "farjkopping": (13.5500, 58.1667),
    "gotene": (13.4833, 58.5333),
    "goteborg": (11.9750, 57.7100),
    "grastorp": (12.6833, 58.3333),
    "gullspang": (14.1167, 58.9667),
    "hjo": (14.2833, 58.3000),
    "harryda": (12.3333, 57.7000),
    "herrljunga": (13.0333, 58.0833),
    "karlsborg": (14.5167, 58.5333),
    "kungalv": (11.9667, 57.8667),
    "lerum": (12.2700, 57.7700),
    "lidkoping": (13.1500, 58.5000),
    "lilla edet": (12.1333, 58.1333),
    "lysekil": (11.4333, 58.2833),
    "mariestad": (13.8167, 58.7000),
    "mark": (12.7000, 57.5167),
    "mellerud": (12.4500, 58.7000),
    "munkedal": (11.6833, 58.4667),
    "mullsjo": (13.8833, 57.9167),
    "molndal": (12.0167, 57.6500),
    "orust": (11.6333, 58.1833),
    "partille": (12.1167, 57.7333),
    "skara": (13.4333, 58.3833),
    "skovde": (13.8500, 58.3833),
    "sotenas": (11.2333, 58.4167),
    "stenungsund": (11.8167, 58.0833),
    "stromstad": (11.1667, 58.9333),
    "svenljunga": (13.1167, 57.4833),
    "tanum": (11.3333, 58.7167),
    "tibro": (14.1667, 58.4167),
    "tidaholm": (13.9500, 58.1833),
    "tjorn": (11.5500, 58.0167),
    "tranemo": (13.3333, 57.4833),
    "trollhattan": (12.2833, 58.2833),
    "toreboda": (14.1167, 58.7000),
    "uddevalla": (11.9333, 58.3500),
    "ulricehamn": (13.4167, 57.7833),
    "vara": (12.9500, 58.2667),
    "vargarda": (12.7833, 58.0333),
    "vanersborg": (12.3167, 58.3833),
    # Common Vastra Gotaland postorter that differ from kommun name
    "billdal": (11.9500, 57.6000),         # Goteborg kommun
    "ellos": (11.4667, 58.1833),           # Orust kommun
    "hamburgsund": (11.3000, 58.6000),     # Tanum kommun
    "hunnebostrand": (11.2833, 58.4500),   # Sotenas kommun
    "jonsered": (12.1500, 57.7667),        # Partille/Lerum
    "kopstadso": (11.7333, 57.6833),       # Goteborg kommun (skargard)
    "larv": (13.0333, 58.1167),            # Vara kommun
    "ror": (11.5667, 57.7000),             # Goteborg skargard
    "roro": (11.6500, 57.7500),            # Goteborg skargard
    "tanumshede": (11.3333, 58.7167),      # Tanum kommun
    "almestad": (13.2667, 57.7000),        # Ulricehamn area
    "hultafors": (12.5667, 57.7667),       # Bollebygd kommun
    "ockero": (11.6500, 57.7167),          # Ockero kommun

    # Other large Swedish cities/kommuner that may appear
    "ange": (15.6500, 62.5167),
    "arboga": (15.8333, 59.4000),
    "arjeplog": (17.8833, 66.0500),
    "arvidsjaur": (19.1833, 65.5833),
    "arvika": (12.5833, 59.6500),
    "askersund": (14.9000, 58.8833),
    "avesta": (16.1667, 60.1500),
    "bjuv": (12.9167, 56.0833),
    "boden": (21.6833, 65.8333),
    "bollnas": (16.4000, 61.3500),
    "borgholm": (16.6500, 56.8833),
    "borlange": (15.4333, 60.4833),
    "boxholm": (15.0500, 58.2000),
    "bromolla": (14.4833, 56.0833),
    "burlov": (13.0667, 55.6333),
    "danderyd": (18.0333, 59.4000),
    "degerfors": (14.4333, 59.2333),
    "eda": (12.2833, 59.8833),
    "eskilstuna": (16.5083, 59.3667),
    "eslov": (13.3000, 55.8333),
    "fagersta": (15.8000, 59.9833),
    "falkenberg": (12.4833, 56.9000),
    "falun": (15.6333, 60.6000),
    "filipstad": (14.1667, 59.7167),
    "finspang": (15.7833, 58.7167),
    "flen": (16.5833, 59.0500),
    "forshaga": (13.4833, 59.5333),
    "gallivare": (20.6500, 67.1333),
    "gislaved": (13.5500, 57.3000),
    "gnesta": (17.3000, 59.0500),
    "gnosjo": (13.7333, 57.3500),
    "grums": (13.1167, 59.3500),
    "grythyttan": (14.5333, 59.6833),
    "gavle": (17.1417, 60.6750),
    "habo": (14.1833, 57.9167),
    "haparanda": (24.1333, 65.8333),
    "haninge": (18.1500, 59.1667),
    "harnosand": (17.9333, 62.6333),
    "hassleholm": (13.7667, 56.1583),
    "hedemora": (15.9833, 60.2833),
    "helsingborg": (12.6944, 56.0467),
    "hofors": (16.2833, 60.5500),
    "huddinge": (17.9833, 59.2333),
    "hudiksvall": (17.1000, 61.7333),
    "hultsfred": (15.8333, 57.4833),
    "hylte": (13.2167, 57.0167),
    "hallefors": (14.5000, 59.7833),
    "halleforsnas": (16.4500, 59.1833),
    "halsingborg": (12.6944, 56.0467),
    "hogsby": (16.0333, 57.1667),
    "horby": (13.6667, 55.8500),
    "horsby": (13.6667, 55.8500),
    "jokkmokk": (19.8333, 66.6000),
    "jonkoping": (14.1667, 57.7833),
    "kalix": (23.1500, 65.8500),
    "kalmar": (16.3667, 56.6667),
    "karlshamn": (14.8500, 56.1700),
    "karlskoga": (14.5167, 59.3333),
    "karlskrona": (15.5867, 56.1612),
    "karlstad": (13.5000, 59.3833),
    "katrineholm": (16.2000, 59.0000),
    "kil": (13.3167, 59.5000),
    "kinda": (15.6000, 58.0000),
    "kiruna": (20.2167, 67.8500),
    "klippan": (13.1333, 56.1333),
    "knivsta": (17.7833, 59.7167),
    "koping": (15.9833, 59.5167),
    "kramfors": (17.7833, 62.9333),
    "kristianstad": (14.1500, 56.0333),
    "kristinehamn": (14.1167, 59.3000),
    "krokom": (14.4833, 63.3333),
    "kumla": (15.1333, 59.1333),
    "kungsbacka": (12.0667, 57.4833),
    "kungsor": (16.1000, 59.4167),
    "laholm": (13.0500, 56.5167),
    "landskrona": (12.8333, 55.8667),
    "leksand": (15.0167, 60.7333),
    "lessebo": (15.2667, 56.7500),
    "linkoping": (15.6167, 58.4167),
    "ljungby": (13.9333, 56.8333),
    "ljusdal": (16.0833, 61.8333),
    "ljusnarsberg": (15.0667, 59.8667),
    "lomma": (13.0833, 55.6833),
    "ludvika": (15.1900, 60.1500),
    "lulea": (22.1500, 65.5833),
    "lund": (13.1944, 55.7047),
    "lycksele": (18.6833, 64.6000),
    "malmo": (13.0000, 55.6000),
    "mala": (18.7000, 65.2000),
    "malung-salen": (13.7333, 60.6833),
    "malung": (13.7333, 60.6833),
    "mariefred": (17.2167, 59.2500),
    "mark": (12.7000, 57.5167),
    "markaryd": (13.6000, 56.4500),
    "mjolby": (15.1333, 58.3167),
    "mora": (14.5333, 61.0000),
    "motala": (15.0333, 58.5333),
    "mullsjo": (13.8833, 57.9167),
    "munkfors": (13.5500, 59.8333),
    "nacka": (18.1667, 59.3000),
    "nora": (15.0333, 59.5167),
    "norberg": (15.9333, 60.0667),
    "nordanstig": (17.1500, 62.0500),
    "nordmaling": (19.4833, 63.5667),
    "norrkoping": (16.1833, 58.6000),
    "norrtalje": (18.7000, 59.7667),
    "norsjo": (19.5000, 65.0167),
    "nybro": (15.9000, 56.7500),
    "nykvarn": (17.4167, 59.1833),
    "nykoping": (17.0083, 58.7500),
    "nynashamn": (17.9333, 58.9000),
    "ockelbo": (16.7167, 60.8833),
    "olofstrom": (14.5333, 56.2667),
    "orsa": (14.6167, 61.1333),
    "orust": (11.6333, 58.1833),
    "osby": (13.9833, 56.3833),
    "oskarshamn": (16.4333, 57.2667),
    "ostersund": (14.6333, 63.1833),
    "ostra goinge": (14.0667, 56.2333),
    "ovanaker": (15.7833, 61.4500),
    "overkalix": (22.8167, 66.3333),
    "overtornea": (23.6500, 66.3833),
    "pajala": (23.3667, 67.2000),
    "perstorp": (13.4000, 56.1333),
    "pitea": (21.4833, 65.3167),
    "ragunda": (16.4000, 63.1000),
    "robertsfors": (20.8500, 64.2000),
    "ronneby": (15.2833, 56.2000),
    "salem": (17.7833, 59.2000),
    "sala": (16.6000, 59.9167),
    "sandviken": (16.7833, 60.6167),
    "sigtuna": (17.7333, 59.6167),
    "simrishamn": (14.3500, 55.5500),
    "sjobo": (13.7167, 55.6333),
    "skara": (13.4333, 58.3833),
    "skelleftea": (20.9500, 64.7500),
    "skinnskatteberg": (15.6833, 59.8333),
    "skurup": (13.5000, 55.4833),
    "smedjebacken": (15.4167, 60.1500),
    "sollefteå": (17.2667, 63.1667),
    "solleftea": (17.2667, 63.1667),
    "sollentuna": (17.9500, 59.4333),
    "solna": (18.0000, 59.3667),
    "sorsele": (17.5333, 65.5167),
    "staffanstorp": (13.2167, 55.6333),
    "stockholm": (18.0686, 59.3294),
    "storfors": (14.2833, 59.5333),
    "storuman": (17.1167, 65.0833),
    "strangnas": (17.0333, 59.3833),
    "sundbyberg": (17.9667, 59.3667),
    "sundsvall": (17.3167, 62.3833),
    "surahammar": (16.2167, 59.7167),
    "svalov": (13.1167, 55.9167),
    "svedala": (13.2333, 55.5083),
    "sater": (15.7500, 60.3500),
    "savsjo": (14.6667, 57.4000),
    "soderhamn": (17.0667, 61.3000),
    "sodertalje": (17.6250, 59.1833),
    "sodertorn": (17.9667, 59.0333),
    "sodermalm": (18.0667, 59.3167),
    "tierp": (17.5167, 60.3417),
    "timra": (17.3000, 62.4833),
    "tomelilla": (13.9500, 55.5500),
    "torsas": (16.0000, 56.4167),
    "torsby": (13.0000, 60.1333),
    "tranas": (14.9833, 58.0333),
    "trelleborg": (13.1500, 55.3750),
    "trosa": (17.5500, 58.8833),
    "umea": (20.2630, 63.8258),
    "upplands vasby": (17.9000, 59.5167),
    "upplands-bro": (17.6500, 59.5167),
    "uppsala": (17.6389, 59.8586),
    "uppvidinge": (15.5333, 57.0167),
    "vadstena": (14.8833, 58.4500),
    "vaggeryd": (14.1500, 57.5000),
    "valdemarsvik": (16.6000, 58.2000),
    "vallentuna": (18.0833, 59.5333),
    "vansbro": (14.2167, 60.5167),
    "varberg": (12.2500, 57.1000),
    "vaxholm": (18.3500, 59.4000),
    "vellinge": (13.0167, 55.4667),
    "vetlanda": (15.0667, 57.4333),
    "vilhelmina": (16.6500, 64.6333),
    "vimmerby": (15.8500, 57.6667),
    "vindeln": (19.7167, 64.2000),
    "vingaker": (15.8667, 59.0333),
    "vasteras": (16.5448, 59.6099),
    "vastervik": (16.6500, 57.7500),
    "vaxjo": (14.8059, 56.8767),
    "ydre": (15.3333, 57.8667),
    "ystad": (13.8167, 55.4286),
    "alvdalen": (14.0333, 61.2333),
    "alvkarleby": (17.4500, 60.5667),
    "alvsbyn": (20.9667, 65.6667),
    "amal": (12.7000, 59.0500),
    "angelholm": (12.8667, 56.2417),
    "atvidaberg": (16.0000, 58.2000),
    "odeshog": (14.6500, 58.2333),
    "orebro": (15.2167, 59.2747),
    "orkelljunga": (13.2833, 56.2833),
    "ornskoldsvik": (18.7167, 63.2900),
    "ostersund": (14.6333, 63.1833),
    "osthammar": (18.3667, 60.2667),
    "ostra goinge": (14.0667, 56.2333),
    "overtornea": (23.6500, 66.3833),
    # Additional kommuner discovered by the all-county search
    "aneby": (14.8000, 57.8500),
    "askersund": (14.9000, 58.8833),
    "berg": (14.4000, 63.0833),
    "bjurholm": (19.0500, 63.9500),
    "bracke": (15.4167, 62.7500),
    "bromolla": (14.4667, 56.0833),
    "dorotea": (16.4167, 64.2667),
    "eksjo": (14.9667, 57.6667),
    "emmaboda": (15.5333, 56.6333),
    "fardelanda": (11.9667, 58.5500),
    "gagnef": (15.0333, 60.5667),
    "gotland": (18.2833, 57.6333),
    "haparanda": (24.1333, 65.8333),
    "harjedalen": (13.8500, 62.0500),
    "hagfors": (13.6833, 60.0333),
    "hammaro": (13.5167, 59.3000),
    "hoganas": (12.5500, 56.2000),
    "hoor": (13.5333, 55.9333),
    "kavlinge": (13.1000, 55.7833),
    "kungsbacka": (12.0667, 57.4833),
    "lekeberg": (14.8000, 59.2333),
    "lidingo": (18.1333, 59.3667),
    "lindesberg": (15.2333, 59.5833),
    "monsteras": (16.4500, 57.0500),
    "morbylanga": (16.3833, 56.5500),
    "nassjo": (14.7000, 57.6500),
    "nordmaling": (19.4833, 63.5667),
    "norrtalje": (18.7000, 59.7667),
    "nybro": (15.9000, 56.7500),
    "oxelosund": (17.1167, 58.6667),
    "rattvik": (15.1167, 60.8833),
    "saffle": (12.9333, 59.1333),
    "saxneset": (14.2833, 62.4333),
    "stromsund": (15.5667, 63.8500),
    "sunne": (13.1500, 59.8333),
    "svenljunga": (13.1167, 57.4833),
    "solvesborg": (14.5833, 56.0500),
    "tingsryd": (14.9833, 56.5333),
    "tjorn": (11.5500, 58.0167),
    "tomelilla": (13.9500, 55.5500),
    "tyreso": (18.2333, 59.2333),
    "taby": (18.0667, 59.4500),
    "vaxholm": (18.3500, 59.4000),
    "vannas": (19.7333, 63.9000),
    "varnamo": (14.0333, 57.1833),
    "arjang": (12.1333, 59.3833),
    # Common postorter that differ from kommun name (selected from warnings)
    "borgholm": (16.6500, 56.8833),
    "broddebo": (13.4500, 56.4000),
    "broddetorp": (13.6833, 58.1500),
    "fardelandet": (11.9667, 58.5500),
    "ljungbyholm": (16.1667, 56.6500),
    "lofsdalen": (13.5000, 62.1167),
    "loddekopinge": (13.0333, 55.7667),
    "malmback": (14.4667, 57.5833),
    "mariannelund": (15.5833, 57.6167),
    "nalden": (14.2333, 63.3500),
    "paryd": (16.0333, 56.6000),
    "paskallavik": (16.4500, 57.1833),
    "sturefors": (15.7167, 58.3167),
    "sveg": (14.3667, 62.0333),
    "vankiva": (13.8000, 56.2000),
    "visby": (18.2833, 57.6333),
    "alta": (18.1667, 59.2667),
    "onnestad": (14.0167, 56.0667),
    # More missing kommuner
    "abbekas": (13.6000, 55.4167),
    "alno": (17.4000, 62.4333),
    "bankeryd": (14.1167, 57.8500),
    "bastad": (12.8500, 56.4250),
    "botkyrka": (17.7833, 59.1833),
    "charlottenberg": (12.3000, 59.8833),
    "ekero": (17.8000, 59.2833),
    "halmstad": (12.8578, 56.6739),
    "holo": (17.5667, 59.0333),
    "jarfalla": (17.8333, 59.4083),
    "kattarp": (12.8167, 56.1500),
    "soderkoping": (16.3167, 58.4833),
    "varmdo": (18.4500, 59.3167),
    "are": (13.0833, 63.4000),
}


def normalise(name: str) -> str:
    """Lowercase + strip diacritics for dict lookup."""
    if not name:
        return ""
    n = name.strip().lower()
    table = str.maketrans("åäö", "aao")
    return n.translate(table)


def lookup_coord(postort: str, kommun: str) -> tuple[float, float, str] | None:
    """Try Kommun first, then Postort. Returns (lon, lat, source) or None."""
    if kommun:
        c = COORDS.get(normalise(kommun))
        if c:
            return c[0], c[1], f"kommun:{kommun}"
    if postort:
        c = COORDS.get(normalise(postort))
        if c:
            return c[0], c[1], f"postort:{postort}"
    return None


# Matches "<Kommun>s kommun" (the genitive -s is optional) inside a free-text
# title, e.g. "Tillsyn av vattenverksamhet, Ronneby kommun" -> "Ronneby".
KOMMUN_RUBRIK_RE = re.compile(
    r"([A-Za-zÅÄÖåäö][A-Za-zÅÄÖåäö\-]+?)s?\s+kommun", re.IGNORECASE
)


def kommun_from_rubrik(rubrik: str) -> str | None:
    """Pull a known kommun name out of a case title, or None.

    Only candidates that resolve to a coordinate in COORDS are accepted, so a
    stray word before "kommun" cannot produce a bogus location.
    """
    for m in KOMMUN_RUBRIK_RE.finditer(rubrik or ""):
        cand = m.group(1)
        if COORDS.get(normalise(cand)):
            return cand
    return None


# On the case detail page the kommun appears as a labelled table row:
#   <b>Kommun</b></td><td>Nynäshamn</td>
CASE_KOMMUN_RE = re.compile(
    r"<b>\s*Kommun\s*</b>\s*</td>\s*<td>([^<]*)</td>", re.IGNORECASE
)


def fetch_case_kommun(opener: urllib.request.OpenerDirector, case_id: str) -> str:
    """Fetch CaseInfo.aspx for one case and return its Kommun field ("" if none)."""
    try:
        with opener.open(CASE_INFO_URL + case_id, timeout=30) as resp:
            page = resp.read().decode("utf-8")
    except Exception:  # noqa: BLE001 - network hiccups shouldn't abort the run
        return ""
    m = CASE_KOMMUN_RE.search(page)
    if not m:
        return ""
    return html.unescape(m.group(1)).replace("\xa0", " ").strip()


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Treat 3xx responses as terminal so the caller can read Location."""

    def http_error_302(self, req, fp, code, msg, headers):
        raise urllib.error.HTTPError(req.full_url, code, msg, headers, fp)

    http_error_301 = http_error_303 = http_error_307 = http_error_302


def build_opener(follow_redirects: bool = True) -> urllib.request.OpenerDirector:
    cj = CookieJar()
    handlers = [urllib.request.HTTPCookieProcessor(cj)]
    if not follow_redirects:
        handlers.append(_NoRedirect())
    opener = urllib.request.build_opener(*handlers)
    opener.addheaders = [
        ("User-Agent", USER_AGENT),
        ("Accept", "text/html,application/xhtml+xml"),
        ("Accept-Language", "sv,en-US;q=0.8"),
    ]
    return opener


def form_search(
    county_id: str,
    status: str,
    title: str,
    date_from: str,
    date_to: str,
) -> str:
    """Submit the diarium search form for a single county and return the
    absolute search result URL (CaseSearchResult.aspx?query=...).
    """
    opener = build_opener(follow_redirects=False)
    with opener.open(SEARCH_FORM_URL, timeout=30) as resp:
        form_page = resp.read().decode("utf-8")
    state = extract_state(form_page)
    if not state:
        raise RuntimeError("Could not extract VIEWSTATE from form page")

    data = {
        "__EVENTTARGET": "ctl00$SearchPlaceHolder$CaseSearch$btnHiddenSearch",
        "__EVENTARGUMENT": "",
        "__LASTFOCUS": "",
        **state,
        "ctl00$SearchPlaceHolder$CaseSearch$ddDiaryID": county_id,
        "ctl00$SearchPlaceHolder$CaseSearch$txtHiddenDiaryID": county_id,
        "ctl00$SearchPlaceHolder$CaseSearch$diaryNO": "",
        "ctl00$SearchPlaceHolder$CaseSearch$title": title,
        "ctl00$SearchPlaceHolder$CaseSearch$ddlStatus": status,
        "ctl00$SearchPlaceHolder$CaseSearch$ddDatefrom": date_from,
        "ctl00$SearchPlaceHolder$CaseSearch$ddDateto": date_to,
        "ctl00$SearchPlaceHolder$CaseSearch$ddlOrgUnit": "0",
        "ctl00$SearchPlaceHolder$CaseSearch$txtHiddenOrgUnit": "0",
        "ctl00$SearchPlaceHolder$CaseSearch$ddMunicipality": "-1",
    }
    body = urllib.parse.urlencode(data, encoding="utf-8").encode("utf-8")
    req = urllib.request.Request(
        SEARCH_FORM_URL,
        data=body,
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Origin": "https://diarium.lansstyrelsen.se",
            "Referer": SEARCH_FORM_URL,
        },
    )
    try:
        opener.open(req, timeout=30)
    except urllib.error.HTTPError as e:
        if e.code not in (301, 302, 303, 307):
            raise
        loc = e.headers.get("Location", "")
        if not loc:
            raise RuntimeError(f"Search redirect missing Location header (code {e.code})")
        if loc.startswith("/"):
            return RESULT_URL_BASE + loc
        return loc
    raise RuntimeError("Expected a 302 redirect to CaseSearchResult.aspx, got 200")


STATE_FIELDS = ("__VIEWSTATE", "__VIEWSTATEGENERATOR", "__EVENTVALIDATION")


def extract_state(page: str) -> dict[str, str]:
    state: dict[str, str] = {}
    for name in STATE_FIELDS:
        m = re.search(rf'id="{name}"[^>]*value="([^"]*)"', page)
        if m:
            state[name] = html.unescape(m.group(1))
    return state


CELL_RE = re.compile(r"<td[^>]*>(.*?)</td>", re.DOTALL)
ROW_RE = re.compile(r"<tr[^>]*>(.*?)</tr>", re.DOTALL)
TAG_RE = re.compile(r"<[^>]+>")
CASEID_RE = re.compile(r"caseID=(\d+)", re.IGNORECASE)


def clean_cell(cell: str) -> str:
    text = TAG_RE.sub("", cell)
    text = html.unescape(text).replace("\xa0", " ")
    return text.strip()


def parse_rows(page: str) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for r in ROW_RE.findall(page):
        cells = CELL_RE.findall(r)
        if len(cells) != 8:
            continue
        cleaned = [clean_cell(c) for c in cells]
        diarienummer, status, indatum, rubrik, avsandare, postort, kommun, beslutsdatum = cleaned
        if not diarienummer or diarienummer.lower().startswith("diarie"):
            continue
        case_id_m = CASEID_RE.search(cells[0])
        out.append({
            "diarienummer": diarienummer,
            "status": status,
            "indatum": indatum,
            "rubrik": rubrik,
            "avsandare": avsandare,
            "postort": postort,
            "kommun": kommun,
            "beslutsdatum": beslutsdatum,
            "case_id": case_id_m.group(1) if case_id_m else "",
        })
    return out


def find_page_count(page: str) -> int:
    """Return highest visible Page$N value (best-effort estimate)."""
    pages = [int(n) for n in re.findall(r"Page\$(\d+)", page)]
    return max(pages) if pages else 1


def fetch_initial(opener: urllib.request.OpenerDirector, url: str) -> str:
    with opener.open(url, timeout=30) as resp:
        return resp.read().decode("utf-8")


def fetch_page(
    opener: urllib.request.OpenerDirector,
    url: str,
    state: dict[str, str],
    page_index: int,
) -> str:
    data = {
        "__EVENTTARGET": GRIDVIEW_TARGET,
        "__EVENTARGUMENT": f"Page${page_index}",
        **state,
    }
    body = urllib.parse.urlencode(data).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Origin": "https://diarium.lansstyrelsen.se",
            "Referer": url,
        },
    )
    with opener.open(req, timeout=30) as resp:
        return resp.read().decode("utf-8")


def jitter(lon: float, lat: float, seed_key: str) -> tuple[float, float]:
    """Deterministically jitter coords so points sharing an ort do not overlap."""
    rng = random.Random(seed_key)
    # ~ 300 m at lat 58 -> approx 0.005 deg lon, 0.003 deg lat
    return lon + rng.uniform(-0.005, 0.005), lat + rng.uniform(-0.003, 0.003)


def to_geojson(rows: list[dict[str, str]]) -> tuple[dict, dict[str, int]]:
    features: list[dict] = []
    stats = {"total": 0, "geocoded": 0, "missing": 0}
    missing_keys: set[str] = set()
    for row in rows:
        stats["total"] += 1
        coord = lookup_coord(row["postort"], row["kommun"])
        if coord is None:
            stats["missing"] += 1
            if row["postort"] or row["kommun"]:
                missing_keys.add(f"{row['postort']} / {row['kommun']}")
            continue
        lon, lat, source = coord
        lon, lat = jitter(lon, lat, row["diarienummer"])
        feature = {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {
                **row,
                "geocoded_from": source,
            },
        }
        features.append(feature)
        stats["geocoded"] += 1
    if missing_keys:
        print("Saknar koordinater for foljande Postort/Kommun-par:", file=sys.stderr)
        for k in sorted(missing_keys):
            print(f"  - {k}", file=sys.stderr)
    fc = {"type": "FeatureCollection", "features": features}
    return fc, stats


def scrape_county(county_id: str, county_label: str, args, opener) -> list[dict[str, str]]:
    """Run a search for one county and return all rows across pagination."""
    try:
        result_url = form_search(
            county_id=county_id,
            status=args.status,
            title=args.title,
            date_from=args.date_from,
            date_to=args.date_to,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"  [{county_label}] sokning misslyckades: {exc}", file=sys.stderr)
        return []

    try:
        page1 = fetch_initial(opener, result_url)
    except Exception as exc:  # noqa: BLE001
        print(f"  [{county_label}] hamtning misslyckades: {exc}", file=sys.stderr)
        return []

    state = extract_state(page1)
    rows = parse_rows(page1)

    visited_pages = {1}
    pages_to_visit = list(range(2, find_page_count(page1) + 1))
    while pages_to_visit:
        n = pages_to_visit.pop(0)
        if n in visited_pages or n > args.max_pages:
            continue
        visited_pages.add(n)
        try:
            page = fetch_page(opener, result_url, state, n)
        except Exception as exc:  # noqa: BLE001
            print(f"  [{county_label}] sida {n} misslyckades: {exc}", file=sys.stderr)
            continue
        state = extract_state(page) or state
        page_rows = parse_rows(page)
        rows.extend(page_rows)
        for cand in range(2, find_page_count(page) + 1):
            if cand not in visited_pages and cand not in pages_to_visit and cand <= args.max_pages:
                pages_to_visit.append(cand)

    print(f"  [{county_label}] {len(rows)} rader pa {len(visited_pages)} sidor")
    return rows


def enrich_missing(
    rows: list[dict[str, str]], opener: urllib.request.OpenerDirector
) -> dict[str, int]:
    """Fill in Kommun for rows the list columns can't geocode.

    For each row that lookup_coord can't place, try the rubrik first (cheap,
    no request) and then the case detail page. A recovered kommun is written
    back into row["kommun"] (so it geocodes and shows in the popup) and tagged
    with row["kommun_kalla"] to record where it came from.
    """
    stats = {"rubrik": 0, "detaljsida": 0}
    for row in rows:
        if lookup_coord(row["postort"], row["kommun"]) is not None:
            continue
        k = kommun_from_rubrik(row["rubrik"])
        if k:
            row["kommun"] = k
            row["kommun_kalla"] = "rubrik"
            stats["rubrik"] += 1
            continue
        cid = row.get("case_id")
        if cid:
            k = fetch_case_kommun(opener, cid)
            if k:
                row["kommun"] = k
                row["kommun_kalla"] = "detaljsida"
                stats["detaljsida"] += 1
    return stats


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--status", default="Handläggning", help="Arendets status")
    parser.add_argument("--title", default="vattenverksamhet", help="Arenderubrik (substring)")
    parser.add_argument("--date-from", default="2026-01-01", help="Inkommet fr.o.m. (YYYY-MM-DD)")
    parser.add_argument("--date-to", default="", help="Inkommet t.o.m. (YYYY-MM-DD), empty = no upper bound")
    parser.add_argument(
        "--counties",
        default="",
        help="Comma-separated diary IDs to search. Empty = all 21 lansstyrelser.",
    )
    parser.add_argument("--output", type=Path, default=OUTPUT_PATH, help="Output GeoJSON path")
    parser.add_argument("--max-pages", type=int, default=50, help="Safety cap on pages to fetch per county")
    args = parser.parse_args()

    if args.counties:
        wanted = {c.strip() for c in args.counties.split(",") if c.strip()}
        counties = [(cid, name) for cid, name in COUNTIES if cid in wanted]
    else:
        counties = COUNTIES

    print(
        f"Searching {len(counties)} lansstyrelser:"
        f" status='{args.status}' title='{args.title}' fr.o.m={args.date_from}"
        + (f" t.o.m={args.date_to}" if args.date_to else "")
    )

    opener = build_opener()
    all_rows: list[dict[str, str]] = []
    for cid, name in counties:
        county_rows = scrape_county(cid, name, args, opener)
        # Tag each row with the originating county for the popup
        for r in county_rows:
            r["lansstyrelse"] = f"Lansstyrelsen i {name}s lan"
        all_rows.extend(county_rows)

    # De-duplicate on (county, diarienummer). Diarienummer are only unique
    # within a single lansstyrelse, so the same number routinely appears in
    # several counties as unrelated cases - keying on the number alone would
    # wrongly drop them. Pagination can still repeat a row within a county,
    # which this also catches.
    seen: set[tuple[str, str]] = set()
    deduped: list[dict[str, str]] = []
    for r in all_rows:
        key = (r.get("lansstyrelse", ""), r["diarienummer"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(r)

    # For cases whose Postort/Kommun list columns are empty, derive the kommun
    # from the rubrik and, failing that, the case detail page.
    print("Kompletterar saknade platser fran rubrik/detaljsida ...")
    enriched = enrich_missing(deduped, opener)
    print(
        f"  {enriched['rubrik']} fran rubrik, "
        f"{enriched['detaljsida']} fran detaljsida"
    )

    fc, stats = to_geojson(deduped)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(fc, ensure_ascii=False, indent=1), encoding="utf-8")
    print(
        f"Klart. {stats['geocoded']} av {stats['total']} arenden geokodade -> {args.output}",
    )
    if stats["missing"]:
        print(f"  ({stats['missing']} arenden saknade koordinater)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
