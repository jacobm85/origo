#!/usr/bin/env python3
"""Generate the Origo group + layer entries for kommun-protokoll from the
registry. Prints two JSON fragments that you paste into index.json:

  1. The groups block (parent group + one sub-group per län with data,
     using Origo's `parent:` convention - NESTED `groups:` arrays are
     not flattened by viewer.js).
  2. The layers block (one entry per CONFIGURED kommun).

Only kommuner with a `source` block in registry.py are emitted, and
only län with at least one such kommun get a sub-group. Placeholders
for un-configured kommuner are skipped to keep the legend clean.

Run after editing tools/protokoll/registry.py.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from protokoll import registry  # noqa: E402


PARENT_GROUP_NAME = "motesprotokoll"
PARENT_GROUP_TITLE = "Mötesprotokoll – samhällsbyggnadsförvaltningar"


def _configured_lans() -> list[str]:
    """Return län-ids that have at least one kommun with a `source` block."""
    seen: set[str] = set()
    for cfg in registry.KOMMUNER.values():
        if cfg.get("source"):
            seen.add(cfg["lan"])
    # Preserve LAN dict order
    return [lid for lid in registry.LAN if lid in seen]


def build_groups() -> list[dict]:
    """Parent + sub-groups, flat list with parent: pointers.

    Origo's viewer.js stores group configs as-is (it does NOT recurse into
    `groups:` arrays). Sub-groups must be siblings of the parent with a
    `parent:` field; the legend's Overlays component re-attaches them.
    """
    out: list[dict] = [{
        "name": PARENT_GROUP_NAME,
        "title": PARENT_GROUP_TITLE,
        "type": "grouplayer",
        "expanded": False,
    }]
    for lan_id in _configured_lans():
        out.append({
            "name": f"{PARENT_GROUP_NAME}-{lan_id}",
            "title": registry.LAN[lan_id],
            "type": "grouplayer",
            "parent": PARENT_GROUP_NAME,
            "expanded": False,
        })
    return out


def build_layers() -> list[dict]:
    layers = []
    for slug, cfg in registry.KOMMUNER.items():
        if not cfg.get("source"):
            continue
        layers.append({
            "name": f"protokoll-{slug}",
            "title": cfg["title"],
            "group": f"{PARENT_GROUP_NAME}-{cfg['lan']}",
            "type": "GEOJSON",
            "source": f"data/protokoll/{slug}.geojson",
            "style": "protokoll-point",
            "clusterStyle": "protokoll-cluster",
            "layerType": "cluster",
            "queryable": True,
            "visible": False,
            "legend": True,
            "attribution": f"{cfg['title']} kommun",
            "attributes": [
                {"name": "kommun", "title": "Kommun"},
                {"name": "namnd", "title": "Nämnd"},
                {"name": "date", "title": "Mötesdatum"},
                {"name": "paragraph", "title": "§"},
                {"name": "title", "title": "Ärende"},
                {"name": "fastighet", "title": "Fastighet"},
                {
                    "name": "pdf_url",
                    "title": "Protokoll-PDF",
                    "url": "pdf_url",
                    "target": "_blank",
                },
            ],
        })
    return layers


def main() -> int:
    print("/* --- groups - paste inside the existing index.json \"groups\" array --- */")
    print(json.dumps(build_groups(), ensure_ascii=False, indent=2))
    print()
    print("/* --- layers - paste inside the existing index.json \"layers\" array --- */")
    print(json.dumps(build_layers(), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
