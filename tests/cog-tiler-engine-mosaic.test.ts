import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CogTilerEngine,
  type CogEngineLayer,
  type CogTilerModule,
} from '../src/lib/state/CogTilerEngine';
import { createLayerState } from '../src/lib/state/RasterLayer';
import type { MosaicAsset } from '../src/lib/raster/mosaic';

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
    setLayerZoomRange: vi.fn(),
    moveLayer: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
  };
  return { map: map as unknown as MapLibreMap, sources, layers, raw: map };
}

/** One 256x256 RGBA tile. `alpha` fills every pixel's alpha; `rgb` its colour. */
function tileRGBA(rgb: number, alpha: number): Uint8Array {
  const buf = new Uint8Array(256 * 256 * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = rgb;
    buf[i + 1] = rgb;
    buf[i + 2] = rgb;
    buf[i + 3] = alpha;
  }
  return buf;
}

/** Half-covered tile: the first half opaque, the rest transparent — the shape
 * cog-tiler-wasm returns for a tile straddling a COG's edge. */
function halfTileRGBA(rgb: number): Uint8Array {
  const buf = tileRGBA(rgb, 255);
  for (let i = Math.floor(buf.length / 2 / 4) * 4; i < buf.length; i += 4) {
    buf[i + 3] = 0;
  }
  return buf;
}

/**
 * A fake module whose `openCog` yields a distinct source per URL, each rendering
 * whatever `tiles[url]` says (a buffer, or null for a blank tile).
 */
function makeMosaicModule(tiles: Record<string, Uint8Array | null>) {
  const rendered: string[] = [];
  const opened: string[] = [];
  const rgbaToPng = vi.fn(async (rgba: Uint8Array | Uint8ClampedArray) => {
    // Encode just enough to assert on: the first pixel's RGB.
    return new Uint8Array([rgba[0], rgba[1], rgba[2], rgba[3]]);
  });
  const openCog = vi.fn(async (url: string | File) => {
    const key = String(url);
    opened.push(key);
    if (!(key in tiles)) throw new Error(`cannot open ${key}`);
    return {
      mode: '3857' as const,
      crsLabel: 'EPSG:3857',
      levels: [],
      boundsLonLat: [-180, -85, 180, 85],
      hasPalette: false,
      renderTileRGBA: vi.fn(async () => {
        rendered.push(key);
        return tiles[key];
      }),
      renderTilePNG: vi.fn(async () => new Uint8Array([137, 80, 78, 71])),
    };
  });
  const module = {
    init: vi.fn(async () => undefined),
    openCog,
    rgbaToPng,
    colormaps: () => [],
  } as unknown as CogTilerModule;
  return { module, openCog, rgbaToPng, rendered, opened };
}

function asset(url: string, bbox: MosaicAsset['bbox']): MosaicAsset {
  return { url, bbox };
}

function mosaicLayer(overrides?: Partial<CogEngineLayer>): CogEngineLayer {
  return {
    id: 'm',
    source: 'https://example.com/mosaic.json',
    assets: [asset('a.tif', [-180, -85, 0, 85]), asset('b.tif', [0, -85, 180, 85])],
    minzoom: null,
    state: createLayerState({ mode: 'rgb', bands: [1, 2, 3] }),
    autoStats: null,
    beforeId: null,
    zoomTo: false,
    ...overrides,
  };
}

/** Drives one tile through the registered protocol handler. */
async function renderTile(
  addProtocol: ReturnType<typeof vi.spyOn>,
  layerId: string,
  z: number,
  x: number,
  y: number,
): Promise<Uint8Array> {
  const [scheme, handler] = addProtocol.mock.calls.at(-1)!;
  const result = await (
    handler as (p: { url: string }, c: AbortController) => Promise<{ data: Uint8Array }>
  )({ url: `${scheme}://${layerId}/${z}/${x}/${y}` }, new AbortController());
  return result.data;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CogTilerEngine mosaic layers', () => {
  it('renders a mosaic without opening a COG up front', async () => {
    // A manifest can list thousands of assets; the engine must not open one
    // eagerly the way it does for a plain layer.
    const { map, sources } = makeFakeMap();
    const fake = makeMosaicModule({ 'a.tif': tileRGBA(10, 255) });
    const engine = new CogTilerEngine(map, {
      loadModule: async () => fake.module,
      onBounds: vi.fn(),
      onError: vi.fn(),
    });

    engine.sync([mosaicLayer()]);
    await vi.waitFor(() => expect(sources.size).toBe(1));

    expect(fake.openCog).not.toHaveBeenCalled();
  });

  it('composites only the assets whose bbox covers the tile', async () => {
    const addProtocol = vi.spyOn(maplibregl, 'addProtocol');
    const { map, sources } = makeFakeMap();
    const fake = makeMosaicModule({
      'a.tif': tileRGBA(10, 255),
      'b.tif': tileRGBA(20, 255),
    });
    const engine = new CogTilerEngine(map, {
      loadModule: async () => fake.module,
      onBounds: vi.fn(),
      onError: vi.fn(),
    });

    engine.sync([mosaicLayer()]);
    await vi.waitFor(() => expect(sources.size).toBe(1));

    // z1/x0/y0 is the north-west quadrant: only the western asset covers it.
    const data = await renderTile(addProtocol, 'm', 1, 0, 0);

    expect(fake.rendered).toEqual(['a.tif']);
    expect(data[0]).toBe(10);
  });

  it('stops once the tile is opaque instead of decoding every asset', async () => {
    // Assets tile the plane, so the first covering asset usually fills the tile.
    // Decoding the rest would be wasted CPU on every pan.
    const addProtocol = vi.spyOn(maplibregl, 'addProtocol');
    const { map, sources } = makeFakeMap();
    const fake = makeMosaicModule({
      'a.tif': tileRGBA(10, 255),
      'b.tif': tileRGBA(20, 255),
    });
    const engine = new CogTilerEngine(map, {
      loadModule: async () => fake.module,
      onBounds: vi.fn(),
      onError: vi.fn(),
    });

    // Both assets span the whole world, so both cover the tile.
    engine.sync([
      mosaicLayer({
        assets: [
          asset('a.tif', [-180, -85, 180, 85]),
          asset('b.tif', [-180, -85, 180, 85]),
        ],
      }),
    ]);
    await vi.waitFor(() => expect(sources.size).toBe(1));

    const data = await renderTile(addProtocol, 'm', 0, 0, 0);

    expect(fake.rendered).toEqual(['a.tif']);
    expect(data[0]).toBe(10);
  });

  it('fills a partly covered tile from the next asset underneath', async () => {
    const addProtocol = vi.spyOn(maplibregl, 'addProtocol');
    const { map, sources } = makeFakeMap();
    const fake = makeMosaicModule({
      'a.tif': halfTileRGBA(10), // covers half the tile, transparent elsewhere
      'b.tif': tileRGBA(20, 255),
    });
    const engine = new CogTilerEngine(map, {
      loadModule: async () => fake.module,
      onBounds: vi.fn(),
      onError: vi.fn(),
    });

    engine.sync([
      mosaicLayer({
        assets: [
          asset('a.tif', [-180, -85, 180, 85]),
          asset('b.tif', [-180, -85, 180, 85]),
        ],
      }),
    ]);
    await vi.waitFor(() => expect(sources.size).toBe(1));

    await renderTile(addProtocol, 'm', 0, 0, 0);

    // The second asset is needed to finish the tile, so both are decoded.
    expect(fake.rendered).toEqual(['a.tif', 'b.tif']);
    // First-covering-asset wins where they overlap, matching the inspector.
    expect(fake.rgbaToPng.mock.calls[0][0][0]).toBe(10);
  });

  it('skips an asset that cannot be opened rather than blanking the tile', async () => {
    const addProtocol = vi.spyOn(maplibregl, 'addProtocol');
    const { map, sources } = makeFakeMap();
    // 'broken.tif' is absent from the map, so openCog rejects for it.
    const fake = makeMosaicModule({ 'good.tif': tileRGBA(30, 255) });
    const engine = new CogTilerEngine(map, {
      loadModule: async () => fake.module,
      onBounds: vi.fn(),
      onError: vi.fn(),
    });

    engine.sync([
      mosaicLayer({
        assets: [
          asset('broken.tif', [-180, -85, 180, 85]),
          asset('good.tif', [-180, -85, 180, 85]),
        ],
      }),
    ]);
    await vi.waitFor(() => expect(sources.size).toBe(1));

    const data = await renderTile(addProtocol, 'm', 0, 0, 0);

    expect(fake.rendered).toEqual(['good.tif']);
    expect(data[0]).toBe(30);
  });

  it('returns a blank tile when no asset covers it', async () => {
    const addProtocol = vi.spyOn(maplibregl, 'addProtocol');
    const { map, sources } = makeFakeMap();
    const fake = makeMosaicModule({ 'a.tif': tileRGBA(10, 255) });
    const engine = new CogTilerEngine(map, {
      loadModule: async () => fake.module,
      onBounds: vi.fn(),
      onError: vi.fn(),
    });

    // A single asset confined to the eastern hemisphere.
    engine.sync([mosaicLayer({ assets: [asset('a.tif', [10, 0, 20, 10])] })]);
    await vi.waitFor(() => expect(sources.size).toBe(1));

    // North-west quadrant: nowhere near the asset.
    const data = await renderTile(addProtocol, 'm', 1, 0, 0);

    expect(fake.openCog).not.toHaveBeenCalled();
    expect(data.length).toBe(0);
  });

  it('reuses one opened source across tiles', async () => {
    const addProtocol = vi.spyOn(maplibregl, 'addProtocol');
    const { map, sources } = makeFakeMap();
    const fake = makeMosaicModule({ 'a.tif': tileRGBA(10, 255) });
    const engine = new CogTilerEngine(map, {
      loadModule: async () => fake.module,
      onBounds: vi.fn(),
      onError: vi.fn(),
    });

    engine.sync([mosaicLayer({ assets: [asset('a.tif', [-180, -85, 180, 85])] })]);
    await vi.waitFor(() => expect(sources.size).toBe(1));

    await renderTile(addProtocol, 'm', 2, 0, 0);
    await renderTile(addProtocol, 'm', 2, 1, 1);
    await renderTile(addProtocol, 'm', 2, 2, 2);

    // Three tiles, three renders, but the COG header is opened once.
    expect(fake.rendered).toHaveLength(3);
    expect(fake.opened).toEqual(['a.tif']);
  });

  it('applies a mosaic minzoom to the raster source', async () => {
    // A large mosaic hides below this zoom so a world view never composites
    // every asset at once.
    const { map, sources } = makeFakeMap();
    const fake = makeMosaicModule({ 'a.tif': tileRGBA(10, 255) });
    const engine = new CogTilerEngine(map, {
      loadModule: async () => fake.module,
      onBounds: vi.fn(),
      onError: vi.fn(),
    });

    engine.sync([mosaicLayer({ minzoom: 9.4 })]);
    await vi.waitFor(() => expect(sources.size).toBe(1));

    const def = [...sources.values()][0] as { minzoom?: number };
    expect(def.minzoom).toBe(9);
  });

  it('omits minzoom when the mosaic has none', async () => {
    const { map, sources } = makeFakeMap();
    const fake = makeMosaicModule({ 'a.tif': tileRGBA(10, 255) });
    const engine = new CogTilerEngine(map, {
      loadModule: async () => fake.module,
      onBounds: vi.fn(),
      onError: vi.fn(),
    });

    engine.sync([mosaicLayer({ minzoom: null })]);
    await vi.waitFor(() => expect(sources.size).toBe(1));

    const def = [...sources.values()][0] as { minzoom?: number };
    expect(def.minzoom).toBeUndefined();
  });
});
