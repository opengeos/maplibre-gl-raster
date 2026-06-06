import type { Map } from 'maplibre-gl';

/** Rendering mode: RGB composite (one band per channel) or single band
 * through a colormap. */
export type RasterMode = 'rgb' | 'single';

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
  /** 1-indexed band selection: [r, g, b] in RGB mode, [band] in single mode. */
  bands: number[];
  /** Per-channel [min, max] rescale windows; null = auto (2-98% percentile
   * from computed stats). */
  rescale: [number, number][] | null;
  /** Colormap name (single-band mode only). 'palette' uses the image's
   * embedded color table; defaults to 'gray'. */
  colormap: string;
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
}

/** Where a raster layer's data came from. */
export type RasterLayerSource =
  | { kind: 'url'; url: string }
  | { kind: 'file'; fileName: string; objectUrl: string };

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
  /** Band count, known once the GeoTIFF header loads. */
  bandCount: number | null;
  /** 1-indexed band names parsed from GDAL_METADATA, when present. */
  bandNames: globalThis.Map<number, string> | null;
  /** Map style layer id the raster is inserted beneath, when set. */
  beforeId: string | null;
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
