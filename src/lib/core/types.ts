import type { EpsgResolver } from '@developmentseed/proj';
import type { ControlPosition, Map } from 'maplibre-gl';
import type { ColorbarOrientation } from './Colorbar';

/** Rendering mode: RGB composite (one band per channel), a single band
 * through a colormap, or a normalized-difference index of two bands through a
 * colormap. */
export type RasterMode = 'rgb' | 'single' | 'index';

/**
 * Which backend renders the raster layers:
 * - `'maplibre-gl-raster'` — the default GPU pipeline (a deck.gl `COGLayer` on
 *   a shared `MapboxOverlay`). Also renders a mosaic (MosaicJSON or STAC
 *   `FeatureCollection`) client-side as a deck.gl `MosaicLayer` — one
 *   `COGLayer` per in-view asset, read directly over HTTP.
 * - `'cog-tiler-wasm'` — a serverless CPU/WASM tiler ([cog-tiler-wasm](https://github.com/opengeos/cog-tiler-wasm))
 *   wired to a MapLibre custom protocol; loaded lazily on first use. Also
 *   renders a mosaic, compositing the assets that cover each tile as that tile
 *   is requested.
 * - `'titiler'` — a server-side dynamic tiler ([TiTiler](https://developmentseed.org/titiler/)):
 *   tiles are rendered by a remote TiTiler instance and drawn as a native
 *   MapLibre raster layer. Renders a MosaicJSON server-side (so it reaches
 *   assets a browser can't, e.g. non-CORS buckets). Configure the instance with
 *   {@link RasterControlOptions.titilerEndpoint}.
 *
 * Both mosaic kinds render on `'maplibre-gl-raster'` (default) and
 * `'cog-tiler-wasm'`; only a MosaicJSON also renders on `'titiler'`.
 *
 * The choice is global (it applies to every layer), not per-layer.
 */
export type RenderEngine =
  | 'maplibre-gl-raster'
  | 'cog-tiler-wasm'
  | 'titiler';

/**
 * Per-layer colorbar legend config. When `visible`, the control shows a
 * {@link import('./Colorbar').Colorbar} for the (single-band) layer, driven by
 * its colormap, `reversed` flag, and effective rescale range. The fields here
 * are the parts the data can't supply.
 */
export interface RasterColorbarState {
  /** Whether the legend is shown for this layer. */
  visible: boolean;
  /** Legend title; defaults to the layer name when empty. */
  title?: string;
  /** Horizontal alignment of the title. @default 'left' */
  titleAlign?: 'left' | 'center' | 'right';
  /** Unit suffix appended to tick labels. */
  units?: string;
  /** Fixed decimal places for tick labels; omitted = compact auto format. */
  decimals?: number;
  /** Bar orientation. @default 'horizontal' */
  orientation?: ColorbarOrientation;
  /** Map corner to dock the legend in. @default 'bottom-right' */
  position?: ControlPosition;
}

/** Curve applied to the rescaled [0, 1] value before gamma / colormap.
 * "log" expands the low-value range (useful for skewed data with most
 * variation near zero); "sqrt" is a gentler version. */
export type RasterStretch = 'linear' | 'log' | 'sqrt';

/** Nodata handling: 'auto' reads the value declared by the COG (and treats
 * NaN as nodata for float data), a number overrides it in source units, and
 * 'off' renders every pixel. */
export type RasterNodata = number | 'off' | 'auto';

/**
 * Per-layer visualization state.
 */
export interface RasterLayerState {
  /** Rendering mode. */
  mode: RasterMode;
  /** 1-indexed band selection: [r, g, b] in RGB mode, [band] in single mode,
   * [A, B] in index mode (the operands of `(A - B) / (A + B)`). */
  bands: number[];
  /** Selected normalized-difference index preset id (index mode only), e.g.
   * `'ndvi'` or `'custom'`. See `NORMALIZED_DIFFERENCE_INDICES`. Ignored in
   * other modes. */
  index?: string;
  /** Per-channel [min, max] rescale windows; null = auto (2-98% percentile
   * from computed stats). */
  rescale: [number, number][] | null;
  /** Colormap name (single-band mode only). 'palette' uses the image's
   * embedded color table; defaults to 'gray'. */
  colormap: string;
  /** Sample the colormap back-to-front (single-band named colormaps only;
   * ignored for 'palette', whose entries are categorical). Equivalent to a
   * reversed variant of the ramp. */
  reversed: boolean;
  /** Nodata handling. */
  nodata: RasterNodata;
  /** Layer transparency, 0 (invisible) to 1 (fully opaque). */
  opacity: number;
  /** Power-law gamma correction (1.0 = off). */
  gamma: number;
  /** Curve applied to rescaled values. */
  stretch: RasterStretch;
  /** Whether the layer is drawn on the map. */
  visible: boolean;
  /** Minimum map zoom at which the layer is drawn. Follows MapLibre layer
   * semantics: at zooms below this the layer is hidden. Defaults to 0 when
   * omitted. */
  minZoom?: number;
  /** Maximum map zoom at which the layer is drawn. Follows MapLibre layer
   * semantics: at zooms at or above this the layer is hidden. Defaults to 24
   * when omitted. */
  maxZoom?: number;
  /** Optional colorbar legend shown on the map for this layer. */
  colorbar?: RasterColorbarState;
}

/** Lowest zoom a layer can be constrained to (MapLibre's minimum). */
export const RASTER_MIN_ZOOM = 0;
/** Highest zoom a layer can be constrained to (MapLibre's maximum). */
export const RASTER_MAX_ZOOM = 24;

/** Where a raster layer's data came from. */
export type RasterLayerSource =
  | { kind: 'url'; url: string }
  | { kind: 'file'; fileName: string; objectUrl: string };

/** Geographic (WGS84) bounds of a layer, as reported by COGLayer. */
export type GeographicBounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

/**
 * Public, read-only snapshot of a raster layer.
 */
export interface RasterLayerInfo {
  /** Stable layer id. */
  id: string;
  /** Display name shown in the layer list. */
  name: string;
  /** Data source. */
  source: RasterLayerSource;
  /** For a layer loaded from a mosaic VRT, the member COG URLs it expanded to
   * (in VRT source order); null for a plain single-file raster. */
  memberUrls: string[] | null;
  /** Band count, known once the GeoTIFF header loads. */
  bandCount: number | null;
  /** 1-indexed band names parsed from GDAL_METADATA, when present. */
  bandNames: globalThis.Map<number, string> | null;
  /** Map style layer id the raster is inserted beneath, when set. */
  beforeId: string | null;
  /** Attribution shown in the map's attribution control while the layer is
   * visible, when set. */
  attribution: string | null;
  /** Geographic (WGS84) bounds, known once the raster renders. A
   * 'rasterchange' event fires when they become available. */
  bounds: GeographicBounds | null;
  /** Whether the GeoTIFF header is still loading. */
  loading: boolean;
  /** Load error, when the GeoTIFF failed to load. */
  error: Error | null;
  /** Current visualization state. */
  state: RasterLayerState;
}

/**
 * Options for {@link AddRasterOptions} consumers (RasterControl.addRaster).
 */
export interface AddRasterOptions {
  /** Layer id; auto-generated when omitted. */
  id?: string;
  /** Display name; derived from the URL / file name when omitted. */
  name?: string;
  /** Initial visualization state overrides (mode/bands default from the
   * loaded band count). */
  state?: Partial<RasterLayerState>;
  /** Fit the map to the raster's bounds once loaded. @default true */
  zoomTo?: boolean;
  /** Id of an existing map style layer to insert the raster beneath (e.g. a
   * symbol layer so labels stay readable). Drawn on top when omitted or when
   * the layer does not exist. */
  beforeId?: string;
  /** Attribution shown in the map's attribution control while the layer is
   * visible (plain text or HTML, e.g. an anchor tag; MapLibre sanitizes it). */
  attribution?: string;
}

/**
 * A named sample dataset offered as a one-click entry in the panel's
 * "Load sample data" dropdown. Picking it fills the Add data URL input.
 */
export interface RasterSampleDataset {
  /** Label shown in the dropdown (e.g. 'Land cover'). */
  label: string;

  /** COG URL filled into the Add data input when this entry is picked. */
  url: string;

  /** Attribution filled into the panel's Attribution input when this entry is
   * picked (shown in the map's attribution control while the layer is
   * visible). Leaves the input untouched when omitted. */
  attribution?: string;
}

/**
 * Options for configuring the RasterControl
 */
export interface RasterControlOptions {
  /**
   * Whether the control panel should start collapsed (showing only the toggle button)
   * @default true
   */
  collapsed?: boolean;

  /**
   * Position of the control on the map
   * @default 'top-right'
   */
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

  /**
   * Title displayed in the control header
   * @default 'Raster'
   */
  title?: string;

  /**
   * Width of the control panel in pixels
   * @default 360
   */
  panelWidth?: number;

  /**
   * Custom CSS class name for the control container
   */
  className?: string;

  /**
   * Render the deck.gl overlay interleaved with the basemap's layers.
   * @default true
   */
  interleaved?: boolean;

  /**
   * Which rendering backend to start with. Users can switch at runtime from the
   * panel; this only sets the initial choice. The `'cog-tiler-wasm'` engine is
   * loaded lazily (it adds a wasm tiler and its peer dependencies), so the
   * default keeps the bundle lean.
   * @default 'maplibre-gl-raster'
   */
  engine?: RenderEngine;

  /**
   * Base URL of the TiTiler instance used by the `'titiler'` rendering engine.
   * Any deployment exposing the standard `/cog` and `/mosaicjson` routers
   * works. Ignored by the other engines.
   * @default 'https://titiler.d2s.org'
   */
  titilerEndpoint?: string;

  /**
   * Prefills the "Add data" URL input with this COG URL. The raster is only
   * loaded automatically when {@link autoLoad} is true; otherwise the user
   * still clicks Load.
   * @default ''
   */
  defaultUrl?: string;

  /**
   * When true and {@link defaultUrl} is set, the raster is loaded as soon as
   * the control is added to the map (instead of prefilling the URL input).
   * @default false
   */
  autoLoad?: boolean;

  /**
   * Sample datasets offered as a one-click "Load sample data" dropdown above
   * the Add data URL input. Picking one fills the input (the user still clicks
   * Load). Omit or leave empty to hide the dropdown, so the input stays clean
   * for the user's own URLs instead of a prefilled sample.
   */
  sampleData?: RasterSampleDataset[];

  /**
   * Placeholder shown in the sample-data dropdown before a selection.
   * Ignored when {@link sampleData} is empty.
   * @default 'Load sample data...'
   */
  sampleDataLabel?: string;

  /**
   * Collapse the panel when the user clicks outside it (e.g. on the map). Set
   * to `false` to keep the panel open until the header close button is used.
   * @default true
   */
  closeOnOutsideClick?: boolean;

  /**
   * Resolves a GeoTIFF's numeric EPSG code to a projection definition used for
   * reprojection. Defaults to {@link createResilientEpsgResolver}, which
   * answers common CRS offline and looks the rest up from epsg.io. Supply a
   * fully offline resolver (e.g. backed by a local EPSG database) to remove the
   * network dependency entirely. Resolution failures surface as a layer error.
   */
  epsgResolver?: EpsgResolver;
}

/**
 * Internal state of the plugin control
 */
export interface RasterControlState {
  /**
   * Whether the control panel is currently collapsed
   */
  collapsed: boolean;

  /**
   * Current panel width in pixels
   */
  panelWidth: number;

  /**
   * Any custom state data
   */
  data?: Record<string, unknown>;
}

/**
 * Props for the React wrapper component
 */
export interface RasterControlReactProps extends RasterControlOptions {
  /**
   * MapLibre GL map instance
   */
  map: Map;

  /**
   * Callback fired when the control state changes
   */
  onStateChange?: (state: RasterControlState) => void;

  /**
   * Callback fired once the control is added to the map, with the control
   * instance — use it to call imperative methods like addRaster().
   */
  onReady?: (control: import('./RasterControl').RasterControl) => void;
}

/**
 * Event types emitted by the raster control
 */
export type RasterControlEvent =
  | 'collapse'
  | 'expand'
  | 'statechange'
  | 'rasteradd'
  | 'rasterremove'
  | 'rasterchange'
  | 'rasterselect'
  | 'error';

/**
 * Event payload passed to registered handlers.
 */
export interface RasterControlEventData {
  type: RasterControlEvent;
  state: RasterControlState;
  /** Affected layer id for raster* events. */
  layerId?: string;
  /** Error detail for 'error' events. */
  error?: Error;
}

/**
 * Event handler function type
 */
export type RasterControlEventHandler = (event: RasterControlEventData) => void;
