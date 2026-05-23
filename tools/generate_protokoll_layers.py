#!/usr/bin/env python3
"""Generate the Origo group + layer entries for kommun-protokoll from the
registry. Prints two JSON fragments that you paste into index.json:

  1. The groups block (one flat group for all kommun-protokoll layers).
  2. The layers block (one entry per CONFIGURED kommun, all in that
     same flat group).

Nested län/kommun hierarchies are intentionally avoided - they hit a
combination of Origo legend quirks (nested `groups:` arrays not
flattened, sub-group DOM not present when layers are added) that left
nothing rendering. Keeping it flat matches the pattern every other
layer in index.json uses (`group: "root"` or a single grouplayer).

Run after editing tools/protokoll/registry.py.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from protokoll import registry  # noqa: E402


GROUP_NAME = "motesprotokoll"
GROUP_TITLE = "Mötesprotokoll – samhällsbyggnadsförvaltningar"


def build_groups() -> list[dict]:
    return [{
        "name": GROUP_NAME,
        "title": GROUP_TITLE,
        "expanded": False,
    }]


def build_layers() -> list[dict]:
    layers = []
    for slug, cfg in registry.KOMMUNER.items():
        if not cfg.get("source"):
            continue
        layers.append({
            "name": f"protokoll-{slug}",
            "title": f"{cfg['title']} ({registry.LAN.get(cfg['lan'], cfg['lan'])})",
            "group": GROUP_NAME,
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
