import { MapboxOverlay } from '@deck.gl/mapbox';
import { COGLayer } from '@developmentseed/deck.gl-geotiff';
import {
  createColormapTexture,
  decodeColormapSprite,
} from '@developmentseed/deck.gl-raster/gpu-modules';
import type { GeoTIFF } from '@developmentseed/geotiff';
import type { Device, Texture } from '@luma.gl/core';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { AddRasterOptions, RasterLayerState } from '../core/types';
import { colormapsPngUrl } from '../raster/colormaps';
import { loadGeoTIFF as defaultLoadGeoTIFF } from '../raster/load-geotiff';
import {
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
import { generateId } from '../utils/helpers';
import {
  createLayerState,
  deriveLayerName,
  type GeographicBounds,
  type RasterLayer,
} from './RasterLayer';

// Module-scope so the getTileData identity stays stable for the lifetime of
// the page. deck.gl's TileLayer treats a changed getTileData reference as
// cache-invalidating, so allocating a fresh closure per rebuild would refetch
// tiles on every state change (opacity drag, band swap, etc.). All layers
// share one loader that always fetches the first up-to-4 bands.
const FETCHED_BANDS = Array.from({ length: MAX_BAND_SLOTS }, (_, i) => i + 1);
const getTileData = makeMultiBandTileLoader(FETCHED_BANDS);

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
}

const DEFAULT_DEPS: LayerManagerDeps = {
  loadGeoTIFF: defaultLoadGeoTIFF,
  computeAutoStats: defaultComputeAutoStats,
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
  private _overlay: OverlayLike | null = null;
  private _device: Device | null = null;
  private _colormapTexture: Texture | null = null;
  private _handlers = new globalThis.Map<
    LayerManagerEvent,
    Set<LayerManagerEventHandler>
  >();
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
    options?: { interleaved?: boolean },
    deps?: Partial<LayerManagerDeps>,
  ) {
    this._map = map;
    this._interleaved = options?.interleaved ?? true;
    this._deps = { ...DEFAULT_DEPS, ...deps };
  }

  /** The id of the layer currently selected for editing, or null. */
  get selectedId(): string | null {
    return this._selectedId;
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
      name:
        options?.name ?? deriveLayerName(isFile ? source.name : source),
      source: isFile
        ? { kind: 'file', fileName: source.name, objectUrl: url }
        : { kind: 'url', url },
      url,
      state: createLayerState(options?.state),
      userPickedMode:
        options?.state?.mode !== undefined || options?.state?.bands !== undefined,
      geotiff: null,
      autoStats: null,
      bandCount: null,
      bandNames: null,
      bounds: null,
      zoomTo: options?.zoomTo ?? true,
      loading: true,
      error: null,
      abort: new AbortController(),
    };

    this._layers.push(layer);
    this._ensureOverlay();
    this.select(layer.id);
    this._emit({ type: 'rasteradd', layerId: layer.id });

    try {
      const tiff = await this._deps.loadGeoTIFF(url);
      if (this._destroyed || !this.getLayer(layer.id)) return layer.id;
      layer.geotiff = tiff;
      layer.bandCount = tiff.count;
      layer.bandNames = readBandNames(tiff);
      layer.loading = false;
      if (!layer.userPickedMode) {
        // 1 or 2 bands → single + colormap. RGB on 2 bands leaves blue empty.
        if (tiff.count >= 3) {
          layer.state.mode = 'rgb';
          layer.state.bands = [1, 2, 3];
        } else {
          layer.state.mode = 'single';
          layer.state.bands = [1];
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
    }
    this._layers = [];
    this._selectedId = null;
    if (this._overlay) {
      this._deps.removeOverlay(this._map, this._overlay);
      this._overlay = null;
    }
    this._handlers.clear();
  }

  private _emit(data: Omit<LayerManagerEventData, 'type'> & { type: LayerManagerEvent }): void {
    const handlers = this._handlers.get(data.type);
    if (handlers) {
      handlers.forEach((handler) => handler(data));
    }
  }

  private _ensureOverlay(): void {
    if (this._overlay) return;
    this._overlay = this._deps.createOverlay(this._map, {
      interleaved: this._interleaved,
      onDeviceInitialized: (device) => {
        this._device = device;
        void this._loadColormapTexture();
      },
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
    if (!this._overlay) return;
    const layers = this._layers
      .filter((l) => l.geotiff && l.state.visible)
      .map((l) => this._buildCogLayer(l));
    this._overlay.setProps({ layers });
  }

  private _buildCogLayer(layer: RasterLayer): COGLayer<MultiBandTileData> {
    const renderTile =
      layer.state.mode === 'single' && this._colormapTexture
        ? buildSingleCompositeRenderTile(
            layer.state,
            this._colormapTexture,
            layer.autoStats,
          )
        : buildRgbCompositeRenderTile(layer.state, layer.autoStats);

    return new COGLayer({
      id: layer.id,
      geotiff: layer.geotiff!,
      opacity: layer.state.opacity,
      getTileData,
      renderTile,
      onGeoTIFFLoad: (
        _tiff: GeoTIFF,
        options: { geographicBounds: GeographicBounds },
      ) => {
        layer.bounds = options.geographicBounds;
        if (layer.zoomTo) {
          layer.zoomTo = false;
          this._fitBounds(layer.bounds);
        }
      },
    });
  }
}
