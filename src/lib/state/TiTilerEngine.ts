import type { Map as MapLibreMap } from 'maplibre-gl';
import type { GeographicBounds, RasterLayerState } from '../core/types';
import type { AutoStats } from '../raster/stats';
import {
  buildTiTilerParams,
  buildTileJsonUrl,
  rebaseTileUrl,
  tileSizeOf,
  type TiTilerKind,
  type TiTilerTileJson,
} from '../raster/titiler';

/** A layer the TiTiler engine should render, projected from a RasterLayer. */
export interface TiTilerEngineLayer {
  id: string;
  /** COG or MosaicJSON URL passed to TiTiler as its `url` param. */
  url: string;
  /** Which TiTiler router renders the source. */
  kind: TiTilerKind;
  state: RasterLayerState;
  autoStats: AutoStats | null;
  /** Style layer id to insert the raster beneath, when present. */
  beforeId: string | null;
  /** Fit the map to the source bounds once known (consumed once). */
  zoomTo: boolean;
}

/** Injectable collaborators so the engine can be driven without a network or a
 * live map under tests. */
export interface TiTilerEngineDeps {
  /** TiTiler base URL (e.g. `https://titiler.d2s.org`). */
  endpoint: string;
  /** Fetches and parses a TiTiler `tilejson.json` (default: `fetch`). */
  fetchTileJson: (url: string) => Promise<TiTilerTileJson>;
  /** Reports a source's WGS84 bounds once its tilejson resolves, with the
   * source's native minimum zoom so the caller can floor the map fit inside the
   * range where tiles actually exist. */
  onBounds: (
    layerId: string,
    bounds: GeographicBounds,
    zoomTo: boolean,
    minzoom?: number,
  ) => void;
  /** Reports a tilejson failure for a layer. */
  onError: (layerId: string, error: Error) => void;
}

/** Default tilejson fetcher: surfaces TiTiler's `{detail}` error body as a
 * readable message rather than a bare HTTP status. */
export async function defaultFetchTileJson(
  url: string,
): Promise<TiTilerTileJson> {
  const resp = await fetch(url);
  const body: unknown = await resp.json().catch(() => null);
  if (!resp.ok) {
    const detail = (body as { detail?: unknown } | null)?.detail;
    const message =
      typeof detail === 'string'
        ? detail
        : detail
          ? JSON.stringify(detail)
          : `${resp.status} ${resp.statusText}`;
    throw new Error(`TiTiler request failed: ${message}`);
  }
  return body as TiTilerTileJson;
}

/** Per-instance source-id prefix so multiple controls never collide. */
let engineSeq = 0;

/** What was applied to the map for a layer, keyed by the request that produced
 * it — a changed key triggers a re-fetch + re-add. */
interface AppliedEntry {
  /** The tilejson request URL that produced the current tiles. */
  key: string;
  /** Whether the MapLibre source/layer are currently on the map. */
  added: boolean;
}

/**
 * The `titiler` rendering backend: a server-side dynamic tiler.
 *
 * For each visible layer it requests a `tilejson.json` from TiTiler (which
 * bakes the render params into a tile URL template and reports the source
 * bounds), then adds a native MapLibre raster source/layer pointed at those
 * tiles. Both a single COG (`/cog`) and a MosaicJSON of many COGs
 * (`/mosaicjson`) render through the same path — only the router differs.
 *
 * Unlike the deck.gl and cog-tiler-wasm engines, nothing is decoded in the
 * browser: TiTiler renders every tile, so this engine needs neither the GPU
 * pipeline nor the wasm module. It is constructed and synced by
 * {@link import('./LayerManager').LayerManager} only while the `titiler` engine
 * is selected.
 */
export class TiTilerEngine {
  private _map: MapLibreMap;
  private _deps: TiTilerEngineDeps;
  /** TiTiler base URL; changeable at runtime via {@link setEndpoint}. */
  private _endpoint: string;
  private _prefix = `mlrtt${engineSeq++}`;
  private _destroyed = false;
  /** The most recent desired layer set; re-applied after async work settles. */
  private _layers: TiTilerEngineLayer[] = [];
  /** Applied request state per layer id. */
  private _applied = new Map<string, AppliedEntry>();
  /** In-flight tilejson request key per layer, to dedupe concurrent fetches. */
  private _pending = new Map<string, string>();
  /** Layers whose bounds were already reported (report once per source url). */
  private _boundsKey = new Map<string, string>();
  private _onStyleLoad: (() => void) | null = null;
  /** Latches true once the style has loaded; see CogTilerEngine for the
   * rationale (isStyleLoaded may dip false again while sources load). */
  private _styleReady = false;
  /** Source ids whose tile failure was already reported, so a whole viewport of
   * failing tiles surfaces one error per layer, not one per tile. Reset when a
   * layer is (re-)added. */
  private _tileErrored = new Set<string>();
  private _onMapError: ((e: unknown) => void) | null = null;

  constructor(map: MapLibreMap, deps: TiTilerEngineDeps) {
    this._map = map;
    this._deps = deps;
    this._endpoint = deps.endpoint;
    // MapLibre reports a failed tile fetch (a TiTiler 4xx/5xx — e.g. an
    // unreadable asset, or a source the server can't reach) as a map 'error'
    // event carrying the sourceId. Surface the first such failure per layer so
    // a blank raster is explained instead of silent. Not every MapLibre build
    // emits sourceId, so this is best-effort.
    this._onMapError = (e: unknown) => this._handleMapError(e);
    // `on` exists on a real map; guarded for the minimal fakes used in tests.
    (this._map as unknown as { on?: (t: string, h: unknown) => void }).on?.(
      'error',
      this._onMapError,
    );
  }

  /** Renders the given layers (in draw order, first = bottom), adding, updating,
   * reordering, and removing native MapLibre raster layers to match. */
  sync(layers: TiTilerEngineLayer[]): void {
    this._layers = layers;
    this._apply();
  }

  /** Switches the TiTiler instance every layer renders through. The caller
   * follows with a {@link sync} so tiles refetch from the new endpoint (the
   * changed base URL alters each layer's request key, forcing a re-add). */
  setEndpoint(endpoint: string): void {
    this._endpoint = endpoint;
  }

  /** Removes all MapLibre raster layers/sources this engine added, keeping
   * per-layer bookkeeping so switching back re-fetches cheaply. */
  clear(): void {
    for (const id of [...this._applied.keys()]) this._removeMapLayer(id);
    this._applied.clear();
  }

  /** Tears the engine down: removes its layers and all caches. */
  destroy(): void {
    this._destroyed = true;
    if (this._onStyleLoad) {
      this._map.off('load', this._onStyleLoad);
      this._onStyleLoad = null;
    }
    if (this._onMapError) {
      (
        this._map as unknown as { off?: (t: string, h: unknown) => void }
      ).off?.('error', this._onMapError);
      this._onMapError = null;
    }
    this.clear();
    this._pending.clear();
    this._boundsKey.clear();
    this._tileErrored.clear();
  }

  /** Maps a MapLibre tile-load 'error' event back to the owning layer and
   * reports it once per layer (per applied render). */
  private _handleMapError(event: unknown): void {
    if (this._destroyed) return;
    const sourceId = (event as { sourceId?: string })?.sourceId;
    if (!sourceId || !sourceId.startsWith(`${this._prefix}-src-`)) return;
    if (this._tileErrored.has(sourceId)) return;
    const layerId = sourceId.slice(`${this._prefix}-src-`.length);
    if (!this._applied.has(layerId)) return;
    this._tileErrored.add(sourceId);
    const raw = (event as { error?: unknown }).error;
    const detail =
      raw instanceof Error
        ? raw.message
        : typeof raw === 'string'
          ? raw
          : 'the tile server returned an error';
    this._deps.onError(
      layerId,
      new Error(
        `TiTiler could not render tiles for this source (${detail}). The ` +
          'server may be unable to read the source, or be slow for this ' +
          "zoom; try a different TiTiler endpoint or zoom in.",
      ),
    );
  }

  /** Reconciles the map with {@link _layers}, deferring until the style loads. */
  private _apply(): void {
    if (this._destroyed) return;
    // addSource/addLayer throw before the style first loads; defer the first
    // apply. Once loaded, proceed unconditionally (a later isStyleLoaded()
    // === false only means sources are still loading). See CogTilerEngine.
    if (!this._styleReady) {
      if (this._map.isStyleLoaded()) {
        this._styleReady = true;
      } else {
        if (!this._onStyleLoad) {
          this._onStyleLoad = () => {
            this._onStyleLoad = null;
            this._styleReady = true;
            this._apply();
          };
          this._map.once('load', this._onStyleLoad);
        }
        return;
      }
    }

    const desired = this._layers;
    const desiredIds = new Set(desired.map((l) => l.id));
    for (const id of [...this._applied.keys()]) {
      if (!desiredIds.has(id)) this._removeMapLayer(id);
    }
    for (const layer of desired) this._applyLayer(layer);
    this._reorder(desired);
  }

  /** Requests (or reuses) the layer's tiles and adds/updates its raster layer. */
  private _applyLayer(layer: TiTilerEngineLayer): void {
    const params = buildTiTilerParams(layer.state, layer.autoStats);
    const key = buildTileJsonUrl(
      this._endpoint,
      layer.kind,
      layer.url,
      params,
    );
    const applied = this._applied.get(layer.id);
    if (applied?.added && applied.key === key) {
      // Only the opacity (a cheap paint change) can differ without changing the
      // tilejson request; keep it in sync without a refetch.
      this._setOpacity(layer);
      return;
    }
    // Nothing to do while an identical request is already in flight.
    if (this._pending.get(layer.id) === key) return;
    this._pending.set(layer.id, key);

    this._deps.fetchTileJson(key).then(
      (tilejson) => {
        this._pending.delete(layer.id);
        if (this._destroyed) return;
        // Bail if the layer was removed meanwhile.
        const current = this._layers.find((l) => l.id === layer.id);
        if (!current) return;
        // A newer sync may have changed the request; don't apply a stale one.
        const latestKey = buildTileJsonUrl(
          this._endpoint,
          current.kind,
          current.url,
          buildTiTilerParams(current.state, current.autoStats),
        );
        if (latestKey !== key) return;
        this._renderTiles(current, key, tilejson);
      },
      (err) => {
        this._pending.delete(layer.id);
        if (this._destroyed) return;
        this._deps.onError(
          layer.id,
          err instanceof Error ? err : new Error(String(err)),
        );
      },
    );
  }

  /** Adds/replaces the MapLibre raster source + layer from a tilejson response,
   * and reports the source bounds. */
  private _renderTiles(
    layer: TiTilerEngineLayer,
    key: string,
    tilejson: TiTilerTileJson,
  ): void {
    const template = tilejson.tiles?.[0];
    if (!template) {
      this._deps.onError(
        layer.id,
        new Error('TiTiler returned no tile URL for this source.'),
      );
      return;
    }
    const tiles = rebaseTileUrl(template, this._endpoint);
    const tileSize = tileSizeOf(template) ?? 256;

    this._removeMapLayer(layer.id);
    const srcId = this._srcId(layer.id);
    const lyrId = this._lyrId(layer.id);
    // A fresh render deserves a fresh chance to report a tile failure.
    this._tileErrored.delete(srcId);
    try {
      this._map.addSource(srcId, {
        type: 'raster',
        tiles: [tiles],
        tileSize,
        // `bounds` limits requests to the data's extent. `minzoom` is
        // deliberately NOT forwarded: TiTiler is a dynamic tiler that renders
        // any zoom (downsampling from overviews), but the tilejson advertises
        // the source's *native* min zoom — often well above the zoom fitBounds
        // lands on for a small, high-resolution source. Setting it as the
        // MapLibre source minzoom would make the map request no tiles at all
        // (a blank layer) until the user zoomed in. `maxzoom` is kept so deeper
        // views overzoom the finest tiles instead of requesting past native
        // resolution.
        ...(tilejson.bounds ? { bounds: tilejson.bounds } : {}),
        ...(typeof tilejson.maxzoom === 'number'
          ? { maxzoom: tilejson.maxzoom }
          : {}),
      });
      this._map.addLayer(
        {
          id: lyrId,
          type: 'raster',
          source: srcId,
          paint: { 'raster-opacity': layer.state.opacity },
        },
        this._beforeMapId(layer),
      );
    } catch (err) {
      this._deps.onError(
        layer.id,
        err instanceof Error ? err : new Error(String(err)),
      );
      return;
    }
    this._applied.set(layer.id, { key, added: true });

    // Report bounds once per source URL (a settings change re-fetches tilejson
    // but keeps the same extent, so re-reporting would re-fit the map).
    if (tilejson.bounds && tilejson.bounds.length === 4) {
      const [west, south, east, north] = tilejson.bounds;
      if (
        this._boundsKey.get(layer.id) !== layer.url &&
        [west, south, east, north].every(Number.isFinite)
      ) {
        this._boundsKey.set(layer.id, layer.url);
        this._deps.onBounds(
          layer.id,
          { west, south, east, north },
          layer.zoomTo,
          typeof tilejson.minzoom === 'number' ? tilejson.minzoom : undefined,
        );
      }
    }
    // Keep draw order correct after the async add.
    this._reorder(this._layers);
  }

  private _setOpacity(layer: TiTilerEngineLayer): void {
    const lyrId = this._lyrId(layer.id);
    if (this._map.getLayer(lyrId)) {
      this._map.setPaintProperty(lyrId, 'raster-opacity', layer.state.opacity);
    }
  }

  /** Enforces the draw order (first = bottom), honoring each layer's style
   * beforeId when present. */
  private _reorder(desired: TiTilerEngineLayer[]): void {
    for (const layer of desired) {
      const lyrId = this._lyrId(layer.id);
      if (!this._map.getLayer(lyrId)) continue;
      try {
        this._map.moveLayer(lyrId, this._beforeMapId(layer));
      } catch {
        // Ignore transient ordering errors during style churn.
      }
    }
  }

  /** Removes a layer's MapLibre layer + source and its applied bookkeeping. */
  private _removeMapLayer(id: string): void {
    const lyrId = this._lyrId(id);
    const srcId = this._srcId(id);
    try {
      if (this._map.getLayer(lyrId)) this._map.removeLayer(lyrId);
      if (this._map.getSource(srcId)) this._map.removeSource(srcId);
    } catch {
      // best-effort during teardown / style churn
    }
    this._applied.delete(id);
    this._tileErrored.delete(srcId);
  }

  /** Resolves a layer's style beforeId only when that layer exists. */
  private _beforeMapId(layer: TiTilerEngineLayer): string | undefined {
    if (!layer.beforeId) return undefined;
    try {
      return this._map.getLayer(layer.beforeId) ? layer.beforeId : undefined;
    } catch {
      return undefined;
    }
  }

  private _srcId(id: string): string {
    return `${this._prefix}-src-${id}`;
  }

  // The MapLibre style-layer id is the raster layer id itself, matching the
  // other engines so hosts that track layers by id resolve the same native
  // layer regardless of engine. See CogTilerEngine._lyrId.
  private _lyrId(id: string): string {
    return id;
  }
}
