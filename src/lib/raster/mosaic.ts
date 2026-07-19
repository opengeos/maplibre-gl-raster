/**
 * Client-side mosaic support for the deck.gl engine.
 *
 * A mosaic is a JSON manifest of many COGs rendered as one layer. Two shapes
 * are recognized:
 *
 * - **MosaicJSON** — the [MosaicJSON spec](https://github.com/developmentseed/mosaicjson-spec):
 *   `tiles` maps web-mercator quadkeys to the assets covering them. It carries
 *   no per-asset geometry, so each asset's bbox is derived from the union of
 *   the quadkey tiles that reference it.
 * - **STAC `FeatureCollection`** — each feature carries its own `bbox` and an
 *   `assets` map (the shape the
 *   [deck.gl-raster NAIP example](https://developmentseed.org/deck.gl-raster/examples/naip-mosaic/)
 *   renders). The COG URL is read from the `visual`/`image` asset.
 *
 * Either way the result is a flat list of `{ url, bbox }` the deck.gl
 * {@link import('@developmentseed/deck.gl-geotiff').MosaicLayer} culls to the
 * viewport, opening (and georeferencing) each COG lazily only while it is
 * visible — a country-scale mosaic never opens every header up front. The bbox
 * is only used for that spatial cull; each COG is still placed exactly by its
 * own header.
 *
 * The TiTiler engine renders a MosaicJSON server-side and needs none of this;
 * this path is what lets the default GPU engine render one too. (A STAC
 * FeatureCollection has no TiTiler equivalent, so it renders only on deck.gl.)
 */

import type { GeographicBounds } from '../core/types';

/** One COG asset of a mosaic, with the WGS84 bbox used to place it in the
 * mosaic's spatial index. */
export interface MosaicAsset {
  /** Absolute http(s) URL the COG is read from (s3:// rewritten to https). */
  url: string;
  /** WGS84 bounds as `[minX, minY, maxX, maxY]` — the shape a
   * {@link import('@developmentseed/deck.gl-geotiff').MosaicSource} expects. */
  bbox: [number, number, number, number];
}

/** Which manifest a mosaic was parsed from. Only `'mosaicjson'` has a
 * server-side TiTiler equivalent; `'stac'` renders on deck.gl only. */
export type MosaicKind = 'mosaicjson' | 'stac';

/** A parsed mosaic manifest ready to render as a client-side mosaic. */
export interface ParsedMosaic {
  /** The manifest shape this came from. */
  kind: MosaicKind;
  /** Unique COG assets, each with a bbox. Always at least one. */
  assets: MosaicAsset[];
  /** Overall WGS84 bounds of the mosaic. */
  bounds: GeographicBounds;
  /** Native minimum zoom the assets carry data at (MosaicJSON only). */
  minzoom: number | null;
  /** Native maximum zoom (MosaicJSON only). */
  maxzoom: number | null;
}

/** The raw MosaicJSON document shape this module reads. */
interface MosaicJsonDoc {
  minzoom?: number;
  maxzoom?: number;
  bounds?: [number, number, number, number];
  /** Quadkey → list of asset URLs (or asset indices into {@link assets}). */
  tiles?: Record<string, Array<string | number>>;
  /** Some encoders hoist asset URLs into a shared array and index into it. */
  assets?: string[];
}

/** The subset of a STAC Item / FeatureCollection this module reads. */
interface StacAsset {
  href?: string;
  type?: string;
}
interface StacItem {
  bbox?: number[];
  assets?: Record<string, StacAsset>;
}
interface StacFeatureCollection {
  type?: string;
  features?: StacItem[];
}

/** Most COG assets a mosaic may expand to. A mosaic that lists more is almost
 * certainly meant for a tile server (TiTiler), not a browser holding every
 * asset's bbox and opening headers on the fly; failing with a clear message
 * beats hanging the page. The spatial index culls to the viewport, so this is a
 * generous ceiling, not a working-set limit. */
export const MAX_MOSAIC_ASSETS = 10000;

/** STAC asset keys tried in order for the COG to render. */
const STAC_ASSET_PREFERENCE = ['visual', 'image', 'rgb', 'data'];

/** Marker for a manifest this engine cannot render client-side. */
export class MosaicUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MosaicUnsupportedError';
  }
}

/** Decodes a web-mercator quadkey into its tile `{x, y, z}`. */
function quadkeyToTile(quadkey: string): { x: number; y: number; z: number } {
  let x = 0;
  let y = 0;
  const z = quadkey.length;
  for (let i = 0; i < z; i++) {
    const mask = 1 << (z - i - 1);
    switch (quadkey[i]) {
      case '0':
        break;
      case '1':
        x |= mask;
        break;
      case '2':
        y |= mask;
        break;
      case '3':
        x |= mask;
        y |= mask;
        break;
      default:
        throw new MosaicUnsupportedError(
          `Invalid quadkey "${quadkey}" in MosaicJSON.`,
        );
    }
  }
  return { x, y, z };
}

/** Longitude (degrees) of a tile's left edge. */
function tileLon(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180;
}

/** Latitude (degrees) of a tile's top edge. */
function tileLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/** The WGS84 bbox `[w, s, e, n]` of a quadkey's tile. */
function quadkeyBbox(quadkey: string): [number, number, number, number] {
  const { x, y, z } = quadkeyToTile(quadkey);
  return [tileLon(x, z), tileLat(y + 1, z), tileLon(x + 1, z), tileLat(y, z)];
}

/**
 * Rewrites an `s3://bucket/key` asset URL to its virtual-hosted https form so a
 * browser can range-read it. Non-s3 URLs pass through unchanged. The bucket
 * must still be public (or presigned) and CORS-enabled for the fetch to
 * succeed — unlike the TiTiler engine, nothing proxies the request here.
 */
export function assetUrlToHttps(url: string): string {
  const match = /^s3:\/\/([^/]+)\/(.+)$/i.exec(url);
  if (!match) return url;
  const [, bucket, key] = match;
  return `https://${bucket}.s3.amazonaws.com/${key}`;
}

/** The smallest bbox containing both inputs. */
function unionBbox(
  a: [number, number, number, number],
  b: [number, number, number, number],
): [number, number, number, number] {
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.max(a[3], b[3]),
  ];
}

/** The union of every asset bbox as WGS84 bounds. */
function boundsFromAssets(assets: MosaicAsset[]): GeographicBounds {
  const union = assets.map((a) => a.bbox).reduce((acc, b) => unionBbox(acc, b));
  return { west: union[0], south: union[1], east: union[2], north: union[3] };
}

/** Guards the derived asset count against {@link MAX_MOSAIC_ASSETS}. */
function assertAssetCount(count: number): void {
  if (count > MAX_MOSAIC_ASSETS) {
    throw new MosaicUnsupportedError(
      `This mosaic lists ${count} COGs. More than ${MAX_MOSAIC_ASSETS} is ` +
        'impractical to render in the browser; use the "titiler" engine, ' +
        'which renders the mosaic on a server.',
    );
  }
}

/**
 * Parses a mosaic manifest (MosaicJSON or STAC FeatureCollection) into the
 * assets and extent needed to render it as a client-side mosaic.
 *
 * @param doc - The parsed manifest JSON
 * @returns The manifest kind, unique assets, overall bounds, and zoom range
 * @throws {MosaicUnsupportedError} When the document is neither shape, carries
 *   no usable assets, or lists more than {@link MAX_MOSAIC_ASSETS}
 */
export function parseMosaic(doc: unknown): ParsedMosaic {
  if (doc && typeof doc === 'object') {
    const asStac = doc as StacFeatureCollection;
    if (asStac.type === 'FeatureCollection' && Array.isArray(asStac.features)) {
      return parseStac(asStac);
    }
    const asMosaic = doc as MosaicJsonDoc;
    if (asMosaic.tiles && typeof asMosaic.tiles === 'object') {
      return parseMosaicJson(asMosaic);
    }
  }
  throw new MosaicUnsupportedError(
    'This file is not a MosaicJSON (no "tiles" index) or a STAC ' +
      'FeatureCollection.',
  );
}

/** Parses a MosaicJSON: invert `tiles` (quadkey → assets), deriving each
 * asset's bbox from the union of its quadkey tiles. */
function parseMosaicJson(doc: MosaicJsonDoc): ParsedMosaic {
  const tiles = doc.tiles!;
  const sharedAssets = Array.isArray(doc.assets) ? doc.assets : null;

  const byUrl = new Map<string, [number, number, number, number]>();
  for (const [quadkey, refs] of Object.entries(tiles)) {
    if (!Array.isArray(refs) || refs.length === 0) continue;
    const bbox = quadkeyBbox(quadkey);
    for (const ref of refs) {
      const raw =
        typeof ref === 'number'
          ? (sharedAssets?.[ref] ?? null)
          : typeof ref === 'string'
            ? ref
            : null;
      if (!raw) continue;
      const url = assetUrlToHttps(raw);
      const existing = byUrl.get(url);
      byUrl.set(url, existing ? unionBbox(existing, bbox) : bbox);
    }
  }

  if (byUrl.size === 0) {
    throw new MosaicUnsupportedError(
      'This MosaicJSON references no COG assets.',
    );
  }
  assertAssetCount(byUrl.size);

  const assets: MosaicAsset[] = [...byUrl].map(([url, bbox]) => ({ url, bbox }));
  const declared = doc.bounds;
  const bounds: GeographicBounds =
    declared && declared.length === 4 && declared.every(Number.isFinite)
      ? {
          west: declared[0],
          south: declared[1],
          east: declared[2],
          north: declared[3],
        }
      : boundsFromAssets(assets);

  return {
    kind: 'mosaicjson',
    assets,
    bounds,
    minzoom: typeof doc.minzoom === 'number' ? doc.minzoom : null,
    maxzoom: typeof doc.maxzoom === 'number' ? doc.maxzoom : null,
  };
}

/** Reads the COG href from a STAC item's assets, preferring a visual/RGB
 * asset and falling back to any GeoTIFF-typed or `.tif` asset. */
function stacAssetHref(
  assets: Record<string, StacAsset> | undefined,
): string | null {
  if (!assets || typeof assets !== 'object') return null;
  for (const key of STAC_ASSET_PREFERENCE) {
    const href = assets[key]?.href;
    if (typeof href === 'string') return href;
  }
  for (const asset of Object.values(assets)) {
    const href = asset?.href;
    const type = asset?.type;
    if (
      typeof href === 'string' &&
      (/\.tiff?($|\?)/i.test(href) ||
        (typeof type === 'string' && /geotiff|cog/i.test(type)))
    ) {
      return href;
    }
  }
  for (const asset of Object.values(assets)) {
    if (typeof asset?.href === 'string') return asset.href;
  }
  return null;
}

/** Parses a STAC FeatureCollection: one asset per feature, bbox taken directly
 * from each feature. Features without a usable bbox or COG asset are skipped. */
function parseStac(doc: StacFeatureCollection): ParsedMosaic {
  const seen = new Set<string>();
  const assets: MosaicAsset[] = [];
  for (const feature of doc.features ?? []) {
    const bbox = feature.bbox;
    if (
      !Array.isArray(bbox) ||
      bbox.length < 4 ||
      !bbox.slice(0, 4).every(Number.isFinite)
    ) {
      continue;
    }
    const href = stacAssetHref(feature.assets);
    if (!href) continue;
    const url = assetUrlToHttps(href);
    if (seen.has(url)) continue;
    seen.add(url);
    assets.push({ url, bbox: [bbox[0], bbox[1], bbox[2], bbox[3]] });
    // Bail on an oversized collection rather than scanning it all.
    if (assets.length > MAX_MOSAIC_ASSETS) assertAssetCount(assets.length);
  }

  if (assets.length === 0) {
    throw new MosaicUnsupportedError(
      'This STAC FeatureCollection has no features with both a bounding box ' +
        'and a COG asset.',
    );
  }

  return {
    kind: 'stac',
    assets,
    bounds: boundsFromAssets(assets),
    // STAC items carry no shared zoom range; deck.gl renders any zoom.
    minzoom: null,
    maxzoom: null,
  };
}

/**
 * A mosaic small enough to fit its whole extent on load without rendering too
 * many COGs at once. Above this, the initial view is capped (see
 * {@link mosaicInitialView}).
 */
export const MOSAIC_FIT_ALL_MAX = 48;

/** Roughly how many assets across the capped initial view should span (so about
 * this squared are shown). */
const MOSAIC_VIEW_ASSETS_ACROSS = 4;

/** Roughly how many assets across the viewport at the mosaic's `minZoom` — the
 * zoom below which a large deck.gl mosaic renders nothing. A few times wider
 * than the initial view, so a small zoom-out still shows the mosaic. */
const MOSAIC_MINZOOM_ASSETS_ACROSS = 12;

/** Degrees of longitude a roughly 1024px-wide map viewport spans at zoom 0
 * (twice the 360° of a single 512px world tile). Used to convert an asset size
 * into a web-mercator zoom. */
const VIEWPORT_DEGREES_AT_Z0 = 720;

/** Median of a numeric array (unsorted input is copied). */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

/**
 * The bounds the map should fit to when a client-side (deck.gl) mosaic loads.
 *
 * The deck.gl engine renders one `COGLayer` per in-view asset, so fitting the
 * whole extent of a large mosaic would open and draw hundreds of COGs at once —
 * slow, and rarely what the user wants to look at first. For a small mosaic the
 * full extent is returned unchanged; for a large one the view is capped to a
 * window a few assets wide, centred on the mosaic (using the *median* asset
 * centre, so a stray far-flung asset doesn't drag the view off the data). The
 * user can still zoom out to load the rest.
 *
 * @param bounds - The mosaic's full WGS84 bounds
 * @param assets - Its assets (for count, size, and centre)
 * @returns The bounds to fit on load
 */
export function mosaicInitialView(
  bounds: GeographicBounds,
  assets: MosaicAsset[],
): GeographicBounds {
  if (assets.length <= MOSAIC_FIT_ALL_MAX) return bounds;
  const cx = median(assets.map((a) => (a.bbox[0] + a.bbox[2]) / 2));
  const cy = median(assets.map((a) => (a.bbox[1] + a.bbox[3]) / 2));
  const assetW = median(assets.map((a) => a.bbox[2] - a.bbox[0]));
  const assetH = median(assets.map((a) => a.bbox[3] - a.bbox[1]));
  const halfW = Math.min(
    (bounds.east - bounds.west) / 2,
    (MOSAIC_VIEW_ASSETS_ACROSS * assetW) / 2,
  );
  const halfH = Math.min(
    (bounds.north - bounds.south) / 2,
    (MOSAIC_VIEW_ASSETS_ACROSS * assetH) / 2,
  );
  return {
    west: cx - halfW,
    south: cy - halfH,
    east: cx + halfW,
    north: cy + halfH,
  };
}

/**
 * The `minZoom` a large deck.gl mosaic should render at — below it, nothing is
 * drawn.
 *
 * The deck.gl `MosaicLayer` renders one `COGLayer` per asset whose bbox
 * intersects the viewport. At a low zoom (e.g. the world view a map opens on)
 * *every* asset of a country-scale mosaic intersects, so it would spin up
 * hundreds of layers at once — the difference between "renders instantly" and
 * "takes a while". Gating the layer at a `minZoom` where only a couple of dozen
 * assets can be on screen keeps every view cheap; the mosaic simply hides when
 * zoomed further out (as detailed imagery mosaics conventionally do). Returns
 * null for a small mosaic, which is always cheap to draw in full.
 *
 * @param assets - The mosaic's assets (for count and median size)
 * @returns A web-mercator zoom, or null to impose no floor
 */
export function mosaicMinZoom(assets: MosaicAsset[]): number | null {
  if (assets.length <= MOSAIC_FIT_ALL_MAX) return null;
  const assetW = median(assets.map((a) => a.bbox[2] - a.bbox[0]));
  const assetH = median(assets.map((a) => a.bbox[3] - a.bbox[1]));
  const size = Math.max(Math.sqrt(Math.abs(assetW * assetH)), 1e-6);
  const zoom = Math.log2(
    VIEWPORT_DEGREES_AT_Z0 / (MOSAIC_MINZOOM_ASSETS_ACROSS * size),
  );
  return Math.max(0, Math.floor(zoom));
}

/**
 * Fetches and parses a mosaic manifest (MosaicJSON or STAC) from a URL.
 *
 * @param url - The manifest URL
 * @param signal - Optional abort signal
 * @returns The parsed mosaic
 * @throws {MosaicUnsupportedError} When the document is not a usable manifest
 */
export async function loadMosaic(
  url: string,
  signal?: AbortSignal,
): Promise<ParsedMosaic> {
  const resp = await fetch(url, { signal });
  if (!resp.ok) {
    throw new Error(
      `Failed to load mosaic "${url}" (${resp.status} ${resp.statusText}).`,
    );
  }
  return parseMosaic(await resp.json());
}
