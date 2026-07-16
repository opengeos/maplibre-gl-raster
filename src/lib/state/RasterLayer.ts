import type { GeoTIFF } from '@developmentseed/geotiff';
import type { Texture } from '@luma.gl/core';
import type {
  GeographicBounds,
  RasterLayerInfo,
  RasterLayerSource,
  RasterLayerState,
} from '../core/types';
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
 * The layer's images that could carry a sample at `lngLat`, in priority order.
 *
 * A plain layer has exactly one image. A mosaic VRT layer has one per member,
 * and only the members whose extent covers the point are worth reading — a
 * member whose bounds have not been reported yet stays a candidate rather than
 * being skipped, since bounds only arrive once a member renders.
 *
 * @param layer - The layer to read from
 * @param lngLat - The location, [lng, lat] in WGS84
 * @returns Candidate images; empty when the layer has not loaded or the point
 *   falls outside every member
 */
export function imagesAt(
  layer: RasterLayer,
  lngLat: [number, number],
): GeoTIFF[] {
  if (!layer.members) return layer.geotiff ? [layer.geotiff] : [];
  return layer.members
    .filter((m) => !m.bounds || containsPoint(m.bounds, lngLat))
    .map((m) => m.geotiff);
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
