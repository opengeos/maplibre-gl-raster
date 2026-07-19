import { describe, expect, it } from 'vitest';
import {
  assetUrlToHttps,
  MOSAIC_FIT_ALL_MAX,
  mosaicInitialView,
  MosaicUnsupportedError,
  parseMosaic,
  type MosaicAsset,
} from '../src/lib/raster/mosaic';

describe('assetUrlToHttps', () => {
  it('rewrites s3:// to the virtual-hosted https form', () => {
    expect(assetUrlToHttps('s3://my-bucket/a/b/c.tif')).toBe(
      'https://my-bucket.s3.amazonaws.com/a/b/c.tif',
    );
  });
  it('leaves http(s) URLs untouched', () => {
    expect(assetUrlToHttps('https://x.com/a.tif')).toBe('https://x.com/a.tif');
  });
});

describe('parseMosaic — MosaicJSON', () => {
  it('inverts quadkeys into unique assets with a union bbox', () => {
    // Two quadkeys at z=1: "0" (NW quadrant) and "1" (NE quadrant), both
    // referencing the same asset — its bbox spans the union of both.
    const mosaic = parseMosaic({
      mosaicjson: '0.0.3',
      minzoom: 8,
      maxzoom: 14,
      tiles: {
        '0': ['s3://b/a.tif'],
        '1': ['s3://b/a.tif', 'https://x.com/c.tif'],
      },
    });
    expect(mosaic.kind).toBe('mosaicjson');
    expect(mosaic.minzoom).toBe(8);
    expect(mosaic.maxzoom).toBe(14);

    const byUrl = Object.fromEntries(mosaic.assets.map((a) => [a.url, a.bbox]));
    // s3:// asset rewritten to https.
    expect(byUrl['https://b.s3.amazonaws.com/a.tif']).toBeDefined();
    expect(byUrl['https://x.com/c.tif']).toBeDefined();
    // "a.tif" spans quadkeys 0 and 1 → its bbox covers the whole northern
    // hemisphere strip: west -180, east +180.
    const aBbox = byUrl['https://b.s3.amazonaws.com/a.tif'];
    expect(aBbox[0]).toBeCloseTo(-180, 5);
    expect(aBbox[2]).toBeCloseTo(180, 5);
    expect(aBbox[3]).toBeGreaterThan(aBbox[1]);
  });

  it('prefers the manifest bounds when present', () => {
    const mosaic = parseMosaic({
      tiles: { '0': ['https://x.com/a.tif'] },
      bounds: [-100, 30, -90, 40],
    });
    expect(mosaic.bounds).toEqual({
      west: -100,
      south: 30,
      east: -90,
      north: 40,
    });
  });

  it('resolves numeric asset indices against a shared assets array', () => {
    const mosaic = parseMosaic({
      tiles: { '0': [0], '1': [1] },
      assets: ['https://x.com/one.tif', 'https://x.com/two.tif'],
    });
    expect(mosaic.assets.map((a) => a.url).sort()).toEqual([
      'https://x.com/one.tif',
      'https://x.com/two.tif',
    ]);
  });

  it('throws on a document that is neither a MosaicJSON nor STAC', () => {
    expect(() => parseMosaic({ foo: 'bar' })).toThrow(MosaicUnsupportedError);
  });
});

describe('parseMosaic — STAC FeatureCollection', () => {
  it('reads one asset per feature with the feature bbox', () => {
    const mosaic = parseMosaic({
      type: 'FeatureCollection',
      features: [
        {
          bbox: [-104.6, 40.0, -104.5, 40.1],
          assets: { image: { href: 'https://naip/1.tif' } },
        },
        {
          bbox: [-104.5, 40.1, -104.4, 40.2],
          assets: { image: { href: 'https://naip/2.tif' } },
        },
      ],
    });
    expect(mosaic.kind).toBe('stac');
    expect(mosaic.assets).toHaveLength(2);
    expect(mosaic.assets[0]).toEqual({
      url: 'https://naip/1.tif',
      bbox: [-104.6, 40.0, -104.5, 40.1],
    });
    // Overall bounds are the union of the feature bboxes.
    expect(mosaic.bounds).toEqual({
      west: -104.6,
      south: 40.0,
      east: -104.4,
      north: 40.2,
    });
    // STAC carries no shared zoom range.
    expect(mosaic.minzoom).toBeNull();
  });

  it('prefers a visual asset, then falls back to a GeoTIFF-typed asset', () => {
    const mosaic = parseMosaic({
      type: 'FeatureCollection',
      features: [
        {
          bbox: [0, 0, 1, 1],
          assets: {
            thumbnail: { href: 'https://x/t.png', type: 'image/png' },
            visual: { href: 'https://x/v.tif' },
          },
        },
        {
          bbox: [1, 1, 2, 2],
          assets: {
            data: { href: 'https://x/d.tif', type: 'image/tiff; cloud-optimized' },
          },
        },
      ],
    });
    expect(mosaic.assets.map((a) => a.url)).toEqual([
      'https://x/v.tif',
      'https://x/d.tif',
    ]);
  });

  it('skips features missing a bbox or a usable asset, and dedupes assets', () => {
    const mosaic = parseMosaic({
      type: 'FeatureCollection',
      features: [
        { assets: { image: { href: 'https://x/no-bbox.tif' } } },
        { bbox: [0, 0, 1, 1], assets: {} },
        { bbox: [0, 0, 1, 1], assets: { image: { href: 'https://x/dup.tif' } } },
        { bbox: [1, 1, 2, 2], assets: { image: { href: 'https://x/dup.tif' } } },
      ],
    });
    expect(mosaic.assets).toHaveLength(1);
    expect(mosaic.assets[0].url).toBe('https://x/dup.tif');
  });

  it('throws when no feature has both a bbox and an asset', () => {
    expect(() =>
      parseMosaic({ type: 'FeatureCollection', features: [{ bbox: [0, 0, 1, 1] }] }),
    ).toThrow(MosaicUnsupportedError);
  });
});

describe('mosaicInitialView', () => {
  const bounds = { west: 0, south: 0, east: 100, north: 100 };

  it('returns the full extent for a small mosaic', () => {
    const assets: MosaicAsset[] = Array.from({ length: 10 }, (_, i) => ({
      url: `u${i}`,
      bbox: [i, i, i + 1, i + 1],
    }));
    expect(mosaicInitialView(bounds, assets)).toBe(bounds);
  });

  it('caps a large mosaic to a central window a few assets wide', () => {
    // A grid of 1x1 assets across a 100x100 extent (well over the cap).
    const assets: MosaicAsset[] = [];
    for (let x = 0; x < 20; x++) {
      for (let y = 0; y < 20; y++) {
        assets.push({ url: `${x}-${y}`, bbox: [x, y, x + 1, y + 1] });
      }
    }
    expect(assets.length).toBeGreaterThan(MOSAIC_FIT_ALL_MAX);
    const view = mosaicInitialView(bounds, assets);
    const width = view.east - view.west;
    const height = view.north - view.south;
    // Far smaller than the full 100-wide extent — only a handful of 1-wide
    // assets across.
    expect(width).toBeLessThanOrEqual(6);
    expect(height).toBeLessThanOrEqual(6);
    // Centred within the data, not off it.
    expect(view.west).toBeGreaterThanOrEqual(0);
    expect(view.east).toBeLessThanOrEqual(20);
  });
});
