#!/usr/bin/env python3
"""Delad, beroendefri (endast standardbibliotek) verktygsmodul för att läsa
svenska polygon-shapefiler i SWEREF99 TM (EPSG:3006) och skriva WGS84-GeoJSON.

Används av tools/build_forsvarsmakten_riksintressen.py och
tools/build_slutforvaring_riksintresse.py. Innehåller:

  * sweref99_tm_to_wgs84(e, n)         – inverse transverse Mercator (GRS80)
  * read_dbf(bytes)                    – minimal dBASE-läsare (textfält)
  * read_shp_polygons(bytes)           – shapetyp 5/15 (Polygon[Z])
  * find_shapefile_in_zip(bytes)       – hittar .shp/.dbf, även i nästlad zip
  * build_polygon_geojson(...)         – hela kedjan zip → FeatureCollection

SWEREF99 TM-serien är identisk med den i scrape_trafikverket.py
(HMK / Lantmäteriet TR 2009:14).
"""
from __future__ import annotations

import io
import math
import struct
import zipfile
from typing import Callable, Optional


# --------------------------------------------------------------------------- #
# Projektion
# --------------------------------------------------------------------------- #
def sweref99_tm_to_wgs84(easting: float, northing: float) -> tuple[float, float]:
    a = 6378137.0
    f = 1.0 / 298.257222101
    k0 = 0.9996
    lambda0 = math.radians(15.0)
    FN = 0.0
    FE = 500000.0

    e2 = f * (2 - f)
    n = f / (2 - f)
    a_hat = (a / (1 + n)) * (1 + n*n/4 + n*n*n*n/64)

    d1 = n/2 - 2*n*n/3 + 37*n*n*n/96 - n*n*n*n/360
    d2 = n*n/48 + n*n*n/15 - 437*n*n*n*n/1440
    d3 = 17*n*n*n/480 - 37*n*n*n*n/840
    d4 = 4397*n*n*n*n/161280

    A = e2 + e2**2 + e2**3 + e2**4
    B = -(7*e2**2 + 17*e2**3 + 30*e2**4) / 6
    C = (224*e2**3 + 889*e2**4) / 120
    D = -(4279*e2**4) / 1260

    xi = (northing - FN) / (k0 * a_hat)
    eta = (easting - FE) / (k0 * a_hat)

    xi_p = (xi
            - d1 * math.sin(2*xi) * math.cosh(2*eta)
            - d2 * math.sin(4*xi) * math.cosh(4*eta)
            - d3 * math.sin(6*xi) * math.cosh(6*eta)
            - d4 * math.sin(8*xi) * math.cosh(8*eta))
    eta_p = (eta
             - d1 * math.cos(2*xi) * math.sinh(2*eta)
             - d2 * math.cos(4*xi) * math.sinh(4*eta)
             - d3 * math.cos(6*xi) * math.sinh(6*eta)
             - d4 * math.cos(8*xi) * math.sinh(8*eta))

    phi_star = math.asin(math.sin(xi_p) / math.cosh(eta_p))
    delta_lambda = math.atan(math.sinh(eta_p) / math.cos(xi_p))

    phi = (phi_star
           + math.sin(phi_star) * math.cos(phi_star)
           * (A + B * math.sin(phi_star)**2
              + C * math.sin(phi_star)**4
              + D * math.sin(phi_star)**6))
    lambda_ = lambda0 + delta_lambda
    return math.degrees(lambda_), math.degrees(phi)


# --------------------------------------------------------------------------- #
# dBASE / shapefile-läsare
# --------------------------------------------------------------------------- #
def read_dbf(buf: bytes) -> list[dict]:
    numrec = struct.unpack("<i", buf[4:8])[0]
    hdrsize = struct.unpack("<h", buf[8:10])[0]
    nfields = (hdrsize - 33) // 32
    fields = []
    for i in range(nfields):
        off = 32 + i * 32
        name = buf[off:off + 11].split(b"\x00")[0].decode("latin-1")
        flen = buf[off + 16]
        fields.append((name, flen))
    reclen = sum(fl for _, fl in fields) + 1  # +1 för raderingsflaggan
    rows = []
    for r in range(numrec):
        rec = buf[hdrsize + r * reclen: hdrsize + (r + 1) * reclen]
        if not rec or rec[:1] == b"*":  # raderad post
            continue
        o = 1
        row = {}
        for name, flen in fields:
            raw = rec[o:o + flen]
            o += flen
            try:
                val = raw.decode("utf-8").strip()
            except UnicodeDecodeError:
                val = raw.decode("cp1252", "replace").strip()
            row[name] = val
        rows.append(row)
    return rows


def read_shp_polygons(buf: bytes) -> list[list[list[tuple[float, float]]]]:
    """Lista av features; varje feature är en lista av ringar (lista av (x, y) i
    källans projektion). Hanterar shapetyp 5 (Polygon) och 15 (PolygonZ)."""
    out = []
    pos = 100  # filheader
    n = len(buf)
    while pos + 8 <= n:
        content_len = struct.unpack(">i", buf[pos + 4:pos + 8])[0] * 2
        rec = buf[pos + 8: pos + 8 + content_len]
        pos += 8 + content_len
        if len(rec) < 4:
            continue
        shptype = struct.unpack("<i", rec[0:4])[0]
        if shptype not in (5, 15):
            continue
        numparts = struct.unpack("<i", rec[36:40])[0]
        numpoints = struct.unpack("<i", rec[40:44])[0]
        po = 44
        parts = list(struct.unpack("<%di" % numparts, rec[po:po + 4 * numparts]))
        po += 4 * numparts
        coords = struct.unpack("<%dd" % (2 * numpoints), rec[po:po + 16 * numpoints])
        pts = [(coords[2 * i], coords[2 * i + 1]) for i in range(numpoints)]
        rings = []
        for i in range(numparts):
            start = parts[i]
            end = parts[i + 1] if i + 1 < numparts else numpoints
            rings.append(pts[start:end])
        out.append(rings)
    return out


def find_shapefile_in_zip(zip_bytes: bytes) -> tuple[bytes, bytes]:
    """Returnera (shp_bytes, dbf_bytes). Letar i arkivet och stiger ned i en
    eventuell nästlad zip (Försvarsmaktens arkiv har en zip-i-zip)."""
    z = zipfile.ZipFile(io.BytesIO(zip_bytes))
    base = next((n[:-4] for n in z.namelist() if n.lower().endswith(".shp")), None)
    if base:
        return z.read(base + ".shp"), z.read(base + ".dbf")
    for n in z.namelist():
        if n.lower().endswith(".zip") and not n.startswith("__MACOSX") and "shp" in n.lower():
            try:
                return find_shapefile_in_zip(z.read(n))
            except (RuntimeError, zipfile.BadZipFile):
                continue
    raise RuntimeError("hittade ingen .shp i arkivet")


# --------------------------------------------------------------------------- #
# Geometri: Douglas–Peucker (i källans meter) + ring-gruppering → MultiPolygon.
# --------------------------------------------------------------------------- #
def _perp_dist(p, a, b) -> float:
    (px, py), (ax, ay), (bx, by) = p, a, b
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def simplify(points, tol: float):
    if len(points) < 3:
        return points
    dmax, idx = 0.0, 0
    for i in range(1, len(points) - 1):
        d = _perp_dist(points[i], points[0], points[-1])
        if d > dmax:
            dmax, idx = d, i
    if dmax > tol:
        left = simplify(points[:idx + 1], tol)
        right = simplify(points[idx:], tol)
        return left[:-1] + right
    return [points[0], points[-1]]


def _signed_area(ring) -> float:
    s = 0.0
    for i in range(len(ring)):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % len(ring)]
        s += x1 * y2 - x2 * y1
    return s / 2.0


def rings_to_multipolygon(rings_xy, simplify_tol_m: float, decimals: int):
    """Gruppera ringar (SWEREF99 TM) till GeoJSON-polygonlista i WGS84.
    Shapefile-regel: medurs ring (negativ signerad area i bildkoordinater) =
    yttre, moturs = hål i föregående polygon."""
    polygons = []
    current = None
    for ring in rings_xy:
        if len(ring) < 4:
            continue
        ring = simplify(ring, simplify_tol_m)
        if len(ring) < 4:
            continue
        is_outer = _signed_area(ring) < 0
        wgs = []
        for x, y in ring:
            lon, lat = sweref99_tm_to_wgs84(x, y)
            wgs.append([round(lon, decimals), round(lat, decimals)])
        if wgs[0] != wgs[-1]:
            wgs.append(wgs[0])
        if is_outer or current is None:
            current = [wgs]
            polygons.append(current)
        else:
            current.append(wgs)
    return polygons


def build_polygon_geojson(
    zip_bytes: bytes,
    properties_fn: Callable[[dict], dict],
    simplify_tol_m: float = 25.0,
    decimals: int = 5,
) -> dict:
    """Hela kedjan: zip-bytes (SWEREF99 TM polygon-shapefil) → GeoJSON
    FeatureCollection (WGS84). `properties_fn` mappar en dbf-rad till
    feature-egenskaper."""
    shp_bytes, dbf_bytes = find_shapefile_in_zip(zip_bytes)
    geoms = read_shp_polygons(shp_bytes)
    attrs = read_dbf(dbf_bytes)
    features = []
    for rings, row in zip(geoms, attrs):
        polygons = rings_to_multipolygon(rings, simplify_tol_m, decimals)
        if not polygons:
            continue
        if len(polygons) == 1:
            geometry = {"type": "Polygon", "coordinates": polygons[0]}
        else:
            geometry = {"type": "MultiPolygon", "coordinates": polygons}
        features.append({
            "type": "Feature",
            "geometry": geometry,
            "properties": properties_fn(row),
        })
    return {"type": "FeatureCollection", "features": features}, len(geoms), len(attrs)
