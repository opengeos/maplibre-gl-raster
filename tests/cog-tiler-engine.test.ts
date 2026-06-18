import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CogTilerEngine,
  type CogEngineLayer,
  type CogTilerModule,
} from '../src/lib/state/CogTilerEngine';
import { createLayerState } from '../src/lib/state/RasterLayer';
import type { AutoStats } from '../src/lib/raster/stats';

/** A fake map recording the source/layer mutations the engine performs. */
function makeFakeMap() {
  const sources = new Map<string, unknown>();
  const layers = new Map<string, unknown>();
  const map = {
    isStyleLoaded: () => true,
    getSource: (id: string) => sources.get(id),
    getLayer: (id: string) => layers.get(id),
    addSource: vi.fn((id: string, def: unknown) => sources.set(id, def)),
    addLayer: vi.fn((def: { id: string }) => layers.set(def.id, def)),
    removeLayer: vi.fn((id: string) => layers.delete(id)),
    removeSource: vi.fn((id: string) => sources.delete(id)),
    setPaintProperty: vi.fn(),
    moveLayer: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
  };
  return { map: map as unknown as MapLibreMap, sources, layers, raw: map };
}

/** A fake cog-tiler-wasm module with a single rendering source. */
function makeFakeModule(opts?: { bounds?: number[]; hasPalette?: boolean }) {
  const renderTilePNG = vi.fn(async () => new Uint8Array([137, 80, 78, 71]));
  const source = {
    mode: '3857' as const,
    crsLabel: 'EPSG:3857',
    levels: [],
    boundsLonLat: opts?.bounds ?? [-10, -5, 10, 5],
    hasPalette: opts?.hasPalette ?? false,
    renderTilePNG,
  };
  const openCog = vi.fn(async () => source);
  const init = vi.fn(async () => undefined);
  const module = {
    init,
    openCog,
    colormaps: () => [],
  } as unknown as CogTilerModule;
  return { module, openCog, init, renderTilePNG, source };
}

function layer(overrides?: Partial<CogEngineLayer>): CogEngineLayer {
  return {
    id: 'a',
    source: 'https://example.com/a.tif',
    state: createLayerState({
      mode: 'single',
      bands: [1],
      colormap: 'viridis',
    }),
    autoStats: null,
    beforeId: null,
    zoomTo: true,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CogTilerEngine.sync', () => {
  it('loads the module, opens the source, and adds a MapLibre raster layer', async () => {
    const { map, raw } = makeFakeMap();
    const fake = makeFakeModule();
    const onBounds = vi.fn();
    const onError = vi.fn();
    const engine = new CogTilerEngine(map, {
      loadModule: async () => fake.module,
      onBounds,
      onError,
    });

    engine.sync([layer()]);
    await vi.waitFor(() => expect(raw.addLayer).toHaveBeenCalled());

    expect(fake.init).toHaveBeenCalled();
    expect(fake.openCog).toHaveBeenCalledWith('https://example.com/a.tif');
    expect(raw.addSource).toHaveBeenCalled();
    const sourceDef = raw.addSource.mock.calls[0][1] as {
      type: string;
      tiles: string[];
    };
    expect(sourceDef.type).toBe('raster');
    expect(sourceDef.tiles[0]).toMatch(/:\/\/a\/\{z\}\/\{x\}\/\{y\}\?v=1$/);
    expect(onBounds).toHaveBeenCalledWith(
      'a',
      { west: -10, south: -5, east: 10, north: 5 },
      true,
    );
    expect(onError).not.toHaveBeenCalled();

    engine.destroy();
  });

  it('maps layer state onto cog-tiler render options via the tile protocol', async () => {
    const addProtocol = vi.spyOn(maplibregl, 'addProtocol');
    const { map, raw } = makeFakeMap();
    const fake = makeFakeModule();
    const engine = new CogTilerEngine(map, {
      loadModule: async () => fake.module,
      onBounds: vi.fn(),
      onError: vi.fn(),
    });

    engine.sync([
      layer({
        state: createLayerState({
          mode: 'single',
          bands: [2],
          colormap: 'magma',
          reversed: true,
          rescale: [[0, 3000]],
          stretch: 'log',
          gamma: 1.5,
          nodata: -9999,
        }),
      }),
    ]);
    await vi.waitFor(() => expect(raw.addLayer).toHaveBeenCalled());

    const [scheme, handler] = addProtocol.mock.calls.at(-1)!;
    await handler(
      { url: `${scheme}://a/4/3/2` } as never,
      new AbortController(),
    );

    expect(fake.renderTilePNG).toHaveBeenCalledWith(4, 3, 2, {
      bidx: [2],
      stretch: 'log',
      gamma: 1.5,
      reversed: true,
      colormap: 'magma',
      rescale: [[0, 3000]],
      nodata: -9999,
    });

    engine.destroy();
  });

  it('omits the colormap for an embedded palette and applies RGB band selection', async () => {
    const addProtocol = vi.spyOn(maplibregl, 'addProtocol');
    const { map, raw } = makeFakeMap();
    const fake = makeFakeModule({ hasPalette: true });
    const engine = new CogTilerEngine(map, {
      loadModule: async () => fake.module,
      onBounds: vi.fn(),
      onError: vi.fn(),
    });

    engine.sync([
      layer({ state: createLayerState({ mode: 'rgb', bands: [4, 3, 2] }) }),
    ]);
    await vi.waitFor(() => expect(raw.addLayer).toHaveBeenCalled());

    const [scheme, handler] = addProtocol.mock.calls.at(-1)!;
    await handler(
      { url: `${scheme}://a/1/0/0` } as never,
      new AbortController(),
    );
    const opts = fake.renderTilePNG.mock.calls.at(-1)![3] as Record<
      string,
      unknown
    >;
    expect(opts.bidx).toEqual([4, 3, 2]);
    expect(opts.colormap).toBeUndefined();

    engine.destroy();
  });

  it('derives the rescale range from auto-stats when none is set', async () => {
    const addProtocol = vi.spyOn(maplibregl, 'addProtocol');
    const { map, raw } = makeFakeMap();
    const fake = makeFakeModule();
    const stats: AutoStats = {
      perBand: new Map([
        [1, { min: 0, max: 100, histogram: new Array<number>(100).fill(1) }],
      ]),
      global: { min: 0, max: 100, histogram: new Array<number>(100).fill(1) },
    };
    const engine = new CogTilerEngine(map, {
      loadModule: async () => fake.module,
      onBounds: vi.fn(),
      onError: vi.fn(),
    });

    engine.sync([
      layer({
        autoStats: stats,
        state: createLayerState({ mode: 'single', bands: [1], rescale: null }),
      }),
    ]);
    await vi.waitFor(() => expect(raw.addLayer).toHaveBeenCalled());

    const [scheme, handler] = addProtocol.mock.calls.at(-1)!;
    await handler(
      { url: `${scheme}://a/1/0/0` } as never,
      new AbortController(),
    );
    const opts = fake.renderTilePNG.mock.calls.at(-1)![3] as {
      rescale?: [number, number][];
    };
    // A non-degenerate range was derived from the histogram.
    expect(opts.rescale).toHaveLength(1);
    expect(opts.rescale![0][0]).toBeLessThan(opts.rescale![0][1]);

    engine.destroy();
  });

  it('bumps the tile version when render settings change', async () => {
    const { map, raw } = makeFakeMap();
    const fake = makeFakeModule();
    const engine = new CogTilerEngine(map, {
      loadModule: async () => fake.module,
      onBounds: vi.fn(),
      onError: vi.fn(),
    });

    const base = layer();
    engine.sync([base]);
    await vi.waitFor(() => expect(raw.addSource).toHaveBeenCalledTimes(1));

    // A colormap change must refetch tiles (new version), reusing the source.
    engine.sync([
      {
        ...base,
        state: createLayerState({
          mode: 'single',
          bands: [1],
          colormap: 'turbo',
        }),
      },
    ]);
    await vi.waitFor(() => expect(raw.addSource).toHaveBeenCalledTimes(2));
    const v2 = (raw.addSource.mock.calls[1][1] as { tiles: string[] }).tiles[0];
    expect(v2).toMatch(/\?v=2$/);
    // openCog is only called once: the source identity did not change.
    expect(fake.openCog).toHaveBeenCalledTimes(1);

    engine.destroy();
  });

  it('removes the MapLibre layer when a layer drops out of the sync set', async () => {
    const { map, raw } = makeFakeMap();
    const fake = makeFakeModule();
    const engine = new CogTilerEngine(map, {
      loadModule: async () => fake.module,
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

  it('reports an open failure through onError', async () => {
    const { map } = makeFakeMap();
    const fake = makeFakeModule();
    fake.openCog.mockRejectedValueOnce(new Error('range request failed'));
    const onError = vi.fn();
    const engine = new CogTilerEngine(map, {
      loadModule: async () => fake.module,
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
