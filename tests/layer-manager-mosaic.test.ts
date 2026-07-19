import { describe, expect, it, vi } from 'vitest';
import type { GeoTIFF } from '@developmentseed/geotiff';
import type { Map as MapLibreMap } from 'maplibre-gl';
import {
  LayerManager,
  type LayerManagerDeps,
  type OverlayLike,
} from '../src/lib/state/LayerManager';
import type { ParsedMosaic } from '../src/lib/raster/mosaic';
import type { AutoStats } from '../src/lib/raster/stats';

function makeFakeTiff(count = 3): GeoTIFF {
  return {
    count,
    isTiled: true,
    image: { value: () => undefined },
  } as unknown as GeoTIFF;
}

function makeStats(): AutoStats {
  const band = { min: 0, max: 255, histogram: new Array<number>(64).fill(1) };
  return { perBand: new Map([[1, band]]), global: band };
}

const MOSAICJSON: ParsedMosaic = {
  kind: 'mosaicjson',
  assets: [
    { url: 'https://x.com/a.tif', bbox: [-10, -5, 0, 5] },
    { url: 'https://x.com/b.tif', bbox: [0, -5, 10, 5] },
  ],
  bounds: { west: -10, south: -5, east: 10, north: 5 },
  minzoom: 12,
  maxzoom: 19,
};

const STAC: ParsedMosaic = {
  kind: 'stac',
  assets: [{ url: 'https://naip/1.tif', bbox: [-104.6, 40, -104.5, 40.1] }],
  bounds: { west: -104.6, south: 40, east: -104.5, north: 40.1 },
  minzoom: null,
  maxzoom: null,
};

function makeHarness(opts?: {
  engine?: 'maplibre-gl-raster' | 'titiler';
  mosaic?: ParsedMosaic;
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
    off: vi.fn(),
  } as unknown as MapLibreMap;

  const loadGeoTIFF = vi.fn(async () => makeFakeTiff(3));
  const loadMosaic = vi.fn(async () => opts?.mosaic ?? MOSAICJSON);
  const deps: Partial<LayerManagerDeps> = {
    loadGeoTIFF,
    loadMosaic,
    computeAutoStats: vi.fn(async () => makeStats()),
    createOverlay: vi.fn(() => overlay),
    removeOverlay: vi.fn(),
    fetchTileJson: vi.fn(async () => {
      throw new Error('titiler should not be used for deck.gl mosaics');
    }),
  };

  const manager = new LayerManager(
    map,
    { interleaved: true, engine: opts?.engine },
    deps,
  );
  return { manager, map, overlay, setProps, loadGeoTIFF, loadMosaic };
}

/** The layer array pushed to the overlay on its last setProps call. */
function lastLayers(setProps: ReturnType<typeof vi.fn>): Array<{ id: string; constructor: { name: string }; props: { sources?: unknown[] } }> {
  const calls = setProps.mock.calls;
  return (calls.at(-1)?.[0]?.layers ?? []) as never;
}

describe('LayerManager deck.gl mosaic', () => {
  it('renders a MosaicJSON as a deck.gl MosaicLayer, keeping the default engine', async () => {
    const { manager, map, setProps, loadGeoTIFF } = makeHarness();
    const id = await manager.addRaster('https://example.com/mosaic.json');

    // Stays on the GPU engine (no auto-switch to titiler anymore).
    expect(manager.engine).toBe('maplibre-gl-raster');
    const layer = manager.getLayer(id)!;
    expect(layer.isMosaicJson).toBe(true);
    expect(layer.mosaicKind).toBe('mosaicjson');
    expect(layer.mosaicAssets).toHaveLength(2);
    // No single GeoTIFF is attached; the first asset header was read for bands.
    expect(layer.geotiff).toBeNull();
    expect(loadGeoTIFF).toHaveBeenCalledWith('https://x.com/a.tif');
    expect(layer.bandCount).toBe(3);
    expect(layer.state.mode).toBe('rgb');

    // The overlay received exactly one MosaicLayer carrying both assets.
    const layers = lastLayers(setProps as ReturnType<typeof vi.fn>);
    expect(layers).toHaveLength(1);
    expect(layers[0].constructor.name).toBe('MosaicLayer');
    expect(layers[0].props.sources).toHaveLength(2);
    // Fitted to the mosaic bounds.
    expect(map.fitBounds).toHaveBeenCalled();
  });

  it('renders a STAC FeatureCollection on deck.gl, falling back from titiler', async () => {
    // A STAC mosaic has no TiTiler equivalent, so adding one while the titiler
    // engine is active falls back to the deck.gl engine.
    const { manager, setProps } = makeHarness({
      engine: 'titiler',
      mosaic: STAC,
    });
    const id = await manager.addRaster('https://example.com/stac.json');

    expect(manager.engine).toBe('maplibre-gl-raster');
    const layer = manager.getLayer(id)!;
    expect(layer.mosaicKind).toBe('stac');
    const layers = lastLayers(setProps as ReturnType<typeof vi.fn>);
    expect(layers).toHaveLength(1);
    expect(layers[0].constructor.name).toBe('MosaicLayer');
  });

  it('renders a local .json mosaic file on the deck.gl engine', async () => {
    const createObjectURL = vi.fn(() => 'blob:fake-mosaic');
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL,
      revokeObjectURL: vi.fn(),
    });
    try {
      const { manager, setProps, loadMosaic } = makeHarness({
        engine: 'titiler',
        mosaic: STAC,
      });
      const file = new File(['{}'], 'my_mosaic.json', {
        type: 'application/json',
      });
      const id = await manager.addRaster(file);

      // A local file's blob URL is parsed for the manifest, and (unreachable by
      // a server) it renders on the deck.gl engine.
      expect(loadMosaic).toHaveBeenCalledWith('blob:fake-mosaic', expect.anything());
      expect(manager.engine).toBe('maplibre-gl-raster');
      const layer = manager.getLayer(id)!;
      expect(layer.isMosaicJson).toBe(true);
      expect(layer.source.kind).toBe('file');
      const layers = lastLayers(setProps as ReturnType<typeof vi.fn>);
      expect(layers).toHaveLength(1);
      expect(layers[0].constructor.name).toBe('MosaicLayer');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('resolves a failed asset open to null instead of rejecting', async () => {
    // A rejected getSource would leave MosaicLayer rendering a null tile and
    // crash; the engine must resolve null so the asset is simply skipped.
    const { manager, setProps, loadGeoTIFF } = makeHarness();
    await manager.addRaster('https://example.com/mosaic.json');
    const layers = lastLayers(setProps as ReturnType<typeof vi.fn>);
    const getSource = (
      layers[0] as unknown as {
        props: { getSource: (s: { url: string }) => Promise<unknown> };
      }
    ).props.getSource;

    loadGeoTIFF.mockRejectedValueOnce(new Error('CORS blocked'));
    await expect(
      getSource({ url: 'https://x.com/broken.tif' }),
    ).resolves.toBeNull();
  });

  it('hides the mosaic from the overlay when the layer is not visible', async () => {
    const { manager, setProps } = makeHarness();
    const id = await manager.addRaster('https://example.com/mosaic.json');
    manager.setVisible(id, false);
    const layers = lastLayers(setProps as ReturnType<typeof vi.fn>);
    expect(layers).toHaveLength(0);
  });
});
