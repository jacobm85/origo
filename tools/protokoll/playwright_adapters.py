"""Adapters for kommuner whose protokoll-data lives in a JavaScript-rendered
SPA. These use Playwright (headless Chromium) to render the page, then
extract structured records directly from the DOM - no PDF parsing needed.

Used by tools/scrape_protokoll.py for source.type values starting with
'playwright_'. Returns a list of dicts ready to be turned into GeoJSON
features (same fields as the PDF-pipeline output: kommun, namnd, date,
paragraph, title, fastighet, pdf_url, filename).

Run-time cost: ~5-10 seconds per meeting page. Browser is launched once
per kommun call and reused across meetings.
"""

from __future__ import annotations

import re
from typing import Any

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sync_playwright = None  # type: ignore


def _to_para_int(s: str) -> int | None:
    m = re.search(r"\d+", s or "")
    return int(m.group()) if m else None


def adapter_stockholm_sbn(source: dict, cfg: dict) -> list[dict]:
    """Stockholm stadsbyggnadsnämnden via Bygg- och plantjänsten.

    Each meeting page (.../sammantrade/<id>) lists ärenden as a series of
    <dl> blocks with dt/dd pairs: Paragraf, Diarienummer, Fastighet,
    Dagordningstext, Ärendegrupp, Tjänsteutlåtande. We pull each ärende
    as one record, link back to the per-ärende detail page for popup.
    """
    if sync_playwright is None:
        raise RuntimeError("playwright not installed. Run: pip install playwright && python -m playwright install chromium")

    landing = source["url"]
    namnd_label = source.get("label", "Stadsbyggnadsnämnden")
    rows: list[dict] = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(user_agent="Mozilla/5.0 (Windows) origo-protokoll-scraper/1.0")
        page = ctx.new_page()

        # 1. Get list of meetings from landing page
        page.goto(landing, wait_until="networkidle", timeout=60000)
        page.wait_for_timeout(1500)
        meetings: list[dict[str, str]] = page.evaluate(
            r"""() => {
              const seen = new Set(); const out = [];
              document.querySelectorAll('a[href*="sammantrade/"]').forEach(a => {
                const m = a.href.match(/sammantrade\/(\d+)/);
                if (!m || seen.has(m[1])) return;
                seen.add(m[1]);
                const row = a.closest('article, li, tr, div, dl') || a.parentElement;
                out.push({id: m[1], href: a.href, text: (row?.textContent||'').trim().slice(0,200)});
              });
              return out;
            }"""
        )
        print(f"  [stockholm] {len(meetings)} mötessidor funna")

        # 2. For each meeting, scrape its ärenden
        for mi, m in enumerate(meetings, 1):
            try:
                page.goto(m["href"], wait_until="networkidle", timeout=60000)
                page.wait_for_timeout(1200)
            except Exception as exc:  # noqa: BLE001
                print(f"    möte {m['id']}: kunde inte ladda ({exc})")
                continue
            data: dict[str, Any] = page.evaluate(
                r"""() => {
                  const items = []; let meta = {};
                  document.querySelectorAll('dl').forEach(dl => {
                    const fields = {};
                    const dts = dl.querySelectorAll('dt');
                    const dds = dl.querySelectorAll('dd');
                    for (let i = 0; i < dts.length; i++) {
                      fields[(dts[i].textContent||'').trim()] = (dds[i]?.textContent||'').trim();
                    }
                    if (fields['Datum']) meta = fields;
                    else if (fields['Paragraf'] || fields['Dagordningstext']) items.push(fields);
                  });
                  // also collect per-ärende detail page URL
                  document.querySelectorAll('a[href*="/arende/"]').forEach((a, i) => {
                    if (items[i]) items[i]['_detail_url'] = a.href;
                  });
                  return { meta, items };
                }"""
            )
            meta = data.get("meta") or {}
            items = data.get("items") or []
            mdate = meta.get("Datum", "")
            kept = 0
            for it in items:
                title = (it.get("Dagordningstext") or "").strip()
                if not title or len(title) > 300:
                    continue
                para = _to_para_int(it.get("Paragraf", ""))
                if para is None:
                    continue
                rows.append({
                    "kommun": cfg["title"],
                    "namnd": namnd_label,
                    "date": mdate,
                    "paragraph": para,
                    "title": title,
                    "fastighet": (it.get("Fastighet") or "").strip() or None,
                    "pdf_url": it.get("_detail_url") or m["href"],
                    "filename": f"stockholm-sbn-{mdate}-§{para}",
                })
                kept += 1
            print(f"    möte {mi}/{len(meetings)} ({mdate}): {kept}/{len(items)} ärenden")

        browser.close()

    return rows


PLAYWRIGHT_ADAPTERS = {
    "playwright_stockholm_sbn": adapter_stockholm_sbn,
}
