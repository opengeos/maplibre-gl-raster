import { describe, expect, it, vi } from 'vitest';
import type { GeoTIFF } from '@developmentseed/geotiff';
import type { Map as MapLibreMap } from 'maplibre-gl';
import {
  LayerManager,
  type LayerManagerDeps,
  type LayerManagerEventData,
  type OverlayLike,
} from '../src/lib/state/LayerManager';
import type { AutoStats } from '../src/lib/raster/stats';

function makeFakeTiff(count = 3): GeoTIFF {
  return {
    count,
    image: { value: () => undefined },
  } as unknown as GeoTIFF;
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
}) {
  const setProps = vi.fn();
  const overlay: OverlayLike = { setProps };
  const map = {
    addControl: vi.fn(),
    removeControl: vi.fn(),
    fitBounds: vi.fn(),
    getLayer: vi.fn((id: string) => (id === 'existing-layer' ? {} : undefined)),
  } as unknown as MapLibreMap;

  const deps: Partial<LayerManagerDeps> = {
    loadGeoTIFF: vi.fn(async (url: string) => {
      if (opts?.failLoad) throw new Error(`load failed: ${url}`);
      return makeFakeTiff(opts?.bandCount ?? 3);
    }),
    computeAutoStats: vi.fn(async () => makeFakeStats()),
    createOverlay: vi.fn(() => overlay),
    removeOverlay: vi.fn(),
  };

  const manager = new LayerManager(map, { interleaved: true }, deps);
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
  return { manager, map, overlay, setProps, deps, events };
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
