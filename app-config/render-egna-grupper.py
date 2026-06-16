#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Genererar de "egna" (redigerbara) lagergrupperna i index.json från env-
variabeln EGNA_GRUPPER vid containerstart. Körs av
/docker-entrypoint.d/40-render-egna-grupper.sh.

EGNA_GRUPPER = lista med gruppnamn separerade med ; eller ,
  t.ex.  EGNA_GRUPPER="Projekt;Utredning;Fält"

Varje grupp får tre redigerbara WFS-T-lager (Ytor/Linjer/Punkter) som var och
en backas av en egen tabell/feature type i GeoServer (workspace "eget"):
  - Grupp 1 använder de befintliga tabellerna  eget_yta / eget_linje / eget_punkt
    (så att redan ritad data bevaras).
  - Grupp 2..N använder  eget_g2_*  /  eget_g3_*  osv.

Tabell-, feature type- och lagernamn beräknas på exakt samma sätt i
db/provision-egna-grupper.sh och geoserver/provision.sh.

Är EGNA_GRUPPER tom görs ingenting – då behålls den inbyggda "Eget lager"-
gruppen som ligger i index.json (oförändrat beteende).

Idempotent: alla grupper/lager vars namn börjar på "eget" tas bort och byggs om,
så skriptet kan köras om utan att dubblera något.
"""
import json
import os
import re
import sys

SEP = re.compile(r"[;,]")
GEOMS = [
    ("yta", "Ytor", "Polygon"),
    ("linje", "Linjer", "LineString"),
    ("punkt", "Punkter", "Point"),
]


def prefix_for(index):
    """Grupp 1 → 'eget' (bevarar befintliga tabeller), därefter 'eget_g2', ..."""
    return "eget" if index == 0 else f"eget_g{index + 1}"


def main():
    raw = os.environ.get("EGNA_GRUPPER", "").strip()
    path = os.environ.get("INDEX_JSON", "/usr/share/nginx/html/index.json")

    if not raw:
        print("[egna-grupper] EGNA_GRUPPER tom – behåller inbyggd konfiguration")
        return 0

    names = [n.strip() for n in SEP.split(raw) if n.strip()]
    if not names:
        return 0

    # Flera grupper nästlas under EN överordnad "Eget lager"-grupp (hopfälld som
    # standard) så att de inte tar plats var för sig i lagerlistan. En ensam
    # grupp visas platt (ingen onödig nästling). Origo nästlar grupper via en
    # "parent"-egenskap på undergruppen.
    single = len(names) == 1
    groups, layers = [], []
    if not single:
        groups.append({"name": "eget", "title": "Eget lager", "expanded": False})

    for i, title in enumerate(names):
        # Gruppens namn i lagerlistan ("eget" för ensam grupp, annars eget_g{i}).
        gname = "eget" if single else f"eget_g{i + 1}"
        # Tabell-/feature type-prefix (oberoende av gruppnamnet): grupp 1
        # återanvänder de befintliga eget_*-tabellerna, övriga får eget_g{i}_*.
        tp = prefix_for(i)

        grp = {"name": gname, "title": title, "expanded": False}
        if not single:
            grp["parent"] = "eget"
        groups.append(grp)

        for sfx, ltitle, gtype in GEOMS:
            layers.append({
                "name": f"{gname}-{sfx}",
                "title": ltitle,
                "group": gname,
                "type": "WFS",
                "source": "eget-geoserver",
                "id": f"{tp}_{sfx}",
                "geometryName": "geom",
                "geometryType": gtype,
                "editable": True,
                "queryable": True,
                "visible": False,
                "legend": True,
                "style": "eget-lager-style",
                "attribution": f"{title} (delat)",
                "attributes": [
                    {"name": "rubrik", "title": "Rubrik", "type": "text", "maxLength": 100},
                    {"name": "beskrivning", "title": "Beskrivning", "type": "textarea", "maxLength": 1000},
                ],
            })

    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)

    # Ta bort tidigare egna grupper/lager (allt vars namn/grupp börjar på "eget")
    cfg["groups"] = groups + [g for g in cfg.get("groups", [])
                              if not str(g.get("name", "")).startswith("eget")]
    cfg["layers"] = [ly for ly in cfg.get("layers", [])
                     if not str(ly.get("group", "")).startswith("eget")] + layers

    with open(path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)

    if single:
        print(f"[egna-grupper] skrev 1 grupp: eget='{names[0]}'")
    else:
        print(f"[egna-grupper] skrev huvudgrupp 'Eget lager' med {len(names)} "
              "undergrupper: "
              + ", ".join(f"eget_g{i + 1}='{n}'" for i, n in enumerate(names)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
