import { describe, expect, it, vi } from 'vitest';
import proj4 from 'proj4';
import type {
  GeoTIFF,
  RasterArray,
  RasterTypedArray,
} from '@developmentseed/geotiff';
import { readPixelValues } from '../src/lib/raster/inspect';

/**
 * Build a fake band-separate RasterArray where band `b` (0-based) at local
 * pixel index `i` holds the value `b * 1000 + i`. Lets a test assert the exact
 * value read for a given (band, localRow, localCol).
 */
function makeBandSeparateTile(
  count: number,
  width: number,
  height: number,
  nodata: number | null = null,
): RasterArray {
  const bands: RasterTypedArray[] = [];
  for (let b = 0; b < count; b++) {
    const arr = new Float32Array(width * height);
    for (let i = 0; i < arr.length; i++) arr[i] = b * 1000 + i;
    bands.push(arr);
  }
  return {
    layout: 'band-separate',
    count,
    width,
    height,
    nodata,
    mask: null,
    bands,
  } as unknown as RasterArray;
}

/** Pixel-interleaved variant: pixel `i`, band `b` holds `b * 1000 + i`. */
function makeInterleavedTile(
  count: number,
  width: number,
  height: number,
  nodata: number | null = null,
): RasterArray {
  const data = new Float32Array(width * height * count);
  for (let i = 0; i < width * height; i++) {
    for (let b = 0; b < count; b++) {
      data[i * count + b] = b * 1000 + i;
    }
  }
  return {
    layout: 'pixel-interleaved',
    count,
    width,
    height,
    nodata,
    mask: null,
    data,
  } as unknown as RasterArray;
}

interface FakeTiffOptions {
  crs?: number;
  /** Affine [a, b, c, d, e, f] mapping (col, row) -> (x, y). */
  transform?: readonly [number, number, number, number, number, number];
  width?: number;
  height?: number;
  tileWidth?: number;
  tileHeight?: number;
  count?: number;
  tile?: RasterArray;
  fetchTile?: ReturnType<typeof vi.fn>;
}

/**
 * Construct a fake GeoTIFF exposing only the members readPixelValues reads.
 * Defaults: a north-up EPSG:4326 grid spanning lon [0, 10], lat [40, 50],
 * 10x10 px, 4x4 tiles, 3 bands.
 */
function makeFakeTiff(opts: FakeTiffOptions = {}) {
  const width = opts.width ?? 10;
  const height = opts.height ?? 10;
  const count = opts.count ?? 3;
  const tileWidth = opts.tileWidth ?? 4;
  const tileHeight = opts.tileHeight ?? 4;
  // North-up: x = col, y = 50 - row.
  const transform = opts.transform ?? ([1, 0, 0, 0, -1, 50] as const);
  const tile = opts.tile ?? makeBandSeparateTile(count, tileWidth, tileHeight);
  const fetchTile =
    opts.fetchTile ?? vi.fn(async () => ({ array: tile }));
  const tiff = {
    crs: opts.crs ?? 4326,
    transform,
    width,
    height,
    tileWidth,
    tileHeight,
    count,
    nodata: tile.nodata,
    fetchTile,
  } as unknown as GeoTIFF;
  return { tiff, fetchTile };
}

describe('readPixelValues', () => {
  it('reads all band values at a clicked location (EPSG:4326)', async () => {
    const { tiff, fetchTile } = makeFakeTiff();
    // lng=3.5, lat=47.5 -> x=3.5, y=47.5 -> col=3, row=2.
    const reading = await readPixelValues(tiff, [3.5, 47.5]);

    expect(reading).not.toBeNull();
    expect(reading!.col).toBe(3);
    expect(reading!.row).toBe(2);
    // Tile (0, 0) contains pixel (3, 2); local index = 2*4 + 3 = 11.
    expect(fetchTile).toHaveBeenCalledWith(0, 0, expect.anything());
    expect(reading!.bands).toEqual([
      { index: 1, name: null, value: 11, isNodata: false },
      { index: 2, name: null, value: 1011, isNodata: false },
      { index: 3, name: null, value: 2011, isNodata: false },
    ]);
  });

  it('selects the correct tile for a pixel outside the first tile', async () => {
    const { tiff, fetchTile } = makeFakeTiff();
    // lng=6.5, lat=43.5 -> col=6, row=6 -> tile (1, 1), local (2, 2) = idx 10.
    const reading = await readPixelValues(tiff, [6.5, 43.5]);

    expect(reading!.col).toBe(6);
    expect(reading!.row).toBe(6);
    expect(fetchTile).toHaveBeenCalledWith(1, 1, expect.anything());
    expect(reading!.bands[0].value).toBe(10);
  });

  it('attaches band names when provided', async () => {
    const { tiff } = makeFakeTiff();
    const names = new Map([
      [1, 'red'],
      [3, 'blue'],
    ]);
    const reading = await readPixelValues(tiff, [3.5, 47.5], {
      bandNames: names,
    });

    expect(reading!.bands.map((b) => b.name)).toEqual(['red', null, 'blue']);
  });

  it('flags nodata pixels', async () => {
    const tile = makeBandSeparateTile(3, 4, 4, 11); // band 0 idx 11 === 11
    const { tiff } = makeFakeTiff({ tile });
    const reading = await readPixelValues(tiff, [3.5, 47.5]);

    expect(reading!.bands[0]).toEqual({
      index: 1,
      name: null,
      value: 11,
      isNodata: true,
    });
    expect(reading!.bands[1].isNodata).toBe(false);
  });

  it('flags NaN nodata pixels', async () => {
    const tile = makeBandSeparateTile(1, 4, 4, Number.NaN);
    const bands = (tile as unknown as { bands: Float32Array[] }).bands;
    bands[0][11] = Number.NaN;
    const { tiff } = makeFakeTiff({ tile });
    const reading = await readPixelValues(tiff, [3.5, 47.5]);

    expect(reading!.bands[0]).toEqual({
      index: 1,
      name: null,
      value: Number.NaN,
      isNodata: true,
    });
  });

  it('reads pixel-interleaved tiles', async () => {
    const tile = makeInterleavedTile(3, 4, 4);
    const { tiff } = makeFakeTiff({ tile });
    const reading = await readPixelValues(tiff, [3.5, 47.5]);

    expect(reading!.bands).toEqual([
      { index: 1, name: null, value: 11, isNodata: false },
      { index: 2, name: null, value: 1011, isNodata: false },
      { index: 3, name: null, value: 2011, isNodata: false },
    ]);
  });

  it('returns null when the click is outside the pixel grid', async () => {
    const { tiff, fetchTile } = makeFakeTiff();
    // lng=20 is east of the 10-wide grid.
    const reading = await readPixelValues(tiff, [20, 47.5]);

    expect(reading).toBeNull();
    expect(fetchTile).not.toHaveBeenCalled();
  });

  it('reprojects WGS84 clicks for a projected CRS (EPSG:3857)', async () => {
    // North-up 3857 grid: x = 1000*col, y = 5000 - 1000*row, 10x10 px.
    const transform = [1000, 0, 0, 0, -1000, 5000] as const;
    const { tiff, fetchTile } = makeFakeTiff({
      crs: 3857,
      transform,
      tileWidth: 16,
      tileHeight: 16,
    });
    const lngLat: [number, number] = [0.02, 0.01];
    const [x, y] = proj4('EPSG:4326', 'EPSG:3857').forward(lngLat);
    const expectedCol = Math.floor(x / 1000);
    const expectedRow = Math.floor((5000 - y) / 1000);

    const reading = await readPixelValues(tiff, lngLat);

    expect(reading).not.toBeNull();
    expect(reading!.col).toBe(expectedCol);
    expect(reading!.row).toBe(expectedRow);
    expect(fetchTile).toHaveBeenCalledTimes(1);
  });
});
