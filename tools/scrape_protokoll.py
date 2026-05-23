#!/usr/bin/env python3
"""Scrape committee protocols (samhallsbyggnadsnamnd / miljo-bygg) for
Swedish kommuner. Generates one GeoJSON per kommun in data/protokoll/.

Configuration lives in tools/protokoll/registry.py - add a new kommun
there to include it in the next run. Kommuner without a "source" entry
generate an empty GeoJSON so the Origo legend still shows them as a
placeholder.

Limitations (same as the v1 Lulea-only scraper):
  - Lulea-style "samlingsprotokoll" PDFs only carry the agenda
    (innehallsforteckning) and selected paragraphs publicly, not the
    full bygglov reasoning. We extract the agenda titles.
  - Most bygglov titles are GDPR-anonymised. Detaljplaner /
    samradsyttranden retain fastigheter, which we pull out by regex.
  - No real geocoding. Every feature is placed at the kommun centroid
    (registry.py) with a stable per-record jitter.
"""

from __future__ import annotations

import argparse
import hashlib
import html as html_lib
import io
import json
import random
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

try:
    import pypdf
except ImportError as exc:
    raise SystemExit("pypdf not installed. Run: py -m pip install pypdf") from exc

# Allow `tools.protokoll.registry` resolution when invoked from repo root.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from protokoll import registry  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_DIR = REPO_ROOT / "data" / "protokoll"
USER_AGENT = "origo-protokoll-scraper/1.0 (+https://github.com/jacobm85/origo)"

# ---------------------------------------------------------------------------
# PDF + agenda parsing (lifted from the original Lulea scraper)
# ---------------------------------------------------------------------------

LOCATION_RELEVANT = re.compile(
    r"\b("
    r"bygglov|detaljplan|f[öo]rhandsbesked|samr[åa]dsyttrande|"
    r"tillsyn|marklov|rivningslov|nybyggnad|tillbyggnad|"
    r"ombyggnad|str[åa]ndskydd|avlopp|t[äa]kt|gruv|planbesked"
    r")\b",
    re.IGNORECASE,
)

FASTIGHET_PATTERN = re.compile(
    r"\b("
    r"[A-Z][A-Za-zåäöÅÄÖ]+(?:\s+[A-Za-zåäöÅÄÖ-]+)?"  # 1-2 words
    r"\s+"
    r"\d+(?::\d+)?"                                      # 1:16 or 3
    r")\b"
)

GENERIC_FIRST_WORDS = {
    "nybyggnad", "tillbyggnad", "ombyggnad", "anläggning",
    "antagande", "ändring", "bygglov", "detaljplan",
    "förhandsbesked", "samrådsyttrande", "tidsbegränsat",
    "redovisning", "tillsyn", "förbud", "föreläggande",
    "revidering", "avdelningschefen", "delårsuppföljning",
    "samråd", "yttrande", "verksamhets", "ärende",
}

DATE_FROM_FILENAME = re.compile(r"(\d{4}-\d{2}-\d{2})")
AGENDA_HEADERS = ("innehållsförteckning", "ärendelista", "föredragningslista", "dagordning")
AGENDA_END_MARKERS = re.compile(
    r"\b(NÄRVAROLISTA|Övriga\b|TJÄNSTGÖRANDE|Justerandes\s+signatur|§\s*1\b)",
    re.IGNORECASE,
)


def http_get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=45) as resp:
        return resp.read()


def _find_agenda_block(full_text: str) -> str | None:
    """Locate the agenda/innehallsforteckning block within the PDF text.
    Case-insensitive so we match e.g. 'Innehållsförteckning' (Piteå) as
    well as 'INNEHÅLLSFÖRTECKNING' (Luleå)."""
    lower = full_text.lower()
    for header in AGENDA_HEADERS:
        i = lower.find(header)
        if i >= 0:
            block = full_text[i + len(header):]
            # Cut at the start of body content (e.g. first "§ 1" + title-text)
            end = AGENDA_END_MARKERS.search(block, pos=80)
            return block[: end.start()] if end else block
    return None


def _parse_gallivare_style(block: str) -> list[dict]:
    """One-column agenda: '§ N\\nTitle wrapping multiple lines... <page>'."""
    # Each entry: "§ N" then everything until next "§ N+1" or end
    entries = re.split(r"(?=§\s*\d+\s)", block)
    out: list[dict] = []
    for entry in entries:
        m = re.match(r"§\s*(\d+)\s*\n?(.*)", entry, re.DOTALL)
        if not m:
            continue
        num = int(m.group(1))
        title_raw = m.group(2)
        # Strip optional dotted page leaders + trailing page number.
        # Pite-style ("§ 45 Title ... 4") has no dots, just a trailing
        # digit cluster; Gällivare-style ("§ 1 Title .... 3") has dots.
        title = re.sub(r"\s*(?:\.{3,}\s*\.?)?\s*\d+\s*$", "", title_raw, flags=re.DOTALL)
        title = re.sub(r"\.{3,}", " ", title)
        title = " ".join(title.split())  # collapse whitespace
        title = title.strip(" .")
        if title:
            out.append({"paragraph": num, "title": title})
    return out


def _parse_kiruna_style(full_text: str) -> list[dict]:
    """Kiruna-style table: 'Ärenden Bil nr Dnr § nr' header, then rows
    of 'N. TITLE (multi-line)  <DNR> § N'. DNR examples: G-2024-4,
    M-2023-1078, B-2023-582. pypdf often eats the Ä, so the header
    regex is forgiving.
    """
    head = re.search(r"(?:[ÄA]renden|renden)\s+Bil\s*nr\s+Dnr\s+§\s*nr", full_text)
    body = full_text[head.end():] if head else full_text
    # Limit scan to ~6000 chars after the header so we do not pick up
    # § references in the meeting-body text further down.
    body = body[:6000]
    item_re = re.compile(
        r"(?ms)^\s*(\d+)\.\s+(.+?)\s+(?:[A-Z]{1,2}-\d{4}-\d+\s+)?§\s*(\d+)\b"
    )
    out: list[dict] = []
    seen_paras: set[int] = set()
    for m in item_re.finditer(body):
        para = int(m.group(3))
        if para in seen_paras:
            continue
        title = " ".join(m.group(2).split()).rstrip(" .,")
        if title:
            out.append({"paragraph": para, "title": title})
            seen_paras.add(para)
    return out


def _parse_lulea_style(block: str) -> list[dict]:
    """Two-column agenda: all '§ N' first, then all titles, in order."""
    paragraph_numbers = [int(n) for n in re.findall(r"§\s*(\d+)\s*(?:[\d\s\-]*)?", block)]
    last_para_pos = 0
    for m in re.finditer(r"§\s*\d+\s*(?:[\d\s\-]+)?", block):
        last_para_pos = m.end()
    titles_block = block[last_para_pos:]
    raw_titles = [ln.strip() for ln in titles_block.split("\n") if ln.strip()]
    titles = [t for t in raw_titles if not re.fullmatch(r"[\d\s\-]+", t)]
    merged: list[str] = []
    for t in titles:
        first = t.lstrip()[:1]
        starts_lower = first.islower() or t.lstrip().startswith(("(", ")", "."))
        if merged and starts_lower:
            merged[-1] = merged[-1].rstrip() + " " + t.lstrip()
        else:
            merged.append(t)
    titles = merged
    n = min(len(paragraph_numbers), len(titles))
    return [
        {"paragraph": paragraph_numbers[i], "title": titles[i].strip()}
        for i in range(n)
    ]


def parse_agenda(pdf_bytes: bytes) -> list[dict]:
    reader = pypdf.PdfReader(io.BytesIO(pdf_bytes))
    full_text = ""
    # Scan more pages - some kommuner put agenda on p2 or p3.
    for page in reader.pages[:10]:
        full_text += (page.extract_text() or "") + "\n"
    # Kiruna's "Ärenden Bil nr Dnr § nr" table is not captured by
    # _find_agenda_block (different header), so try it on the raw text.
    kiruna = _parse_kiruna_style(full_text)
    block = _find_agenda_block(full_text)
    one_col: list[dict] = []
    two_col: list[dict] = []
    if block is not None:
        one_col = _parse_gallivare_style(block)
        two_col = _parse_lulea_style(block)
    # Keep whichever layout produced the most entries.
    best = max((kiruna, one_col, two_col), key=len)
    return best


def extract_fastighet(title: str) -> str | None:
    if not title:
        return None
    for m in FASTIGHET_PATTERN.finditer(title):
        candidate = m.group(1).strip()
        if re.match(r"^\d{4}(?:-\d{1,2}){0,2}$", candidate):
            continue
        first = candidate.split()[0].lower()
        if first in GENERIC_FIRST_WORDS:
            continue
        return candidate
    return None


def jitter(centroid: tuple[float, float], seed_key: str, scale: float = 0.04) -> tuple[float, float]:
    rng = random.Random(hashlib.md5(seed_key.encode()).hexdigest())
    return (
        centroid[0] + rng.uniform(-scale, scale),
        centroid[1] + rng.uniform(-scale / 2.5, scale / 2.5),
    )


def extract_meeting_date(filename: str) -> str:
    m = DATE_FROM_FILENAME.search(filename)
    return m.group(1) if m else ""


# ---------------------------------------------------------------------------
# Source adapters
# ---------------------------------------------------------------------------


def _find_pdf_hrefs(html: str) -> list[str]:
    """Pick out every href ending in .pdf, with HTML entities decoded.
    Returns the raw href strings (still URL-encoded, will be joined to
    the site_base later)."""
    raw = re.findall(r'href="([^"]+\.pdf)"', html, re.IGNORECASE)
    return [html_lib.unescape(h) for h in raw]


def _href_to_url(href: str, site_base: str) -> str:
    """Make a fully-qualified URL from a (possibly relative) href.
    Quote any non-ASCII bytes so urllib accepts the URL."""
    if href.startswith("http"):
        full = href
    else:
        full = site_base + href
    return urllib.parse.quote(full, safe=":/?#[]@!$&'()*+,;=%")


def adapter_sitevision_folder(source: dict, site_base: str) -> list[tuple[str, str]]:
    """Lulea-style: a folder URL listing all PDFs we want."""
    html = http_get(source["url"]).decode("utf-8", errors="replace")
    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    for href in _find_pdf_hrefs(html):
        if href in seen:
            continue
        seen.add(href)
        fname = urllib.parse.unquote(href.rsplit("/", 1)[-1])
        out.append((fname, _href_to_url(href, site_base)))
    return out


def adapter_sitevision_listing(source: dict, site_base: str) -> list[tuple[str, str]]:
    """Single page mixing many namnder's PDFs - filter by filename regex."""
    html = http_get(source["url"]).decode("utf-8", errors="replace")
    pattern = re.compile(source["filename_pattern"])
    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    for href in _find_pdf_hrefs(html):
        if href in seen:
            continue
        seen.add(href)
        fname = urllib.parse.unquote(href.rsplit("/", 1)[-1])
        if pattern.search(fname):
            out.append((fname, _href_to_url(href, site_base)))
    return out


ADAPTERS = {
    "sitevision_folder": adapter_sitevision_folder,
    "sitevision_listing": adapter_sitevision_listing,
}


def site_base_from_url(url: str) -> str:
    p = urllib.parse.urlparse(url)
    return f"{p.scheme}://{p.netloc}"


# ---------------------------------------------------------------------------
# Per-kommun pipeline
# ---------------------------------------------------------------------------


def scrape_kommun(slug: str, cfg: dict) -> list[dict]:
    src = cfg.get("source")
    if not src:
        return []
    adapter = ADAPTERS.get(src["type"])
    if not adapter:
        print(f"  [{slug}] okänd source.type {src['type']!r}", file=sys.stderr)
        return []
    try:
        pdfs = adapter(src, site_base_from_url(src["url"]))
    except Exception as exc:  # noqa: BLE001
        print(f"  [{slug}] kunde inte lista PDF:er: {exc}", file=sys.stderr)
        return []
    print(f"  [{slug}] {len(pdfs)} PDF:er hittade")
    rows: list[dict] = []
    for fname, url in pdfs:
        try:
            pdf_bytes = http_get(url)
        except Exception as exc:  # noqa: BLE001
            print(f"    [{fname}] hämtning misslyckades: {exc}", file=sys.stderr)
            continue
        meeting_date = extract_meeting_date(fname)
        try:
            agenda = parse_agenda(pdf_bytes)
        except Exception as exc:  # noqa: BLE001
            print(f"    [{fname}] PDF-parsning misslyckades: {exc}", file=sys.stderr)
            continue
        kept = 0
        for entry in agenda:
            title = entry["title"]
            if not LOCATION_RELEVANT.search(title):
                continue
            rows.append({
                "kommun": cfg["title"],
                "namnd": src.get("label", "Samhällsbyggnadsförvaltningen"),
                "date": meeting_date,
                "paragraph": entry["paragraph"],
                "title": title,
                "fastighet": extract_fastighet(title),
                "pdf_url": url,
                "filename": fname,
            })
            kept += 1
        print(f"    {meeting_date or fname[:40]}: {kept}/{len(agenda)} relevanta")
    return rows


def rows_to_geojson(slug: str, cfg: dict, rows: list[dict]) -> dict:
    features = []
    for r in rows:
        seed = f"{slug}|{r['date']}|{r['paragraph']}"
        lon, lat = jitter(cfg["centroid"], seed)
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": r,
        })
    return {"type": "FeatureCollection", "features": features}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--only",
        help="Comma-separated list of kommun slugs to scrape (default: all configured)",
    )
    parser.add_argument(
        "--lan",
        help="Only scrape kommuner in this län-id (e.g. 'norrbotten')",
    )
    args = parser.parse_args()

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    targets: list[tuple[str, dict]] = []
    only = set(s.strip() for s in args.only.split(",")) if args.only else None
    for slug, cfg in registry.KOMMUNER.items():
        if only is not None and slug not in only:
            continue
        if args.lan and cfg.get("lan") != args.lan:
            continue
        targets.append((slug, cfg))

    total_features = 0
    configured = 0
    for slug, cfg in targets:
        print(f"\n== {cfg['title']} ({slug}) ==")
        rows = scrape_kommun(slug, cfg)
        fc = rows_to_geojson(slug, cfg, rows)
        (OUTPUT_DIR / f"{slug}.geojson").write_text(
            json.dumps(fc, ensure_ascii=False, indent=1), encoding="utf-8"
        )
        if cfg.get("source"):
            configured += 1
        total_features += len(rows)

    print(
        f"\nKlart. {total_features} ärenden från {configured}/{len(targets)} konfigurerade kommuner."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
