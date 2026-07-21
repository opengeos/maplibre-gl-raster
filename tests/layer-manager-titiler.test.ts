import { describe, expect, it, vi } from 'vitest';
import type { GeoTIFF } from '@developmentseed/geotiff';
import type { Map as MapLibreMap } from 'maplibre-gl';
import {
  LayerManager,
  type LayerManagerDeps,
  type OverlayLike,
} from '../src/lib/state/LayerManager';
import type { TiTilerTileJson } from '../src/lib/raster/titiler';

function makeFakeTiff(count = 3): GeoTIFF {
  return {
    count,
    isTiled: true,
    image: { value: () => undefined },
  } as unknown as GeoTIFF;
}

function makeHarness(opts?: { engine?: 'maplibre-gl-raster' | 'titiler' }) {
  const setProps = vi.fn();
  const overlay: OverlayLike = { setProps };
  const sources = new Map<string, unknown>();
  const layers = new Map<string, unknown>();
  const map = {
    addControl: vi.fn(),
    removeControl: vi.fn(),
    fitBounds: vi.fn(),
    getLayer: vi.fn((id: string) => layers.get(id)),
    isStyleLoaded: () => true,
    getSource: vi.fn((id: string) => sources.get(id)),
    addSource: vi.fn((id: string, def: unknown) => sources.set(id, def)),
    addLayer: vi.fn((def: { id: string }) => layers.set(def.id, def)),
    removeLayer: vi.fn((id: string) => layers.delete(id)),
    removeSource: vi.fn((id: string) => sources.delete(id)),
    setPaintProperty: vi.fn(),
    moveLayer: vi.fn(),
    once: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    getZoom: vi.fn(() => 0),
    setLayerZoomRange: vi.fn(),
  } as unknown as MapLibreMap;

  // Return a valid tilejson; the request URL (asserted by tests) already
  // encodes which router (cog / mosaicjson) was used.
  const fetchTileJson = vi.fn(
    async (): Promise<TiTilerTileJson> => ({
      tiles: [
        'http://titiler.example.com/cog/tiles/WebMercatorQuad/{z}/{x}/{y}?url=a',
      ],
      bounds: [-10, -5, 10, 5],
      minzoom: 3,
      maxzoom: 12,
    }),
  );

  const loadGeoTIFF = vi.fn(async () => makeFakeTiff(3));
  const loadMosaic = vi.fn(async () => ({
    kind: 'mosaicjson' as const,
    assets: [
      {
        url: 'https://example.com/a.tif',
        bbox: [-10, -5, 10, 5] as [number, number, number, number],
      },
    ],
    bounds: { west: -10, south: -5, east: 10, north: 5 },
    minzoom: 12,
    maxzoom: 19,
  }));
  const deps: Partial<LayerManagerDeps> = {
    loadGeoTIFF,
    loadMosaic,
    computeAutoStats: vi.fn(async () => {
      throw new Error('unused');
    }),
    createOverlay: vi.fn(() => overlay),
    removeOverlay: vi.fn(),
    fetchTileJson,
  };

  const manager = new LayerManager(
    map,
    {
      interleaved: true,
      engine: opts?.engine,
      titilerEndpoint: 'https://titiler.example.com',
    },
    deps,
  );
  return { manager, map, overlay, setProps, fetchTileJson, loadGeoTIFF };
}

describe('LayerManager TiTiler engine', () => {
  it('renders a remote COG through TiTiler, adding a native raster layer', async () => {
    const { manager, map, fetchTileJson, loadGeoTIFF } = makeHarness({
      engine: 'titiler',
    });
    const id = await manager.addRaster('https://example.com/a.tif');

    // A COG still loads its header locally (for band count, stats, inspector).
    expect(loadGeoTIFF).toHaveBeenCalledWith('https://example.com/a.tif');

    await vi.waitFor(() => expect(map.addLayer).toHaveBeenCalled());
    expect(fetchTileJson.mock.calls[0][0]).toContain(
      '/cog/WebMercatorQuad/tilejson.json?',
    );
    const layer = manager.getLayer(id)!;
    expect(layer.bounds).toEqual({ west: -10, south: -5, east: 10, north: 5 });
    expect(map.fitBounds).toHaveBeenCalled();
    // The deck.gl overlay is never fed layers under the titiler engine.
    expect(manager.engine).toBe('titiler');
  });

  it('keeps a titiler-active mosaic on the TiTiler engine (server-side render)', async () => {
    const { manager, map, fetchTileJson } = makeHarness({ engine: 'titiler' });
    const id = await manager.addRaster('https://example.com/mosaic.json');
    expect(manager.engine).toBe('titiler');

    await vi.waitFor(() => expect(map.addLayer).toHaveBeenCalled());
    expect(fetchTileJson.mock.calls[0][0]).toContain(
      '/mosaicjson/WebMercatorQuad/tilejson.json?',
    );
    const layer = manager.getLayer(id)!;
    expect(layer.isMosaicJson).toBe(true);
    // No single local GeoTIFF is attached for a mosaic.
    expect(layer.geotiff).toBeNull();
    expect(layer.loading).toBe(false);
    // The manifest is still parsed into assets (so the user can switch to the
    // deck.gl engine without re-adding).
    expect(layer.mosaicAssets?.length).toBeGreaterThan(0);
  });

  it('refetches from a new TiTiler endpoint via setTitilerEndpoint', async () => {
    const { manager, map, fetchTileJson } = makeHarness({ engine: 'titiler' });
    await manager.addRaster('https://example.com/a.tif');
    await vi.waitFor(() => expect(map.addLayer).toHaveBeenCalled());
    expect(fetchTileJson.mock.calls[0][0]).toContain(
      'https://titiler.example.com/',
    );

    manager.setTitilerEndpoint('https://other-titiler.example.com');
    expect(manager.titilerEndpoint).toBe('https://other-titiler.example.com');
    await vi.waitFor(() => expect(fetchTileJson.mock.calls.length).toBeGreaterThan(1));
    expect(fetchTileJson.mock.calls.at(-1)![0]).toContain(
      'https://other-titiler.example.com/',
    );
  });

  it('restores the default endpoint when set to an empty value', async () => {
    const { manager } = makeHarness({ engine: 'titiler' });
    manager.setTitilerEndpoint('https://custom.example.com');
    expect(manager.titilerEndpoint).toBe('https://custom.example.com');
    manager.setTitilerEndpoint('   ');
    expect(manager.titilerEndpoint).toBe('https://titiler.d2s.org');
  });

  it('keeps rendering a MosaicJSON when it is the only layer and stays on titiler', async () => {
    const { manager, map } = makeHarness({ engine: 'titiler' });
    await manager.addRaster('https://example.com/mosaic.json');
    await vi.waitFor(() => expect(map.addSource).toHaveBeenCalled());
    const sourceDef = (map.addSource as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as { type: string; tiles: string[] };
    expect(sourceDef.type).toBe('raster');
    expect(sourceDef.tiles[0]).toContain('https://titiler.example.com/');
  });
});
