// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { DecoderMetadata, GeoTIFF } from '@developmentseed/geotiff';
import { decoderPoolFor, isBigEndian, swapBytesInPlace } from '../src/lib/raster/byte-order';

/** TIFF Compression.None. */
const NONE = 1;

/** A stand-in image whose header declares the given byte order. */
function image(littleEndian: boolean): GeoTIFF {
  return { image: { tiff: { isLittleEndian: littleEndian } } } as unknown as GeoTIFF;
}

function metadata(overrides: Partial<DecoderMetadata>): DecoderMetadata {
  return {
    sampleFormat: 3,
    bitsPerSample: 32,
    samplesPerPixel: 1,
    width: 2,
    height: 1,
    predictor: 1,
    planarConfiguration: 1,
    ...overrides,
  } as DecoderMetadata;
}

/** Encode samples big-endian, the way GeoServer writes them. */
function bigEndianBytes(values: number[], write: (view: DataView, offset: number, v: number) => void, width: number): ArrayBuffer {
  const buffer = new ArrayBuffer(values.length * width);
  const view = new DataView(buffer);
  values.forEach((v, i) => write(view, i * width, v));
  return buffer;
}

describe('byte order', () => {
  it('only overrides decoding for big-endian files', () => {
    expect(isBigEndian(image(false))).toBe(true);
    expect(isBigEndian(image(true))).toBe(false);
    expect(decoderPoolFor(image(true))).toBeUndefined();
    expect(decoderPoolFor(image(false))).toBeDefined();
  });

  it('swaps every sample in place', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    swapBytesInPlace(bytes, 4);
    expect([...bytes]).toEqual([4, 3, 2, 1, 8, 7, 6, 5]);
  });

  it('reads uncompressed big-endian Float32 without mutating the input', async () => {
    const pool = decoderPoolFor(image(false))!;
    const input = bigEndianBytes([-1035.16345, -3331.28125], (v, o, x) => v.setFloat32(o, x), 4);
    const copy = new Uint8Array(input.slice(0));
    const decoded = await pool.decode(input, NONE, metadata({}));
    expect(decoded.layout).toBe('pixel-interleaved');
    const data = (decoded as { data: Float32Array }).data;
    expect(data[0]).toBeCloseTo(-1035.16345, 3);
    expect(data[1]).toBe(-3331.28125);
    expect(new Uint8Array(input)).toEqual(copy);
  });

  it('swaps before undoing horizontal differencing', async () => {
    const pool = decoderPoolFor(image(false))!;
    // Rows [1000, 1300, 900] and [-5, -5, 10], stored as differences.
    const diffs = [1000, 300, -400, -5, 0, 15];
    const input = bigEndianBytes(diffs, (v, o, x) => v.setInt16(o, x), 2);
    const decoded = await pool.decode(
      input,
      NONE,
      metadata({ sampleFormat: 2, bitsPerSample: 16, width: 3, height: 2, predictor: 2 }),
    );
    expect([...(decoded as { data: Int16Array }).data]).toEqual([1000, 1300, 900, -5, -5, 10]);
  });

  it('undoes differencing per band for interleaved pixels', async () => {
    const pool = decoderPoolFor(image(false))!;
    // Two pixels of two bands: (10, 200) then (15, 180).
    const input = bigEndianBytes([10, 200, 5, -20], (v, o, x) => v.setInt32(o, x), 4);
    const decoded = await pool.decode(
      input,
      NONE,
      metadata({ sampleFormat: 2, samplesPerPixel: 2, predictor: 2 }),
    );
    expect([...(decoded as { data: Int32Array }).data]).toEqual([10, 200, 15, 180]);
  });

  it('leaves byte samples to the stock decoder', async () => {
    const pool = decoderPoolFor(image(false))!;
    const decoded = await pool.decode(
      new Uint8Array([7, 9]).buffer,
      NONE,
      metadata({ sampleFormat: 1, bitsPerSample: 8 }),
    );
    expect([...(decoded as { data: Uint8Array }).data]).toEqual([7, 9]);
  });
});
