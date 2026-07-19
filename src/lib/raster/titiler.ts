import type { RasterLayerState } from '../core/types';
import { autoRangeFor, statsForBand } from './render-pipeline';
import type { AutoStats } from './stats';
import { PALETTE_COLORMAP } from '../ui/ColormapPicker';

/**
 * The default public TiTiler deployment used by the `titiler` rendering engine.
 * Any TiTiler instance exposing the standard `/cog` and `/mosaicjson` routers
 * works; override it with the control's `titilerEndpoint` option.
 */
export const DEFAULT_TITILER_ENDPOINT = 'https://titiler.d2s.org';

/**
 * The TileMatrixSet TiTiler tiles are requested in. Web Mercator is the only
 * grid MapLibre GL renders raster tiles on, so it is fixed here.
 */
export const TITILER_TMS = 'WebMercatorQuad';

/** Which TiTiler router renders a source: a single Cloud-Optimized GeoTIFF
 * (`/cog`) or a MosaicJSON of many COGs (`/mosaicjson`). */
export type TiTilerKind = 'cog' | 'mosaicjson';

/** The subset of a TiTiler `tilejson.json` response this module reads. */
export interface TiTilerTileJson {
  /** XYZ tile URL templates (with `{z}/{x}/{y}` placeholders). */
  tiles: string[];
  /** WGS84 bounds `[west, south, east, north]`, when reported. */
  bounds?: [number, number, number, number];
  minzoom?: number;
  maxzoom?: number;
}

/**
 * Recognizes a MosaicJSON source by its URL.
 *
 * A COG is a `.tif`/`.tiff`; a MosaicJSON is a `.json` manifest listing the
 * COGs to mosaic (see the [TiTiler MosaicJSON guide](https://developmentseed.org/titiler/examples/notebooks/Working_with_MosaicJSON)).
 * The query string is ignored so a signed URL still matches. Only the
 * `titiler` engine can render a MosaicJSON — the deck.gl and cog-tiler-wasm
 * engines read a single GeoTIFF header, which a manifest does not provide.
 *
 * @param url - The source URL
 * @returns `true` when the URL points at a `.json` mosaic manifest
 */
export function isMosaicJsonUrl(url: string): boolean {
  try {
    const path = url.includes('://') ? new URL(url).pathname : url.split('?')[0];
    return /\.json$/i.test(path);
  } catch {
    return /\.json(\?|$)/i.test(url);
  }
}

/**
 * Builds the TiTiler tile render query for a layer's visualization state, as an
 * ordered list of `[key, value]` pairs (TiTiler repeats `bidx` and `rescale`
 * per band, so a flat object cannot represent it).
 *
 * The mapping mirrors the deck.gl / cog-tiler-wasm engines where TiTiler has an
 * equivalent knob:
 * - **rgb** → one `bidx` per selected channel, one `rescale=min,max` per band.
 * - **single** → `bidx` for the one band, `colormap_name` (with a `_r` suffix
 *   when reversed), and its `rescale`. An embedded `palette` is left to
 *   TiTiler's own internal-colormap handling (no `colormap_name`).
 * - **index** → a server-side band-math `expression` `(bA-bB)/(bA+bB)` (TiTiler
 *   computes the real normalized difference, unlike cog-tiler-wasm), a
 *   `colormap_name`, and a fixed `[-1, 1]` `rescale` unless overridden.
 *
 * `nodata` is forwarded only as a numeric override; `'auto'` defers to the
 * source's declared nodata and `'off'` has no TiTiler equivalent. The `stretch`
 * and `gamma` controls have no standard TiTiler tile parameter and are omitted.
 *
 * @param state - The layer's visualization state
 * @param autoStats - Sampled statistics, used to fill the rescale window when
 *   the state leaves it on auto
 * @returns Ordered query parameters (without the leading `url`)
 */
export function buildTiTilerParams(
  state: RasterLayerState,
  autoStats: AutoStats | null,
): [string, string][] {
  const params: [string, string][] = [];
  const rescaleFor = (band: number, index: number): [number, number] | null => {
    if (state.rescale) return state.rescale[index] ?? state.rescale[0] ?? null;
    const st = statsForBand(autoStats, band);
    return st ? autoRangeFor(st) : null;
  };
  const pushRescale = (bands: number[]): void => {
    bands.forEach((band, i) => {
      const range = rescaleFor(band, i);
      if (range) params.push(['rescale', `${range[0]},${range[1]}`]);
    });
  };

  if (state.mode === 'index') {
    // Operands of (A - B) / (A + B); band-math indexes are 1-based like bidx.
    const a = state.bands[0] || 1;
    const b = state.bands[1] || 2;
    params.push(['expression', `(b${a}-b${b})/(b${a}+b${b})`]);
    const colormap = colormapName(state);
    if (colormap) params.push(['colormap_name', colormap]);
    const range = state.rescale?.[0] ?? [-1, 1];
    params.push(['rescale', `${range[0]},${range[1]}`]);
    return withNodata(params, state);
  }

  if (state.mode === 'single') {
    const band = state.bands[0] || 1;
    params.push(['bidx', String(band)]);
    const colormap = colormapName(state);
    if (colormap) params.push(['colormap_name', colormap]);
    pushRescale([band]);
    return withNodata(params, state);
  }

  // RGB composite: up to three channels.
  const bands = (state.bands.length ? state.bands : [1, 2, 3]).slice(0, 3);
  for (const band of bands) params.push(['bidx', String(band || 1)]);
  pushRescale(bands.map((b) => b || 1));
  return withNodata(params, state);
}

/** The `colormap_name` for a colormapped layer, or null when the embedded
 * palette should be used (TiTiler applies the COG's internal colormap itself).
 * Appends the `_r` suffix TiTiler uses for reversed matplotlib ramps. */
function colormapName(state: RasterLayerState): string | null {
  const name = state.colormap;
  if (!name || name === PALETTE_COLORMAP) return null;
  return state.reversed ? `${name}_r` : name;
}

/** Appends a numeric `nodata` override, when set. */
function withNodata(
  params: [string, string][],
  state: RasterLayerState,
): [string, string][] {
  if (typeof state.nodata === 'number') {
    params.push(['nodata', String(state.nodata)]);
  }
  return params;
}

/**
 * Builds the TiTiler `tilejson.json` request URL for a source.
 *
 * The tilejson response carries a ready-made tile URL template (with the render
 * params baked in) plus the source's bounds and zoom range, so one request
 * serves both rendering and the map fit — for a COG and a MosaicJSON alike.
 *
 * @param endpoint - TiTiler base URL (no trailing path)
 * @param kind - Which TiTiler router to use
 * @param url - The COG or MosaicJSON URL (the `url` query param)
 * @param params - Render params from {@link buildTiTilerParams}
 * @returns The absolute tilejson.json URL
 */
export function buildTileJsonUrl(
  endpoint: string,
  kind: TiTilerKind,
  url: string,
  params: [string, string][],
): string {
  const base = endpoint.replace(/\/+$/, '');
  const search = new URLSearchParams();
  search.set('url', url);
  for (const [key, value] of params) search.append(key, value);
  return `${base}/${kind}/${TITILER_TMS}/tilejson.json?${search.toString()}`;
}

/**
 * Rewrites a tilejson tile template's origin to the configured endpoint.
 *
 * TiTiler fills the template's scheme/host from the request it saw, which
 * behind a proxy is often plain `http://…` — a mixed-content failure on an
 * HTTPS page. Re-basing onto the endpoint the caller actually configured keeps
 * the exact path and query TiTiler chose while guaranteeing a usable origin.
 *
 * @param tileUrl - A tile URL template from a tilejson response
 * @param endpoint - The configured TiTiler base URL
 * @returns The template with its origin replaced by the endpoint's
 */
export function rebaseTileUrl(tileUrl: string, endpoint: string): string {
  const base = endpoint.replace(/\/+$/, '');
  try {
    const origin = new URL(tileUrl).origin;
    return base + tileUrl.slice(origin.length);
  } catch {
    // Not absolute (already a path): join onto the endpoint.
    return tileUrl.startsWith('/') ? base + tileUrl : `${base}/${tileUrl}`;
  }
}

/** The tile pixel size encoded in a TiTiler tile template (`tilesize=NNN`),
 * or null when absent. TiTiler serves 256px tiles by default; the tilejson may
 * request a different size. */
export function tileSizeOf(tileUrl: string): number | null {
  const match = /[?&]tilesize=(\d+)/.exec(tileUrl);
  if (!match) return null;
  const size = Number(match[1]);
  return Number.isFinite(size) && size > 0 ? size : null;
}
