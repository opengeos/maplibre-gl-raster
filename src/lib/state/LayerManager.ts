import { MapboxOverlay } from '@deck.gl/mapbox';
import { COGLayer } from '@developmentseed/deck.gl-geotiff';
import {
  createColormapTexture,
  decodeColormapSprite,
} from '@developmentseed/deck.gl-raster/gpu-modules';
import { parseColormap, type GeoTIFF } from '@developmentseed/geotiff';
import type { EpsgResolver } from '@developmentseed/proj';
import type { Device, Texture } from '@luma.gl/core';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type {
  AddRasterOptions,
  RasterLayerState,
  RenderEngine,
} from '../core/types';
import { colormapsPngUrl } from '../raster/colormaps';
import { createResilientEpsgResolver } from '../raster/epsg-resolver';
import { loadGeoTIFF as defaultLoadGeoTIFF } from '../raster/load-geotiff';
import {
  buildPaletteCompositeRenderTile,
  buildRgbCompositeRenderTile,
  buildSingleCompositeRenderTile,
} from '../raster/render-pipeline';
import {
  computeAutoStats as defaultComputeAutoStats,
  readBandNames,
  type AutoStats,
} from '../raster/stats';
import {
  makeMultiBandTileLoader,
  MAX_BAND_SLOTS,
  type MultiBandTileData,
} from '../raster/tile-loader';
import { WebMercatorCOGLayer } from '../raster/web-mercator-cog-layer';
import { generateId } from '../utils/helpers';
import {
  CogTilerEngine,
  type CogEngineLayer,
  type CogTilerModule,
} from './CogTilerEngine';
import {
  createLayerState,
  deriveLayerName,
  type GeographicBounds,
  type RasterLayer,
} from './RasterLayer';

/** Default engine when none is configured: the deck.gl GPU pipeline. */
export const DEFAULT_ENGINE: RenderEngine = 'maplibre-gl-raster';

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
}

const DEFAULT_DEPS: LayerManagerDeps = {
  loadGeoTIFF: defaultLoadGeoTIFF,
  computeAutoStats: defaultComputeAutoStats,
  epsgResolver: createResilientEpsgResolver(),
  // Resolved lazily: the package is an optional peer dependency, only loaded
  // when the user selects the cog-tiler-wasm engine. A literal specifier so
  // Vite/consumers resolve and code-split it; the lib build externalizes it
  // (see vite.config.ts) so it never enters the default bundle.
  loadCogTiler: () => import('cog-tiler-wasm'),
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
  private _destroyed = false;

  /**
   * Creates a LayerManager bound to a map.
   *
   * @param map - The MapLibre GL map instance
   * @param options - Overlay options (interleaved rendering)
   * @param deps - Injectable collaborators for testing
   */
  constructor(
    map: MapLibreMap,
    options?: { interleaved?: boolean; engine?: RenderEngine },
    deps?: Partial<LayerManagerDeps>,
  ) {
    this._map = map;
    this._interleaved = options?.interleaved ?? true;
    this._engine = options?.engine ?? DEFAULT_ENGINE;
    this._deps = { ...DEFAULT_DEPS, ...deps };
  }

  /** The id of the layer currently selected for editing, or null. */
  get selectedId(): string | null {
    return this._selectedId;
  }

  /** The active rendering backend. */
  get engine(): RenderEngine {
    return this._engine;
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
    if (engine === 'maplibre-gl-raster') {
      // Hand rendering back to deck.gl: drop the cog-tiler map layers first.
      this._cogEngine?.clear();
    } else {
      // Hand rendering to cog-tiler: blank the deck.gl overlay first.
      this._overlay?.setProps({ layers: [] });
    }
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
      autoStats: null,
      bandCount: null,
      bandNames: null,
      palette: null,
      paletteTexture: null,
      beforeId: options?.beforeId?.trim() || null,
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
      const tiff = await this._deps.loadGeoTIFF(url);
      if (this._destroyed || !this.getLayer(layer.id)) return layer.id;
      // Both rendering engines stream tiles on demand, so the source must be a
      // tiled Cloud-Optimized GeoTIFF. A striped GeoTIFF (common for files
      // exported from desktop GIS) has no tile grid: the deck.gl path throws
      // 'Tiff is not tiled' deep inside an un-awaited parse step, which surfaces
      // only as a console error while the layer renders blank with a default
      // [0, 1] rescale window. Detect it up front and fail the layer with an
      // actionable message instead. See opengeos/GeoLibre#789.
      if (!tiff.isTiled) {
        throw new Error(
          'This GeoTIFF is striped, not tiled, so it cannot be streamed as ' +
            'map tiles. Convert it to a tiled Cloud-Optimized GeoTIFF (COG) ' +
            'first, for example with `rio cogeo create input.tif output.tif` ' +
            'or `gdal_translate input.tif output.tif -of COG`, then load the ' +
            'result.',
        );
      }
      layer.geotiff = tiff;
      layer.bandCount = tiff.count;
      layer.bandNames = readBandNames(tiff);
      layer.palette = extractPalette(tiff);
      layer.loading = false;
      if (!layer.userPickedMode) {
        // 1 or 2 bands → single + colormap. RGB on 2 bands leaves blue empty.
        if (tiff.count >= 3) {
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
    if (this._overlay) {
      this._deps.removeOverlay(this._map, this._overlay);
      this._overlay = null;
    }
    if (this._cogEngine) {
      this._cogEngine.destroy();
      this._cogEngine = null;
    }
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
    else this._ensureCogEngine();
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
      });
    }
    return this._cogEngine;
  }

  /** Records a cog-tiler source's bounds (fitting the map once when requested),
   * mirroring the deck path's onGeoTIFFLoad behavior. */
  private _onCogBounds(
    id: string,
    bounds: GeographicBounds,
    zoomTo: boolean,
  ): void {
    const layer = this.getLayer(id);
    if (!layer) return;
    const boundsArrived = !layer.bounds;
    layer.bounds = bounds;
    if (zoomTo && layer.zoomTo) {
      layer.zoomTo = false;
      this._fitBounds(bounds);
    }
    if (boundsArrived) this._emit({ type: 'rasterchange', layerId: id });
  }

  /** Surfaces a cog-tiler open / module-load failure as a layer (or global)
   * error. */
  private _onCogError(id: string | undefined, error: Error): void {
    if (this._destroyed) return;
    if (id) {
      const layer = this.getLayer(id);
      if (layer) {
        layer.loading = false;
        layer.error = error;
      }
      this._emit({ type: 'error', layerId: id, error });
      this._emit({ type: 'rasterchange', layerId: id });
    } else {
      this._emit({ type: 'error', error });
    }
  }

  /** Projects the renderable layers into the cog-tiler engine's input shape. */
  private _cogRenderableLayers(): CogEngineLayer[] {
    return this._layers
      .filter((l) => l.geotiff && l.state.visible && !this._crsFailed.has(l.id))
      .map((l) => ({
        id: l.id,
        source: l.file ?? l.url,
        state: l.state,
        autoStats: l.autoStats,
        beforeId: l.beforeId,
        zoomTo: l.zoomTo,
      }));
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

  private _computeStats(layer: RasterLayer): void {
    if (!layer.geotiff) return;
    const signal = layer.abort.signal;
    void (async () => {
      try {
        const stats = await this._deps.computeAutoStats(
          layer.geotiff!,
          signal,
          (partial) => {
            if (signal.aborted || this._destroyed) return;
            layer.autoStats = partial;
            this._rebuild();
            this._emit({ type: 'rasterchange', layerId: layer.id });
          },
        );
        if (signal.aborted || this._destroyed) return;
        layer.autoStats = stats;
        this._rebuild();
        this._emit({ type: 'rasterchange', layerId: layer.id });
      } catch {
        // Stats are an enhancement; rendering falls back to [0, 1] rescale.
      }
    })();
  }

  private _fitBounds(bounds: GeographicBounds): void {
    this._map.fitBounds(
      [
        [bounds.west, bounds.south],
        [bounds.east, bounds.north],
      ],
      { padding: 40, duration: 800 },
    );
  }

  /** Re-derives the deck.gl layer array from current layer states and pushes
   * it to the overlay. Layer ids are stable so deck.gl preserves each
   * layer's tile cache across rebuilds. */
  private _rebuild(): void {
    if (this._engine === 'cog-tiler-wasm') {
      // Keep the deck.gl overlay blank (if it was ever created) and let the
      // cog-tiler engine drive the native MapLibre raster layers.
      this._overlay?.setProps({ layers: [] });
      this._ensureCogEngine().sync(this._cogRenderableLayers());
      return;
    }
    if (!this._overlay) return;
    const layers = this._layers
      .filter((l) => l.geotiff && l.state.visible && !this._crsFailed.has(l.id))
      .map((l) => this._buildCogLayer(l));
    this._overlay.setProps({ layers });
  }

  private _buildCogLayer(layer: RasterLayer): COGLayer<MultiBandTileData> {
    const renderTile = this._renderTileFor(layer);
    // Fetch only the bands this layer's render pipeline samples, so any band
    // (e.g. band 12 of a 12-band image) can be displayed — not just the first
    // four. The id encodes the band set so a band change remounts the layer and
    // refetches (see cogLayerId); within a set the loader closure's identity is
    // irrelevant (the inner TileLayer ignores getTileData changes).
    const fetchBands = fetchBandsFor(layer);
    const getTileData = makeMultiBandTileLoader(fetchBands);

    // beforeId is read by @deck.gl/mapbox's MapboxOverlay in interleaved
    // mode but missing from COGLayer's narrower props type — build the props
    // as a const so structural assignability applies instead of the
    // excess-property check. Only forward ids that exist in the current
    // style; a stale id would make the overlay throw on the next style event.
    const cogProps = {
      id: cogLayerId(layer, fetchBands),
      geotiff: layer.geotiff!,
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
        // Only the first arrival is an observable change; onGeoTIFFLoad can
        // re-fire on later rebuilds with the same already-loaded GeoTIFF, and
        // re-emitting there could ping-pong with handlers that call setState.
        const boundsArrived = !layer.bounds;
        layer.bounds = options.geographicBounds;
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
    return buildRgbCompositeRenderTile(layer.state, layer.autoStats);
  }
}
