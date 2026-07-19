import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import type { CogSource, RenderOptions } from 'cog-tiler-wasm';
import type { GeographicBounds, RasterLayerState } from '../core/types';
import type { MosaicAsset } from '../raster/mosaic';
import { autoRangeFor, statsForBand } from '../raster/render-pipeline';
import type { AutoStats } from '../raster/stats';
import { PALETTE_COLORMAP } from '../ui/ColormapPicker';

/** The lazily-imported `cog-tiler-wasm` module surface the engine relies on. */
export type CogTilerModule = typeof import('cog-tiler-wasm');

/** A layer the engine should render, projected from a managed RasterLayer. */
export interface CogEngineLayer {
  id: string;
  /** Remote COG URL, or a local File for in-memory reads. For a mosaic layer
   * this is the manifest URL, used only as the cache identity — the pixels come
   * from {@link assets}. */
  source: string | File;
  /** The mosaic's member COGs (URL + WGS84 bbox) when this layer came from a
   * MosaicJSON or STAC manifest, else null. Present means the tile handler
   * composites the covering assets per tile instead of reading one COG. */
  assets?: MosaicAsset[] | null;
  /** Zoom below which a large mosaic is hidden, mirroring the deck.gl engine so
   * a world view never opens every asset at once. */
  minzoom?: number | null;
  state: RasterLayerState;
  autoStats: AutoStats | null;
  /** Style layer id to insert the raster beneath, when present. */
  beforeId: string | null;
  /** Fit the map to the source bounds once opened (consumed once). */
  zoomTo: boolean;
}

/** Injectable collaborators so the engine can be driven without a real wasm
 * module or a live map under tests. */
export interface CogTilerEngineDeps {
  /** Loads the optional `cog-tiler-wasm` package (default: a dynamic import). */
  loadModule: () => Promise<CogTilerModule>;
  /** Reports a source's WGS84 bounds once it opens. */
  onBounds: (
    layerId: string,
    bounds: GeographicBounds,
    zoomTo: boolean,
  ) => void;
  /** Reports an open / module-load failure (layerId omitted for global ones). */
  onError: (layerId: string | undefined, error: Error) => void;
}

/**
 * The colormaps `cog-tiler-wasm` can render, mirroring its `colormaps()`.
 *
 * The panel offers the ~100 ramps baked into the deck.gl colormap sprite, but
 * this engine only knows these. Passing any other name does not fall back to a
 * default — the wasm tiler renders the tile **black**, which reads as "the
 * colormap did nothing". The picker is therefore narrowed to this set while
 * this engine is active (see
 * {@link import('./LayerManager').LayerManager.supportedColormaps}).
 *
 * Kept as a literal rather than read from `colormaps()` so the UI can filter
 * before the wasm module has loaded; re-check it when upgrading the package.
 */
export const COG_TILER_COLORMAPS: readonly string[] = [
  'viridis',
  'magma',
  'plasma',
  'inferno',
  'cividis',
  'turbo',
  'terrain',
  'blues',
  'greens',
  'reds',
  'rdylgn',
  'spectral',
  'gray',
];

/** A blank tile: cog-tiler returns an empty buffer for tiles outside the COG. */
const EMPTY_TILE = new Uint8Array(0);

/** Upper bound on how many mosaic assets one tile will composite.
 *
 * Deliberately high: this is a runaway guard for a pathological manifest, not a
 * routine limit. A zoomed-out tile legitimately spans every asset of a modest
 * mosaic (all 45 of the NAIP sample at z3), and truncating there would drop
 * real imagery from the picture. Cost stays bounded because low zoom has very
 * few tiles, high zoom exits early once a tile is opaque, and
 * {@link ASSET_CONCURRENCY} caps decodes in flight. Passing it is logged rather
 * than silently truncating. */
const MAX_TILE_ASSETS = 512;

/** How many assets a single tile opens/renders at once. Each is a CPU decode in
 * wasm, so a burst of tiles times a burst of assets would otherwise saturate the
 * main thread and stall the map. */
const ASSET_CONCURRENCY = 4;

/** The WGS84 bounds of an XYZ tile, as `[west, south, east, north]`. */
function tileBBox(
  z: number,
  x: number,
  y: number,
): [number, number, number, number] {
  const n = 2 ** z;
  const lng = (i: number) => (i / n) * 360 - 180;
  const lat = (j: number) => {
    const t = Math.PI * (1 - (2 * j) / n);
    return (Math.atan(Math.sinh(t)) * 180) / Math.PI;
  };
  return [lng(x), lat(y + 1), lng(x + 1), lat(y)];
}

/** True when two `[west, south, east, north]` boxes overlap (edges included). */
function bboxIntersects(
  a: [number, number, number, number],
  b: [number, number, number, number],
): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/**
 * Paints `src` under whatever `dst` already holds, in place.
 *
 * "Under", not over: assets are composited in manifest order and the first one
 * covering a pixel keeps it, which matches how the pixel inspector picks the
 * asset it reports (see `assetsAt`). A mosaic's assets are drawn in whatever
 * order its spatial index yields, so no order is authoritative — being
 * self-consistent with the inspector is what matters, so the value shown on
 * click is the value drawn.
 *
 * Only fully transparent destination pixels are filled. Mosaic assets are
 * opaque inside their footprint and transparent outside it (verified against
 * `renderTileRGBA`, which returns null for a tile entirely outside a COG), so
 * partial alpha never arises in practice and true blending is not needed.
 *
 * @returns Whether `dst` is now fully opaque, so remaining assets can be skipped
 */
function paintUnder(
  dst: Uint8ClampedArray,
  src: Uint8Array | Uint8ClampedArray,
): boolean {
  let complete = true;
  for (let i = 3; i < dst.length; i += 4) {
    if (dst[i] !== 0) continue;
    if (src[i] === 0) {
      complete = false;
      continue;
    }
    dst[i - 3] = src[i - 3];
    dst[i - 2] = src[i - 2];
    dst[i - 1] = src[i - 1];
    dst[i] = src[i];
  }
  return complete;
}

/** Per-instance protocol scheme counter so multiple controls never collide on a
 * single global MapLibre protocol registration. */
let protocolSeq = 0;

interface SourceEntry {
  /** Identity of the opened resource; a change re-opens it. */
  key: string;
  source: CogSource | null;
}

/**
 * The `cog-tiler-wasm` rendering backend: a serverless CPU/WASM XYZ tiler wired
 * to a MapLibre custom protocol. For each visible layer it opens a
 * {@link CogSource} and adds a native MapLibre raster source/layer whose tiles
 * resolve through `<scheme>://<layerId>/{z}/{x}/{y}`; the protocol handler
 * renders each tile with the layer's current settings.
 *
 * The deck.gl path remains the default; this engine is constructed and synced
 * by {@link import('./LayerManager').LayerManager} only while the
 * `cog-tiler-wasm` engine is selected. The heavy wasm module and its peer deps
 * load lazily on first {@link sync}.
 */
export class CogTilerEngine {
  private _map: MapLibreMap;
  private _deps: CogTilerEngineDeps;
  private _protocol = `mlrcog${protocolSeq++}`;
  private _protocolRegistered = false;
  private _module: CogTilerModule | null = null;
  private _modulePromise: Promise<CogTilerModule> | null = null;
  private _destroyed = false;
  /** The most recent desired layer set; re-applied after async work settles. */
  private _layers: CogEngineLayer[] = [];
  private _sources = new Map<string, SourceEntry>();
  /** Render settings the protocol handler reads per tile, by layer id. A mosaic
   * layer carries `assets` instead of a single opened `source`. */
  private _registry = new Map<
    string,
    {
      source: CogSource | null;
      assets: MosaicAsset[] | null;
      render: RenderOptions;
    }
  >();
  /** Opened mosaic assets by COG URL, shared across layers and tiles. A failed
   * open resolves null and is evicted so a later tile can retry. */
  private _assetSources = new Map<string, Promise<CogSource | null>>();
  /** Last applied render key per layer, to know when to bust the tile cache. */
  private _applied = new Map<string, string>();
  /** Monotonic tile-URL version per layer, bumped to refetch on settings edits. */
  private _versions = new Map<string, number>();
  private _onStyleLoad: (() => void) | null = null;
  /** Latches true once the style has loaded. After that, `isStyleLoaded()` may
   * dip false again while sources load - which must NOT re-gate later syncs
   * (the one-shot 'load' event never fires twice), or stats-driven re-renders
   * would be lost. */
  private _styleReady = false;

  constructor(map: MapLibreMap, deps: CogTilerEngineDeps) {
    this._map = map;
    this._deps = deps;
  }

  /** Renders the given layers (in draw order, first = bottom), adding, updating,
   * reordering, and removing native MapLibre raster layers to match. */
  sync(layers: CogEngineLayer[]): void {
    this._layers = layers;
    this._apply();
  }

  /** Removes all MapLibre raster layers/sources this engine added, keeping the
   * opened-source cache and protocol so switching back is cheap. */
  clear(): void {
    for (const id of [...this._registry.keys()]) this._removeMapLayer(id);
    this._registry.clear();
    this._applied.clear();
  }

  /** Tears the engine down: removes its layers, the protocol, and all caches. */
  destroy(): void {
    this._destroyed = true;
    if (this._onStyleLoad) {
      this._map.off('load', this._onStyleLoad);
      this._onStyleLoad = null;
    }
    this.clear();
    if (this._protocolRegistered) {
      try {
        maplibregl.removeProtocol(this._protocol);
      } catch {
        // best-effort
      }
      this._protocolRegistered = false;
    }
    this._sources.clear();
    this._assetSources.clear();
    this._versions.clear();
  }

  /** Reconciles the map with {@link _layers}, deferring until the style is
   * loaded and the wasm module is ready. */
  private _apply(): void {
    if (this._destroyed) return;
    // addSource/addLayer throw before the style first loads, so defer the very
    // first apply until then. Once loaded, proceed unconditionally: a later
    // isStyleLoaded() === false only means sources are still loading (adding is
    // still safe), and re-deferring to the one-shot 'load' event would strand
    // every subsequent sync (e.g. the rescale update once auto-stats arrive).
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
    const mod = this._ensureModule();
    if (!mod) return; // loading; _apply re-runs when it resolves
    this._ensureProtocol();

    const desired = this._layers;
    const desiredIds = new Set(desired.map((l) => l.id));
    // Drop layers no longer desired (hidden / removed).
    for (const id of [...this._registry.keys()]) {
      if (!desiredIds.has(id)) this._dropLayer(id);
    }
    for (const layer of desired) this._applyLayer(layer, mod);
    this._reorder(desired);
  }

  /** Returns the loaded module, or null while it loads (kicking off the load
   * and a re-apply on the first call). */
  private _ensureModule(): CogTilerModule | null {
    if (this._module) return this._module;
    if (!this._modulePromise) {
      this._modulePromise = this._deps
        .loadModule()
        .then(async (m) => {
          await m.init();
          if (!this._destroyed) this._module = m;
          return m;
        })
        .catch((err) => {
          this._modulePromise = null;
          this._deps.onError(
            undefined,
            err instanceof Error ? err : new Error(String(err)),
          );
          throw err;
        });
      this._modulePromise.then(
        () => {
          if (!this._destroyed) this._apply();
        },
        () => {},
      );
    }
    return null;
  }

  private _ensureProtocol(): void {
    if (this._protocolRegistered) return;
    maplibregl.addProtocol(
      this._protocol,
      // MapLibre's typed handler is broader than the {url}->{data} shape used
      // here; narrow it locally.
      (async (params: { url: string }) => ({
        data: await this._handleTile(params.url),
      })) as Parameters<typeof maplibregl.addProtocol>[1],
    );
    this._protocolRegistered = true;
  }

  /** Protocol handler: parse `<scheme>://<layerId>/<z>/<x>/<y>` and render the
   * tile with the layer's current settings. */
  private _handleTile = async (url: string): Promise<Uint8Array> => {
    try {
      const rest = url.slice(url.indexOf('://') + 3);
      const [path] = rest.split('?');
      const [layerId, zs, xs, ys] = path.split('/');
      const z = Number(zs);
      const x = Number(xs);
      const y = Number(ys);
      const entry = this._registry.get(layerId);
      if (!entry || ![z, x, y].every(Number.isFinite)) return EMPTY_TILE;
      if (entry.assets) {
        return await this._renderMosaicTile(entry.assets, entry.render, z, x, y);
      }
      if (!entry.source) return EMPTY_TILE;
      return await entry.source.renderTilePNG(z, x, y, entry.render);
    } catch {
      // A failed tile renders blank rather than breaking the whole map.
      return EMPTY_TILE;
    }
  };

  /**
   * Renders one mosaic tile by compositing every asset that covers it.
   *
   * Unlike a plain layer — one open COG, one `renderTilePNG` — a mosaic has no
   * single image, so the tile is assembled here: pick the assets whose bbox
   * meets the tile, render each to RGBA, and paint them into one buffer. Assets
   * are opened lazily and cached by URL, so panning across a large mosaic only
   * ever opens what the viewport actually touched.
   *
   * Work stops as soon as the tile is fully opaque, which is the common case
   * after the first asset: mosaic assets tile the plane, so most tiles fall
   * inside exactly one.
   */
  private async _renderMosaicTile(
    assets: MosaicAsset[],
    render: RenderOptions,
    z: number,
    x: number,
    y: number,
  ): Promise<Uint8Array> {
    const mod = this._module;
    if (!mod) return EMPTY_TILE;
    const tile = tileBBox(z, x, y);
    const covering = assets.filter((a) => bboxIntersects(tile, a.bbox));
    if (covering.length === 0) return EMPTY_TILE;
    if (covering.length > MAX_TILE_ASSETS) {
      // Never silently truncate: say what was dropped, so a mosaic that renders
      // incomplete is diagnosable rather than mysterious.
      console.warn(
        `[maplibre-gl-raster] tile ${z}/${x}/${y} covered by ${covering.length} ` +
          `mosaic assets; compositing the first ${MAX_TILE_ASSETS}`,
      );
    }
    const candidates = covering.slice(0, MAX_TILE_ASSETS);

    let dst: Uint8ClampedArray | null = null;
    for (let i = 0; i < candidates.length; ) {
      // The first candidate is tried alone: mosaic assets tile the plane, so it
      // usually fills the tile and the common case costs a single decode. Only
      // once it leaves holes (an edge tile, or assets that merely touch at a
      // shared boundary) is it worth fanning out over the rest.
      const width = i === 0 ? 1 : ASSET_CONCURRENCY;
      const batch = candidates.slice(i, i + width);
      i += width;
      const rendered = await Promise.all(
        batch.map(async (asset) => {
          const source = await this._openAsset(asset.url, mod);
          if (!source || this._destroyed) return null;
          try {
            return await source.renderTileRGBA(z, x, y, render);
          } catch {
            // One unreadable asset must not blank the whole tile.
            return null;
          }
        }),
      );
      for (const rgba of rendered) {
        if (!rgba) continue;
        if (!dst) dst = new Uint8ClampedArray(rgba.length);
        else if (rgba.length !== dst.length) continue;
        if (paintUnder(dst, rgba)) return mod.rgbaToPng(dst);
      }
    }
    if (!dst) return EMPTY_TILE;
    return mod.rgbaToPng(dst);
  }

  /** Opens (or reuses) a mosaic asset's COG. Resolves null on failure and drops
   * the cache entry so a later tile can retry a transient error. */
  private _openAsset(
    url: string,
    mod: CogTilerModule,
  ): Promise<CogSource | null> {
    let opened = this._assetSources.get(url);
    if (!opened) {
      opened = mod.openCog(url).catch(() => {
        this._assetSources.delete(url);
        return null;
      });
      this._assetSources.set(url, opened);
    }
    return opened;
  }

  /** Opens (or reuses) the layer's source and adds/updates its raster layer. */
  private _applyLayer(layer: CogEngineLayer, mod: CogTilerModule): void {
    // A mosaic opens nothing up front: its extent comes from the manifest (the
    // manager already has it) and its assets open per tile, on demand.
    const entry = layer.assets ? null : this._ensureSource(layer, mod);
    if (entry && !entry.source) return; // still opening; _apply re-runs on resolve
    const render = this._renderOptionsFor(layer);
    const renderKey = JSON.stringify(render);

    const srcId = this._srcId(layer.id);
    const lyrId = this._lyrId(layer.id);
    const exists = !!this._map.getSource(srcId);
    if (!exists) {
      this._addMapLayer(layer, renderKey);
    } else if (this._applied.get(layer.id) !== renderKey) {
      // RasterTileSource has no live tiles setter, so re-add with a bumped
      // version to make MapLibre refetch with the new settings.
      this._removeMapLayer(layer.id);
      this._addMapLayer(layer, renderKey);
    }
    // Register the render settings AFTER any remove/add cycle: _removeMapLayer
    // clears the registry, and the protocol handler reads it per tile, so a
    // stale-cleared entry would make every tile render blank.
    this._registry.set(layer.id, {
      source: entry?.source ?? null,
      assets: layer.assets ?? null,
      render,
    });
    // Opacity is a cheap paint change that never needs a tile refetch.
    if (this._map.getLayer(lyrId)) {
      this._map.setPaintProperty(lyrId, 'raster-opacity', layer.state.opacity);
    }
  }

  private _addMapLayer(layer: CogEngineLayer, renderKey: string): void {
    const srcId = this._srcId(layer.id);
    const lyrId = this._lyrId(layer.id);
    // Clear any stale layer/source under these ids first - e.g. the deck.gl
    // custom layer keyed by the same raster id, left over from a just-switched
    // engine - so addLayer/addSource cannot throw "already exists".
    try {
      if (this._map.getLayer(lyrId)) this._map.removeLayer(lyrId);
      if (this._map.getSource(srcId)) this._map.removeSource(srcId);
    } catch {
      // best-effort
    }
    const version = (this._versions.get(layer.id) ?? 0) + 1;
    this._versions.set(layer.id, version);
    this._map.addSource(srcId, {
      type: 'raster',
      tiles: [`${this._protocol}://${layer.id}/{z}/{x}/{y}?v=${version}`],
      tileSize: 256,
      // A large mosaic hides below the zoom where a single tile would span most
      // of it, so a zoomed-out view never composites every asset at once. Same
      // guard the deck.gl engine applies via MosaicLayer's minZoom.
      ...(layer.minzoom != null ? { minzoom: Math.floor(layer.minzoom) } : {}),
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
    this._applied.set(layer.id, renderKey);
  }

  /** Enforces the draw order (first = bottom), honoring each layer's style
   * beforeId when present. */
  private _reorder(desired: CogEngineLayer[]): void {
    for (const layer of desired) {
      const lyrId = this._lyrId(layer.id);
      if (!this._map.getLayer(lyrId)) continue;
      const before = this._beforeMapId(layer);
      try {
        this._map.moveLayer(lyrId, before);
      } catch {
        // Ignore transient ordering errors during style churn.
      }
    }
  }

  /** Opens the layer's COG (or reuses the open one), re-opening when the source
   * identity changed. */
  private _ensureSource(
    layer: CogEngineLayer,
    mod: CogTilerModule,
  ): SourceEntry {
    const key = this._sourceKey(layer.source);
    const existing = this._sources.get(layer.id);
    if (existing && existing.key === key) return existing;
    if (existing) this._dropLayer(layer.id);

    const entry: SourceEntry = { key, source: null };
    this._sources.set(layer.id, entry);
    mod.openCog(layer.source).then(
      (source) => {
        // Bail if the layer was removed or its source replaced meanwhile.
        if (this._destroyed || this._sources.get(layer.id) !== entry) return;
        entry.source = source;
        const b = source.boundsLonLat;
        if (b && b.length === 4 && b.every(Number.isFinite)) {
          this._deps.onBounds(
            layer.id,
            { west: b[0], south: b[1], east: b[2], north: b[3] },
            layer.zoomTo,
          );
        }
        this._apply();
      },
      (err) => {
        if (this._destroyed || this._sources.get(layer.id) !== entry) return;
        this._deps.onError(
          layer.id,
          err instanceof Error ? err : new Error(String(err)),
        );
      },
    );
    return entry;
  }

  /** Maps a layer's visualization state onto cog-tiler render options. Opacity
   * is intentionally excluded (applied as a paint property instead). */
  private _renderOptionsFor(layer: CogEngineLayer): RenderOptions {
    const s = layer.state;
    // cog-tiler-wasm has no band-math endpoint, so index mode can't compute
    // (A - B) / (A + B) here. Degrade to a colormapped view of operand A —
    // the default 'maplibre-gl-raster' engine renders the real index. The
    // panel notes this limitation when the CPU engine is active.
    const colormapped = s.mode === 'single' || s.mode === 'index';
    const bidx = colormapped
      ? [s.bands[0] ?? 1]
      : s.bands.slice(0, 3).map((b) => b || 1);
    const opts: RenderOptions = { bidx, stretch: s.stretch, gamma: s.gamma };
    if (colormapped) {
      opts.reversed = s.reversed;
      // The embedded palette renders categorically; cog-tiler picks it up from
      // the COG, so leave colormap unset in that case.
      if (s.colormap && s.colormap !== PALETTE_COLORMAP) {
        opts.colormap = s.colormap;
      }
    }
    if (s.rescale) {
      opts.rescale = s.rescale;
    } else {
      // Mirror the panel's auto range (2-98% percentile) per band.
      const ranges = bidx.map((b) => {
        const st = statsForBand(layer.autoStats, b);
        return st ? autoRangeFor(st) : null;
      });
      if (ranges.every((r): r is [number, number] => r !== null)) {
        opts.rescale = ranges;
      }
    }
    // A numeric override maps directly; 'auto' uses the COG's declared nodata
    // (omit) and 'off' has no cog-tiler equivalent, so it is omitted too.
    if (typeof s.nodata === 'number') opts.nodata = s.nodata;
    return opts;
  }

  /** Removes a layer's MapLibre layer + source and forgets its open source. */
  private _dropLayer(id: string): void {
    this._removeMapLayer(id);
    this._sources.delete(id);
  }

  /** Removes a layer's MapLibre layer + source and per-layer render bookkeeping
   * (keeping its opened source cached). */
  private _removeMapLayer(id: string): void {
    const lyrId = this._lyrId(id);
    const srcId = this._srcId(id);
    try {
      if (this._map.getLayer(lyrId)) this._map.removeLayer(lyrId);
      if (this._map.getSource(srcId)) this._map.removeSource(srcId);
    } catch {
      // best-effort during teardown / style churn
    }
    this._registry.delete(id);
    this._applied.delete(id);
  }

  /** Resolves a layer's style beforeId only when that layer exists. */
  private _beforeMapId(layer: CogEngineLayer): string | undefined {
    if (!layer.beforeId) return undefined;
    try {
      return this._map.getLayer(layer.beforeId) ? layer.beforeId : undefined;
    } catch {
      return undefined;
    }
  }

  private _sourceKey(source: string | File): string {
    return typeof source === 'string'
      ? source
      : `file:${source.name}:${source.size}:${source.lastModified}`;
  }

  private _srcId(id: string): string {
    return `${this._protocol}-src-${id}`;
  }

  // The MapLibre style-layer id is the raster layer id itself. This matches the
  // deck.gl engine (whose interleaved custom layer is keyed by the raster id),
  // so hosts that track raster layers by id - e.g. GeoLibre's layer panel and
  // on-map ordering, which expect the native layer under `info.id` - resolve the
  // same native layer for both engines.
  private _lyrId(id: string): string {
    return id;
  }
}
