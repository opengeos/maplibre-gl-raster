import type { Layer } from '@deck.gl/core';
import { MapboxOverlay } from '@deck.gl/mapbox';
import {
  COGLayer,
  MosaicLayer,
  type MosaicSource,
} from '@developmentseed/deck.gl-geotiff';
import {
  createColormapTexture,
  decodeColormapSprite,
} from '@developmentseed/deck.gl-raster/gpu-modules';
import { parseColormap, type GeoTIFF } from '@developmentseed/geotiff';
import type { EpsgResolver } from '@developmentseed/proj';
import type { Device, Texture } from '@luma.gl/core';
import type { Map as MapLibreMap } from 'maplibre-gl';
import {
  RASTER_MAX_ZOOM,
  RASTER_MIN_ZOOM,
  type AddRasterOptions,
  type RasterLayerState,
  type RenderEngine,
} from '../core/types';
import { colormapsPngUrl } from '../raster/colormaps';
import { createResilientEpsgResolver } from '../raster/epsg-resolver';
import { loadGeoTIFF as defaultLoadGeoTIFF } from '../raster/load-geotiff';
import {
  buildIndexCompositeRenderTile,
  buildPaletteCompositeRenderTile,
  buildRgbCompositeRenderTile,
  buildSingleCompositeRenderTile,
} from '../raster/render-pipeline';
import {
  computeAutoStats as defaultComputeAutoStats,
  mergeAutoStats,
  readBandNames,
  type AutoStats,
} from '../raster/stats';
import {
  makeMultiBandTileLoader,
  MAX_BAND_SLOTS,
  type MultiBandTileData,
} from '../raster/tile-loader';
import { WebMercatorCOGLayer } from '../raster/web-mercator-cog-layer';
import {
  isVrtFile,
  isVrtUrl,
  loadVrt as defaultLoadVrt,
  VrtUnsupportedError,
  type VrtMosaic,
} from '../raster/vrt';
import { generateId } from '../utils/helpers';
import {
  CogTilerEngine,
  type CogEngineLayer,
  type CogTilerModule,
  COG_TILER_COLORMAPS,
} from './CogTilerEngine';
import {
  defaultFetchTileJson,
  TiTilerEngine,
  type TiTilerEngineLayer,
} from './TiTilerEngine';
import {
  DEFAULT_TITILER_ENDPOINT,
  isMosaicJsonUrl,
  type TiTilerTileJson,
} from '../raster/titiler';
import {
  loadMosaic as defaultLoadMosaic,
  mosaicInitialView,
  mosaicMinZoom,
  type MosaicAsset,
  type ParsedMosaic,
} from '../raster/mosaic';

/** A deck.gl {@link MosaicSource} augmented with the asset URL the engine opens
 * and renders. */
type MosaicRenderSource = MosaicSource & { url: string };
import {
  createLayerState,
  deriveLayerName,
  type GeographicBounds,
  type RasterLayer,
  type RasterMember,
} from './RasterLayer';

/** Default engine when none is configured: the deck.gl GPU pipeline. */
export const DEFAULT_ENGINE: RenderEngine = 'maplibre-gl-raster';

/**
 * Most member COGs a mosaic VRT may expand to.
 *
 * Every member becomes its own tiled layer with its own tile cache and its own
 * stream of range requests, so a large mosaic (a country-scale VRT can list
 * hundreds of tiles) would exhaust the browser rather than draw slowly. Failing
 * with a message that names the fix is more useful than hanging the page.
 */
export const MAX_VRT_MEMBERS = 32;

/** Separator between a layer id and its member index in per-member render layer
 * ids. Chosen so it cannot collide with `generateId`'s output — but a
 * caller-supplied id may contain it, so only the *last* occurrence marks the
 * suffix these helpers added. */
const MEMBER_ID_SEPARATOR = '::m';

/** Strips the member suffix added by {@link memberLayerId}, yielding the id of
 * the owning RasterLayer. */
function ownerLayerId(renderId: string): string {
  const index = renderId.lastIndexOf(MEMBER_ID_SEPARATOR);
  return index === -1 ? renderId : renderId.slice(0, index);
}

/** Render-layer id for one member of a mosaic layer. */
function memberLayerId(layerId: string, memberIndex: number): string {
  return `${layerId}${MEMBER_ID_SEPARATOR}${memberIndex}`;
}

/** The member index encoded in a render-layer id, or null when the id belongs
 * to a plain (non-mosaic) layer. */
function memberIndexOf(renderId: string): number | null {
  const at = renderId.lastIndexOf(MEMBER_ID_SEPARATOR);
  if (at === -1) return null;
  const index = Number(renderId.slice(at + MEMBER_ID_SEPARATOR.length));
  return Number.isInteger(index) && index >= 0 ? index : null;
}

/** The smallest bounds containing all of `bounds`. */
function unionBounds(bounds: GeographicBounds[]): GeographicBounds | null {
  if (bounds.length === 0) return null;
  return bounds.reduce((acc, b) => ({
    west: Math.min(acc.west, b.west),
    south: Math.min(acc.south, b.south),
    east: Math.max(acc.east, b.east),
    north: Math.max(acc.north, b.north),
  }));
}

/**
 * Rejects a GeoTIFF that cannot be streamed as map tiles.
 *
 * Both rendering engines stream tiles on demand, so the source must be a tiled
 * Cloud-Optimized GeoTIFF. A striped GeoTIFF (common for files exported from
 * desktop GIS) has no tile grid: the deck.gl path throws 'Tiff is not tiled'
 * deep inside an un-awaited parse step, which surfaces only as a console error
 * while the layer renders blank with a default [0, 1] rescale window. Detect it
 * up front and fail the layer with an actionable message instead. See
 * opengeos/GeoLibre#789.
 *
 * @param tiff - The loaded header
 * @param label - Source description for the message; omit for the layer's own
 *   file, pass a member URL when checking a VRT source
 */
function assertTiled(tiff: GeoTIFF, label?: string): void {
  if (tiff.isTiled) return;
  const subject = label
    ? `The VRT source "${label}" is striped, not tiled,`
    : 'This GeoTIFF is striped, not tiled,';
  throw new Error(
    `${subject} so it cannot be streamed as map tiles. Convert it to a tiled ` +
      'Cloud-Optimized GeoTIFF (COG) first, for example with `rio cogeo ' +
      'create input.tif output.tif` or `gdal_translate input.tif output.tif ' +
      '-of COG`, then load the result.',
  );
}

/**
 * Clamps a bounds' latitudes to the valid WGS84 range. GeoTIFF bounds are
 * derived as `origin + n * pixelSize`, so a global raster whose pixel size was
 * stored rounded (e.g. GEBCO's 1/240° stored as 0.004166666666667) can
 * overshoot the poles by a floating-point epsilon — and MapLibre's LngLat
 * rejects any latitude outside [-90, 90], crashing fitBounds. Longitudes are
 * left alone: MapLibre accepts any longitude, and clamping would corrupt
 * antimeridian-crossing rasters.
 */
function clampBoundsLatitude(bounds: GeographicBounds): GeographicBounds {
  const clamp = (lat: number) => Math.min(90, Math.max(-90, lat));
  const south = clamp(bounds.south);
  const north = clamp(bounds.north);
  if (south === bounds.south && north === bounds.north) return bounds;
  return { ...bounds, south, north };
}

/**
 * The band indexes a layer actually samples, deduped and sorted. Mirrors the
 * `requested` logic in render-pipeline's buildRenderTile: RGB samples the first
 * three entries (R, G, B); single-band / colormap / palette the first one. The
 * render pipeline looks textures up by band number, not slot order, so the
 * fetch order is irrelevant — sorting makes the set order-independent, so
 * reassigning RGB channels among the same bands does not force a refetch.
 * Always yields at least band 1 so a layer with an empty/invalid selection
 * still fetches something to draw.
 *
 * The sampled channels are sliced off **before** dedupe/sort so a state that
 * carries more entries than channels (e.g. `bands: [12, 1, 2, 3, 4]`) can't
 * sort-then-cap a band that a channel still samples (here the red channel's
 * 12) out of the fetched set. By construction the result is ≤ 3 entries — well
 * within the CompositeBands shader's {@link MAX_BAND_SLOTS} texture slots.
 */
function fetchBandsFor(layer: RasterLayer): number[] {
  const bands = layer.state.bands;
  const sampled =
    layer.state.mode === 'rgb'
      ? (bands && bands.length > 0 ? bands : [1, 2, 3]).slice(0, 3)
      : layer.state.mode === 'index'
        ? // Index mode needs both operands of (A - B) / (A + B).
          (bands && bands.length > 0 ? bands : [1, 2]).slice(0, 2)
        : [bands?.[0] ?? 1];
  const unique = [
    ...new Set(sampled.filter((b) => Number.isInteger(b) && b >= 1)),
  ].sort((a, b) => a - b);
  if (unique.length === 0) unique.push(1);
  return unique.slice(0, MAX_BAND_SLOTS);
}

/**
 * The deck.gl layer id for a raster layer, with its fetched band set encoded.
 *
 * The tile loader only fetches {@link fetchBandsFor} (≤ MAX_BAND_SLOTS) bands,
 * so a single-band view of e.g. band 12 needs band 12 in the tile textures.
 * deck.gl's `TileLayer` does **not** refetch when `getTileData` changes — its
 * RasterTileLayer wrapper sets no `getTileData` updateTrigger, so a swapped
 * loader closure is silently ignored and the previously fetched bands stay
 * cached. The one reliable way to refetch is to remount the layer, which
 * deck.gl does when the layer id changes. Encoding the (sorted) band set in the
 * id therefore makes a band-selection change refetch the newly selected bands,
 * while leaving the id — and thus the tile cache — stable across opacity,
 * colormap, rescale and RGB-channel-reorder changes that don't alter the set.
 */
function cogLayerId(layer: RasterLayer, fetchBands: number[]): string {
  return `${layer.id}#b${fetchBands.join('-')}`;
}

/** Uploads an embedded color table as a 2D-array texture for the Colormap
 * shader module. Unlike `createColormapTexture` (which uses linear filtering
 * for smooth continuous colormaps), palette lookups must be NEAREST-filtered:
 * the shader samples at index/255, which lands between texel centers, and
 * linear filtering would blend each class color with its neighbors — mostly
 * unused black entries in typical land-cover palettes. */
function createPaletteTexture(device: Device, palette: ImageData): Texture {
  const bytes = new Uint8Array(
    palette.data.buffer,
    palette.data.byteOffset,
    palette.data.byteLength,
  );
  return device.createTexture({
    dimension: '2d-array',
    format: 'rgba8unorm',
    width: palette.width,
    height: 1,
    depth: 1,
    data: bytes,
    mipLevels: 1,
    sampler: {
      minFilter: 'nearest',
      magFilter: 'nearest',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
    },
  });
}

/** Parses the TIFF's embedded color table (ColorMap tag) into a 256x1 RGBA
 * ImageData, marking the declared nodata index transparent. Returns null
 * when the tag is absent or the palette isn't 8-bit (256 entries) — the GPU
 * colormap texture path only supports 256-texel tables. */
function extractPalette(tiff: GeoTIFF): ImageData | null {
  const cmap = tiff.cachedTags?.colorMap;
  if (!cmap || cmap.length !== 256 * 3) return null;
  const nodata = tiff.nodata;
  const nodataIndex =
    nodata !== null && Number.isInteger(nodata) && nodata >= 0 && nodata < 256
      ? nodata
      : undefined;
  try {
    return parseColormap(cmap, nodataIndex);
  } catch {
    return null;
  }
}

/** Events emitted by the LayerManager. */
export type LayerManagerEvent =
  | 'rasteradd'
  | 'rasterremove'
  | 'rasterchange'
  | 'rasterselect'
  | 'error';

/** Payload passed to LayerManager event handlers. */
export interface LayerManagerEventData {
  type: LayerManagerEvent;
  layerId?: string;
  error?: Error;
}

export type LayerManagerEventHandler = (event: LayerManagerEventData) => void;

/** Minimal overlay surface the manager drives. MapboxOverlay satisfies it;
 * tests inject a recorder. */
export interface OverlayLike {
  setProps(props: { layers?: unknown[] }): void;
}

/** Injectable collaborators, overridable in unit tests so no network or
 * WebGL is touched under jsdom. */
export interface LayerManagerDeps {
  loadGeoTIFF: (url: string) => Promise<GeoTIFF>;
  /** Fetches and parses a mosaic VRT into the member COGs to render. */
  loadVrt: (url: string, signal?: AbortSignal) => Promise<VrtMosaic>;
  /** Fetches and parses a mosaic manifest (MosaicJSON or STAC) into the member
   * COG assets to render. */
  loadMosaic: (url: string, signal?: AbortSignal) => Promise<ParsedMosaic>;
  computeAutoStats: (
    tiff: GeoTIFF,
    signal: AbortSignal,
    onProgress?: (partial: AutoStats) => void,
  ) => Promise<AutoStats>;
  /** Creates the deck.gl overlay and adds it to the map. */
  createOverlay: (
    map: MapLibreMap,
    options: { interleaved: boolean; onDeviceInitialized: (d: Device) => void },
  ) => OverlayLike;
  /** Removes a previously created overlay from the map. */
  removeOverlay: (map: MapLibreMap, overlay: OverlayLike) => void;
  /**
   * Resolves a GeoTIFF's numeric EPSG code to a projection definition for
   * reprojection. Defaults to a resolver that answers common CRS offline and
   * delegates the rest to epsg.io; supply a fully offline resolver to remove
   * the network dependency.
   */
  epsgResolver: EpsgResolver;
  /**
   * Loads the optional `cog-tiler-wasm` package for the CPU/WASM engine.
   * Defaults to a dynamic import so the wasm tiler and its peer dependencies
   * never enter the default bundle; overridable in tests.
   */
  loadCogTiler: () => Promise<CogTilerModule>;
  /** Fetches a TiTiler `tilejson.json` for the `titiler` engine (default:
   * `fetch`); overridable in tests so no network is touched. */
  fetchTileJson: (url: string) => Promise<TiTilerTileJson>;
}

const DEFAULT_DEPS: LayerManagerDeps = {
  loadGeoTIFF: defaultLoadGeoTIFF,
  loadVrt: defaultLoadVrt,
  loadMosaic: defaultLoadMosaic,
  computeAutoStats: defaultComputeAutoStats,
  epsgResolver: createResilientEpsgResolver(),
  // Resolved lazily: the package is an optional peer dependency, only loaded
  // when the user selects the cog-tiler-wasm engine. A literal specifier so
  // Vite/consumers resolve and code-split it; the lib build externalizes it
  // (see vite.config.ts) so it never enters the default bundle.
  loadCogTiler: () => import('cog-tiler-wasm'),
  fetchTileJson: defaultFetchTileJson,
  createOverlay: (map, options) => {
    const overlay = new MapboxOverlay({
      interleaved: options.interleaved,
      layers: [],
      onDeviceInitialized: options.onDeviceInitialized,
    });
    map.addControl(overlay);
    return overlay;
  },
  removeOverlay: (map, overlay) => {
    map.removeControl(overlay as unknown as MapboxOverlay);
  },
};

/**
 * Owns the raster layer list and the shared deck.gl overlay.
 *
 * Responsibilities:
 * - lazily creates one MapboxOverlay on first addRaster
 * - loads GeoTIFFs (with the CORS workaround) and computes auto-stats
 * - auto-picks mode/bands from the band count
 * - rebuilds the COGLayer array (stable per-layer ids preserve tile caches)
 * - emits rasteradd / rasterremove / rasterchange / rasterselect / error
 */
export class LayerManager {
  private _map: MapLibreMap;
  private _interleaved: boolean;
  private _deps: LayerManagerDeps;
  private _layers: RasterLayer[] = [];
  private _selectedId: string | null = null;
  /** Active rendering backend. */
  private _engine: RenderEngine = DEFAULT_ENGINE;
  /** The cog-tiler-wasm backend, created lazily when that engine is selected. */
  private _cogEngine: CogTilerEngine | null = null;
  /** The TiTiler backend, created lazily when that engine is selected. */
  private _titilerEngine: TiTilerEngine | null = null;
  /** Opened GeoTIFF headers for mosaic assets, keyed by URL, so the deck.gl
   * mosaic reuses them across renders instead of re-opening on every viewport
   * change. A failed open resolves to null (not a rejection) so MosaicLayer
   * skips the asset rather than crashing on a null tile. Cleared on destroy. */
  private _mosaicGeotiffs = new globalThis.Map<
    string,
    Promise<GeoTIFF | null>
  >();
  /** Memoized deck.gl mosaic sources per asset list, so a re-render reuses the
   * same array reference and MosaicLayer keeps its spatial index instead of
   * rebuilding it every time. */
  private _mosaicSources = new WeakMap<MosaicAsset[], MosaicRenderSource[]>();
  /** TiTiler instance the `titiler` engine renders through. */
  private _titilerEndpoint: string;
  private _overlay: OverlayLike | null = null;
  private _device: Device | null = null;
  private _colormapTexture: Texture | null = null;
  private _handlers = new globalThis.Map<
    LayerManagerEvent,
    Set<LayerManagerEventHandler>
  >();
  // Layer ids whose CRS could not be resolved. COGLayer only reprojects once
  // it has a projection, so these layers cannot render; they are excluded from
  // _rebuild (so the failing resolver is not retried in a render loop) and
  // their error is surfaced once via _failLayerCrs.
  private _crsFailed = new Set<string>();
  // Attribution strings currently applied to the map (via helper sources),
  // by layer id. See _syncAttributions.
  private _attributions = new globalThis.Map<string, string>();
  private _attribStyleReady = false;
  private _onAttribStyleData: (() => void) | null = null;
  private _destroyed = false;
  // Map 'zoom' listener that re-runs a deck.gl rebuild when a layer crosses a
  // min/max-zoom boundary. The native (cog-tiler-wasm / titiler) engines get
  // MapLibre's own per-layer minzoom/maxzoom, so they need no listener.
  private _onZoom: (() => void) | null = null;
  // Signature of the set of deck.gl layers currently within their zoom range,
  // so the zoom listener only rebuilds when that set actually changes.
  private _zoomVisibleSig = '';

  /**
   * Creates a LayerManager bound to a map.
   *
   * @param map - The MapLibre GL map instance
   * @param options - Overlay options (interleaved rendering)
   * @param deps - Injectable collaborators for testing
   */
  constructor(
    map: MapLibreMap,
    options?: {
      interleaved?: boolean;
      engine?: RenderEngine;
      titilerEndpoint?: string;
    },
    deps?: Partial<LayerManagerDeps>,
  ) {
    this._map = map;
    this._interleaved = options?.interleaved ?? true;
    this._engine = options?.engine ?? DEFAULT_ENGINE;
    this._titilerEndpoint =
      options?.titilerEndpoint?.trim() || DEFAULT_TITILER_ENDPOINT;
    this._deps = { ...DEFAULT_DEPS, ...deps };
    // Re-render the deck.gl overlay whenever the map crosses a layer's zoom
    // boundary, so per-layer minZoom/maxZoom hide/show the raster (the deck.gl
    // engine has no MapLibre layer to carry a native zoom range).
    this._onZoom = () => this._syncZoomVisibility();
    this._map.on('zoom', this._onZoom);
  }

  /** The id of the layer currently selected for editing, or null. */
  get selectedId(): string | null {
    return this._selectedId;
  }

  /** The active rendering backend. */
  get engine(): RenderEngine {
    return this._engine;
  }

  /** The TiTiler instance the `titiler` engine renders through. */
  get titilerEndpoint(): string {
    return this._titilerEndpoint;
  }

  /**
   * The colormap names the active engine can actually render, or null when it
   * supports every colormap the panel offers.
   *
   * Only `cog-tiler-wasm` is limited: it knows a fixed set compiled into the
   * wasm, and renders an unknown name with its `gray` ramp rather than the
   * requested one — which reads as "the colormap was ignored". The panel
   * narrows its picker to this set so a user cannot pick a ramp that will not
   * draw as chosen. The deck.gl engine draws the full sprite, and TiTiler
   * resolves names server-side.
   *
   * The set comes from the loaded engine, not a hard-coded list, so a
   * `cog-tiler-wasm` release that adds ramps widens the picker with no change
   * here. Before the engine exists (or its module has loaded) the conservative
   * {@link COG_TILER_COLORMAPS} baseline applies.
   */
  get supportedColormaps(): ReadonlySet<string> | null {
    if (this._engine !== 'cog-tiler-wasm') return null;
    return this._cogEngine?.supportedColormaps ?? new Set(COG_TILER_COLORMAPS);
  }

  /**
   * Points the `titiler` engine at a different TiTiler instance. Empty input
   * restores the default endpoint. When the `titiler` engine is active, tiles
   * refetch from the new server immediately. A no-op when unchanged.
   *
   * @param endpoint - TiTiler base URL, or empty for the default
   */
  setTitilerEndpoint(endpoint: string): void {
    const next = endpoint.trim() || DEFAULT_TITILER_ENDPOINT;
    if (next === this._titilerEndpoint) return;
    this._titilerEndpoint = next;
    this._titilerEngine?.setEndpoint(next);
    if (this._engine === 'titiler') {
      // Re-render every layer from the new server.
      this._titilerEngine?.clear();
      this._rebuild();
    }
    this._emit({ type: 'rasterchange' });
  }

  /**
   * Switches the rendering backend for every layer. Tears down the previous
   * backend's map artifacts and re-renders with the new one. A no-op when the
   * engine is unchanged.
   *
   * @param engine - The backend to use
   */
  setEngine(engine: RenderEngine): void {
    if (engine === this._engine) return;
    this._engine = engine;
    // Tear down the map artifacts of every engine that is no longer active, so
    // two engines never draw the same layer at once.
    if (engine !== 'maplibre-gl-raster') this._overlay?.setProps({ layers: [] });
    if (engine !== 'cog-tiler-wasm') this._cogEngine?.clear();
    if (engine !== 'titiler') this._titilerEngine?.clear();
    // Ensure the newly active engine's artifacts exist before rendering into
    // them — switching to deck.gl before any layer was added on it must create
    // the overlay, or _rebuild would render nothing.
    this._ensureEngine();
    this._rebuild();
    this._emit({ type: 'rasterchange' });
  }

  /** All managed layers in draw order (first = bottom). */
  getLayers(): RasterLayer[] {
    return [...this._layers];
  }

  /** Looks up a layer by id. */
  getLayer(id: string): RasterLayer | undefined {
    return this._layers.find((l) => l.id === id);
  }

  /**
   * Adds a raster layer from a remote URL or a local File.
   *
   * The layer appears in the list immediately (loading state) and renders
   * once the GeoTIFF header loads. Resolves with the layer id after the
   * header loads; rejects (and emits 'error') when loading fails.
   *
   * @param source - COG URL or a local GeoTIFF File
   * @param options - Id/name/state overrides and zoom behavior
   * @returns The new layer's id
   */
  async addRaster(
    source: string | File,
    options?: AddRasterOptions,
  ): Promise<string> {
    const id = options?.id ?? generateId('raster');
    if (this.getLayer(id)) {
      throw new Error(`Raster layer id "${id}" already exists`);
    }
    const isFile = typeof source !== 'string';
    const url = isFile ? URL.createObjectURL(source) : source;
    // A `.json` source is a mosaic manifest (MosaicJSON or STAC), not a single
    // GeoTIFF, so it takes a distinct load path below. A local `.json` file is
    // parsed from its blob URL and rendered client-side by deck.gl (its member
    // COGs are absolute URLs); TiTiler can only render a remote manifest.
    const mosaicJson = isMosaicJsonUrl(isFile ? source.name : source);
    const layer: RasterLayer = {
      id,
      name: options?.name ?? deriveLayerName(isFile ? source.name : source),
      source: isFile
        ? { kind: 'file', fileName: source.name, objectUrl: url }
        : { kind: 'url', url },
      url,
      file: isFile ? source : null,
      state: createLayerState(options?.state),
      userPickedMode:
        options?.state?.mode !== undefined ||
        options?.state?.bands !== undefined,
      geotiff: null,
      members: null,
      isMosaicJson: mosaicJson,
      mosaicKind: null,
      mosaicAssets: null,
      mosaicMinzoom: null,
      autoStats: null,
      bandCount: null,
      bandNames: null,
      palette: null,
      paletteTexture: null,
      beforeId: options?.beforeId?.trim() || null,
      attribution: options?.attribution?.trim() || null,
      bounds: null,
      zoomTo: options?.zoomTo ?? true,
      loading: true,
      error: null,
      abort: new AbortController(),
    };

    this._layers.push(layer);
    this._ensureEngine();
    this.select(layer.id);
    this._emit({ type: 'rasteradd', layerId: layer.id });

    try {
      // A mosaic manifest (MosaicJSON or STAC) has no single local GeoTIFF. It
      // is rendered client-side as a deck.gl mosaic (one COGLayer per in-view
      // asset) or, for a MosaicJSON, server-side by TiTiler. Parse it into its
      // assets + extent, then pick an engine that can draw it.
      if (mosaicJson) {
        await this._openMosaic(layer, url);
        if (this._destroyed || !this.getLayer(layer.id)) return layer.id;
        layer.loading = false;
        // A STAC mosaic has no TiTiler equivalent and a local file's blob URL is
        // unreachable by the server, so those fall back to the default GPU
        // engine. deck.gl always renders a mosaic; cog-tiler-wasm composites the
        // covering assets per tile (its assets are read by URL, so a manifest
        // dropped as a local file works too); TiTiler renders only a remote
        // MosaicJSON.
        const canRender =
          this._engine === 'maplibre-gl-raster' ||
          this._engine === 'cog-tiler-wasm' ||
          (this._engine === 'titiler' &&
            layer.mosaicKind === 'mosaicjson' &&
            !isFile);
        if (!canRender) {
          // setEngine rebuilds (rendering the new layer) and emits rasterchange.
          this.setEngine(DEFAULT_ENGINE);
        } else {
          this._ensureEngine();
          this._rebuild();
          this._emit({ type: 'rasterchange', layerId: layer.id });
        }
        if (layer.bounds && layer.zoomTo) {
          layer.zoomTo = false;
          if (this._engine === 'titiler') {
            // TiTiler renders the whole mosaic server-side as one raster source,
            // so fit the full extent — floored to the native minzoom, below
            // which no tiles exist.
            this._fitBounds(layer.bounds, layer.mosaicMinzoom ?? undefined);
          } else {
            // deck.gl draws one COGLayer per in-view asset; cap the initial
            // view of a large mosaic so it doesn't render hundreds at once.
            this._fitBounds(
              mosaicInitialView(layer.bounds, layer.mosaicAssets ?? []),
            );
          }
        }
        return layer.id;
      }
      // A .vrt is a manifest, not raster data: expand it into its member COGs.
      // Everything downstream reads the first member, which the expansion
      // requires every other member to agree with (see _openVrt).
      if (isFile ? isVrtFile(source) : isVrtUrl(source)) {
        await this._openVrt(layer, url);
      } else {
        const tiff = await this._deps.loadGeoTIFF(url);
        if (this._destroyed || !this.getLayer(layer.id)) return layer.id;
        assertTiled(tiff);
        layer.geotiff = tiff;
        layer.bandCount = tiff.count;
      }
      if (this._destroyed || !this.getLayer(layer.id)) return layer.id;
      const tiff = layer.geotiff!;
      layer.bandNames = readBandNames(tiff);
      layer.palette = extractPalette(tiff);
      layer.loading = false;
      if (!layer.userPickedMode) {
        // 1 or 2 bands → single + colormap. RGB on 2 bands leaves blue empty.
        if (layer.bandCount! >= 3) {
          layer.state.mode = 'rgb';
          layer.state.bands = [1, 2, 3];
        } else {
          layer.state.mode = 'single';
          layer.state.bands = [1];
          // Prefer the image's embedded color table when it carries one;
          // otherwise the 'gray' default from DEFAULT_LAYER_STATE applies.
          if (layer.palette) layer.state.colormap = 'palette';
        }
      }
      this._rebuild();
      this._emit({ type: 'rasterchange', layerId: layer.id });
      this._computeStats(layer);
      return layer.id;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (!this._destroyed && this.getLayer(layer.id)) {
        layer.loading = false;
        layer.error = error;
        this._emit({ type: 'error', layerId: layer.id, error });
        this._emit({ type: 'rasterchange', layerId: layer.id });
      }
      throw error;
    }
  }

  /**
   * Expands a mosaic VRT into the member COGs the layer renders.
   *
   * Populates `layer.members` plus the band metadata the rest of the manager
   * reads. Band count comes from the VRT (not from the member headers) so a
   * VRT that exposes a subset of its sources' bands still shows what it
   * declares; members are required to carry at least that many bands, since
   * every band N is read from band N of each member (`parseVrt` rejects any
   * VRT that remaps bands).
   *
   * @param layer - The layer being added; mutated in place
   * @param url - URL the `.vrt` is fetched from
   * @throws {VrtUnsupportedError} When the VRT needs GDAL to render
   */
  private async _openVrt(layer: RasterLayer, url: string): Promise<void> {
    const mosaic = await this._deps.loadVrt(url, layer.abort.signal);
    if (this._destroyed || !this.getLayer(layer.id)) return;

    if (mosaic.members.length > MAX_VRT_MEMBERS) {
      throw new VrtUnsupportedError(
        `This VRT mosaics ${mosaic.members.length} files. Each one is drawn as ` +
          `its own tiled layer here, and more than ${MAX_VRT_MEMBERS} would ` +
          'overwhelm the browser. Merge it into a single Cloud-Optimized ' +
          'GeoTIFF first with `gdal_translate mosaic.vrt mosaic.tif -of COG`, ' +
          'then load that.',
      );
    }

    // Members are independent HTTP reads; fetch the headers concurrently. The
    // count is bounded by MAX_VRT_MEMBERS above.
    const tiffs = await Promise.all(
      mosaic.members.map(async (member) => {
        try {
          return await this._deps.loadGeoTIFF(member.url);
        } catch (cause) {
          const detail = cause instanceof Error ? cause.message : String(cause);
          const error = new Error(
            `This VRT references "${member.url}", which could not be loaded ` +
              `(${detail}). Every source must be a CORS-enabled Cloud-` +
              'Optimized GeoTIFF reachable from the browser.',
          );
          // Preserve the underlying cause without relying on the ErrorOptions
          // constructor argument (not in this project's TS lib target).
          if (cause instanceof Error) {
            (error as { cause?: unknown }).cause = cause;
          }
          throw error;
        }
      }),
    );
    if (this._destroyed || !this.getLayer(layer.id)) return;

    const members: RasterMember[] = mosaic.members.map((member, i) => ({
      url: member.url,
      geotiff: tiffs[i],
      bounds: null,
    }));

    for (const member of members) {
      assertTiled(member.geotiff, member.url);
      if (member.geotiff.count < mosaic.bandCount) {
        throw new VrtUnsupportedError(
          `This VRT declares ${mosaic.bandCount} band(s), but its source ` +
            `"${member.url}" has only ${member.geotiff.count}. Every source ` +
            'must supply every band the VRT exposes.',
        );
      }
    }

    layer.members = members;
    layer.geotiff = members[0].geotiff;
    layer.bandCount = mosaic.bandCount;
    // The VRT is the dataset-level authority on nodata: honour its declaration
    // when the caller left nodata on 'auto' (which otherwise reads whatever the
    // individual members happen to declare, if anything).
    if (mosaic.nodata !== null && layer.state.nodata === 'auto') {
      layer.state.nodata = mosaic.nodata;
    }
  }

  /**
   * Parses a mosaic manifest (MosaicJSON or STAC) into the assets the deck.gl
   * engine renders and the band metadata the panel reads.
   *
   * Unlike a VRT, the assets are not all opened up front — a mosaic can list
   * thousands, and the deck.gl {@link MosaicLayer} opens each lazily only while
   * it is in view. Only the first asset's header is read here, to supply the
   * band count, names and embedded palette the whole mosaic shares, and to seed
   * one rescale window (sampling every asset is infeasible). Band count and
   * bounds come from that header and the manifest; each asset is still
   * georeferenced by its own header when opened.
   *
   * @param layer - The layer being added; mutated in place
   * @param url - URL the manifest is fetched from
   */
  private async _openMosaic(layer: RasterLayer, url: string): Promise<void> {
    const mosaic = await this._deps.loadMosaic(url, layer.abort.signal);
    if (this._destroyed || !this.getLayer(layer.id)) return;
    layer.mosaicKind = mosaic.kind;
    layer.mosaicAssets = mosaic.assets;
    layer.mosaicMinzoom = mosaic.minzoom;
    layer.bounds = clampBoundsLatitude(mosaic.bounds);

    try {
      const tiff = await this._deps.loadGeoTIFF(mosaic.assets[0].url);
      if (this._destroyed || !this.getLayer(layer.id)) return;
      layer.bandCount = tiff.count;
      layer.bandNames = readBandNames(tiff);
      layer.palette = extractPalette(tiff);
      if (!layer.userPickedMode) {
        if (layer.bandCount >= 3) {
          layer.state.mode = 'rgb';
          layer.state.bands = [1, 2, 3];
        } else {
          layer.state.mode = 'single';
          layer.state.bands = [1];
          if (layer.palette) layer.state.colormap = 'palette';
        }
      }
      // Sample this one asset's statistics for a shared rescale window.
      this._computeMosaicStats(layer, tiff);
    } catch {
      // The first asset's header could not be read (e.g. CORS). Assume an RGB
      // imagery mosaic so the band pickers offer three channels; rendering
      // falls back to a [0, 1] rescale until the user sets one.
      if (this._destroyed || !this.getLayer(layer.id)) return;
      layer.bandCount = 3;
      if (!layer.userPickedMode) {
        layer.state.mode = 'rgb';
        layer.state.bands = [1, 2, 3];
      }
    }
  }

  /** Samples one mosaic asset's statistics in the background, applying them as
   * the whole mosaic's rescale window when they land. */
  private _computeMosaicStats(layer: RasterLayer, sample: GeoTIFF): void {
    const signal = layer.abort.signal;
    void this._deps.computeAutoStats(sample, signal).then(
      (stats) => {
        if (signal.aborted || this._destroyed) return;
        layer.autoStats = stats;
        this._rebuild();
        this._emit({ type: 'rasterchange', layerId: layer.id });
      },
      () => {
        // Stats are an enhancement; rendering falls back to a [0, 1] rescale.
      },
    );
  }

  /** Opens (or reuses) a mosaic asset's GeoTIFF header.
   *
   * A failed open resolves to null and is evicted from the cache — never
   * rejects. MosaicLayer wraps this in its tile `getTileData`; a rejection
   * there leaves deck.gl calling `renderSubLayers` with null tile content,
   * which the layer destructures unguarded and crashes on. Resolving null makes
   * the tile render nothing, and the eviction lets a later viewport pass retry
   * (e.g. after a transient CORS/network failure).
   *
   * Public so the pixel inspector can read a mosaic asset through the same
   * cache the renderer fills, instead of refetching a header per click. */
  openMosaicAsset(url: string): Promise<GeoTIFF | null> {
    let opened = this._mosaicGeotiffs.get(url);
    if (!opened) {
      opened = this._deps.loadGeoTIFF(url).catch(() => {
        this._mosaicGeotiffs.delete(url);
        return null;
      });
      this._mosaicGeotiffs.set(url, opened);
    }
    return opened;
  }

  /**
   * Removes a layer, aborting any in-flight stats sampling and revoking the
   * blob URL for local files.
   *
   * @param id - The layer id
   */
  removeRaster(id: string): void {
    const index = this._layers.findIndex((l) => l.id === id);
    if (index === -1) return;
    const [layer] = this._layers.splice(index, 1);
    layer.abort.abort();
    if (layer.source.kind === 'file') {
      URL.revokeObjectURL(layer.source.objectUrl);
    }
    this._crsFailed.delete(id);
    this._destroyPaletteTexture(layer);
    if (this._selectedId === id) {
      this.select(this._layers[this._layers.length - 1]?.id ?? null);
    }
    this._rebuild();
    this._emit({ type: 'rasterremove', layerId: id });
  }

  /**
   * Merges a partial visualization state into a layer and re-renders.
   *
   * @param id - The layer id
   * @param patch - State fields to update
   */
  setState(id: string, patch: Partial<RasterLayerState>): void {
    const layer = this.getLayer(id);
    if (!layer) return;
    if (patch.mode !== undefined || patch.bands !== undefined) {
      layer.userPickedMode = true;
    }
    layer.state = { ...layer.state, ...patch };
    this._rebuild();
    this._emit({ type: 'rasterchange', layerId: id });
  }

  /**
   * Shows or hides a layer.
   *
   * @param id - The layer id
   * @param visible - Whether the layer should render
   */
  setVisible(id: string, visible: boolean): void {
    this.setState(id, { visible });
  }

  /**
   * Selects the layer whose settings the panel edits.
   *
   * @param id - The layer id, or null to clear the selection
   */
  select(id: string | null): void {
    if (id !== null && !this.getLayer(id)) return;
    if (this._selectedId === id) return;
    this._selectedId = id;
    this._emit({ type: 'rasterselect', layerId: id ?? undefined });
  }

  /**
   * Fits the map view to a layer's geographic bounds (known once the
   * GeoTIFF loads).
   *
   * @param id - The layer id
   */
  zoomTo(id: string): void {
    const layer = this.getLayer(id);
    if (!layer?.bounds) return;
    this._fitBounds(layer.bounds);
  }

  /**
   * Moves a layer to a new position in the draw order.
   *
   * @param id - The layer id
   * @param toIndex - Target index (0 = bottom)
   */
  reorder(id: string, toIndex: number): void {
    const from = this._layers.findIndex((l) => l.id === id);
    if (from === -1) return;
    const to = Math.max(0, Math.min(this._layers.length - 1, toIndex));
    if (from === to) return;
    const [layer] = this._layers.splice(from, 1);
    this._layers.splice(to, 0, layer);
    this._rebuild();
    this._emit({ type: 'rasterchange', layerId: id });
  }

  /**
   * Sets the MapLibre layer a raster draws beneath (interleaved mode).
   *
   * In interleaved rendering, @deck.gl/mapbox groups raster layers by their
   * `beforeId`: a layer with no `beforeId` is drawn on top of the whole style,
   * so a host that interleaves rasters with its own vector layers calls this to
   * place a raster below a given vector layer. A no-op when the id is unchanged.
   *
   * @param id - The layer id
   * @param beforeId - The MapLibre style layer id to draw beneath, or null/empty
   *   to draw the raster on top.
   */
  setBeforeId(id: string, beforeId: string | null): void {
    const layer = this.getLayer(id);
    if (!layer) return;
    const normalized = beforeId?.trim() || null;
    if (layer.beforeId === normalized) return;
    layer.beforeId = normalized;
    this._rebuild();
  }

  /**
   * Registers an event handler.
   *
   * @param event - Event type
   * @param handler - Callback
   */
  on(event: LayerManagerEvent, handler: LayerManagerEventHandler): void {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event)!.add(handler);
  }

  /**
   * Removes an event handler.
   *
   * @param event - Event type
   * @param handler - Callback to remove
   */
  off(event: LayerManagerEvent, handler: LayerManagerEventHandler): void {
    this._handlers.get(event)?.delete(handler);
  }

  /**
   * Tears down the manager: aborts stats, revokes blob URLs, and removes
   * the overlay from the map.
   */
  destroy(): void {
    this._destroyed = true;
    for (const layer of this._layers) {
      layer.abort.abort();
      if (layer.source.kind === 'file') {
        URL.revokeObjectURL(layer.source.objectUrl);
      }
      this._destroyPaletteTexture(layer);
    }
    this._layers = [];
    this._selectedId = null;
    for (const id of [...this._attributions.keys()]) {
      this._removeAttribution(id);
    }
    if (this._onAttribStyleData) {
      this._map.off('styledata', this._onAttribStyleData);
      this._onAttribStyleData = null;
    }
    if (this._onZoom) {
      this._map.off('zoom', this._onZoom);
      this._onZoom = null;
    }
    if (this._overlay) {
      this._deps.removeOverlay(this._map, this._overlay);
      this._overlay = null;
    }
    if (this._cogEngine) {
      this._cogEngine.destroy();
      this._cogEngine = null;
    }
    if (this._titilerEngine) {
      this._titilerEngine.destroy();
      this._titilerEngine = null;
    }
    this._mosaicGeotiffs.clear();
    this._handlers.clear();
  }

  private _destroyPaletteTexture(layer: RasterLayer): void {
    if (!layer.paletteTexture) return;
    try {
      layer.paletteTexture.destroy();
    } catch {
      // best-effort
    }
    layer.paletteTexture = null;
  }

  private _emit(
    data: Omit<LayerManagerEventData, 'type'> & { type: LayerManagerEvent },
  ): void {
    const handlers = this._handlers.get(data.type);
    if (handlers) {
      handlers.forEach((handler) => handler(data));
    }
  }

  /** Ensures the artifacts for the active engine exist. */
  private _ensureEngine(): void {
    if (this._engine === 'maplibre-gl-raster') this._ensureOverlay();
    else if (this._engine === 'cog-tiler-wasm') this._ensureCogEngine();
    else this._ensureTiTilerEngine();
  }

  private _ensureOverlay(): void {
    // Only the deck.gl engine needs the overlay; skip it under cog-tiler so we
    // don't spin up an unused WebGL device.
    if (this._engine !== 'maplibre-gl-raster') return;
    if (this._overlay) return;
    this._overlay = this._deps.createOverlay(this._map, {
      interleaved: this._interleaved,
      onDeviceInitialized: (device) => {
        this._device = device;
        void this._loadColormapTexture();
      },
    });
  }

  private _ensureCogEngine(): CogTilerEngine {
    if (!this._cogEngine) {
      this._cogEngine = new CogTilerEngine(this._map, {
        loadModule: this._deps.loadCogTiler,
        onBounds: (id, bounds, zoomTo) => this._onCogBounds(id, bounds, zoomTo),
        onError: (id, error) => this._onCogError(id, error),
        // The module reports which colormaps it actually has; re-emit so the
        // panel's picker widens from the baseline to the real set.
        onReady: () => this._emit({ type: 'rasterchange' }),
      });
    }
    return this._cogEngine;
  }

  private _ensureTiTilerEngine(): TiTilerEngine {
    if (!this._titilerEngine) {
      this._titilerEngine = new TiTilerEngine(this._map, {
        endpoint: this._titilerEndpoint,
        fetchTileJson: this._deps.fetchTileJson,
        onBounds: (id, bounds, zoomTo, minzoom) =>
          this._onCogBounds(id, bounds, zoomTo, minzoom),
        onError: (id, error) => this._onCogError(id, error),
      });
    }
    return this._titilerEngine;
  }

  /**
   * Projects the renderable layers into the TiTiler engine's input shape.
   *
   * TiTiler reads its sources over HTTP, so only remote layers qualify: a
   * MosaicJSON manifest, or a plain remote COG (its URL). Local-file layers
   * (blob URLs the server cannot reach), VRT mosaics (not a format the `/cog`
   * router reads), and STAC mosaics (no `/mosaicjson` equivalent) are skipped —
   * they render on the deck.gl engine instead.
   */
  private _titilerRenderableLayers(): TiTilerEngineLayer[] {
    return this._layers
      .filter(
        (l) =>
          l.state.visible &&
          !this._crsFailed.has(l.id) &&
          l.source.kind === 'url' &&
          (l.mosaicKind === 'mosaicjson' || (!!l.geotiff && !l.members)),
      )
      .map((l) => ({
        id: l.id,
        url: l.url,
        kind: l.isMosaicJson ? ('mosaicjson' as const) : ('cog' as const),
        state: l.state,
        autoStats: l.autoStats,
        beforeId: l.beforeId,
        zoomTo: l.zoomTo,
      }));
  }

  /** Records a cog-tiler source's bounds (fitting the map once when requested),
   * mirroring the deck path's onGeoTIFFLoad behavior. */
  private _onCogBounds(
    id: string,
    bounds: GeographicBounds,
    zoomTo: boolean,
    minzoom?: number,
  ): void {
    // Prefer an exact match: a caller-supplied layer id is free to contain the
    // member separator, and it must not be mistaken for a member of some other
    // layer.
    const layer = this.getLayer(id) ?? this.getLayer(ownerLayerId(id));
    if (!layer) return;
    const clamped = clampBoundsLatitude(bounds);

    // A mosaic layer's sources report one id per member; fold them into the
    // union rather than letting the last one to arrive win.
    const memberIndex = memberIndexOf(id);
    if (layer.members && memberIndex !== null) {
      const member = layer.members[memberIndex];
      // zoomTo is derived from layer.zoomTo per member, and _onMemberBounds
      // re-checks it before fitting the union, so it needs no separate gate.
      if (member) this._onMemberBounds(layer, member, clamped);
      return;
    }

    const boundsArrived = !layer.bounds;
    layer.bounds = clamped;
    if (zoomTo && layer.zoomTo) {
      layer.zoomTo = false;
      this._fitBounds(layer.bounds, minzoom);
    }
    if (boundsArrived) this._emit({ type: 'rasterchange', layerId: layer.id });
  }

  /** Surfaces a cog-tiler open / module-load failure as a layer (or global)
   * error. */
  private _onCogError(id: string | undefined, error: Error): void {
    if (this._destroyed) return;
    if (id) {
      // A member's failure is the owning layer's failure. Prefer an exact
      // match: a caller-supplied id may itself contain the member separator.
      const layerId = this.getLayer(id) ? id : ownerLayerId(id);
      const layer = this.getLayer(layerId);
      if (layer) {
        layer.loading = false;
        layer.error = error;
      }
      this._emit({ type: 'error', layerId, error });
      this._emit({ type: 'rasterchange', layerId });
    } else {
      this._emit({ type: 'error', error });
    }
  }

  /**
   * Projects the renderable layers into the cog-tiler engine's input shape.
   *
   * A mosaic VRT contributes one entry per member — the engine opens a
   * {@link import('cog-tiler-wasm').CogSource} per entry — all carrying the
   * owning layer's shared state and statistics. Members are always read from
   * their URL: a VRT dropped as a local File can only reference absolute URLs
   * anyway (`parseVrt` rejects relative sources for a local VRT, since the
   * browser cannot reach its siblings on disk).
   */
  private _cogRenderableLayers(): CogEngineLayer[] {
    return this._layers
      .filter(
        (l) =>
          (l.geotiff || l.mosaicAssets) &&
          l.state.visible &&
          !this._crsFailed.has(l.id),
      )
      .flatMap((l) => {
        const shared = {
          state: l.state,
          autoStats: l.autoStats,
          beforeId: l.beforeId,
          zoomTo: l.zoomTo,
        };
        // A mosaic manifest is one engine layer carrying its asset list: the
        // engine composites the covering assets per tile rather than opening a
        // COG here (a manifest can list thousands).
        if (l.mosaicAssets) {
          return [
            {
              id: l.id,
              source: l.url,
              assets: l.mosaicAssets,
              minzoom: l.mosaicMinzoom,
              ...shared,
            },
          ];
        }
        if (!l.members) {
          return [{ id: l.id, source: l.file ?? l.url, ...shared }];
        }
        return l.members.map((member, i) => ({
          id: memberLayerId(l.id, i),
          source: member.url,
          ...shared,
        }));
      });
  }

  /** Fetch + decode the colormap sprite once per device, then re-render so
   * single-band layers pick up their colormap (they fall back to RGB
   * rendering until the texture is ready). */
  private async _loadColormapTexture(): Promise<void> {
    if (!this._device || this._colormapTexture) return;
    try {
      const resp = await fetch(colormapsPngUrl);
      const bytes = await resp.arrayBuffer();
      const image = await decodeColormapSprite(bytes);
      if (this._destroyed || !this._device) return;
      this._colormapTexture = createColormapTexture(this._device, image);
      this._rebuild();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this._emit({ type: 'error', error });
    }
  }

  /**
   * Samples the layer's auto statistics in the background, re-rendering when
   * they land.
   *
   * A mosaic VRT samples every member and merges the results, so the one
   * rescale window the members share describes the whole mosaic. Sampling only
   * the first member would still give a single window — but one derived from a
   * single tile, which clips every member whose values fall outside it. The
   * per-tile progress callback is skipped for a mosaic: members would each
   * report partials against their own range and fight over the window.
   */
  private _computeStats(layer: RasterLayer): void {
    if (!layer.geotiff) return;
    const signal = layer.abort.signal;
    const apply = (stats: AutoStats): void => {
      if (signal.aborted || this._destroyed) return;
      layer.autoStats = stats;
      this._rebuild();
      this._emit({ type: 'rasterchange', layerId: layer.id });
    };
    void (async () => {
      try {
        if (layer.members) {
          const perMember = await Promise.all(
            layer.members.map((member) =>
              this._deps.computeAutoStats(member.geotiff, signal),
            ),
          );
          apply(mergeAutoStats(perMember));
          return;
        }
        apply(
          await this._deps.computeAutoStats(layer.geotiff!, signal, apply),
        );
      } catch {
        // Stats are an enhancement; rendering falls back to [0, 1] rescale.
      }
    })();
  }

  private _fitBounds(bounds: GeographicBounds, minZoom?: number): void {
    const bbox: [[number, number], [number, number]] = [
      [bounds.west, bounds.south],
      [bounds.east, bounds.north],
    ];
    // For a small, high-resolution source (a TiTiler mosaic can start at zoom
    // 12+), fitting the whole extent can land the map below the zoom where any
    // tiles exist, leaving it blank. When a native minimum zoom is known and
    // the fit would fall short of it, ease to the bounds center at that zoom
    // instead so the initial view lands inside the tiled range. Falls back to
    // plain fitBounds when the map lacks cameraForBounds (e.g. test fakes).
    const map = this._map as unknown as {
      cameraForBounds?: (b: unknown, o: unknown) => { center: unknown; zoom: number } | undefined;
      easeTo?: (o: unknown) => void;
    };
    if (minZoom !== undefined && map.cameraForBounds && map.easeTo) {
      const camera = map.cameraForBounds(bbox, { padding: 40 });
      if (camera && Number.isFinite(camera.zoom)) {
        map.easeTo({
          center: camera.center,
          zoom: Math.max(camera.zoom, minZoom),
          duration: 800,
        });
        return;
      }
    }
    this._map.fitBounds(bbox, { padding: 40, duration: 800 });
  }

  /** Reconciles per-layer attributions with the map's attribution control.
   *
   * Neither engine gives every raster a MapLibre source the control could read
   * an attribution from (the deck.gl path renders through an overlay with no
   * source at all), so each attributed, visible layer gets a helper: an empty
   * GeoJSON source carrying the attribution string plus a no-op circle layer
   * referencing it. The layer marks the source as used, which is what makes
   * the stock AttributionControl display (and de-duplicate) the string; the
   * empty feature collection means nothing is ever drawn or fetched. */
  private _syncAttributions(): void {
    // addSource/addLayer throw before the style first loads; defer the first
    // sync until then. isStyleLoaded() may dip false again later while sources
    // load (adding is still safe then), so latch rather than re-check. The wait
    // is on 'styledata' rather than the one-shot 'load' -- see CogTilerEngine.
    if (!this._attribStyleReady) {
      if (this._map.isStyleLoaded()) {
        this._attribStyleReady = true;
      } else {
        if (!this._onAttribStyleData) {
          this._onAttribStyleData = () => {
            if (!this._map.isStyleLoaded()) return;
            this._map.off('styledata', this._onAttribStyleData!);
            this._onAttribStyleData = null;
            this._attribStyleReady = true;
            this._syncAttributions();
          };
          this._map.on('styledata', this._onAttribStyleData);
        }
        return;
      }
    }
    // Mirror the render filters: attribution shows only while the layer
    // actually draws (loaded, visible, not errored / CRS-failed).
    const desired = new Map<string, string>();
    for (const l of this._layers) {
      if (
        l.attribution &&
        (l.geotiff || l.isMosaicJson) &&
        l.state.visible &&
        !l.error &&
        !this._crsFailed.has(l.id)
      ) {
        desired.set(l.id, l.attribution);
      }
    }
    for (const [id, applied] of this._attributions) {
      if (desired.get(id) !== applied) this._removeAttribution(id);
    }
    for (const [id, attribution] of desired) {
      if (this._attributions.has(id)) continue;
      const helperId = `mlr-attribution-${id}`;
      try {
        this._map.addSource(helperId, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
          attribution,
        });
        this._map.addLayer({ id: helperId, type: 'circle', source: helperId });
        this._attributions.set(id, attribution);
      } catch {
        // Transient style churn; the next rebuild retries.
      }
    }
  }

  /** Removes a layer's attribution helper source/layer, if present. */
  private _removeAttribution(id: string): void {
    if (!this._attributions.delete(id)) return;
    const helperId = `mlr-attribution-${id}`;
    try {
      if (this._map.getLayer(helperId)) this._map.removeLayer(helperId);
      if (this._map.getSource(helperId)) this._map.removeSource(helperId);
    } catch {
      // best-effort (e.g. the style was swapped out from under us)
    }
  }

  /** Re-derives the deck.gl layer array from current layer states and pushes
   * it to the overlay. Layer ids are stable so deck.gl preserves each
   * layer's tile cache across rebuilds. */
  private _rebuild(): void {
    this._syncAttributions();
    if (this._engine === 'cog-tiler-wasm') {
      // Keep the deck.gl overlay blank (if it was ever created) and let the
      // cog-tiler engine drive the native MapLibre raster layers.
      this._overlay?.setProps({ layers: [] });
      this._ensureCogEngine().sync(this._cogRenderableLayers());
      return;
    }
    if (this._engine === 'titiler') {
      // TiTiler renders server-side into native MapLibre raster layers; keep
      // the deck.gl overlay blank (if any) and let the engine drive them.
      this._overlay?.setProps({ layers: [] });
      this._ensureTiTilerEngine().sync(this._titilerRenderableLayers());
      return;
    }
    if (!this._overlay) return;
    const renderable = this._layers.filter(
      (l) =>
        (l.geotiff || l.mosaicAssets) &&
        l.state.visible &&
        !this._crsFailed.has(l.id) &&
        this._withinZoomRange(l.state),
    );
    // Cache the in-range set so the zoom listener can tell a boundary crossing
    // from an ordinary zoom that leaves every layer's visibility unchanged.
    this._zoomVisibleSig = renderable.map((l) => l.id).join('|');
    const layers = renderable.flatMap((l) => this._buildCogLayers(l));
    this._overlay.setProps({ layers });
  }

  /**
   * Whether a layer draws at the map's current zoom, following MapLibre's
   * per-layer zoom semantics: visible while `minZoom <= zoom < maxZoom`, hidden
   * outside that. An unset bound falls back to the full [0, 24] range, so a
   * layer with no constraint always passes.
   */
  private _withinZoomRange(state: RasterLayerState): boolean {
    const zoom = this._map.getZoom();
    const min = state.minZoom ?? RASTER_MIN_ZOOM;
    const max = state.maxZoom ?? RASTER_MAX_ZOOM;
    return zoom >= min && zoom < max;
  }

  /**
   * Re-renders the deck.gl overlay when the map zoom crosses a layer's min/max
   * boundary. Runs on every 'zoom' event, so it stays cheap: it rebuilds only
   * when the set of in-range layers actually changes, leaving pans and in-range
   * zooms untouched (a needless rebuild would remount the COGLayers and refetch
   * their tiles). The native engines carry their zoom range on the MapLibre
   * layer itself, so this is a no-op for them.
   */
  private _syncZoomVisibility(): void {
    if (this._engine !== 'maplibre-gl-raster' || !this._overlay) return;
    const sig = this._layers
      .filter(
        (l) =>
          (l.geotiff || l.mosaicAssets) &&
          l.state.visible &&
          !this._crsFailed.has(l.id) &&
          this._withinZoomRange(l.state),
      )
      .map((l) => l.id)
      .join('|');
    if (sig === this._zoomVisibleSig) return;
    this._rebuild();
  }

  /**
   * The deck.gl layers that draw one managed layer: exactly one for a plain
   * raster, and one per member for a mosaic VRT.
   *
   * Every member layer is built from the same {@link RasterLayer}, so they
   * share one visualization state and one set of auto statistics — which is
   * what keeps a mosaic from rendering as a quilt of independently stretched
   * tiles.
   */
  private _buildCogLayers(layer: RasterLayer): Layer[] {
    // Build the render pipeline once and hand the same one to every member:
    // besides being what "shared state" means here, _renderTileFor has a side
    // effect (it lazily uploads the palette texture, and reports a failure as a
    // layer error), which must not run once per member.
    //
    // Fetch only the bands this layer's render pipeline samples, so any band
    // (e.g. band 12 of a 12-band image) can be displayed — not just the first
    // four. The id encodes the band set so a band change remounts the layer and
    // refetches (see cogLayerId); within a set the loader closure's identity is
    // irrelevant (the inner TileLayer ignores getTileData changes).
    const fetchBands = fetchBandsFor(layer);
    const pipeline = {
      renderTile: this._renderTileFor(layer),
      fetchBands,
      getTileData: makeMultiBandTileLoader(fetchBands),
    };
    // A MosaicJSON renders as one MosaicLayer that spawns a COGLayer per
    // in-view asset, all sharing this layer's pipeline (state + stats).
    if (layer.mosaicAssets) return [this._buildMosaicLayer(layer, pipeline)];
    if (!layer.members) return [this._buildCogLayer(layer, pipeline)];
    return layer.members.map((member, i) =>
      this._buildCogLayer(layer, pipeline, { member, index: i }),
    );
  }

  /**
   * Builds the deck.gl {@link MosaicLayer} for a MosaicJSON layer.
   *
   * The mosaic holds one {@link import('../raster/mosaicjson').MosaicAsset} per
   * COG (URL + WGS84 bbox); its spatial index culls to the viewport and, for
   * each visible asset, opens the COG ({@link openMosaicAsset}) and renders it
   * with a {@link WebMercatorCOGLayer} carrying the layer's shared pipeline —
   * the same per-COG GPU path a plain raster uses, so every asset is
   * reprojected and stretched identically.
   */
  private _buildMosaicLayer(
    layer: RasterLayer,
    pipeline: {
      renderTile: ReturnType<LayerManager['_renderTileFor']>;
      fetchBands: number[];
      getTileData: ReturnType<typeof makeMultiBandTileLoader>;
    },
  ): Layer {
    const { renderTile, fetchBands, getTileData } = pipeline;
    const bandTag = `#b${fetchBands.join('-')}`;
    type Source = MosaicRenderSource;
    const assets = layer.mosaicAssets!;
    // Reuse the same sources array across re-renders so MosaicLayer's spatial
    // index survives (a fresh array reference forces it to rebuild).
    let sources = this._mosaicSources.get(assets);
    if (!sources) {
      sources = assets.map((asset) => ({
        id: asset.url,
        bbox: asset.bbox,
        url: asset.url,
      }));
      this._mosaicSources.set(assets, sources);
    }
    // Build props as a const so beforeId (read by @deck.gl/mapbox, absent from
    // MosaicLayerProps) passes structural assignability instead of tripping the
    // object-literal excess-property check — same trick as _buildCogLayer.
    const props = {
      // The band set is encoded so a band change remounts the mosaic (and its
      // COGLayers) to refetch, matching cogLayerId's behavior for plain rasters.
      id: `${layer.id}${bandTag}`,
      sources,
      getSource: (source: Source) => this.openMosaicAsset(source.url),
      renderSource: (
        source: Source,
        opts: { data?: GeoTIFF | null },
      ): Layer | null => {
        if (!opts.data) return null;
        return new WebMercatorCOGLayer<MultiBandTileData>({
          id: `${layer.id}::mosaic::${source.url}${bandTag}`,
          geotiff: opts.data,
          opacity: layer.state.opacity,
          getTileData,
          renderTile,
          epsgResolver: this._deps.epsgResolver,
        });
      },
      onSourceError: (_source: Source, info: { error: Error }) => {
        // One unreadable asset must not fail the whole mosaic; surface it as a
        // non-fatal error and let the other assets render.
        this._emit({ type: 'error', layerId: layer.id, error: info.error });
      },
      // Below this zoom the mosaic renders nothing, so a low/world view never
      // spins up one COGLayer per asset for the whole extent (undefined for a
      // small mosaic, which is always cheap to draw in full).
      minZoom: mosaicMinZoom(assets) ?? undefined,
      // Prioritize the assets nearest the viewport centre and cap concurrent
      // COG fetches so a dense view streams in smoothly.
      maxRequests: 24,
      // Each cached tile is a whole COGLayer; opened GeoTIFFs are already cached
      // in _mosaicGeotiffs, so there is nothing cheap to retain here.
      maxCacheSize: 0,
      beforeId: this._resolveBeforeId(layer.beforeId),
    };
    return new MosaicLayer<Source, GeoTIFF | null>(props);
  }

  private _buildCogLayer(
    layer: RasterLayer,
    pipeline: {
      renderTile: ReturnType<LayerManager['_renderTileFor']>;
      fetchBands: number[];
      getTileData: ReturnType<typeof makeMultiBandTileLoader>;
    },
    member?: { member: RasterMember; index: number },
  ): COGLayer<MultiBandTileData> {
    const { renderTile, fetchBands, getTileData } = pipeline;

    // beforeId is read by @deck.gl/mapbox's MapboxOverlay in interleaved
    // mode but missing from COGLayer's narrower props type — build the props
    // as a const so structural assignability applies instead of the
    // excess-property check. Only forward ids that exist in the current
    // style; a stale id would make the overlay throw on the next style event.
    const cogProps = {
      id: member
        ? `${memberLayerId(layer.id, member.index)}#b${fetchBands.join('-')}`
        : cogLayerId(layer, fetchBands),
      geotiff: member ? member.member.geotiff : layer.geotiff!,
      opacity: layer.state.opacity,
      getTileData,
      renderTile,
      beforeId: this._resolveBeforeId(layer.beforeId),
      // COGLayer resolves the GeoTIFF's CRS inside its own (un-awaited,
      // un-caught) parse step, so a resolver rejection would otherwise leave an
      // invisible layer with no error. Surface it as a layer error instead.
      epsgResolver: (epsg: number) =>
        this._deps.epsgResolver(epsg).catch((err: unknown) => {
          this._failLayerCrs(layer, err);
          throw err;
        }),
      onGeoTIFFLoad: (
        _tiff: GeoTIFF,
        options: { geographicBounds: GeographicBounds },
      ) => {
        const bounds = clampBoundsLatitude(options.geographicBounds);
        if (member) {
          this._onMemberBounds(layer, member.member, bounds);
          return;
        }
        // Only the first arrival is an observable change; onGeoTIFFLoad can
        // re-fire on later rebuilds with the same already-loaded GeoTIFF, and
        // re-emitting there could ping-pong with handlers that call setState.
        const boundsArrived = !layer.bounds;
        layer.bounds = bounds;
        if (layer.zoomTo) {
          layer.zoomTo = false;
          this._fitBounds(layer.bounds);
        }
        if (boundsArrived) {
          this._emit({ type: 'rasterchange', layerId: layer.id });
        }
      },
    };
    // WebMercatorCOGLayer is a COGLayer that draws EPSG:3857 sources with an
    // identity reprojection, avoiding the antimeridian wrap that breaks global
    // Web-Mercator COGs (see web-mercator-cog-layer.ts). It is a no-op for any
    // other source CRS.
    return new WebMercatorCOGLayer(cogProps);
  }

  /**
   * Folds one member's bounds into a mosaic layer's extent.
   *
   * Members report independently as each one's header resolves, so the layer's
   * bounds grow to the union as they arrive. The map is only fitted once every
   * member has reported — fitting on the first arrival would zoom to a single
   * tile of the mosaic.
   */
  private _onMemberBounds(
    layer: RasterLayer,
    member: RasterMember,
    bounds: GeographicBounds,
  ): void {
    // onGeoTIFFLoad re-fires on later rebuilds with the same already-loaded
    // GeoTIFF; nothing below is observable once a member has reported.
    if (member.bounds) return;
    member.bounds = bounds;

    const reported = layer.members!.flatMap((m) => (m.bounds ? [m.bounds] : []));
    layer.bounds = unionBounds(reported);
    if (layer.zoomTo && reported.length === layer.members!.length) {
      layer.zoomTo = false;
      this._fitBounds(layer.bounds!);
    }
    this._emit({ type: 'rasterchange', layerId: layer.id });
  }

  /** Records a CRS-resolution failure once: marks the layer errored, drops it
   * from future rebuilds (so the resolver is not retried in a loop), and emits
   * the error to consumers. Runs after the resolver promise settles, so it is
   * never synchronous with a deck.gl render. */
  private _failLayerCrs(layer: RasterLayer, err: unknown): void {
    if (
      this._destroyed ||
      !this.getLayer(layer.id) ||
      this._crsFailed.has(layer.id)
    ) {
      return;
    }
    this._crsFailed.add(layer.id);
    const error = err instanceof Error ? err : new Error(String(err));
    layer.loading = false;
    layer.error = error;
    this._emit({ type: 'error', layerId: layer.id, error });
    this._emit({ type: 'rasterchange', layerId: layer.id });
  }

  /** Returns the beforeId only when that layer exists in the map's current
   * style (warns otherwise). */
  private _resolveBeforeId(beforeId: string | null): string | undefined {
    if (!beforeId) return undefined;
    try {
      if (this._map.getLayer(beforeId)) return beforeId;
    } catch {
      return undefined;
    }
    console.warn(
      `maplibre-gl-raster: beforeId layer "${beforeId}" not found in the map style; drawing the raster on top.`,
    );
    return undefined;
  }

  /** Picks the render pipeline for a layer: embedded palette lookup, named
   * colormap, or RGB compositing. GPU-texture-dependent paths fall back to
   * RGB until the device / textures are ready. */
  private _renderTileFor(layer: RasterLayer) {
    if (layer.state.mode === 'single') {
      if (layer.state.colormap === 'palette' && layer.palette) {
        if (!layer.paletteTexture && this._device) {
          try {
            layer.paletteTexture = createPaletteTexture(
              this._device,
              layer.palette,
            );
          } catch (err) {
            // Drop the palette so we stop retrying and fall back to the
            // named-colormap path on the next rebuild.
            layer.palette = null;
            const error = err instanceof Error ? err : new Error(String(err));
            this._emit({ type: 'error', layerId: layer.id, error });
          }
        }
        if (layer.paletteTexture) {
          return buildPaletteCompositeRenderTile(
            layer.state,
            layer.paletteTexture,
          );
        }
      } else if (this._colormapTexture) {
        return buildSingleCompositeRenderTile(
          layer.state,
          this._colormapTexture,
          layer.autoStats,
        );
      }
    }
    // Index mode needs the shared colormap texture; until it's ready the RGB
    // fallback below draws the raw bands.
    if (layer.state.mode === 'index' && this._colormapTexture) {
      return buildIndexCompositeRenderTile(layer.state, this._colormapTexture);
    }
    return buildRgbCompositeRenderTile(layer.state, layer.autoStats);
  }
}
