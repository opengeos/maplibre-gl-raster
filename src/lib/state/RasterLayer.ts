import type { GeoTIFF } from '@developmentseed/geotiff';
import type { Texture } from '@luma.gl/core';
import {
  RASTER_MAX_ZOOM,
  RASTER_MIN_ZOOM,
  type GeographicBounds,
  type RasterLayerInfo,
  type RasterLayerSource,
  type RasterLayerState,
} from '../core/types';
import type { MosaicAsset, MosaicKind } from '../raster/mosaic';
import type { AutoStats } from '../raster/stats';

// Moved to core/types so the public RasterLayerInfo can reference it;
// re-exported here for backwards compatibility.
export type { GeographicBounds } from '../core/types';

/** Default visualization state for a freshly added layer. Mode/bands are
 * re-picked automatically once the band count is known (unless the caller
 * supplied them explicitly); single-band rasters default to the image's
 * embedded color table when present ('palette') or grayscale otherwise. */
export const DEFAULT_LAYER_STATE: RasterLayerState = {
  mode: 'rgb',
  bands: [1, 2, 3],
  rescale: null,
  colormap: 'gray',
  reversed: false,
  nodata: 'auto',
  opacity: 1,
  gamma: 1,
  stretch: 'linear',
  visible: true,
  minZoom: RASTER_MIN_ZOOM,
  maxZoom: RASTER_MAX_ZOOM,
};

/**
 * Creates a complete layer state from optional overrides.
 *
 * @param overrides - Partial state merged over the defaults
 * @returns A fully populated RasterLayerState
 */
export function createLayerState(
  overrides?: Partial<RasterLayerState>,
): RasterLayerState {
  return { ...DEFAULT_LAYER_STATE, ...overrides };
}

/**
 * Resolves a layer's min/max zoom bounds, filling in the full [0, 24] range for
 * any bound left unset. Shared by the render engines so the deck.gl overlay and
 * the native MapLibre raster layers apply an identical zoom range.
 *
 * @param state - The layer state (only its zoom bounds are read)
 * @returns The concrete `{ minZoom, maxZoom }` bounds
 */
export function resolveZoomRange(state: Pick<RasterLayerState, 'minZoom' | 'maxZoom'>): {
  minZoom: number;
  maxZoom: number;
} {
  return {
    minZoom: state.minZoom ?? RASTER_MIN_ZOOM,
    maxZoom: state.maxZoom ?? RASTER_MAX_ZOOM,
  };
}

/**
 * One member COG of a mosaic VRT layer.
 *
 * A `.vrt` is a manifest, not raster data, so a VRT layer holds the sources it
 * references rather than a single image. Each member renders as its own tiled
 * layer, georeferenced by its own headers, sharing the parent layer's
 * visualization state and statistics. See `raster/vrt.ts`.
 */
export interface RasterMember {
  /** Absolute URL the member COG is read from. */
  url: string;
  /** The member's loaded header. */
  geotiff: GeoTIFF;
  /** WGS84 bounds, known once the member renders. */
  bounds: GeographicBounds | null;
}

/**
 * Internal record for a managed raster layer. The public surface exposes
 * {@link RasterLayerInfo} snapshots derived via {@link toLayerInfo}.
 */
export interface RasterLayer {
  id: string;
  name: string;
  source: RasterLayerSource;
  /** URL handed to loadGeoTIFF (the objectUrl for local files). */
  url: string;
  /** The original File for local-file layers, so the cog-tiler-wasm engine can
   * read it in memory instead of over a blob URL. Null for remote URLs. */
  file: File | null;
  state: RasterLayerState;
  /** Whether the caller explicitly chose mode/bands (suppresses auto-pick). */
  userPickedMode: boolean;
  /** The layer's image. For a VRT mosaic this is {@link members}[0]'s GeoTIFF:
   * band count, band names, palette and statistics are all read from it, and
   * every member is required to agree on the band layout. */
  geotiff: GeoTIFF | null;
  /** Member COGs when this layer came from a mosaic VRT, in VRT source order.
   * Null for a plain single-file raster. */
  members: RasterMember[] | null;
  /** True when the source is a mosaic manifest (MosaicJSON or STAC
   * FeatureCollection) — no single local GeoTIFF. Rendered client-side by the
   * deck.gl engine (via {@link mosaicAssets}), or server-side by the `titiler`
   * engine when {@link mosaicKind} is `'mosaicjson'`. See `raster/mosaic.ts`. */
  isMosaicJson: boolean;
  /** Which manifest a mosaic layer came from, or null when not a mosaic. Only
   * `'mosaicjson'` can also render on the `titiler` engine. */
  mosaicKind: MosaicKind | null;
  /** For a mosaic layer, the member COG assets (URL + WGS84 bbox) the deck.gl
   * engine renders. Null for every other source, and until parsed. */
  mosaicAssets: MosaicAsset[] | null;
  /** A MosaicJSON's native minimum zoom, used to floor the initial map fit on
   * the `titiler` engine so the view lands where tiles exist. Null otherwise. */
  mosaicMinzoom: number | null;
  autoStats: AutoStats | null;
  bandCount: number | null;
  bandNames: globalThis.Map<number, string> | null;
  /** Embedded TIFF color table (256x1 RGBA), when the image carries one. */
  palette: ImageData | null;
  /** GPU upload of {@link palette}; created lazily once a device exists. */
  paletteTexture: Texture | null;
  /** Map style layer id to insert the raster beneath, when set. */
  beforeId: string | null;
  /** Attribution shown in the map's attribution control while visible. */
  attribution: string | null;
  bounds: GeographicBounds | null;
  /** Fit the map to the layer bounds once loaded. */
  zoomTo: boolean;
  loading: boolean;
  error: Error | null;
  /** Aborts in-flight stats sampling when the layer is removed. */
  abort: AbortController;
}

/**
 * Derives the public snapshot for a layer.
 *
 * @param layer - Internal layer record
 * @returns A read-only info object safe to hand to consumers
 */
export function toLayerInfo(layer: RasterLayer): RasterLayerInfo {
  return {
    id: layer.id,
    name: layer.name,
    source: layer.source,
    memberUrls: layer.members ? layer.members.map((m) => m.url) : null,
    bandCount: layer.bandCount,
    bandNames: layer.bandNames ? new Map(layer.bandNames) : null,
    beforeId: layer.beforeId,
    attribution: layer.attribution,
    bounds: layer.bounds ? { ...layer.bounds } : null,
    loading: layer.loading,
    error: layer.error,
    state: { ...layer.state },
  };
}

/** True when `lngLat` falls inside `bounds` (edges included). */
function containsPoint(
  bounds: GeographicBounds,
  lngLat: [number, number],
): boolean {
  const [lng, lat] = lngLat;
  return (
    lng >= bounds.west &&
    lng <= bounds.east &&
    lat >= bounds.south &&
    lat <= bounds.north
  );
}

/**
 * The layer's images that could carry a sample at `lngLat`, topmost first.
 *
 * A plain layer has exactly one image. A mosaic VRT layer has one per member,
 * and only the members whose extent covers the point are worth reading — a
 * member whose bounds have not been reported yet stays a candidate rather than
 * being skipped, since bounds only arrive once a member renders.
 *
 * Members are returned in reverse document order because that is the order they
 * are drawn in: `LayerManager` builds one deck.gl layer per member in member
 * order, so later members paint over earlier ones — matching GDAL, where a
 * VRT's later sources overwrite earlier ones. Sources placed at their natural
 * position can still overlap (adjacent scenes commonly do), so where they do,
 * the last one is what the user sees and therefore what a reader should report.
 *
 * @param layer - The layer to read from
 * @param lngLat - The location, [lng, lat] in WGS84
 * @returns Candidate images, topmost first; empty when the layer has not loaded
 *   or the point falls outside every member
 */
export function imagesAt(
  layer: RasterLayer,
  lngLat: [number, number],
): GeoTIFF[] {
  if (!layer.members) return layer.geotiff ? [layer.geotiff] : [];
  const covering = layer.members.filter(
    (m) => !m.bounds || containsPoint(m.bounds, lngLat),
  );
  return covering.reverse().map((m) => m.geotiff);
}

/**
 * The mosaic assets whose extent covers `lngLat`, in manifest order.
 *
 * A mosaic manifest layer (MosaicJSON or STAC) has no opened image of its own —
 * the deck.gl {@link import('@developmentseed/deck.gl-geotiff').MosaicLayer}
 * opens each asset lazily while it is in view — so a reader works from the
 * manifest's bboxes and opens what it needs. This is the mosaic counterpart to
 * {@link imagesAt}, returning URLs because the COGs may not be open yet.
 *
 * Unlike a VRT's members these are *not* reversed. A VRT has a defined paint
 * order (later sources overwrite earlier ones), but a mosaic's assets are drawn
 * in whatever order its spatial index returns them, so no candidate is reliably
 * "topmost". Manifest order is used instead: it matches MosaicJSON's convention
 * that the first asset listed for a location is the preferred one. Where assets
 * genuinely overlap the drawn pixel is ambiguous, and the first covering asset
 * is as defensible a report as any.
 *
 * @param layer - The layer to read from
 * @param lngLat - The location, [lng, lat] in WGS84
 * @returns Covering asset URLs in manifest order; empty when the layer is not a
 *   mosaic manifest, has not parsed yet, or the point falls outside every asset
 */
export function assetsAt(
  layer: RasterLayer,
  lngLat: [number, number],
): string[] {
  if (!layer.mosaicAssets) return [];
  const [lng, lat] = lngLat;
  return layer.mosaicAssets
    .filter(
      (a) =>
        lng >= a.bbox[0] &&
        lng <= a.bbox[2] &&
        lat >= a.bbox[1] &&
        lat <= a.bbox[3],
    )
    .map((a) => a.url);
}

/**
 * Derives a display name from a URL or file name: the last path segment
 * without query string.
 *
 * @param source - URL string or file name
 * @returns A short human-readable layer name
 */
export function deriveLayerName(source: string): string {
  try {
    const path = source.includes('://') ? new URL(source).pathname : source;
    const segment = path.split('/').filter(Boolean).pop();
    return segment ? decodeURIComponent(segment) : source;
  } catch {
    return source;
  }
}
