import { type Map as MapLibreMap } from 'maplibre-gl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TiTilerEngine,
  type TiTilerEngineLayer,
} from '../src/lib/state/TiTilerEngine';
import { createLayerState } from '../src/lib/state/RasterLayer';
import type { TiTilerTileJson } from '../src/lib/raster/titiler';

/** A fake map recording the source/layer mutations the engine performs. */
function makeFakeMap() {
  const sources = new Map<string, unknown>();
  const layers = new Map<string, unknown>();
  const handlers = new Map<string, Set<(e: unknown) => void>>();
  const map = {
    isStyleLoaded: () => true,
    getSource: (id: string) => sources.get(id),
    getLayer: (id: string) => layers.get(id),
    addSource: vi.fn((id: string, def: unknown) => sources.set(id, def)),
    addLayer: vi.fn((def: { id: string }) => layers.set(def.id, def)),
    removeLayer: vi.fn((id: string) => layers.delete(id)),
    removeSource: vi.fn((id: string) => sources.delete(id)),
    setPaintProperty: vi.fn(),
    setLayerZoomRange: vi.fn(),
    moveLayer: vi.fn(),
    on: vi.fn((t: string, h: (e: unknown) => void) => {
      (handlers.get(t) ?? handlers.set(t, new Set()).get(t)!).add(h);
    }),
    once: vi.fn(),
    off: vi.fn((t: string, h: (e: unknown) => void) => handlers.get(t)?.delete(h)),
  };
  const emit = (t: string, e: unknown) =>
    handlers.get(t)?.forEach((h) => h(e));
  return { map: map as unknown as MapLibreMap, sources, layers, raw: map, emit };
}

const ENDPOINT = 'https://titiler.example.com';

/** A tilejson response whose tile template carries a proxy `http://` origin. */
function tileJson(overrides?: Partial<TiTilerTileJson>): TiTilerTileJson {
  return {
    tiles: [
      'http://titiler.example.com/cog/tiles/WebMercatorQuad/{z}/{x}/{y}?url=a&tilesize=512',
    ],
    bounds: [-10, -5, 10, 5],
    minzoom: 5,
    maxzoom: 14,
    ...overrides,
  };
}

function layer(overrides?: Partial<TiTilerEngineLayer>): TiTilerEngineLayer {
  return {
    id: 'a',
    url: 'https://example.com/a.tif',
    kind: 'cog',
    state: createLayerState({ mode: 'single', bands: [1], colormap: 'viridis' }),
    autoStats: null,
    beforeId: null,
    zoomTo: true,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TiTilerEngine.sync', () => {
  it('fetches tilejson and adds a raster source rebased to the endpoint', async () => {
    const { map, raw } = makeFakeMap();
    const fetchTileJson = vi.fn(async () => tileJson());
    const onBounds = vi.fn();
    const engine = new TiTilerEngine(map, {
      endpoint: ENDPOINT,
      fetchTileJson,
      onBounds,
      onError: vi.fn(),
    });

    engine.sync([layer()]);
    await vi.waitFor(() => expect(raw.addLayer).toHaveBeenCalled());

    // The tilejson request targets the cog router with the render params.
    const requestUrl = fetchTileJson.mock.calls[0][0];
    expect(requestUrl).toContain('/cog/WebMercatorQuad/tilejson.json?');
    expect(requestUrl).toContain('colormap_name=viridis');

    const sourceDef = raw.addSource.mock.calls[0][1] as {
      type: string;
      tiles: string[];
      tileSize: number;
      bounds: number[];
    };
    expect(sourceDef.type).toBe('raster');
    // Origin rewritten to the configured (https) endpoint; path preserved.
    expect(sourceDef.tiles[0]).toBe(
      'https://titiler.example.com/cog/tiles/WebMercatorQuad/{z}/{x}/{y}?url=a&tilesize=512',
    );
    expect(sourceDef.tileSize).toBe(512);
    expect(sourceDef.bounds).toEqual([-10, -5, 10, 5]);
    // Bounds reported with the source's native minzoom (from the tilejson).
    expect(onBounds).toHaveBeenCalledWith(
      'a',
      { west: -10, south: -5, east: 10, north: 5 },
      true,
      5,
    );

    engine.destroy();
  });

  it('applies the layer state min/max zoom to the native raster layer', async () => {
    const { map, raw } = makeFakeMap();
    const fetchTileJson = vi.fn(async () => tileJson());
    const engine = new TiTilerEngine(map, {
      endpoint: ENDPOINT,
      fetchTileJson,
      onBounds: vi.fn(),
      onError: vi.fn(),
    });

    engine.sync([
      layer({
        state: createLayerState({
          mode: 'single',
          bands: [1],
          colormap: 'viridis',
          minZoom: 6,
          maxZoom: 11,
        }),
      }),
    ]);
    await vi.waitFor(() => expect(raw.addLayer).toHaveBeenCalled());

    const layerDef = raw.addLayer.mock.calls[0][0] as {
      minzoom?: number;
      maxzoom?: number;
    };
    expect(layerDef.minzoom).toBe(6);
    expect(layerDef.maxzoom).toBe(11);

    engine.destroy();
  });

  it('uses the mosaicjson router for a mosaic layer', async () => {
    const { map, raw } = makeFakeMap();
    const fetchTileJson = vi.fn(async () =>
      tileJson({
        tiles: [
          'http://titiler.example.com/mosaicjson/tiles/WebMercatorQuad/{z}/{x}/{y}?url=m',
        ],
      }),
    );
    const engine = new TiTilerEngine(map, {
      endpoint: ENDPOINT,
      fetchTileJson,
      onBounds: vi.fn(),
      onError: vi.fn(),
    });

    engine.sync([
      layer({
        id: 'm',
        url: 'https://example.com/m.json',
        kind: 'mosaicjson',
        state: createLayerState({ mode: 'rgb', bands: [1, 2, 3] }),
      }),
    ]);
    await vi.waitFor(() => expect(raw.addLayer).toHaveBeenCalled());

    expect(fetchTileJson.mock.calls[0][0]).toContain(
      '/mosaicjson/WebMercatorQuad/tilejson.json?',
    );

    engine.destroy();
  });

  it('re-fetches and re-adds the source when render settings change', async () => {
    const { map, raw } = makeFakeMap();
    const fetchTileJson = vi.fn(async () => tileJson());
    const engine = new TiTilerEngine(map, {
      endpoint: ENDPOINT,
      fetchTileJson,
      onBounds: vi.fn(),
      onError: vi.fn(),
    });

    const base = layer();
    engine.sync([base]);
    await vi.waitFor(() => expect(raw.addSource).toHaveBeenCalledTimes(1));

    engine.sync([
      { ...base, state: createLayerState({ mode: 'single', bands: [1], colormap: 'turbo' }) },
    ]);
    await vi.waitFor(() => expect(raw.addSource).toHaveBeenCalledTimes(2));
    expect(fetchTileJson).toHaveBeenCalledTimes(2);
    expect(fetchTileJson.mock.calls[1][0]).toContain('colormap_name=turbo');

    engine.destroy();
  });

  it('does not re-fetch when only opacity changes', async () => {
    const { map, raw } = makeFakeMap();
    const fetchTileJson = vi.fn(async () => tileJson());
    const engine = new TiTilerEngine(map, {
      endpoint: ENDPOINT,
      fetchTileJson,
      onBounds: vi.fn(),
      onError: vi.fn(),
    });

    const base = layer();
    engine.sync([base]);
    await vi.waitFor(() => expect(raw.addLayer).toHaveBeenCalled());

    engine.sync([
      {
        ...base,
        state: createLayerState({
          mode: 'single',
          bands: [1],
          colormap: 'viridis',
          opacity: 0.5,
        }),
      },
    ]);
    // Opacity is a paint property, not a tilejson param: no refetch.
    expect(fetchTileJson).toHaveBeenCalledTimes(1);
    expect(raw.setPaintProperty).toHaveBeenCalledWith('a', 'raster-opacity', 0.5);

    engine.destroy();
  });

  it('removes the MapLibre layer when a layer drops out of the sync set', async () => {
    const { map, raw } = makeFakeMap();
    const engine = new TiTilerEngine(map, {
      endpoint: ENDPOINT,
      fetchTileJson: async () => tileJson(),
      onBounds: vi.fn(),
      onError: vi.fn(),
    });

    engine.sync([layer()]);
    await vi.waitFor(() => expect(raw.addLayer).toHaveBeenCalled());

    engine.sync([]);
    expect(raw.removeLayer).toHaveBeenCalled();
    expect(raw.removeSource).toHaveBeenCalled();

    engine.destroy();
  });

  it('does not set a source minzoom (dynamic tiler renders any zoom), keeping bounds + maxzoom', async () => {
    const { map, raw } = makeFakeMap();
    const engine = new TiTilerEngine(map, {
      endpoint: ENDPOINT,
      fetchTileJson: async () => tileJson({ minzoom: 12, maxzoom: 19 }),
      onBounds: vi.fn(),
      onError: vi.fn(),
    });

    engine.sync([layer()]);
    await vi.waitFor(() => expect(raw.addSource).toHaveBeenCalled());
    const def = raw.addSource.mock.calls[0][1] as Record<string, unknown>;
    // minzoom must be absent so a small, high-min-zoom source still requests
    // tiles at the fitted (lower) zoom instead of showing nothing.
    expect(def.minzoom).toBeUndefined();
    expect(def.maxzoom).toBe(19);
    expect(def.bounds).toEqual([-10, -5, 10, 5]);

    engine.destroy();
  });

  it('refetches from the new base after setEndpoint', async () => {
    const { map, raw } = makeFakeMap();
    const fetchTileJson = vi.fn(async () => tileJson());
    const engine = new TiTilerEngine(map, {
      endpoint: ENDPOINT,
      fetchTileJson,
      onBounds: vi.fn(),
      onError: vi.fn(),
    });

    engine.sync([layer()]);
    await vi.waitFor(() => expect(raw.addLayer).toHaveBeenCalled());
    expect(fetchTileJson.mock.calls[0][0]).toContain('https://titiler.example.com/');

    engine.setEndpoint('https://other.example.com');
    engine.sync([layer()]);
    await vi.waitFor(() => expect(fetchTileJson).toHaveBeenCalledTimes(2));
    expect(fetchTileJson.mock.calls[1][0]).toContain('https://other.example.com/');

    engine.destroy();
  });

  it('surfaces a tile-load failure from the map error event through onError', async () => {
    const { map, raw, emit } = makeFakeMap();
    const onError = vi.fn();
    const engine = new TiTilerEngine(map, {
      endpoint: ENDPOINT,
      fetchTileJson: async () => tileJson(),
      onBounds: vi.fn(),
      onError,
    });

    engine.sync([layer()]);
    await vi.waitFor(() => expect(raw.addLayer).toHaveBeenCalled());
    const srcId = raw.addSource.mock.calls[0][0] as string;

    // MapLibre reports a failed tile fetch as an error event carrying sourceId.
    emit('error', { sourceId: srcId, error: new Error('502 Bad Gateway') });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBe('a');
    expect(onError.mock.calls[0][1]).toBeInstanceOf(Error);
    // A second failing tile for the same source does not re-report.
    emit('error', { sourceId: srcId, error: new Error('502 Bad Gateway') });
    expect(onError).toHaveBeenCalledTimes(1);

    engine.destroy();
  });

  it('ignores map errors from other sources', async () => {
    const { map, raw, emit } = makeFakeMap();
    const onError = vi.fn();
    const engine = new TiTilerEngine(map, {
      endpoint: ENDPOINT,
      fetchTileJson: async () => tileJson(),
      onBounds: vi.fn(),
      onError,
    });
    engine.sync([layer()]);
    await vi.waitFor(() => expect(raw.addLayer).toHaveBeenCalled());

    emit('error', { sourceId: 'some-other-source', error: new Error('x') });
    emit('error', { error: new Error('no source id') });
    expect(onError).not.toHaveBeenCalled();

    engine.destroy();
  });

  it('reports a tilejson failure through onError', async () => {
    const { map } = makeFakeMap();
    const onError = vi.fn();
    const engine = new TiTilerEngine(map, {
      endpoint: ENDPOINT,
      fetchTileJson: async () => {
        throw new Error('TiTiler request failed: 404 Not Found');
      },
      onBounds: vi.fn(),
      onError,
    });

    engine.sync([layer()]);
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onError.mock.calls[0][0]).toBe('a');
    expect(onError.mock.calls[0][1]).toBeInstanceOf(Error);

    engine.destroy();
  });
});
