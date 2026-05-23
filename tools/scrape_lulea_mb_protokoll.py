#!/usr/bin/env python3
"""Scrape Lulea kommun's Miljo- och byggnadsnamnden protokoll into a GeoJSON.

The PDFs Lulea publishes are summary protocols - cover page + agenda
(innehallsforteckning) + a couple of selected paragraphs. The detailed
bygglov text is NOT in these PDFs; it lives in separate documents that
are not linked from the public protocol page.

The agenda is what we extract. Each agenda entry looks like:

    Paragrafer  Arenden                                                Sida
    section 42   Avdelningschefen informerar 2026-04-16                4
    section 43   Miljo- och byggnadsnamndens konsekvensbeskrivning...  5 - 8
    section 44   Samradsyttrande over detaljplan for Riga 1:16, Dalbo  9 - 11

Many titles carry a fastighet (e.g. "Riga 1:16") which is the most
valuable bit for prospecting work. We extract those by regex.

This v1 does NOT geocode. All features are emitted at Lulea kommun's
centroid with a small jitter so they cluster on the map. Use the
popup to read the fastighet and look it up manually, or wire up
Lantmateriets fastighetssokning API later.
"""

from __future__ import annotations

import argparse
import hashlib
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
    raise SystemExit(
        "pypdf not installed. Run: py -m pip install pypdf"
    ) from exc

# Lulea kommun centroid (approximate, WGS84). All features default here.
LULEA_LON = 22.1567
LULEA_LAT = 65.5836

REPO_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_PATH = REPO_ROOT / "data" / "lulea_mb_protokoll.geojson"
SITE_BASE = "https://www.lulea.se"

# Default: Miljo- och byggnadsnamndens 2026 folder.
# To add more years/namnds, append additional folder URLs to this list -
# they all have the same SiteVision layout.
DEFAULT_FOLDER_URLS = [
    (
        "Miljö- och byggnadsnämnden 2026",
        "https://www.lulea.se/kommun--politik/moten-handlingar-och-protokoll.html"
        "?folder=19.597b1ac319bc2615cfd43da"
        "&sv.url=12.2b7bdc7f183d5df682e1c3de",
    ),
]

USER_AGENT = "origo-lulea-scraper/1.0 (+https://github.com/jacobm85/origo)"

# Keywords that mark a paragraph as "physically located somewhere".
LOCATION_RELEVANT = re.compile(
    r"\b("
    r"bygglov|detaljplan|f[öo]rhandsbesked|samr[åa]dsyttrande|"
    r"tillsyn|marklov|rivningslov|nybyggnad|tillbyggnad|"
    r"ombyggnad|str[åa]ndskydd|avlopp|t[äa]kt|gruv"
    r")\b",
    re.IGNORECASE,
)

# Swedish fastighet pattern: "Word(s) N:M" e.g. "Riga 1:16" or
# "Skepparen 3" (kvarter + nummer). Captures the full beteckning.
FASTIGHET_PATTERN = re.compile(
    r"\b("
    r"[A-Z][A-Za-zåäöÅÄÖ]+(?:\s+[A-Za-zåäöÅÄÖ-]+)?"  # name (1-2 words)
    r"\s+"
    r"\d+(?::\d+)?"                                      # 1:16 or 3
    r")\b"
)


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=45) as resp:
        return resp.read()


def discover_pdfs(folder_url: str) -> list[tuple[str, str]]:
    """Find protocol PDF links in a year folder page.

    Returns a list of (filename, absolute_url).
    """
    html = fetch(folder_url).decode("utf-8", errors="replace")
    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    for m in re.finditer(r'href="(/download/[^"]+\.pdf)"', html, re.IGNORECASE):
        href = m.group(1)
        if href in seen:
            continue
        seen.add(href)
        # The filename is encoded in the URL.
        fname = urllib.parse.unquote(href.rsplit("/", 1)[-1])
        out.append((fname, SITE_BASE + href))
    return out


AGENDA_HEADER_RE = re.compile(r"INNEHÅLLSFÖRTECKNING", re.IGNORECASE)


def parse_agenda(pdf_bytes: bytes) -> list[dict]:
    """Return a list of {paragraph: int, title: str, page_range: str}."""
    reader = pypdf.PdfReader(io.BytesIO(pdf_bytes))
    # Look across the first few pages for the agenda
    full_text = ""
    for i, page in enumerate(reader.pages[:5]):
        full_text += (page.extract_text() or "") + "\n"
    if not AGENDA_HEADER_RE.search(full_text):
        return []
    # Pull out the agenda block
    agenda_text = full_text[full_text.find("INNEHÅLLSFÖRTECKNING") :]
    # Stop at "NÄRVAROLISTA" or similar section header
    end_match = re.search(r"\b(NÄRVAROLISTA|Övriga\b|TJÄNSTGÖRANDE)", agenda_text)
    if end_match:
        agenda_text = agenda_text[: end_match.start()]

    # The agenda is rendered as two columns: left column has "§ N" + page
    # numbers, right column has titles. pypdf usually emits the left column
    # first followed by the right column. So we find all paragraph numbers in
    # order then all titles in order and zip them.
    paragraph_matches = re.findall(r"§\s*(\d+)\s*(?:[\d\s\-]*)?", agenda_text)
    paragraph_numbers = [int(n) for n in paragraph_matches]

    # Find titles - lines that are not § markers and not very short.
    # Take the portion after the last "§ N ..." marker.
    last_para_pos = 0
    for m in re.finditer(r"§\s*\d+\s*(?:[\d\s\-]+)?", agenda_text):
        last_para_pos = m.end()
    titles_block = agenda_text[last_para_pos:]
    # Split into lines, drop empties and the final page-number-only line
    raw_titles = [ln.strip() for ln in titles_block.split("\n") if ln.strip()]
    # Drop lines that are pure numbers (page indicators)
    titles = [t for t in raw_titles if not re.fullmatch(r"[\d\s\-]+", t)]

    # Merge consecutive title fragments that got line-wrapped (a wrapped line
    # usually starts with lowercase, "(", a digit, or "för/och/m.fl./samt").
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


def extract_fastighet(title: str) -> str | None:
    """Pull the first plausible fastighetsbeteckning out of a title."""
    if not title:
        return None
    # Patterns to ignore (years, paragraph refs, common false positives)
    skip = re.compile(r"^\d{4}(?:-\d{1,2}){0,2}$")
    for m in FASTIGHET_PATTERN.finditer(title):
        candidate = m.group(1).strip()
        # Reject "2026-04-16" style hits
        if skip.match(candidate):
            continue
        # Reject single-word generic terms
        first = candidate.split()[0].lower()
        if first in ("nybyggnad", "tillbyggnad", "ombyggnad", "anläggning",
                     "antagande", "ändring", "bygglov", "detaljplan",
                     "förhandsbesked", "samrådsyttrande", "tidsbegränsat",
                     "redovisning", "tillsyn", "förbud", "föreläggande",
                     "revidering", "avdelningschefen"):
            continue
        return candidate
    return None


def jitter(seed_key: str, scale: float = 0.04) -> tuple[float, float]:
    """Stable per-key offset around Lulea centroid (~3 km radius)."""
    rng = random.Random(hashlib.md5(seed_key.encode()).hexdigest())
    return (
        LULEA_LON + rng.uniform(-scale, scale),
        LULEA_LAT + rng.uniform(-scale / 2.5, scale / 2.5),  # narrower N-S
    )


DATE_FROM_FILENAME = re.compile(r"(\d{4}-\d{2}-\d{2})")


def extract_meeting_date(filename: str) -> str:
    m = DATE_FROM_FILENAME.search(filename)
    return m.group(1) if m else ""


def to_geojson(rows: list[dict]) -> dict:
    features = []
    for r in rows:
        seed = f"{r['namnd']}|{r['date']}|{r['paragraph']}"
        lon, lat = jitter(seed)
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": r,
        })
    return {"type": "FeatureCollection", "features": features}


def process_folder(label: str, folder_url: str, only_location: bool = True) -> list[dict]:
    rows: list[dict] = []
    pdfs = discover_pdfs(folder_url)
    print(f"  {label}: {len(pdfs)} protokoll-PDF:er")
    for fname, pdf_url in pdfs:
        meeting_date = extract_meeting_date(fname)
        try:
            pdf_bytes = fetch(pdf_url)
        except Exception as exc:  # noqa: BLE001
            print(f"    [{fname}] hämtning misslyckades: {exc}", file=sys.stderr)
            continue
        try:
            agenda = parse_agenda(pdf_bytes)
        except Exception as exc:  # noqa: BLE001
            print(f"    [{fname}] PDF-parsning misslyckades: {exc}", file=sys.stderr)
            continue
        kept = 0
        for entry in agenda:
            title = entry["title"]
            if only_location and not LOCATION_RELEVANT.search(title):
                continue
            fastighet = extract_fastighet(title)
            rows.append({
                "namnd": label,
                "date": meeting_date,
                "paragraph": entry["paragraph"],
                "title": title,
                "fastighet": fastighet,
                "pdf_url": pdf_url,
                "filename": fname,
            })
            kept += 1
        print(f"    {meeting_date} ({fname[:60]}...): {kept}/{len(agenda)} relevanta")
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--folder",
        action="append",
        help="Add an additional folder URL to scrape (LABEL=URL)",
    )
    parser.add_argument("--output", type=Path, default=OUTPUT_PATH)
    parser.add_argument(
        "--all-paragraphs",
        action="store_true",
        help="Include ALL paragraphs, not only those that look location-relevant",
    )
    args = parser.parse_args()

    targets: list[tuple[str, str]] = list(DEFAULT_FOLDER_URLS)
    if args.folder:
        for f in args.folder:
            if "=" in f:
                label, url = f.split("=", 1)
            else:
                label, url = "Extra folder", f
            targets.append((label, url))

    all_rows: list[dict] = []
    for label, url in targets:
        all_rows.extend(process_folder(label, url, only_location=not args.all_paragraphs))

    fc = to_geojson(all_rows)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(fc, ensure_ascii=False, indent=1), encoding="utf-8")
    fastighet_count = sum(1 for r in all_rows if r["fastighet"])
    print(
        f"Klart. {len(all_rows)} relevanta ärenden ({fastighet_count} med fastighet)"
        f" -> {args.output}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
