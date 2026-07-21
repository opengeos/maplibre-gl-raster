import { describe, expect, it, vi, type Mock } from 'vitest';
import type { GeoTIFF } from '@developmentseed/geotiff';
import type { Map as MapLibreMap } from 'maplibre-gl';
import {
  LayerManager,
  type LayerManagerDeps,
  type LayerManagerEventData,
  type OverlayLike,
} from '../src/lib/state/LayerManager';
import { toLayerInfo } from '../src/lib/state/RasterLayer';
import type { AutoStats } from '../src/lib/raster/stats';

function makeFakeTiff(count = 3, isTiled = true): GeoTIFF {
  return {
    count,
    isTiled,
    image: { value: () => undefined },
  } as unknown as GeoTIFF;
}

/** A minimal fake cog-tiler-wasm module for the engine-selection tests. */
function makeFakeCogModule(colormaps: string[] = []) {
  const source = {
    mode: '3857' as const,
    crsLabel: 'EPSG:3857',
    levels: [],
    boundsLonLat: [-10, -5, 10, 5],
    hasPalette: false,
    renderTilePNG: vi.fn(async () => new Uint8Array([1])),
  };
  return {
    init: vi.fn(async () => undefined),
    openCog: vi.fn(async () => source),
    // The real module reports the ramps compiled into its wasm; an empty list
    // stands for a build that predates colormaps().
    colormaps: () => colormaps,
  };
}

function makeFakeStats(): AutoStats {
  const band = { min: 0, max: 255, histogram: new Array<number>(128).fill(1) };
  return {
    perBand: new Map([
      [1, band],
      [2, band],
      [3, band],
    ]),
    global: band,
  };
}

function makeHarness(opts?: {
  bandCount?: number;
  failLoad?: boolean;
  notTiled?: boolean;
  epsgResolver?: LayerManagerDeps['epsgResolver'];
  engine?: 'maplibre-gl-raster' | 'cog-tiler-wasm';
  /** Colormaps the fake wasm module reports; empty stands for an older build. */
  cogColormaps?: string[];
}) {
  const setProps = vi.fn();
  const overlay: OverlayLike = { setProps };
  const map = {
    addControl: vi.fn(),
    removeControl: vi.fn(),
    fitBounds: vi.fn(),
    getLayer: vi.fn((id: string) => (id === 'existing-layer' ? {} : undefined)),
    // Native raster-layer surface used by the cog-tiler-wasm engine.
    isStyleLoaded: () => true,
    getSource: vi.fn(() => undefined),
    addSource: vi.fn(),
    addLayer: vi.fn(),
    removeLayer: vi.fn(),
    removeSource: vi.fn(),
    setPaintProperty: vi.fn(),
    moveLayer: vi.fn(),
    once: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    getZoom: vi.fn(() => 0),
    setLayerZoomRange: vi.fn(),
  } as unknown as MapLibreMap;

  const loadCogTiler = vi.fn(async () =>
    makeFakeCogModule(opts?.cogColormaps ?? []),
  );
  const deps: Partial<LayerManagerDeps> = {
    loadGeoTIFF: vi.fn(async (url: string) => {
      if (opts?.failLoad) throw new Error(`load failed: ${url}`);
      return makeFakeTiff(opts?.bandCount ?? 3, !opts?.notTiled);
    }),
    computeAutoStats: vi.fn(async () => makeFakeStats()),
    createOverlay: vi.fn(() => overlay),
    removeOverlay: vi.fn(),
    loadCogTiler,
    ...(opts?.epsgResolver ? { epsgResolver: opts.epsgResolver } : {}),
  };

  const manager = new LayerManager(
    map,
    { interleaved: true, engine: opts?.engine },
    deps,
  );
  const events: LayerManagerEventData[] = [];
  for (const type of [
    'rasteradd',
    'rasterremove',
    'rasterchange',
    'rasterselect',
    'error',
  ] as const) {
    manager.on(type, (e) => events.push(e));
  }
  return { manager, map, overlay, setProps, deps, loadCogTiler, events };
}

describe('LayerManager.addRaster', () => {
  it('adds a layer from a URL, loads it, and emits events', async () => {
    const { manager, events, setProps, deps } = makeHarness();
    const id = await manager.addRaster('https://example.com/data/cog.tif');

    expect(deps.loadGeoTIFF).toHaveBeenCalledWith(
      'https://example.com/data/cog.tif',
    );
    const layer = manager.getLayer(id)!;
    expect(layer.name).toBe('cog.tif');
    expect(layer.source).toEqual({
      kind: 'url',
      url: 'https://example.com/data/cog.tif',
    });
    expect(layer.bandCount).toBe(3);
    expect(layer.loading).toBe(false);
    // 3 bands → RGB auto-pick.
    expect(layer.state.mode).toBe('rgb');
    expect(layer.state.bands).toEqual([1, 2, 3]);
    expect(events.map((e) => e.type)).toContain('rasteradd');
    expect(events.map((e) => e.type)).toContain('rasterchange');
    // The overlay received a non-empty layer array.
    const lastCall = setProps.mock.calls.at(-1)![0];
    expect(lastCall.layers).toHaveLength(1);
  });

  it('auto-picks single-band mode for COGs with fewer than 3 bands', async () => {
    const { manager } = makeHarness({ bandCount: 1 });
    const id = await manager.addRaster('https://example.com/dem.tif');
    const layer = manager.getLayer(id)!;
    expect(layer.state.mode).toBe('single');
    expect(layer.state.bands).toEqual([1]);
  });

  it('respects caller-supplied mode/bands over the auto-pick', async () => {
    const { manager } = makeHarness({ bandCount: 4 });
    const id = await manager.addRaster('https://example.com/ms.tif', {
      state: { mode: 'rgb', bands: [4, 3, 2] },
    });
    expect(manager.getLayer(id)!.state.bands).toEqual([4, 3, 2]);
  });

  it('stores a caller-supplied beforeId and trims blanks to null', async () => {
    const { manager } = makeHarness();
    const a = await manager.addRaster('https://example.com/a.tif', {
      beforeId: 'existing-layer',
    });
    expect(manager.getLayer(a)!.beforeId).toBe('existing-layer');

    const b = await manager.addRaster('https://example.com/b.tif', {
      beforeId: '  ',
    });
    expect(manager.getLayer(b)!.beforeId).toBeNull();
  });

  it('updates a raster beforeId and rebuilds with the resolved id', async () => {
    const { manager, setProps } = makeHarness();
    const id = await manager.addRaster('https://example.com/a.tif');
    expect(manager.getLayer(id)!.beforeId).toBeNull();
    const before = setProps.mock.calls.length;

    manager.setBeforeId(id, 'existing-layer');
    expect(manager.getLayer(id)!.beforeId).toBe('existing-layer');
    expect(setProps.mock.calls.length).toBeGreaterThan(before);
    const layers = setProps.mock.calls.at(-1)![0].layers;
    expect(layers[0].props.beforeId).toBe('existing-layer');
  });

  it('trims a blank beforeId to null and no-ops when unchanged', async () => {
    const { manager, setProps } = makeHarness();
    const id = await manager.addRaster('https://example.com/a.tif', {
      beforeId: 'existing-layer',
    });
    const before = setProps.mock.calls.length;
    manager.setBeforeId(id, 'existing-layer'); // unchanged → no rebuild
    expect(setProps.mock.calls.length).toBe(before);
    manager.setBeforeId(id, '   '); // blank → null, rebuild
    expect(manager.getLayer(id)!.beforeId).toBeNull();
    expect(setProps.mock.calls.length).toBeGreaterThan(before);
  });

  it('creates the overlay once for multiple layers', async () => {
    const { manager, deps } = makeHarness();
    await manager.addRaster('https://example.com/a.tif');
    await manager.addRaster('https://example.com/b.tif');
    expect(deps.createOverlay).toHaveBeenCalledTimes(1);
    expect(manager.getLayers()).toHaveLength(2);
  });

  it('selects the newly added layer', async () => {
    const { manager } = makeHarness();
    const a = await manager.addRaster('https://example.com/a.tif');
    expect(manager.selectedId).toBe(a);
    const b = await manager.addRaster('https://example.com/b.tif');
    expect(manager.selectedId).toBe(b);
  });

  it('marks the layer errored and rejects when loading fails', async () => {
    const { manager, events } = makeHarness({ failLoad: true });
    await expect(
      manager.addRaster('https://example.com/broken.tif'),
    ).rejects.toThrow('load failed');
    const layer = manager.getLayers()[0];
    expect(layer.error).toBeInstanceOf(Error);
    expect(layer.loading).toBe(false);
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('rejects a striped (non-tiled) GeoTIFF with an actionable error', async () => {
    const { manager, events, setProps } = makeHarness({ notTiled: true });
    await expect(
      manager.addRaster('https://example.com/striped.tif'),
    ).rejects.toThrow(/striped, not tiled/);
    const layer = manager.getLayers()[0];
    expect(layer.error).toBeInstanceOf(Error);
    expect(layer.error?.message).toMatch(/Cloud-Optimized GeoTIFF/);
    expect(layer.loading).toBe(false);
    // The tiff is never attached, so neither engine tries to render it.
    expect(layer.geotiff).toBeNull();
    expect(events.some((e) => e.type === 'error')).toBe(true);
    const lastCall = setProps.mock.calls.at(-1)?.[0];
    if (lastCall) expect(lastCall.layers).toHaveLength(0);
  });

  it('accepts a local File and creates a blob source', async () => {
    const createObjectURL = vi.fn(() => 'blob:fake-url');
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL,
      revokeObjectURL: vi.fn(),
    });
    try {
      const { manager, deps } = makeHarness();
      const file = new File(['x'], 'local.tif', { type: 'image/tiff' });
      const id = await manager.addRaster(file);
      const layer = manager.getLayer(id)!;
      expect(createObjectURL).toHaveBeenCalledWith(file);
      expect(layer.source).toEqual({
        kind: 'file',
        fileName: 'local.tif',
        objectUrl: 'blob:fake-url',
      });
      expect(deps.loadGeoTIFF).toHaveBeenCalledWith('blob:fake-url');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('LayerManager.removeRaster', () => {
  it('removes the layer, aborts stats, and revokes blob URLs', async () => {
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:fake-url'),
      revokeObjectURL,
    });
    try {
      const { manager, events, setProps } = makeHarness();
      const file = new File(['x'], 'local.tif', { type: 'image/tiff' });
      const id = await manager.addRaster(file);
      const abortSignal = manager.getLayer(id)!.abort.signal;

      manager.removeRaster(id);
      expect(manager.getLayers()).toHaveLength(0);
      expect(abortSignal.aborted).toBe(true);
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake-url');
      expect(events.some((e) => e.type === 'rasterremove')).toBe(true);
      const lastCall = setProps.mock.calls.at(-1)![0];
      expect(lastCall.layers).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('moves the selection to another layer', async () => {
    const { manager } = makeHarness();
    const a = await manager.addRaster('https://example.com/a.tif');
    const b = await manager.addRaster('https://example.com/b.tif');
    manager.removeRaster(b);
    expect(manager.selectedId).toBe(a);
    manager.removeRaster(a);
    expect(manager.selectedId).toBeNull();
  });
});

describe('LayerManager.setState / setVisible', () => {
  it('merges state patches and re-renders', async () => {
    const { manager, setProps } = makeHarness();
    const id = await manager.addRaster('https://example.com/a.tif');
    setProps.mockClear();

    manager.setState(id, { opacity: 0.5, gamma: 1.4 });
    const layer = manager.getLayer(id)!;
    expect(layer.state.opacity).toBe(0.5);
    expect(layer.state.gamma).toBe(1.4);
    expect(layer.state.mode).toBe('rgb'); // untouched fields preserved
    expect(setProps).toHaveBeenCalled();
  });

  it('drops hidden layers from the overlay layer array', async () => {
    const { manager, setProps } = makeHarness();
    const a = await manager.addRaster('https://example.com/a.tif');
    await manager.addRaster('https://example.com/b.tif');

    manager.setVisible(a, false);
    const lastCall = setProps.mock.calls.at(-1)![0];
    expect(lastCall.layers).toHaveLength(1);

    manager.setVisible(a, true);
    const nextCall = setProps.mock.calls.at(-1)![0];
    expect(nextCall.layers).toHaveLength(2);
  });

  it('treats a user mode change as sticky', async () => {
    const { manager } = makeHarness();
    const id = await manager.addRaster('https://example.com/a.tif');
    manager.setState(id, { mode: 'single', bands: [2] });
    expect(manager.getLayer(id)!.userPickedMode).toBe(true);
  });
});

describe('LayerManager tile-loader band selection', () => {
  /** The id of the most recently pushed deck.gl layer. The fetched band set is
   * encoded in it, and deck.gl only refetches a layer's tiles when its id
   * changes (the inner TileLayer has no getTileData updateTrigger), so the id
   * is the observable signal for "will these bands be fetched". */
  const lastLayerId = (setProps: ReturnType<typeof vi.fn>): string => {
    const layers = setProps.mock.calls.at(-1)![0].layers as { id: string }[];
    return layers[0].id;
  };

  it('keeps the layer id (band set) stable across non-band state changes', async () => {
    // A changed id remounts the layer and refetches every tile, so an opacity
    // drag must not change it.
    const { manager, setProps } = makeHarness({ bandCount: 12 });
    const id = await manager.addRaster('https://example.com/ms.tif');
    const before = lastLayerId(setProps);
    manager.setState(id, { opacity: 0.3 });
    expect(lastLayerId(setProps)).toBe(before);
  });

  it('changes the layer id (forcing a refetch) when bands change', async () => {
    const { manager, setProps } = makeHarness({ bandCount: 12 });
    const id = await manager.addRaster('https://example.com/ms.tif');
    const rgb123 = lastLayerId(setProps);
    expect(rgb123).toContain('#b1-2-3'); // default RGB fetches bands 1,2,3

    // A genuine band swap must refetch, so the id changes…
    manager.setState(id, { bands: [4, 5, 6] });
    const rgb456 = lastLayerId(setProps);
    expect(rgb456).not.toBe(rgb123);
    expect(rgb456).toContain('#b4-5-6');

    // …but reordering RGB channels within the same band set keeps the id (and
    // thus the cached textures): render-time channel reassignment, no refetch.
    manager.setState(id, { bands: [6, 5, 4] });
    expect(lastLayerId(setProps)).toBe(rgb456);
  });

  it('fetches a high band for single-band rendering (band 12 of 12)', async () => {
    // Band 12 must be fetched so its pseudocolor renders rather than falling
    // back to band 1 (issue #485). Single-band fetches exactly that one band.
    const { manager, setProps } = makeHarness({ bandCount: 12 });
    const id = await manager.addRaster('https://example.com/ms.tif');
    manager.setState(id, { mode: 'single', bands: [12] });
    expect(lastLayerId(setProps)).toContain('#b12');
  });

  it('keeps every RGB-sampled band when state carries extra entries', async () => {
    // With more entries than channels (R,G,B = first three), a naive
    // dedupe-then-sort-then-cap could drop a sampled band: [12,1,2,3,4] sorts
    // to [1,2,3,4,12] and caps to [1,2,3,4] — losing the red channel's 12.
    // Only the first three (12,1,2) are sampled, so the fetched set is {1,2,12}.
    const { manager, setProps } = makeHarness({ bandCount: 12 });
    const id = await manager.addRaster('https://example.com/ms.tif');
    manager.setState(id, { mode: 'rgb', bands: [12, 1, 2, 3, 4] });
    expect(lastLayerId(setProps)).toContain('#b1-2-12');
  });
});

describe('LayerManager.reorder', () => {
  it('moves a layer within the draw order and clamps the index', async () => {
    const { manager } = makeHarness();
    const a = await manager.addRaster('https://example.com/a.tif');
    const b = await manager.addRaster('https://example.com/b.tif');
    const c = await manager.addRaster('https://example.com/c.tif');

    manager.reorder(c, 0);
    expect(manager.getLayers().map((l) => l.id)).toEqual([c, a, b]);

    manager.reorder(c, 99);
    expect(manager.getLayers().map((l) => l.id)).toEqual([a, b, c]);

    manager.reorder('missing', 0);
    expect(manager.getLayers().map((l) => l.id)).toEqual([a, b, c]);
  });
});

describe('LayerManager.select', () => {
  it('emits rasterselect and ignores unknown ids', async () => {
    const { manager, events } = makeHarness();
    const a = await manager.addRaster('https://example.com/a.tif');
    events.length = 0;

    manager.select(null);
    expect(manager.selectedId).toBeNull();
    manager.select(a);
    expect(manager.selectedId).toBe(a);
    manager.select('missing');
    expect(manager.selectedId).toBe(a);
    expect(events.filter((e) => e.type === 'rasterselect')).toHaveLength(2);
  });
});

describe('LayerManager.destroy', () => {
  it('aborts stats, removes the overlay, and clears layers', async () => {
    const { manager, deps, map, overlay } = makeHarness();
    const id = await manager.addRaster('https://example.com/a.tif');
    const abortSignal = manager.getLayer(id)!.abort.signal;

    manager.destroy();
    expect(abortSignal.aborted).toBe(true);
    expect(deps.removeOverlay).toHaveBeenCalledWith(map, overlay);
    expect(manager.getLayers()).toHaveLength(0);
  });
});

describe('LayerManager bounds integration', () => {
  const BOUNDS = { west: -10, south: -5, east: 10, north: 5 };

  /** Pulls the onGeoTIFFLoad callback off the last COGLayer pushed to the
   * overlay, as deck.gl would invoke it once the raster renders. */
  function lastOnGeoTIFFLoad(setProps: ReturnType<typeof vi.fn>) {
    const lastCall = setProps.mock.calls.at(-1)![0];
    return lastCall.layers[0].props.onGeoTIFFLoad as (
      tiff: GeoTIFF,
      options: { geographicBounds: typeof BOUNDS },
    ) => void;
  }

  it('stores bounds, fits the map, and emits rasterchange once', async () => {
    const { manager, map, events, setProps } = makeHarness();
    const id = await manager.addRaster('https://example.com/a.tif');
    events.length = 0;

    const onGeoTIFFLoad = lastOnGeoTIFFLoad(setProps);
    onGeoTIFFLoad(makeFakeTiff(), { geographicBounds: BOUNDS });

    expect(manager.getLayer(id)!.bounds).toEqual(BOUNDS);
    expect(map.fitBounds).toHaveBeenCalledWith(
      [
        [BOUNDS.west, BOUNDS.south],
        [BOUNDS.east, BOUNDS.north],
      ],
      expect.anything(),
    );
    expect(
      events.filter((e) => e.type === 'rasterchange' && e.layerId === id),
    ).toHaveLength(1);

    // Later rebuilds re-fire onGeoTIFFLoad with the same GeoTIFF; that is
    // not an observable change and must not re-emit (or re-zoom).
    onGeoTIFFLoad(makeFakeTiff(), { geographicBounds: BOUNDS });
    expect(
      events.filter((e) => e.type === 'rasterchange' && e.layerId === id),
    ).toHaveLength(1);
    expect(map.fitBounds).toHaveBeenCalledTimes(1);
  });

  it('clamps pole-overshooting latitudes so fitBounds never sees an invalid LngLat', async () => {
    const { manager, map, setProps } = makeHarness();
    const id = await manager.addRaster('https://example.com/gebco.tif');

    // Global rasters whose pixel size was stored rounded (e.g. GEBCO's 1/240°)
    // compute bounds that overshoot the poles by a floating-point epsilon.
    // MapLibre's LngLat throws on |lat| > 90, so these must be clamped.
    lastOnGeoTIFFLoad(setProps)(makeFakeTiff(), {
      geographicBounds: {
        west: -180,
        south: -90.0000000000144,
        east: 180.00000000002876,
        north: 90.0000000000144,
      },
    });

    // Latitudes clamp to the valid range; longitudes pass through untouched
    // (MapLibre accepts any longitude, and clamping would corrupt
    // antimeridian-crossing rasters).
    const expected = {
      west: -180,
      south: -90,
      east: 180.00000000002876,
      north: 90,
    };
    expect(manager.getLayer(id)!.bounds).toEqual(expected);
    expect(map.fitBounds).toHaveBeenCalledWith(
      [
        [expected.west, expected.south],
        [expected.east, expected.north],
      ],
      expect.anything(),
    );
  });

  it('exposes bounds, loading, and error in toLayerInfo snapshots', async () => {
    const { manager, setProps } = makeHarness();
    const id = await manager.addRaster('https://example.com/a.tif');

    let info = toLayerInfo(manager.getLayer(id)!);
    expect(info.bounds).toBeNull();
    expect(info.loading).toBe(false);
    expect(info.error).toBeNull();

    lastOnGeoTIFFLoad(setProps)(makeFakeTiff(), { geographicBounds: BOUNDS });
    info = toLayerInfo(manager.getLayer(id)!);
    expect(info.bounds).toEqual(BOUNDS);
    // The snapshot owns its copy; mutating it must not touch the layer.
    info.bounds!.west = -999;
    expect(manager.getLayer(id)!.bounds).toEqual(BOUNDS);
  });
});

describe('LayerManager attribution', () => {
  const helperId = (id: string) => `mlr-attribution-${id}`;

  it('adds an attribution helper source/layer once the raster renders', async () => {
    const { manager, map } = makeHarness();
    const id = await manager.addRaster('https://example.com/a.tif', {
      attribution: '© GEBCO',
    });

    expect(map.addSource).toHaveBeenCalledWith(helperId(id), {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
      attribution: '© GEBCO',
    });
    expect(map.addLayer).toHaveBeenCalledWith({
      id: helperId(id),
      type: 'circle',
      source: helperId(id),
    });
    expect(toLayerInfo(manager.getLayer(id)!).attribution).toBe('© GEBCO');
  });

  it('adds no helper without an attribution (blanks trimmed to null)', async () => {
    const { manager, map } = makeHarness();
    const a = await manager.addRaster('https://example.com/a.tif');
    const b = await manager.addRaster('https://example.com/b.tif', {
      attribution: '   ',
    });

    for (const id of [a, b]) {
      expect(map.addSource).not.toHaveBeenCalledWith(
        helperId(id),
        expect.anything(),
      );
      expect(manager.getLayer(id)!.attribution).toBeNull();
    }
  });

  it('drops the helper while hidden and restores it when shown again', async () => {
    const { manager, map } = makeHarness();
    const id = await manager.addRaster('https://example.com/a.tif', {
      attribution: '© GEBCO',
    });
    const addsFor = () =>
      (map.addSource as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([sourceId]) => sourceId === helperId(id),
      ).length;
    expect(addsFor()).toBe(1);

    manager.setVisible(id, false);
    // Hidden: a later rebuild must not resurrect the helper.
    manager.setState(id, { opacity: 0.5 });
    expect(addsFor()).toBe(1);

    manager.setVisible(id, true);
    expect(addsFor()).toBe(2);
  });

  it('removes the helper when the layer is removed', async () => {
    const { manager, map } = makeHarness();
    const id = await manager.addRaster('https://example.com/a.tif', {
      attribution: '© GEBCO',
    });
    (map.getLayer as ReturnType<typeof vi.fn>).mockReturnValue({});
    (map.getSource as ReturnType<typeof vi.fn>).mockReturnValue({});

    manager.removeRaster(id);
    expect(map.removeLayer).toHaveBeenCalledWith(helperId(id));
    expect(map.removeSource).toHaveBeenCalledWith(helperId(id));
  });

  it('adds the helper under the cog-tiler-wasm engine too', async () => {
    const { manager, map } = makeHarness({ engine: 'cog-tiler-wasm' });
    const id = await manager.addRaster('https://example.com/a.tif', {
      attribution: '© GEBCO',
    });
    await Promise.resolve(); // let the fake module's openCog settle

    expect(map.addSource).toHaveBeenCalledWith(
      helperId(id),
      expect.objectContaining({ attribution: '© GEBCO' }),
    );
  });
});

describe('LayerManager CRS resolution', () => {
  /** Pulls the epsgResolver passed to the last COGLayer pushed to the overlay.
   * This is the per-layer wrapper LayerManager builds around the dep resolver. */
  function lastEpsgResolver(setProps: ReturnType<typeof vi.fn>) {
    const lastCall = setProps.mock.calls.at(-1)![0];
    return lastCall.layers[0].props.epsgResolver as (
      epsg: number,
    ) => Promise<unknown>;
  }

  it('surfaces a CRS-resolution failure as a layer error instead of failing silently', async () => {
    const epsgResolver = vi.fn(async () => {
      throw new Error('Could not resolve coordinate system EPSG:26916');
    });
    const { manager, setProps, events } = makeHarness({ epsgResolver });
    const id = await manager.addRaster('https://example.com/warped.tif');
    events.length = 0;

    // COGLayer would call this during its (un-awaited) parse step; invoking it
    // directly exercises the same wrapper without a real deck.gl render.
    await expect(lastEpsgResolver(setProps)(26916)).rejects.toThrow(
      /EPSG:26916/,
    );

    const layer = manager.getLayer(id)!;
    expect(layer.error).toBeInstanceOf(Error);
    expect(layer.loading).toBe(false);
    expect(
      events.filter((e) => e.type === 'error' && e.layerId === id),
    ).toHaveLength(1);
  });

  it('drops a CRS-failed layer from later rebuilds and emits the error once', async () => {
    const epsgResolver = vi.fn(async () => {
      throw new Error('boom');
    });
    const { manager, setProps, events } = makeHarness({ epsgResolver });
    const id = await manager.addRaster('https://example.com/warped.tif');

    const resolver = lastEpsgResolver(setProps);
    await expect(resolver(26916)).rejects.toThrow();
    // A second failure (e.g. a retried render) must not re-emit.
    await expect(resolver(26916)).rejects.toThrow();
    expect(
      events.filter((e) => e.type === 'error' && e.layerId === id),
    ).toHaveLength(1);

    // A subsequent rebuild excludes the failed layer.
    manager.setState(id, { opacity: 0.5 });
    const lastLayers = setProps.mock.calls.at(-1)![0].layers as unknown[];
    expect(lastLayers).toHaveLength(0);
  });
});

describe('LayerManager engine selection', () => {
  it('defaults to the maplibre-gl-raster (deck.gl) engine', () => {
    const { manager } = makeHarness();
    expect(manager.engine).toBe('maplibre-gl-raster');
  });

  it('reports the colormaps the active engine can render', () => {
    const { manager } = makeHarness();
    // deck.gl draws the whole sprite, so nothing is restricted.
    expect(manager.supportedColormaps).toBeNull();

    // cog-tiler-wasm knows only a fixed set and renders an unknown name with
    // its gray ramp instead of the requested one, so the panel must narrow the
    // picker to these. Before the wasm module loads, the conservative baseline
    // applies.
    manager.setEngine('cog-tiler-wasm');
    const allowed = manager.supportedColormaps;
    expect(allowed).not.toBeNull();
    expect(allowed!.has('viridis')).toBe(true);
    expect(allowed!.has('turbo')).toBe(true);
    expect(allowed!.has('gray')).toBe(true);
    expect(allowed!.has('jet')).toBe(false);
    expect(allowed!.size).toBeLessThan(20);

    // TiTiler resolves colormap names server-side; nothing is restricted.
    manager.setEngine('titiler');
    expect(manager.supportedColormaps).toBeNull();
  });

  it('widens the colormap set to whatever the loaded wasm module reports', async () => {
    // The set is read from the module, not hard-coded, so a cog-tiler-wasm
    // release that adds ramps widens the picker with no change here — and the
    // two packages never have to be upgraded in lockstep.
    const { manager, events } = makeHarness({
      engine: 'cog-tiler-wasm',
      cogColormaps: ['viridis', 'jet', 'rdbu', 'gray'],
    });
    // Baseline until the module resolves.
    expect(manager.supportedColormaps!.has('jet')).toBe(false);

    await manager.addRaster('https://example.com/a.tif');
    await vi.waitFor(() =>
      expect(manager.supportedColormaps!.has('jet')).toBe(true),
    );

    const allowed = manager.supportedColormaps!;
    expect(allowed.has('viridis')).toBe(true);
    expect(allowed.has('rdbu')).toBe(true);
    // Loading the module must re-emit, or the panel would keep showing the
    // baseline picker until some unrelated change forced a re-render.
    expect(events.some((e) => e.type === 'rasterchange')).toBe(true);
  });

  it('keeps the baseline when the module reports no colormaps', async () => {
    // An older module without colormaps(), or one returning an empty list, must
    // not collapse the picker to nothing.
    const { manager } = makeHarness({ engine: 'cog-tiler-wasm' });
    await manager.addRaster('https://example.com/a.tif');

    const allowed = manager.supportedColormaps!;
    expect(allowed.has('viridis')).toBe(true);
    expect(allowed.has('jet')).toBe(false);
    expect(allowed.size).toBeGreaterThan(0);
  });

  it('renders through the cog-tiler-wasm engine when configured, skipping the deck overlay', async () => {
    const { manager, deps, loadCogTiler, map } = makeHarness({
      engine: 'cog-tiler-wasm',
    });
    await manager.addRaster('https://example.com/a.tif');
    // No deck.gl overlay is created under the cog-tiler engine.
    expect(deps.createOverlay).not.toHaveBeenCalled();
    // The cog-tiler module is loaded lazily and a native raster layer added.
    await vi.waitFor(() => expect(loadCogTiler).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(map.addLayer as ReturnType<typeof vi.fn>).toHaveBeenCalled(),
    );
  });

  it('switches engines at runtime, blanking the deck overlay', async () => {
    const { manager, setProps, loadCogTiler } = makeHarness();
    await manager.addRaster('https://example.com/a.tif');
    expect(manager.engine).toBe('maplibre-gl-raster');
    setProps.mockClear();

    manager.setEngine('cog-tiler-wasm');
    expect(manager.engine).toBe('cog-tiler-wasm');
    // The deck overlay is emptied so it stops drawing.
    expect(setProps).toHaveBeenCalledWith({ layers: [] });
    await vi.waitFor(() => expect(loadCogTiler).toHaveBeenCalled());

    // Switching back rebuilds the deck overlay with the layer.
    manager.setEngine('maplibre-gl-raster');
    expect(manager.engine).toBe('maplibre-gl-raster');
    const lastCall = setProps.mock.calls.at(-1)![0];
    expect(lastCall.layers).toHaveLength(1);
  });

  it('ignores a no-op engine change', async () => {
    const { manager, setProps } = makeHarness();
    await manager.addRaster('https://example.com/a.tif');
    setProps.mockClear();
    manager.setEngine('maplibre-gl-raster');
    expect(setProps).not.toHaveBeenCalled();
  });
});

describe('LayerManager zoom range (deck.gl engine)', () => {
  /** Sets what the fake map reports for its current zoom. */
  function setZoom(map: MapLibreMap, zoom: number): void {
    (map as unknown as { getZoom: Mock }).getZoom.mockReturnValue(zoom);
  }
  /** Fires the map 'zoom' handlers the LayerManager registered. */
  function fireZoom(map: MapLibreMap): void {
    const onMock = (map as unknown as { on: Mock }).on;
    for (const [type, handler] of onMock.mock.calls) {
      if (type === 'zoom') (handler as () => void)();
    }
  }
  /** The layer array from the most recent overlay.setProps call. */
  function lastLayers(setProps: Mock): unknown[] {
    return setProps.mock.calls.at(-1)![0].layers;
  }

  it('drops a layer from the overlay while the zoom sits outside its range', async () => {
    const { manager, map, setProps } = makeHarness();
    setZoom(map, 3);
    const id = await manager.addRaster('https://example.com/a.tif');
    manager.setState(id, { minZoom: 2, maxZoom: 8 });
    // In range at zoom 3.
    expect(lastLayers(setProps)).toHaveLength(1);

    // Zoom past the max: the boundary crossing rebuilds with no layers.
    setZoom(map, 10);
    fireZoom(map);
    expect(lastLayers(setProps)).toHaveLength(0);

    // Zoom back into range: the layer returns.
    setZoom(map, 5);
    fireZoom(map);
    expect(lastLayers(setProps)).toHaveLength(1);

    // Zoom below the min: gone again.
    setZoom(map, 1);
    fireZoom(map);
    expect(lastLayers(setProps)).toHaveLength(0);
  });

  it('hides a layer immediately when a new max zoom excludes the current zoom', async () => {
    const { manager, map, setProps } = makeHarness();
    setZoom(map, 10);
    const id = await manager.addRaster('https://example.com/a.tif');
    // Default [0, 24] range: visible at zoom 10.
    expect(lastLayers(setProps)).toHaveLength(1);
    // Constrain below the current zoom: the rebuild filters it out at once.
    manager.setState(id, { maxZoom: 5 });
    expect(lastLayers(setProps)).toHaveLength(0);
  });

  it('treats minZoom as inclusive and maxZoom as exclusive (MapLibre semantics)', async () => {
    const { manager, map, setProps } = makeHarness();
    const id = await manager.addRaster('https://example.com/a.tif');
    manager.setState(id, { minZoom: 4, maxZoom: 8 });

    setZoom(map, 4); // exactly minZoom → visible
    fireZoom(map);
    expect(lastLayers(setProps)).toHaveLength(1);

    setZoom(map, 8); // exactly maxZoom → hidden
    fireZoom(map);
    expect(lastLayers(setProps)).toHaveLength(0);
  });

  it('does not rebuild on a zoom that leaves every layer in range', async () => {
    const { manager, map, setProps } = makeHarness();
    const id = await manager.addRaster('https://example.com/a.tif');
    manager.setState(id, { minZoom: 0, maxZoom: 20 });
    const before = setProps.mock.calls.length;

    // Both zooms stay within [0, 20): no boundary crossed, no rebuild.
    setZoom(map, 5);
    fireZoom(map);
    setZoom(map, 12);
    fireZoom(map);
    expect(setProps.mock.calls.length).toBe(before);
  });

  it('stops rebuilding on zoom after destroy', async () => {
    const { manager, map, setProps } = makeHarness();
    const id = await manager.addRaster('https://example.com/a.tif');
    manager.setState(id, { minZoom: 2, maxZoom: 8 });
    manager.destroy();
    const before = setProps.mock.calls.length;
    setZoom(map, 100);
    fireZoom(map);
    expect(setProps.mock.calls.length).toBe(before);
  });
});

describe('LayerManager stats integration', () => {
  it('stores computed auto-stats on the layer and emits rasterchange', async () => {
    const { manager, events } = makeHarness();
    const id = await manager.addRaster('https://example.com/a.tif');
    // computeAutoStats resolves on a microtask; flush it.
    await Promise.resolve();
    await Promise.resolve();
    const layer = manager.getLayer(id)!;
    expect(layer.autoStats?.perBand?.size).toBe(3);
    expect(
      events.filter((e) => e.type === 'rasterchange' && e.layerId === id)
        .length,
    ).toBeGreaterThanOrEqual(2);
  });
});
