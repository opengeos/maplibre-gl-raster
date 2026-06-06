import type { GeoTIFF } from '@developmentseed/geotiff';
import type {
  RasterLayerInfo,
  RasterLayerSource,
  RasterLayerState,
} from '../core/types';
import type { AutoStats } from '../raster/stats';

/** Geographic (WGS84) bounds of a layer, as reported by COGLayer. */
export type GeographicBounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

/** Default visualization state for a freshly added layer. Mode/bands are
 * re-picked automatically once the band count is known (unless the caller
 * supplied them explicitly). */
export const DEFAULT_LAYER_STATE: RasterLayerState = {
  mode: 'rgb',
  bands: [1, 2, 3],
  rescale: null,
  colormap: 'viridis',
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
 * Internal record for a managed raster layer. The public surface exposes
 * {@link RasterLayerInfo} snapshots derived via {@link toLayerInfo}.
 */
export interface RasterLayer {
  id: string;
  name: string;
  source: RasterLayerSource;
  /** URL handed to loadGeoTIFF (the objectUrl for local files). */
  url: string;
  state: RasterLayerState;
  /** Whether the caller explicitly chose mode/bands (suppresses auto-pick). */
  userPickedMode: boolean;
  geotiff: GeoTIFF | null;
  autoStats: AutoStats | null;
  bandCount: number | null;
  bandNames: globalThis.Map<number, string> | null;
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
    bandCount: layer.bandCount,
    bandNames: layer.bandNames ? new Map(layer.bandNames) : null,
    state: { ...layer.state },
  };
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
    const path = source.includes('://')
      ? new URL(source).pathname
      : source;
    const segment = path.split('/').filter(Boolean).pop();
    return segment ? decodeURIComponent(segment) : source;
  } catch {
    return source;
  }
}
