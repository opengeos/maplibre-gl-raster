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
function makeFakeMap(options?: {
  styleLoaded?: boolean;
  onAddLayer?: () => void;
}) {
  const sources = new Map<string, unknown>();
  const layers = new Map<string, unknown>();
  const handlers = new Map<string, Set<() => void>>();
  // Tracked separately so `once` behaves like MapLibre's: fired at most once,
  // then dropped. A shared set would let a second fire() re-invoke it and hide
  // exactly the one-shot semantics these tests are about.
  const onceHandlers = new Map<string, Set<() => void>>();
  let styleLoaded = options?.styleLoaded ?? true;
  const addHandler = (
    registry: Map<string, Set<() => void>>,
    type: string,
    handler: () => void,
  ) => {
    const set = registry.get(type) ?? new Set<() => void>();
    set.add(handler);
    registry.set(type, set);
  };
  const emit = (type: string) => {
    for (const handler of [...(handlers.get(type) ?? [])]) handler();
    const pending = [...(onceHandlers.get(type) ?? [])];
    onceHandlers.get(type)?.clear();
    for (const handler of pending) handler();
  };
  const map = {
    isStyleLoaded: () => styleLoaded,
    getSource: (id: string) => sources.get(id),
    getLayer: (id: string) => layers.get(id),
    addSource: vi.fn((id: string, def: unknown) => sources.set(id, def)),
    addLayer: vi.fn((def: { id: string }) => {
      layers.set(def.id, def);
      options?.onAddLayer?.();
    }),
    removeLayer: vi.fn((id: string) => layers.delete(id)),
    removeSource: vi.fn((id: string) => sources.delete(id)),
    setPaintProperty: vi.fn(),
    setLayerZoomRange: vi.fn(),
    moveLayer: vi.fn(),
    once: vi.fn((type: string, handler: () => void) => {
      addHandler(onceHandlers, type, handler);
    }),
    on: vi.fn((type: string, handler: () => void) => {
      addHandler(handlers, type, handler);
    }),
    // MapLibre's off() also removes a pending once listener.
    off: vi.fn((type: string, handler: () => void) => {
      handlers.get(type)?.delete(handler);
      onceHandlers.get(type)?.delete(handler);
    }),
  };
  return {
    map: map as unknown as MapLibreMap,
    sources,
    layers,
    raw: map,
    /** Fires an event without changing isStyleLoaded(). */
    fire: emit,
    /** Marks the style loaded and fires the event the engine waits on. */
    finishStyleLoad: (type = 'styledata') => {
      styleLoaded = true;
      emit(type);
    },
    /** Simulates setStyle(): custom map artifacts disappear, then the new
     * style settles and emits styledata. */
    replaceStyle: () => {
      styleLoaded = false;
      sources.clear();
      layers.clear();
      styleLoaded = true;
      emit('styledata');
    },
    listenerCount: (type: string) =>
      (handlers.get(type)?.size ?? 0) + (onceHandlers.get(type)?.size ?? 0),
  };
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
  // Regression: the engine used to wait on the one-shot 'load' event, which
  // MapLibre fires exactly once per map. An engine whose first sync happens
  // after the map has loaded -- while a setStyle swap is in flight, which is
  // what opening a saved project does -- attached a handler that never fired
  // again and silently never added its layers (opengeos/GeoLibre#1463).
  it('still adds its layers when the style settles after the map already loaded', async () => {
    const { map, raw, finishStyleLoad } = makeFakeMap({ styleLoaded: false });
    const fake = makeFakeModule();
    const engine = new CogTilerEngine(map, {
      loadModule: async () => fake.module,
      onBounds: vi.fn(),
      onError: vi.fn(),
    });

    engine.sync([layer()]);
    // Nothing yet: the style cannot accept addSource/addLayer.
    expect(raw.addLayer).not.toHaveBeenCalled();
    // The wait must be repeatable, not a one-shot 'load' subscription.
    expect(raw.once).not.toHaveBeenCalledWith('load', expect.anything());

    finishStyleLoad();
    await vi.waitFor(() => expect(raw.addLayer).toHaveBeenCalled());
  });

  it('ignores a styledata burst fired while the style is still loading', async () => {
    const { map, raw, fire, finishStyleLoad, listenerCount } = makeFakeMap({
      styleLoaded: false,
    });
    const fake = makeFakeModule();
    const engine = new CogTilerEngine(map, {
      loadModule: async () => fake.module,
      onBounds: vi.fn(),
      onError: vi.fn(),
    });

    engine.sync([layer()]);
    // styledata fires repeatedly while a style loads; only the one that leaves
    // isStyleLoaded() true may release the gate.
    fire('styledata');
    fire('styledata');
    expect(raw.addLayer).not.toHaveBeenCalled();
    expect(listenerCount('styledata')).toBe(1);

    finishStyleLoad();
    await vi.waitFor(() => expect(raw.addLayer).toHaveBeenCalled());
    // It stays attached so a later setStyle can restore native layers.
    expect(listenerCount('styledata')).toBe(1);
    engine.destroy();
    expect(listenerCount('styledata')).toBe(0);
  });

  it('re-adds its native source and layer after the map style is replaced', async () => {
    const { map, raw, replaceStyle } = makeFakeMap();
    const fake = makeFakeModule();
    const engine = new CogTilerEngine(map, {
      loadModule: async () => fake.module,
      onBounds: vi.fn(),
      onError: vi.fn(),
    });

    engine.sync([layer()]);
    await vi.waitFor(() => expect(raw.addLayer).toHaveBeenCalledTimes(1));

    replaceStyle();

    await vi.waitFor(() => expect(raw.addLayer).toHaveBeenCalledTimes(2));
    expect(raw.addSource).toHaveBeenCalledTimes(2);
    // The COG itself remains open; only MapLibre's discarded style artifacts
    // are rebuilt.
    expect(fake.openCog).toHaveBeenCalledTimes(1);
    engine.destroy();
  });

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

  it('applies the layer state min/max zoom to the native raster layer', async () => {
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
          bands: [1],
          colormap: 'viridis',
          minZoom: 4,
          maxZoom: 9,
        }),
      }),
    ]);
    await vi.waitFor(() =>
      expect(raw.setLayerZoomRange).toHaveBeenCalledWith('a', 4, 9),
    );

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

  it('can render a tile requested synchronously while addLayer runs', async () => {
    const addProtocol = vi.spyOn(maplibregl, 'addProtocol');
    let firstTile: Promise<{ data: Uint8Array }> | null = null;
    const { map, raw } = makeFakeMap({
      onAddLayer: () => {
        const [scheme, handler] = addProtocol.mock.calls.at(-1)!;
        firstTile = handler(
          { url: `${scheme}://a/1/0/0` } as never,
          new AbortController(),
        ) as Promise<{ data: Uint8Array }>;
      },
    });
    const fake = makeFakeModule();
    const engine = new CogTilerEngine(map, {
      loadModule: async () => fake.module,
      onBounds: vi.fn(),
      onError: vi.fn(),
    });

    engine.sync([layer()]);
    await vi.waitFor(() => expect(raw.addLayer).toHaveBeenCalled());
    expect(firstTile).not.toBeNull();
    const result = await firstTile!;

    expect(fake.renderTilePNG).toHaveBeenCalledWith(
      1,
      0,
      0,
      expect.any(Object),
    );
    expect([...result.data]).toEqual([137, 80, 78, 71]);

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
