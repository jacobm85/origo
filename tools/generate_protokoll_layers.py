#!/usr/bin/env python3
"""Generate the Origo group + layer entries for kommun-protokoll from the
registry. Prints two JSON fragments that you paste into index.json:

  1. The nested groups block (parent group + 21 län sub-groups)
  2. The layers block (one entry per kommun)

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


def build_groups() -> list[dict]:
    """Parent group with one sub-group per län."""
    subgroups = []
    for lan_id, lan_name in registry.LAN.items():
        subgroups.append({
            "name": f"{PARENT_GROUP_NAME}-{lan_id}",
            "title": lan_name,
        })
    return [{
        "name": PARENT_GROUP_NAME,
        "title": PARENT_GROUP_TITLE,
        "groups": subgroups,
    }]


def build_layers() -> list[dict]:
    layers = []
    for slug, cfg in registry.KOMMUNER.items():
        configured = bool(cfg.get("source"))
        layers.append({
            "name": f"protokoll-{slug}",
            "title": cfg["title"] + ("" if configured else " (ej konfigurerad)"),
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
                {"name": "type", "title": "Typ"},
                {"name": "decision", "title": "Beslut"},
                {"name": "summary", "title": "Sammanfattning"},
                {"name": "fastighet", "title": "Fastighet"},
                {"name": "address", "title": "Adress"},
                {"name": "applicant", "title": "Sökande"},
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
