import type { GeoTIFF } from '@developmentseed/geotiff';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { describe, expect, it, vi } from 'vitest';
import {
  LayerManager,
  MAX_VRT_MEMBERS,
  type LayerManagerDeps,
  type LayerManagerEventData,
  type OverlayLike,
} from '../src/lib/state/LayerManager';
import { toLayerInfo } from '../src/lib/state/RasterLayer';
import type { AutoStats } from '../src/lib/raster/stats';
import { VrtUnsupportedError, type VrtMosaic } from '../src/lib/raster/vrt';

const VRT_URL = 'https://example.com/data/mosaic.vrt';
const TILE_A = 'https://example.com/data/tile_a.tif';
const TILE_B = 'https://example.com/data/tile_b.tif';

function makeFakeTiff(count = 3, isTiled = true): GeoTIFF {
  return {
    count,
    isTiled,
    image: { value: () => undefined },
  } as unknown as GeoTIFF;
}

function makeFakeStats(): AutoStats {
  const band = { min: 0, max: 255, histogram: new Array<number>(128).fill(1) };
  return { perBand: new Map([[1, band]]), global: band };
}

/** A parsed mosaic naming `urls`, as `deps.loadVrt` would return it. */
function makeMosaic(urls: string[], overrides?: Partial<VrtMosaic>): VrtMosaic {
  return {
    members: urls.map((url, i) => ({
      url,
      dst: { xOff: i * 1000, yOff: 0, xSize: 1000, ySize: 1000 },
    })),
    bandCount: 3,
    nodata: null,
    ...overrides,
  };
}

function makeHarness(opts?: {
  mosaic?: VrtMosaic;
  loadVrt?: LayerManagerDeps['loadVrt'];
  /** Per-URL overrides for the loaded member headers. */
  tiffs?: Record<string, GeoTIFF>;
  failLoad?: (url: string) => string | undefined;
  engine?: 'maplibre-gl-raster' | 'cog-tiler-wasm';
}) {
  const setProps = vi.fn();
  const overlay: OverlayLike = { setProps };
  const map = {
    addControl: vi.fn(),
    removeControl: vi.fn(),
    fitBounds: vi.fn(),
    getLayer: vi.fn(() => undefined),
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

  const deps: Partial<LayerManagerDeps> = {
    loadVrt:
      opts?.loadVrt ?? vi.fn(async () => opts?.mosaic ?? makeMosaic([TILE_A, TILE_B])),
    loadGeoTIFF: vi.fn(async (url: string) => {
      const failure = opts?.failLoad?.(url);
      if (failure) throw new Error(failure);
      return opts?.tiffs?.[url] ?? makeFakeTiff();
    }),
    computeAutoStats: vi.fn(async () => makeFakeStats()),
    createOverlay: vi.fn(() => overlay),
    removeOverlay: vi.fn(),
  };

  const manager = new LayerManager(
    map,
    { interleaved: true, engine: opts?.engine },
    deps,
  );
  const events: LayerManagerEventData[] = [];
  for (const type of ['rasteradd', 'rasterchange', 'error'] as const) {
    manager.on(type, (e) => events.push(e));
  }
  return { manager, map, setProps, deps, events };
}

/** The deck.gl layers from the most recent overlay update. */
function lastLayers(setProps: ReturnType<typeof vi.fn>) {
  return setProps.mock.calls.at(-1)![0].layers as {
    id: string;
    props: Record<string, unknown>;
  }[];
}

describe('LayerManager.addRaster with a VRT', () => {
  it('expands a mosaic into one render layer per member', async () => {
    const { manager, setProps, deps } = makeHarness();
    const id = await manager.addRaster(VRT_URL);

    expect(deps.loadVrt).toHaveBeenCalledWith(VRT_URL, expect.anything());
    expect(deps.loadGeoTIFF).toHaveBeenCalledWith(TILE_A);
    expect(deps.loadGeoTIFF).toHaveBeenCalledWith(TILE_B);
    // The .vrt itself is a manifest and is never opened as a GeoTIFF.
    expect(deps.loadGeoTIFF).not.toHaveBeenCalledWith(VRT_URL);

    const layer = manager.getLayer(id)!;
    expect(layer.members).toHaveLength(2);
    expect(layer.members!.map((m) => m.url)).toEqual([TILE_A, TILE_B]);
    expect(layer.loading).toBe(false);
    expect(layer.error).toBeNull();

    const layers = lastLayers(setProps);
    expect(layers).toHaveLength(2);
    // Each member draws its own GeoTIFF...
    expect(layers[0].props.geotiff).toBe(layer.members![0].geotiff);
    expect(layers[1].props.geotiff).toBe(layer.members![1].geotiff);
    // ...under a distinct render id, so deck.gl keeps them apart.
    expect(new Set(layers.map((l) => l.id)).size).toBe(2);
  });

  it('presents the mosaic as a single layer in the public surface', async () => {
    const { manager } = makeHarness();
    const id = await manager.addRaster(VRT_URL);

    expect(manager.getLayers()).toHaveLength(1);
    const info = toLayerInfo(manager.getLayer(id)!);
    expect(info.name).toBe('mosaic.vrt');
    expect(info.memberUrls).toEqual([TILE_A, TILE_B]);
    expect(info.source).toEqual({ kind: 'url', url: VRT_URL });
  });

  it('reports null memberUrls for a plain COG', async () => {
    const { manager } = makeHarness();
    const id = await manager.addRaster('https://example.com/data/cog.tif');
    expect(toLayerInfo(manager.getLayer(id)!).memberUrls).toBeNull();
    expect(manager.getLayer(id)!.members).toBeNull();
  });

  it('shares one visualization state and one stats window across members', async () => {
    // The whole point of expanding under a single layer: independent stats per
    // member would stretch each tile differently and render the mosaic as a
    // quilt.
    const { manager, setProps } = makeHarness();
    const id = await manager.addRaster(VRT_URL);
    manager.setState(id, { opacity: 0.5 });

    const layers = lastLayers(setProps);
    expect(layers.map((l) => l.props.opacity)).toEqual([0.5, 0.5]);
    expect(layers[0].props.renderTile).toBe(layers[1].props.renderTile);
    // Stats were sampled once, from the first member.
    const layer = manager.getLayer(id)!;
    expect(layer.geotiff).toBe(layer.members![0].geotiff);
  });

  it('takes the band count from the VRT, not the member headers', async () => {
    // A VRT may expose fewer bands than its sources carry.
    const { manager } = makeHarness({
      mosaic: makeMosaic([TILE_A], { bandCount: 1 }),
      tiffs: { [TILE_A]: makeFakeTiff(4) },
    });
    const id = await manager.addRaster(VRT_URL);

    const layer = manager.getLayer(id)!;
    expect(layer.bandCount).toBe(1);
    // 1 band → single-band auto-pick, as for a 1-band COG.
    expect(layer.state.mode).toBe('single');
    expect(layer.state.bands).toEqual([1]);
  });

  it("honours the VRT's declared nodata when the caller left it on auto", async () => {
    const { manager } = makeHarness({
      mosaic: makeMosaic([TILE_A], { nodata: -9999 }),
    });
    const id = await manager.addRaster(VRT_URL);
    expect(manager.getLayer(id)!.state.nodata).toBe(-9999);
  });

  it('does not override a nodata the caller chose explicitly', async () => {
    const { manager } = makeHarness({
      mosaic: makeMosaic([TILE_A], { nodata: -9999 }),
    });
    const id = await manager.addRaster(VRT_URL, { state: { nodata: 'off' } });
    expect(manager.getLayer(id)!.state.nodata).toBe('off');
  });
});

describe('LayerManager VRT bounds', () => {
  const boundsFor = (west: number, east: number) => ({
    west,
    south: 0,
    east,
    north: 10,
  });

  /** Fires onGeoTIFFLoad for the member at `index`. */
  function reportBounds(
    setProps: ReturnType<typeof vi.fn>,
    index: number,
    bounds: { west: number; south: number; east: number; north: number },
  ) {
    const onLoad = lastLayers(setProps)[index].props.onGeoTIFFLoad as (
      tiff: GeoTIFF,
      options: { geographicBounds: typeof bounds },
    ) => void;
    onLoad(makeFakeTiff(), { geographicBounds: bounds });
  }

  it('grows the layer bounds to the union of its members', async () => {
    const { manager, map, setProps } = makeHarness();
    const id = await manager.addRaster(VRT_URL);

    reportBounds(setProps, 0, boundsFor(-10, 0));
    expect(manager.getLayer(id)!.bounds).toEqual(boundsFor(-10, 0));
    // One member in: fitting now would zoom to a single tile of the mosaic.
    expect(map.fitBounds).not.toHaveBeenCalled();

    reportBounds(setProps, 1, boundsFor(0, 10));
    expect(manager.getLayer(id)!.bounds).toEqual(boundsFor(-10, 10));
    // Every member has reported, so the map fits the whole mosaic exactly once.
    expect(map.fitBounds).toHaveBeenCalledTimes(1);
    expect(map.fitBounds).toHaveBeenCalledWith(
      [
        [-10, 0],
        [10, 10],
      ],
      expect.anything(),
    );
  });

  it('ignores repeat reports from a member on later rebuilds', async () => {
    const { manager, map, setProps } = makeHarness();
    await manager.addRaster(VRT_URL);

    reportBounds(setProps, 0, boundsFor(-10, 0));
    reportBounds(setProps, 1, boundsFor(0, 10));
    reportBounds(setProps, 0, boundsFor(-10, 0));
    reportBounds(setProps, 1, boundsFor(0, 10));

    expect(map.fitBounds).toHaveBeenCalledTimes(1);
  });

  it('does not fit when the caller opted out of zoomTo', async () => {
    const { manager, map, setProps } = makeHarness();
    await manager.addRaster(VRT_URL, { zoomTo: false });

    reportBounds(setProps, 0, boundsFor(-10, 0));
    reportBounds(setProps, 1, boundsFor(0, 10));

    expect(map.fitBounds).not.toHaveBeenCalled();
  });
});

describe('LayerManager VRT failures', () => {
  /** Asserts addRaster rejects, and that the layer carries the same error. */
  async function expectFailure(
    manager: LayerManager,
    url: string,
    match: RegExp,
  ) {
    await expect(manager.addRaster(url, { id: 'vrt' })).rejects.toThrow(match);
    const layer = manager.getLayer('vrt')!;
    expect(layer.loading).toBe(false);
    expect(layer.error?.message).toMatch(match);
  }

  it('surfaces an unsupported VRT as a layer error', async () => {
    const { manager, events } = makeHarness({
      loadVrt: vi.fn(async () => {
        throw new VrtUnsupportedError('This is a warped VRT. Use gdalwarp.');
      }),
    });
    await expectFailure(manager, VRT_URL, /warped VRT/);
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('refuses a mosaic with more members than the browser can draw', async () => {
    const urls = Array.from(
      { length: MAX_VRT_MEMBERS + 1 },
      (_, i) => `https://example.com/data/t${i}.tif`,
    );
    const { manager, deps } = makeHarness({ mosaic: makeMosaic(urls) });

    await expectFailure(manager, VRT_URL, /mosaics 33 files/);
    // Bailed out before opening a single member.
    expect(deps.loadGeoTIFF).not.toHaveBeenCalled();
  });

  it('names the member that could not be loaded', async () => {
    const { manager } = makeHarness({
      failLoad: (url) => (url === TILE_B ? 'HTTP 404' : undefined),
    });
    await expectFailure(manager, VRT_URL, /"https:\/\/example\.com\/data\/tile_b\.tif"/);
    await expect(
      manager.addRaster(VRT_URL, { id: 'vrt2' }),
    ).rejects.toThrow(/HTTP 404/);
  });

  it('rejects a striped member and names it', async () => {
    const { manager } = makeHarness({
      tiffs: { [TILE_B]: makeFakeTiff(3, false) },
    });
    await expectFailure(manager, VRT_URL, /source "https:\/\/example\.com\/data\/tile_b\.tif" is striped/);
  });

  it('rejects a member that lacks a band the VRT exposes', async () => {
    const { manager } = makeHarness({
      mosaic: makeMosaic([TILE_A, TILE_B], { bandCount: 3 }),
      tiffs: { [TILE_B]: makeFakeTiff(1) },
    });
    await expectFailure(manager, VRT_URL, /declares 3 band\(s\), but its source/);
  });

  it('still rejects a striped plain COG with the original message', async () => {
    const { manager } = makeHarness({
      tiffs: { 'https://example.com/data/cog.tif': makeFakeTiff(3, false) },
    });
    await expectFailure(
      manager,
      'https://example.com/data/cog.tif',
      /This GeoTIFF is striped, not tiled/,
    );
  });
});

describe('LayerManager VRT on the cog-tiler-wasm engine', () => {
  it('hands the engine one source per member, sharing the layer state', async () => {
    const { manager } = makeHarness({ engine: 'cog-tiler-wasm' });
    const id = await manager.addRaster(VRT_URL);
    const layer = manager.getLayer(id)!;

    // This engine drives native MapLibre raster layers rather than the deck.gl
    // overlay, so assert on the projection it is handed.
    const engineLayers = (
      manager as unknown as {
        _cogRenderableLayers(): { id: string; source: string; state: unknown }[];
      }
    )._cogRenderableLayers();

    expect(engineLayers).toHaveLength(2);
    expect(engineLayers.map((l) => l.source)).toEqual([TILE_A, TILE_B]);
    // Distinct ids, both resolving back to the one owning layer.
    expect(new Set(engineLayers.map((l) => l.id)).size).toBe(2);
    for (const engineLayer of engineLayers) {
      expect(engineLayer.state).toBe(layer.state);
      expect(engineLayer.id.startsWith(id)).toBe(true);
    }
  });

  it('routes member bounds back to a layer whose own id contains the separator', async () => {
    // A caller-supplied id is free to look like a member id. Only the last
    // separator marks the suffix the manager itself appended.
    const { manager, map } = makeHarness({ engine: 'cog-tiler-wasm' });
    const id = 'weird::m7';
    await manager.addRaster(VRT_URL, { id });

    const engineLayers = (
      manager as unknown as { _cogRenderableLayers(): { id: string }[] }
    )._cogRenderableLayers();
    expect(engineLayers.map((l) => l.id)).toEqual([
      'weird::m7::m0',
      'weird::m7::m1',
    ]);

    const onBounds = (
      manager as unknown as {
        _onCogBounds(
          id: string,
          b: { west: number; south: number; east: number; north: number },
          zoomTo: boolean,
        ): void;
      }
    )._onCogBounds.bind(manager);
    onBounds('weird::m7::m0', { west: -10, south: 0, east: 0, north: 10 }, true);
    onBounds('weird::m7::m1', { west: 0, south: 0, east: 10, north: 10 }, true);

    // Both members resolved to this layer and folded into its union.
    expect(manager.getLayer(id)!.bounds).toEqual({
      west: -10,
      south: 0,
      east: 10,
      north: 10,
    });
    expect(map.fitBounds).toHaveBeenCalledTimes(1);
  });
});
