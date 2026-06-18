import { describe, expect, it, vi } from 'vitest';
import type { GetTileDataOptions } from '@developmentseed/deck.gl-geotiff';
import type { Device, Texture } from '@luma.gl/core';
import { makeMultiBandTileLoader } from '../src/lib/raster/tile-loader';

const WIDTH = 2;
const HEIGHT = 1;
const PIXELS = WIDTH * HEIGHT;

/** Distinct, recognisable sample value for (1-based band, pixel index). */
const sampleValue = (band: number, pixel: number) => band * 100 + pixel;

/** Build a fake decoded tile of `count` bands. With `layout: 'band-separate'`
 * each band is its own Float32 array; otherwise the data is pixel-interleaved
 * (band-contiguous within a pixel), the layout `extractBand` handles. */
function fakeArray(count: number, layout: 'band-separate' | 'pixel') {
  if (layout === 'band-separate') {
    const bands = Array.from({ length: count }, (_, b) =>
      Float32Array.from({ length: PIXELS }, (_, p) => sampleValue(b + 1, p)),
    );
    return { layout: 'band-separate', bands, count, width: WIDTH, height: HEIGHT, nodata: null };
  }
  const data = new Float32Array(PIXELS * count);
  for (let p = 0; p < PIXELS; p++) {
    for (let b = 0; b < count; b++) {
      data[p * count + b] = sampleValue(b + 1, p);
    }
  }
  return { layout: 'pixel', data, count, width: WIDTH, height: HEIGHT, nodata: null };
}

/** A device whose createTexture records the Float32 data it was handed, so a
 * test can assert which band's values landed in which texture. */
function recordingDevice() {
  const created: { data: Float32Array }[] = [];
  const device = {
    createTexture: vi.fn((opts: { data: Float32Array }) => {
      const tex = { data: opts.data, destroy: vi.fn() } as unknown as Texture;
      created.push({ data: opts.data });
      return tex;
    }),
  } as unknown as Device;
  return { device, created };
}

function fakeImage(count: number, layout: 'band-separate' | 'pixel') {
  return {
    fetchTile: vi.fn(async () => ({ array: fakeArray(count, layout) })),
  };
}

async function load(bands: number[], count: number, layout: 'band-separate' | 'pixel') {
  const loader = makeMultiBandTileLoader(bands);
  const { device, created } = recordingDevice();
  const image = fakeImage(count, layout);
  const result = await loader(
    image as never,
    { device, x: 0, y: 0, signal: undefined } as unknown as GetTileDataOptions,
  );
  return { result, created, image };
}

describe('makeMultiBandTileLoader', () => {
  for (const layout of ['band-separate', 'pixel'] as const) {
    it(`fetches an arbitrary high band (band 12 of 12) — ${layout}`, async () => {
      const { result } = await load([12], 12, layout);
      // The selected band is keyed by its 1-based index, and carries band 12's
      // own values — not band 1's. This is exactly what single-band pseudocolor
      // of band 12 needs (GeoLibre issue #485).
      expect([...result.bands.keys()]).toEqual(['12']);
      const tex = result.bands.get('12')!.texture as unknown as { data: Float32Array };
      expect(Array.from(tex.data)).toEqual([sampleValue(12, 0), sampleValue(12, 1)]);
    });

    it(`fetches a non-contiguous multi-band selection — ${layout}`, async () => {
      const { result } = await load([2, 7, 11], 12, layout);
      expect(new Set(result.bands.keys())).toEqual(new Set(['2', '7', '11']));
      const b7 = result.bands.get('7')!.texture as unknown as { data: Float32Array };
      expect(Array.from(b7.data)).toEqual([sampleValue(7, 0), sampleValue(7, 1)]);
    });
  }

  it('silently skips band indexes beyond the image band count', async () => {
    const { result } = await load([1, 13], 12, 'pixel');
    expect([...result.bands.keys()]).toEqual(['1']);
  });

  it('fetches the tile only once regardless of how many bands are requested', async () => {
    const { image } = await load([1, 5, 9], 12, 'band-separate');
    expect(image.fetchTile).toHaveBeenCalledTimes(1);
  });
});
