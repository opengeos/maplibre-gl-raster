#!/usr/bin/env python3
"""Generate a STAC ``FeatureCollection`` from a list of Cloud-Optimized GeoTIFFs.

Each COG becomes one feature whose ``bbox`` is the raster's extent reprojected
to WGS84, with a single COG asset. By default the output is the minimal shape
the maplibre-gl-raster deck.gl mosaic engine renders, matching the
[deck.gl-raster NAIP example](https://developmentseed.org/deck.gl-raster/examples/naip-mosaic/):

    { "type": "FeatureCollection",
      "features": [ { "bbox": [...], "assets": { "image": { "href": ... } } } ] }

Pass ``--full`` to emit complete STAC Items (geometry, properties, and the
projection/eo extensions) instead.

Inputs may be mixed: local files, directories (scanned for ``.tif``/``.tiff``),
shell globs, or remote ``http(s)://`` / ``s3://`` URLs. Remote COGs are read
with HTTP range requests (GDAL ``/vsicurl/`` and ``/vsis3/``), so nothing is
downloaded in full.

Examples
--------
    # A directory of local COGs, hosted under a public base URL:
    python make_stac.py ./tiles -o tiles.json \
        --href-base https://data.example.com/tiles

    # Explicit remote COGs:
    python make_stac.py \
        https://data.source.coop/giswqs/opengeos/tiles/naip_water_train_r0c0.tif \
        https://data.source.coop/giswqs/opengeos/tiles/naip_water_train_r0c1.tif \
        -o naip.json

    # A whole S3 prefix (requires the AWS_* env for private buckets):
    python make_stac.py "s3://my-bucket/cogs/*.tif" -o cogs.json

Requires ``rasterio`` (``pip install rasterio``).
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys
from collections import OrderedDict
from typing import Iterable


def _require_rasterio():
    """Imports rasterio lazily so ``--help`` works without it installed."""
    try:
        import rasterio
        from rasterio.warp import transform_bounds

        return rasterio, transform_bounds
    except ImportError:  # pragma: no cover - dependency hint
        sys.exit("This script needs rasterio. Install it with:\n    pip install rasterio")


COG_MEDIA_TYPE = "image/tiff; application=geotiff; profile=cloud-optimized"
WGS84 = "EPSG:4326"
RASTER_EXTS = (".tif", ".tiff")
STAC_EXTENSIONS = [
    "https://stac-extensions.github.io/projection/v1.1.0/schema.json",
]


def is_url(path: str) -> bool:
    """True for a remote path GDAL reads over the network."""
    return path.startswith(("http://", "https://", "s3://", "/vsi"))


def gdal_path(path: str) -> str:
    """Map a user path to what GDAL/rasterio opens (``/vsicurl/``, ``/vsis3/``)."""
    if path.startswith(("http://", "https://")):
        return f"/vsicurl/{path}"
    if path.startswith("s3://"):
        return f"/vsis3/{path[len('s3://'):]}"
    return path


def expand_inputs(inputs: Iterable[str]) -> list[str]:
    """Expand directories and globs into a flat, sorted list of COG paths.

    Remote URLs are passed through as-is unless they contain a glob character,
    in which case an S3 glob is expanded via GDAL's VSI listing.
    """
    out: list[str] = []
    for item in inputs:
        if is_url(item):
            if any(c in item for c in "*?[") and item.startswith("s3://"):
                out.extend(_expand_s3_glob(item))
            else:
                out.append(item)
            continue
        if os.path.isdir(item):
            for root, _dirs, files in os.walk(item):
                for name in sorted(files):
                    if name.lower().endswith(RASTER_EXTS):
                        out.append(os.path.join(root, name))
            continue
        matches = glob.glob(item)
        if matches:
            out.extend(sorted(matches))
        elif os.path.exists(item):
            out.append(item)
        else:
            print(f"warning: no match for input '{item}'", file=sys.stderr)
    # De-dupe while preserving order.
    seen: set[str] = set()
    unique = [p for p in out if not (p in seen or seen.add(p))]
    return unique


def _expand_s3_glob(pattern: str) -> list[str]:
    """Expand an ``s3://bucket/prefix/*.tif`` pattern via GDAL VSI listing.

    Needs GDAL's Python bindings (``osgeo.gdal``). Without them, pass explicit
    URLs instead of a glob.
    """
    from fnmatch import fnmatch

    key = pattern[len("s3://"):]
    bucket, _, key_prefix = key.partition("/")
    dir_key = os.path.dirname(key_prefix)
    want = os.path.basename(pattern)
    try:
        from osgeo import gdal

        names = gdal.ReadDir(f"/vsis3/{bucket}/{dir_key}".rstrip("/")) or []
    except Exception:
        print(
            f"warning: cannot list '{pattern}' (needs osgeo.gdal); "
            "pass explicit URLs instead",
            file=sys.stderr,
        )
        return []
    base = f"s3://{bucket}/{dir_key}".rstrip("/")
    return sorted(f"{base}/{name}" for name in names if fnmatch(name, want))


def item_id(path: str, prefix: str) -> str:
    """A STAC Item id from the COG's file name (no extension)."""
    name = os.path.splitext(os.path.basename(path.rstrip("/")))[0]
    return f"{prefix}{name}" if prefix else name


def asset_href(path: str, href_base: str | None) -> str:
    """The URL to record for a COG's asset.

    Remote inputs keep their URL. Local inputs use ``--href-base`` joined with
    the file name (so the STAC points at where the COG will be hosted); without
    a base, the absolute local path is used (only resolvable on this machine).
    """
    if is_url(path):
        return path
    if href_base:
        return f"{href_base.rstrip('/')}/{os.path.basename(path)}"
    return os.path.abspath(path)


def eo_bands(colorinterp: tuple[str, ...]) -> list[dict]:
    """An ``eo:bands`` list derived from each band's color interpretation."""
    bands = []
    for i, ci in enumerate(colorinterp, start=1):
        name = ci if ci and ci != "undefined" else f"band{i}"
        band: OrderedDict = OrderedDict([("name", name)])
        if ci in ("red", "green", "blue"):
            band["common_name"] = ci
        bands.append(band)
    return bands


def build_feature(
    path: str,
    args: argparse.Namespace,
) -> OrderedDict | None:
    """Open one COG and build its STAC feature, or None if it cannot be read.

    By default this emits the minimal shape the deck.gl mosaic engine reads (and
    that the deck.gl-raster NAIP example ships): ``{ "bbox", "assets" }`` with a
    single COG asset. ``--full`` adds the fields of a complete STAC Item
    (geometry, properties, and the projection/eo extensions).
    """
    rasterio, transform_bounds = _require_rasterio()
    src_path = gdal_path(path)
    try:
        with rasterio.open(src_path) as src:
            west, south, east, north = transform_bounds(
                src.crs, WGS84, *src.bounds, densify_pts=21
            )
            epsg = src.crs.to_epsg() if (args.full and src.crs) else None
            gsd = (
                round(abs(src.res[0]), 6)
                if (args.full and src.crs and src.crs.is_projected)
                else None
            )
            colorinterp = (
                tuple(ci.name for ci in src.colorinterp) if args.full else ()
            )
    except Exception as exc:  # noqa: BLE001 - report and skip a bad source
        print(f"warning: skipping '{path}' ({exc})", file=sys.stderr)
        return None

    def r(v: float) -> float:
        return round(v, 8)

    bbox = [r(west), r(south), r(east), r(north)]
    asset: OrderedDict = OrderedDict([("href", asset_href(path, args.href_base))])

    # Minimal shape (default), matching the deck.gl-raster example.
    if not args.full:
        return OrderedDict(
            [("bbox", bbox), ("assets", OrderedDict([(args.asset_key, asset)]))]
        )

    # --full: a complete STAC Item.
    asset["type"] = COG_MEDIA_TYPE
    asset["title"] = args.asset_title
    asset["roles"] = args.roles
    if colorinterp:
        asset["eo:bands"] = eo_bands(colorinterp)

    properties: OrderedDict = OrderedDict(
        [("datetime", None if args.datetime == "none" else args.datetime)]
    )
    if gsd is not None:
        properties["gsd"] = gsd
    if epsg is not None:
        properties["proj:epsg"] = epsg

    return OrderedDict(
        [
            ("type", "Feature"),
            ("stac_version", "1.0.0"),
            (
                "stac_extensions",
                STAC_EXTENSIONS
                + (
                    ["https://stac-extensions.github.io/eo/v1.1.0/schema.json"]
                    if colorinterp
                    else []
                ),
            ),
            ("id", item_id(path, args.id_prefix)),
            ("bbox", bbox),
            (
                "geometry",
                {
                    "type": "Polygon",
                    "coordinates": [
                        [
                            [bbox[0], bbox[1]],
                            [bbox[2], bbox[1]],
                            [bbox[2], bbox[3]],
                            [bbox[0], bbox[3]],
                            [bbox[0], bbox[1]],
                        ]
                    ],
                },
            ),
            ("properties", properties),
            ("assets", OrderedDict([(args.asset_key, asset)])),
            ("links", []),
        ]
    )


def union_bbox(features: list[OrderedDict]) -> list[float]:
    """The smallest bbox containing every feature's bbox."""
    boxes = [f["bbox"] for f in features]
    return [
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    ]


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument(
        "inputs",
        nargs="+",
        help="COG paths: files, directories, globs, or http(s)/s3 URLs.",
    )
    p.add_argument(
        "-o",
        "--output",
        default="-",
        help="Output .json path ('-' for stdout, the default).",
    )
    p.add_argument(
        "--href-base",
        help="Base URL local COGs will be hosted under; the file name is "
        "appended. Ignored for inputs that are already URLs.",
    )
    p.add_argument(
        "--asset-key",
        default="image",
        help="Key for the COG asset in each Item (default: image).",
    )
    p.add_argument(
        "--asset-title",
        default="Cloud-Optimized GeoTIFF",
        help="Title for the COG asset.",
    )
    p.add_argument(
        "--roles",
        default="data,visual",
        help="Comma-separated asset roles (default: data,visual).",
    )
    p.add_argument(
        "--datetime",
        default="none",
        help="Item datetime (ISO 8601), or 'none' for null (default).",
    )
    p.add_argument(
        "--id-prefix",
        default="",
        help="Prefix prepended to every Item id (--full only).",
    )
    p.add_argument(
        "--full",
        action="store_true",
        help="Emit complete STAC Items (geometry, properties, extensions) "
        "instead of the minimal {bbox, assets} features (default).",
    )
    p.add_argument(
        "--indent",
        type=int,
        default=2,
        help="JSON indent (default: 2).",
    )
    args = p.parse_args(argv)
    args.roles = [r.strip() for r in args.roles.split(",") if r.strip()]
    return args


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    paths = expand_inputs(args.inputs)
    if not paths:
        print("error: no COGs found from the given inputs", file=sys.stderr)
        return 1

    features = [f for f in (build_feature(p, args) for p in paths) if f]
    if not features:
        print("error: no COGs could be read", file=sys.stderr)
        return 1

    collection: OrderedDict = OrderedDict([("type", "FeatureCollection")])
    # A collection-level bbox is valid GeoJSON but the minimal example omits it;
    # include it only with --full.
    if args.full:
        collection["bbox"] = [round(v, 8) for v in union_bbox(features)]
    collection["features"] = features

    text = json.dumps(collection, indent=args.indent) + "\n"
    if args.output == "-":
        sys.stdout.write(text)
    else:
        with open(args.output, "w", encoding="utf-8") as fh:
            fh.write(text)
        print(
            f"wrote {args.output} with {len(features)} feature(s)",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
