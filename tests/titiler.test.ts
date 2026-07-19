import { describe, expect, it } from 'vitest';
import { createLayerState } from '../src/lib/state/RasterLayer';
import type { AutoStats } from '../src/lib/raster/stats';
import {
  buildTileJsonUrl,
  buildTiTilerParams,
  isMosaicJsonUrl,
  rebaseTileUrl,
  tileSizeOf,
} from '../src/lib/raster/titiler';

/** Collapses ordered params into a lookup that keeps repeated keys as arrays. */
function group(params: [string, string][]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of params) (out[k] ??= []).push(v);
  return out;
}

describe('isMosaicJsonUrl', () => {
  it('matches .json manifests and ignores the query string', () => {
    expect(isMosaicJsonUrl('https://x.com/a.mosaic.json')).toBe(true);
    expect(isMosaicJsonUrl('https://x.com/mosaic.json?token=abc')).toBe(true);
    expect(isMosaicJsonUrl('mosaic.json')).toBe(true);
  });

  it('rejects COGs and other extensions', () => {
    expect(isMosaicJsonUrl('https://x.com/a.tif')).toBe(false);
    expect(isMosaicJsonUrl('https://x.com/a.tiff?x=1')).toBe(false);
    expect(isMosaicJsonUrl('https://x.com/data.vrt')).toBe(false);
  });
});

describe('buildTiTilerParams', () => {
  it('maps RGB mode to one bidx per channel with per-band rescale', () => {
    const params = buildTiTilerParams(
      createLayerState({
        mode: 'rgb',
        bands: [4, 3, 2],
        rescale: [
          [0, 255],
          [10, 200],
          [5, 100],
        ],
      }),
      null,
    );
    const g = group(params);
    expect(g.bidx).toEqual(['4', '3', '2']);
    expect(g.rescale).toEqual(['0,255', '10,200', '5,100']);
    expect(g.colormap_name).toBeUndefined();
  });

  it('maps single mode to bidx + colormap_name, appending _r when reversed', () => {
    const params = buildTiTilerParams(
      createLayerState({
        mode: 'single',
        bands: [2],
        colormap: 'magma',
        reversed: true,
        rescale: [[0, 3000]],
        nodata: -9999,
      }),
      null,
    );
    const g = group(params);
    expect(g.bidx).toEqual(['2']);
    expect(g.colormap_name).toEqual(['magma_r']);
    expect(g.rescale).toEqual(['0,3000']);
    expect(g.nodata).toEqual(['-9999']);
  });

  it('omits colormap_name for an embedded palette', () => {
    const params = buildTiTilerParams(
      createLayerState({ mode: 'single', bands: [1], colormap: 'palette' }),
      null,
    );
    expect(group(params).colormap_name).toBeUndefined();
  });

  it('maps index mode to a band-math expression with a [-1, 1] rescale', () => {
    const params = buildTiTilerParams(
      createLayerState({
        mode: 'index',
        bands: [4, 3],
        colormap: 'rdylgn',
      }),
      null,
    );
    const g = group(params);
    expect(g.expression).toEqual(['(b4-b3)/(b4+b3)']);
    expect(g.colormap_name).toEqual(['rdylgn']);
    expect(g.rescale).toEqual(['-1,1']);
    // Index mode uses an expression, not bidx.
    expect(g.bidx).toBeUndefined();
  });

  it('derives the rescale window from auto-stats when none is set', () => {
    const stats: AutoStats = {
      perBand: new Map([
        [1, { min: 0, max: 100, histogram: new Array<number>(100).fill(1) }],
      ]),
      global: { min: 0, max: 100, histogram: new Array<number>(100).fill(1) },
    };
    const params = buildTiTilerParams(
      createLayerState({ mode: 'single', bands: [1], rescale: null }),
      stats,
    );
    const rescale = group(params).rescale?.[0];
    expect(rescale).toBeDefined();
    const [min, max] = rescale!.split(',').map(Number);
    expect(min).toBeLessThan(max);
  });

  it('omits nodata unless a numeric override is set', () => {
    expect(
      group(
        buildTiTilerParams(
          createLayerState({ mode: 'single', bands: [1], nodata: 'auto' }),
          null,
        ),
      ).nodata,
    ).toBeUndefined();
    expect(
      group(
        buildTiTilerParams(
          createLayerState({ mode: 'single', bands: [1], nodata: 'off' }),
          null,
        ),
      ).nodata,
    ).toBeUndefined();
  });
});

describe('buildTileJsonUrl', () => {
  it('assembles the cog tilejson URL with url first and repeated params', () => {
    const url = buildTileJsonUrl(
      'https://titiler.opengeos.org',
      'cog',
      'https://x.com/a.tif',
      [
        ['bidx', '1'],
        ['bidx', '2'],
        ['colormap_name', 'viridis'],
      ],
    );
    expect(url).toContain('/cog/WebMercatorQuad/tilejson.json?');
    expect(url).toContain('url=https%3A%2F%2Fx.com%2Fa.tif');
    expect(url).toContain('bidx=1&bidx=2');
    expect(url).toContain('colormap_name=viridis');
  });

  it('uses the mosaicjson router for a mosaic and trims a trailing slash', () => {
    const url = buildTileJsonUrl(
      'https://titiler.opengeos.org/',
      'mosaicjson',
      'https://x.com/m.json',
      [],
    );
    expect(url.startsWith('https://titiler.opengeos.org/mosaicjson/')).toBe(
      true,
    );
    expect(url).toContain('/mosaicjson/WebMercatorQuad/tilejson.json?');
  });
});

describe('rebaseTileUrl', () => {
  it('rewrites the tile template origin to the configured endpoint', () => {
    const rebased = rebaseTileUrl(
      'http://titiler.opengeos.org/cog/tiles/WebMercatorQuad/{z}/{x}/{y}?url=x&bidx=1',
      'https://my-titiler.example.com',
    );
    expect(rebased).toBe(
      'https://my-titiler.example.com/cog/tiles/WebMercatorQuad/{z}/{x}/{y}?url=x&bidx=1',
    );
  });

  it('joins a path-only template onto the endpoint', () => {
    expect(
      rebaseTileUrl('/cog/tiles/{z}/{x}/{y}', 'https://t.example.com/'),
    ).toBe('https://t.example.com/cog/tiles/{z}/{x}/{y}');
  });
});

describe('tileSizeOf', () => {
  it('reads the tilesize param, defaulting to null when absent', () => {
    expect(tileSizeOf('https://t/x/{z}/{x}/{y}?url=a&tilesize=512')).toBe(512);
    expect(tileSizeOf('https://t/x/{z}/{x}/{y}?url=a')).toBeNull();
  });
});
