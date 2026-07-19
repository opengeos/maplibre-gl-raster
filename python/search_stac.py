#!/usr/bin/env python3
"""Search a STAC API and write the mosaic JSON the deck.gl engine renders.

Queries a STAC API's ``/search`` endpoint (the
[Planetary Computer](https://planetarycomputer.microsoft.com/) by default) and
writes the minimal ``FeatureCollection`` the maplibre-gl-raster deck.gl mosaic
engine reads, matching the
[deck.gl-raster NAIP example](https://developmentseed.org/deck.gl-raster/examples/naip-mosaic/):

    { "type": "FeatureCollection",
      "features": [ { "bbox": [...], "assets": { "image": { "href": ... } } } ] }

This is the remote-search counterpart to ``make_stac.py``: that script derives
each bbox by opening a COG you already have, while this one takes the bboxes
straight from the API's search results. Pass ``--full`` to write the complete
STAC Items the API returned instead of the minimal shape.

Only the standard library is required.

Examples
--------
    # NAIP over a bbox, one year:
    python python/search_stac.py -c naip -b -99.3759,46.8959,-98.8825,47.1299 \
        -d 2023 -o naip.json

    # Least-cloudy Sentinel-2 scenes, signed for browser access:
    python python/search_stac.py -c sentinel-2-l2a -b 5.6,45.8,6.2,46.1 \
        -d 2024-06-01/2024-09-01 --query '{"eo:cloud_cover":{"lt":10}}' \
        --sortby eo:cloud_cover --max-items 20 --asset visual --sign -o s2.json

    # A different STAC API (assets there are already public):
    python python/search_stac.py --api https://earth-search.aws.element84.com/v1 \
        -c sentinel-2-l2a -b 5.6,45.8,6.2,46.1 -d 2024 --asset visual -o s2.json

Note that client-side rendering reads each COG directly from the browser, so the
assets must be public (or ``--sign``ed) and CORS-enabled.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict
from typing import Any

PC_STAC_API = "https://planetarycomputer.microsoft.com/api/stac/v1"
PC_SAS_API = "https://planetarycomputer.microsoft.com/api/sas/v1/token"

# Asset keys tried in order when --asset is not given, before falling back to
# any asset with a GeoTIFF media type.
ASSET_PREFERENCE = ("image", "visual", "data", "asset", "cog")
GEOTIFF_HINTS = ("image/tiff", "image/vnd.stac.geotiff", "image/x.geotiff")

YEAR_RE = re.compile(r"^\d{4}$")
MONTH_RE = re.compile(r"^\d{4}-\d{2}$")


def http_json(url: str, body: dict | None = None, timeout: float = 60.0) -> Any:
    """GET (or POST when ``body`` is given) a URL and parse the JSON response."""
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
    req = urllib.request.Request(url, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as exc:  # surface the API's own message
        detail = exc.read().decode("utf-8", "replace")[:500]
        raise SystemExit(f"error: {url} returned HTTP {exc.code}\n{detail}")
    except urllib.error.URLError as exc:
        raise SystemExit(f"error: cannot reach {url} ({exc.reason})")


def normalize_bbox_argv(argv: list[str]) -> list[str]:
    """Reattach a negative ``--bbox`` value so argparse does not read it as a flag.

    A western-hemisphere bbox starts with a minus sign, and before Python 3.14
    argparse rejects ``-b -99.4,46.9,-98.9,47.1`` with "expected one argument":
    the value looks like an option. (Its negative-number escape hatch only
    matches a bare number, not a comma-separated list.) Rewriting the pair to
    the ``--bbox=<value>`` form argparse always accepts makes the documented
    command work on every supported Python.

    Only a value that is unambiguously a bbox is touched — one starting with
    ``-`` and containing a comma — so a genuine typo'd flag still errors.
    """
    out: list[str] = []
    i = 0
    while i < len(argv):
        token = argv[i]
        following = argv[i + 1] if i + 1 < len(argv) else None
        if (
            token in ("-b", "--bbox")
            and following is not None
            and following.startswith("-")
            and "," in following
        ):
            out.append(f"--bbox={following}")
            i += 2
            continue
        out.append(token)
        i += 1
    return out


def parse_bbox(text: str) -> list[float]:
    """Parse ``west,south,east,north`` (commas and/or whitespace separated)."""
    # `-b=-99,46,-98,47` reaches argparse as a value with a leading '='; accept
    # it rather than failing with a confusing "must be numeric".
    parts = [p for p in re.split(r"[,\s]+", text.strip().lstrip("=")) if p]
    if len(parts) != 4:
        raise SystemExit(f"error: --bbox needs 4 numbers, got {len(parts)}: {text!r}")
    try:
        west, south, east, north = (float(p) for p in parts)
    except ValueError:
        raise SystemExit(f"error: --bbox must be numeric: {text!r}")
    if west >= east or south >= north:
        raise SystemExit(
            "error: --bbox must be west,south,east,north with west<east and "
            f"south<north, got {text!r}"
        )
    return [west, south, east, north]


def parse_datetime(text: str) -> str:
    """Expand shorthand into a STAC datetime interval.

    ``2023`` and ``2023-06`` become full closed intervals; a bare date becomes
    that whole day. ``a/b`` intervals (including open ``../b`` and ``a/..``) and
    explicit timestamps pass through unchanged.
    """

    def start_of(token: str) -> str:
        if YEAR_RE.match(token):
            return f"{token}-01-01T00:00:00Z"
        if MONTH_RE.match(token):
            return f"{token}-01T00:00:00Z"
        return f"{token}T00:00:00Z" if len(token) == 10 else token

    def end_of(token: str) -> str:
        if YEAR_RE.match(token):
            return f"{token}-12-31T23:59:59Z"
        if MONTH_RE.match(token):
            year, month = (int(v) for v in token.split("-"))
            last = [
                31,
                29 if _is_leap(year) else 28,
                31,
                30,
                31,
                30,
                31,
                31,
                30,
                31,
                30,
                31,
            ][month - 1]
            return f"{token}-{last:02d}T23:59:59Z"
        return f"{token}T23:59:59Z" if len(token) == 10 else token

    text = text.strip()
    if "/" in text:
        start, _, end = text.partition("/")
        start = ".." if start in ("", "..") else start_of(start)
        end = ".." if end in ("", "..") else end_of(end)
        return f"{start}/{end}"
    return f"{start_of(text)}/{end_of(text)}"


def _is_leap(year: int) -> bool:
    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)


def search(api: str, body: dict, max_items: int | None) -> list[dict]:
    """Run a POST /search and follow ``next`` links until exhausted.

    Handles both link styles: a POST ``next`` carrying a (possibly ``merge``d)
    body, and a plain GET href.
    """
    url = f"{api.rstrip('/')}/search"
    items: list[dict] = []
    seen_urls: set[str] = set()
    while True:
        page = http_json(url, body)
        found = page.get("features", [])
        items.extend(found)
        if max_items and len(items) >= max_items:
            return items[:max_items]
        links = [link for link in page.get("links", []) if link.get("rel") == "next"]
        if not found or not links:
            return items
        link = links[0]
        next_url = link.get("href", url)
        next_body = link.get("body")
        if next_body is not None:
            body = {**body, **next_body} if link.get("merge") else next_body
        elif next_url in seen_urls:  # no cursor to advance: stop rather than loop
            return items
        seen_urls.add(next_url)
        url = next_url


def collection_exists(api: str, collection: str) -> bool:
    """Whether the API advertises a collection (used only to explain empty results)."""
    url = f"{api.rstrip('/')}/collections/{urllib.parse.quote(collection)}"
    try:
        with urllib.request.urlopen(url, timeout=30) as resp:
            return resp.status == 200
    except Exception:  # noqa: BLE001 - a probe; assume it exists and stay quiet
        return False


def pick_asset(assets: dict, wanted: str | None) -> tuple[str, dict] | None:
    """Choose the COG asset from an Item, or None when there is nothing to draw."""
    if wanted:
        asset = assets.get(wanted)
        return (
            (wanted, asset) if isinstance(asset, dict) and asset.get("href") else None
        )
    for key in ASSET_PREFERENCE:
        asset = assets.get(key)
        if isinstance(asset, dict) and asset.get("href"):
            return key, asset
    for key, asset in assets.items():
        media = (asset or {}).get("type", "") if isinstance(asset, dict) else ""
        if any(hint in media for hint in GEOTIFF_HINTS) and asset.get("href"):
            return key, asset
    return None


class Signer:
    """Appends Planetary Computer SAS tokens to asset hrefs, one token per collection."""

    def __init__(self, sas_api: str = PC_SAS_API) -> None:
        self.sas_api = sas_api.rstrip("/")
        self._tokens: dict[str, str] = {}

    def token(self, collection: str) -> str:
        if collection not in self._tokens:
            payload = http_json(f"{self.sas_api}/{collection}")
            self._tokens[collection] = payload.get("token", "")
        return self._tokens[collection]

    def sign(self, href: str, collection: str) -> str:
        token = self.token(collection)
        if not token:
            return href
        base, _, existing = href.partition("?")
        query = "&".join(q for q in (existing, token) if q)
        return f"{base}?{query}"


def item_bbox(item: dict) -> list[float] | None:
    """An Item's bbox, falling back to the envelope of its geometry."""
    bbox = item.get("bbox")
    if isinstance(bbox, list) and len(bbox) >= 4:
        # A 6-element (3D) bbox is [west,south,minz,east,north,maxz].
        return [bbox[0], bbox[1], bbox[3], bbox[4]] if len(bbox) == 6 else bbox[:4]
    coords = _flatten_coords((item.get("geometry") or {}).get("coordinates"))
    if not coords:
        return None
    xs = [c[0] for c in coords]
    ys = [c[1] for c in coords]
    return [min(xs), min(ys), max(xs), max(ys)]


def _flatten_coords(node: Any) -> list[list[float]]:
    """Every [x, y] pair in an arbitrarily nested GeoJSON coordinates array."""
    if not isinstance(node, list) or not node:
        return []
    if isinstance(node[0], (int, float)):
        return [[float(node[0]), float(node[1])]] if len(node) >= 2 else []
    out: list[list[float]] = []
    for child in node:
        out.extend(_flatten_coords(child))
    return out


def build_body(args: argparse.Namespace) -> dict:
    """The POST /search request body from the parsed CLI arguments."""
    body: dict[str, Any] = {"collections": args.collections, "limit": args.page_size}
    if args.bbox:
        # nargs="+" so `-b -99.4 46.9 -98.9 47.1` works too; parse_bbox splits
        # on commas and whitespace alike, so the forms converge here.
        body["bbox"] = parse_bbox(" ".join(args.bbox))
    if args.intersects:
        body["intersects"] = load_geometry(args.intersects)
    if args.datetime:
        body["datetime"] = parse_datetime(args.datetime)
    if args.query:
        body["query"] = parse_json_arg(args.query, "--query")
    if args.filter:
        body["filter"] = parse_json_arg(args.filter, "--filter")
        body["filter-lang"] = "cql2-json"
    if args.ids:
        body["ids"] = [i.strip() for i in args.ids.split(",") if i.strip()]
    if args.sortby:
        body["sortby"] = [
            {
                "field": field.lstrip("+-"),
                "direction": "desc" if field.startswith("-") else "asc",
            }
            for field in (f.strip() for f in args.sortby.split(","))
            if field
        ]
    return body


def parse_json_arg(text: str, flag: str) -> Any:
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"error: {flag} is not valid JSON ({exc})")


def load_geometry(path: str) -> dict:
    """A GeoJSON geometry from a file holding a geometry, Feature, or FeatureCollection."""
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except OSError as exc:
        raise SystemExit(f"error: cannot read --intersects file '{path}' ({exc})")
    except json.JSONDecodeError as exc:
        raise SystemExit(f"error: --intersects file '{path}' is not valid JSON ({exc})")
    if data.get("type") == "FeatureCollection":
        features = data.get("features") or []
        if not features:
            raise SystemExit(f"error: --intersects file '{path}' has no features")
        return features[0]["geometry"]
    if data.get("type") == "Feature":
        return data["geometry"]
    return data


def dump_json(doc: Any, args: argparse.Namespace) -> str:
    """Serialize the output document, honouring ``--compact`` / ``--indent``.

    ``--compact`` drops every newline and the space after each separator, which
    is what the deck.gl-raster example ships and roughly halves the file for a
    mosaic of any size. A trailing newline is still added by the caller so the
    file ends cleanly for diffs and shells.
    """
    if args.compact:
        return json.dumps(doc, separators=(",", ":"))
    return json.dumps(doc, indent=args.indent)


def union_bbox(boxes: list[list[float]]) -> list[float]:
    """The smallest bbox containing every input bbox."""
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
        "-c",
        "--collection",
        dest="collections",
        action="append",
        required=True,
        help="Collection id to search; repeat the flag to search several.",
    )
    p.add_argument(
        "-b",
        "--bbox",
        nargs="+",
        metavar="BBOX",
        help="Search extent as west,south,east,north (commas or spaces).",
    )
    p.add_argument(
        "--intersects",
        help="Path to a GeoJSON file to search by geometry instead of --bbox.",
    )
    p.add_argument(
        "-d",
        "--datetime",
        help="Date or interval: '2023', '2023-06', '2023-06-01', or 'start/end' "
        "(open-ended with '..', e.g. '2023-01-01/..').",
    )
    p.add_argument(
        "--query",
        help='STAC query extension JSON, e.g. \'{"eo:cloud_cover":{"lt":10}}\'.',
    )
    p.add_argument(
        "--filter", help="CQL2-JSON filter (sent with filter-lang=cql2-json)."
    )
    p.add_argument(
        "--ids", help="Comma-separated Item ids to fetch instead of a search."
    )
    p.add_argument(
        "--sortby",
        help="Comma-separated sort fields, '-' prefixed for descending "
        "(e.g. '-datetime,eo:cloud_cover'). Not supported by every API.",
    )
    p.add_argument(
        "-o",
        "--output",
        default="-",
        help="Output .json path ('-' for stdout, the default).",
    )
    p.add_argument(
        "--api",
        default=PC_STAC_API,
        help=f"STAC API root (default: {PC_STAC_API}).",
    )
    p.add_argument(
        "--asset",
        help="Asset key to render. Default: the first of "
        f"{'/'.join(ASSET_PREFERENCE)} present, else any GeoTIFF asset.",
    )
    p.add_argument(
        "--asset-key",
        default="image",
        help="Key the chosen asset is written under (default: image).",
    )
    p.add_argument(
        "--sign",
        action="store_true",
        help="Append Planetary Computer SAS tokens to asset hrefs. Needed for "
        "collections whose blobs are not anonymously readable. Tokens expire "
        "(typically within hours), so re-run before reuse.",
    )
    p.add_argument(
        "--max-items",
        type=int,
        default=0,
        help="Stop after N items (default: 0, meaning all matches).",
    )
    p.add_argument(
        "--page-size",
        type=int,
        default=500,
        help="Items requested per page (default: 500).",
    )
    p.add_argument(
        "--full",
        action="store_true",
        help="Write the complete STAC Items returned by the API instead of the "
        "minimal {bbox, assets} features (default).",
    )
    p.add_argument("--indent", type=int, default=2, help="JSON indent (default: 2).")
    p.add_argument(
        "--compact",
        action="store_true",
        help="Write the whole document on one line with no space after "
        "separators — the smallest file, and the shape the deck.gl-raster "
        "example ships. Overrides --indent.",
    )
    args = p.parse_args(normalize_bbox_argv(argv))
    if not (args.bbox or args.intersects or args.ids):
        p.error("one of --bbox, --intersects, or --ids is required")
    if args.max_items < 0:
        p.error("--max-items cannot be negative")
    if args.page_size < 1:
        p.error("--page-size must be at least 1")
    return args


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    items = search(args.api, build_body(args), args.max_items or None)
    if not items:
        # A search against a collection that does not exist comes back empty
        # rather than 404 on most APIs, so name that case explicitly.
        unknown = [c for c in args.collections if not collection_exists(args.api, c)]
        if unknown:
            print(
                f"error: unknown collection(s) {', '.join(unknown)} on {args.api}",
                file=sys.stderr,
            )
        else:
            print(
                "error: the search returned no items (check the bbox, the date "
                "range, and any --query filters)",
                file=sys.stderr,
            )
        return 1

    signer = Signer() if args.sign else None
    features: list[Any] = []
    boxes: list[list[float]] = []
    skipped_asset = skipped_bbox = 0

    for item in sorted(items, key=lambda i: str(i.get("id", ""))):
        found = pick_asset(item.get("assets") or {}, args.asset)
        if not found:
            skipped_asset += 1
            continue
        _key, asset = found
        bbox = item_bbox(item)
        if not bbox:
            skipped_bbox += 1
            continue
        href = asset["href"]
        if signer:
            href = signer.sign(href, item.get("collection") or args.collections[0])

        boxes.append(bbox)
        if args.full:
            signed = dict(item)
            if signer:
                signed["assets"] = {
                    k: (
                        {
                            **v,
                            "href": signer.sign(
                                v["href"], item.get("collection") or args.collections[0]
                            ),
                        }
                        if isinstance(v, dict) and v.get("href")
                        else v
                    )
                    for k, v in (item.get("assets") or {}).items()
                }
            features.append(signed)
        else:
            features.append(
                OrderedDict(
                    [
                        ("bbox", bbox),
                        (
                            "assets",
                            OrderedDict(
                                [
                                    (args.asset_key, OrderedDict([("href", href)])),
                                ]
                            ),
                        ),
                    ]
                )
            )

    if skipped_asset:
        which = f"'{args.asset}'" if args.asset else "a renderable"
        print(
            f"warning: skipped {skipped_asset} item(s) without {which} asset",
            file=sys.stderr,
        )
    if skipped_bbox:
        print(
            f"warning: skipped {skipped_bbox} item(s) without a bbox or geometry",
            file=sys.stderr,
        )
    if not features:
        print("error: no items had a renderable asset", file=sys.stderr)
        return 1

    collection: OrderedDict = OrderedDict([("type", "FeatureCollection")])
    if args.full:  # the minimal example omits a collection-level bbox
        collection["bbox"] = union_bbox(boxes)
    collection["features"] = features

    text = dump_json(collection, args) + "\n"
    if args.output == "-":
        sys.stdout.write(text)
    else:
        with open(args.output, "w", encoding="utf-8") as fh:
            fh.write(text)
        extent = union_bbox(boxes)
        print(
            f"wrote {args.output} with {len(features)} feature(s); "
            f"extent {', '.join(f'{v:.6g}' for v in extent)}",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
