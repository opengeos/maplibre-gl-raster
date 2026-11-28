import {
  DECODER_REGISTRY,
  DecoderPool,
  type DecodedPixels,
  type DecoderMetadata,
  type GeoTIFF,
  type Overview,
  type RasterTypedArray,
} from '@developmentseed/geotiff';

/**
 * Byte-order handling for big-endian GeoTIFFs.
 *
 * `@developmentseed/geotiff` 0.7 views decoded bytes as typed arrays in the
 * platform's (little-endian) byte order and never consults the file's byte
 * order, so every sample wider than one byte in a big-endian ("MM") TIFF comes
 * back with its bytes reversed. GeoServer writes big-endian TIFFs by default,
 * which made the pixel inspector show values like 0.0035 for a -1035 m depth.
 * Upstream fixed this in 0.10; until this package moves to it, tiles of a
 * big-endian file are decoded through {@link decoderPoolFor}, which mirrors the
 * upstream fix: swap samples to platform order before the predictor runs.
 */

/** TIFF Predictor tag values (from `@cogeotiff/core`'s `Predictor`). */
const PREDICTOR_NONE = 1;
const PREDICTOR_HORIZONTAL = 2;
const PREDICTOR_FLOATING_POINT = 3;
/** TIFF SampleFormat tag values (from `@cogeotiff/core`'s `SampleFormat`). */
const SAMPLE_UINT = 1;
const SAMPLE_INT = 2;
const SAMPLE_FLOAT = 3;
/** PlanarConfiguration.Separate: each band is its own plane. */
const PLANAR_SEPARATE = 2;

/** Main-thread fallback pool for the cases that need no byte swap. */
let fallbackPool: DecoderPool | undefined;

/**
 * Whether a GeoTIFF or overview stores its samples big-endian.
 *
 * @param image - A loaded GeoTIFF or one of its overviews
 * @returns True for a big-endian ("MM") file
 */
export function isBigEndian(image: GeoTIFF | Overview): boolean {
  return image.image?.tiff?.isLittleEndian === false;
}

/**
 * Reverse the byte order of every `bytesPerSample`-byte sample, in place.
 *
 * @param bytes - The buffer to swap
 * @param bytesPerSample - Width of one sample in bytes (2, 4 or 8)
 */
export function swapBytesInPlace(bytes: Uint8Array, bytesPerSample: number): void {
  for (let i = 0; i + bytesPerSample <= bytes.length; i += bytesPerSample) {
    for (let lo = i, hi = i + bytesPerSample - 1; lo < hi; lo++, hi--) {
      const tmp = bytes[lo];
      bytes[lo] = bytes[hi];
      bytes[hi] = tmp;
    }
  }
}

/**
 * View platform-order sample bytes as the typed array the sample format names.
 *
 * @param buffer - Decoded, platform-order sample bytes
 * @param metadata - The tile's decoder metadata
 * @returns The typed sample array
 */
function toTypedArray(buffer: ArrayBuffer, metadata: DecoderMetadata): RasterTypedArray {
  const { sampleFormat, bitsPerSample } = metadata;
  const format = sampleFormat as number;
  if (format === SAMPLE_UINT) {
    if (bitsPerSample === 16) return new Uint16Array(buffer);
    if (bitsPerSample === 32) return new Uint32Array(buffer);
  } else if (format === SAMPLE_INT) {
    if (bitsPerSample === 16) return new Int16Array(buffer);
    if (bitsPerSample === 32) return new Int32Array(buffer);
  } else if (format === SAMPLE_FLOAT) {
    if (bitsPerSample === 32) return new Float32Array(buffer);
    if (bitsPerSample === 64) return new Float64Array(buffer);
  }
  throw new Error(
    `Unsupported sample format/depth: SampleFormat=${sampleFormat}, BitsPerSample=${bitsPerSample}`,
  );
}

/**
 * Undo TIFF horizontal differencing (Predictor 2) on platform-order samples.
 *
 * The predictor differences whole sample words as unsigned integers, floating
 * point samples included, so it is undone on an unsigned view of the bytes
 * before they are read as the sample type. Unsigned typed arrays wrap the sums
 * the way the encoder's subtraction did.
 *
 * @param buffer - The tile's platform-order sample bytes, modified in place
 * @param metadata - The tile's decoder metadata
 */
function undoHorizontalPredictor(buffer: ArrayBuffer, metadata: DecoderMetadata): void {
  const { width, height, bitsPerSample } = metadata;
  // Band-separate tiles reach the decoder one band at a time.
  const stride =
    (metadata.planarConfiguration as number) === PLANAR_SEPARATE
      ? 1
      : metadata.samplesPerPixel;
  const rowLength = width * stride;
  const accumulate = <T extends number | bigint>(words: { [i: number]: T }) => {
    for (let row = 0; row < height; row++) {
      const start = row * rowLength;
      for (let i = start + stride; i < start + rowLength; i++) {
        words[i] = ((words[i] as never) + (words[i - stride] as never)) as T;
      }
    }
  };
  if (bitsPerSample === 16) accumulate(new Uint16Array(buffer));
  else if (bitsPerSample === 32) accumulate(new Uint32Array(buffer));
  else if (bitsPerSample === 64) accumulate(new BigUint64Array(buffer));
  else throw new Error(`Unsupported predictor sample width: ${bitsPerSample}`);
}

/**
 * Decode one big-endian tile into platform-order samples.
 *
 * @param bytes - The tile's compressed bytes
 * @param compression - The tile's compression code
 * @param metadata - The tile's decoder metadata
 * @returns The decoded pixels in platform byte order
 */
async function decodeBigEndian(
  bytes: ArrayBuffer,
  compression: Parameters<DecoderPool['decode']>[1],
  metadata: DecoderMetadata,
): Promise<DecodedPixels> {
  const { bitsPerSample, predictor } = metadata;
  // Byte samples have no order, and the floating-point predictor's byte planes
  // are always most significant byte first, which the stock decoder already
  // reassembles in platform order.
  if (bitsPerSample <= 8 || (predictor as number) === PREDICTOR_FLOATING_POINT) {
    fallbackPool ??= new DecoderPool({ size: 0 });
    return fallbackPool.decode(bytes, compression, metadata);
  }
  const loader = DECODER_REGISTRY.get(compression);
  if (!loader) throw new Error(`Unsupported compression: ${compression}`);
  const decoder = await loader();
  const result = await decoder(bytes, metadata);
  const bytesPerSample = bitsPerSample / 8;
  if (!(result instanceof ArrayBuffer)) {
    // Codecs that return typed pixels (LERC) also hold file-order samples.
    const arrays = result.layout === 'pixel-interleaved' ? [result.data] : result.bands;
    for (const array of arrays) {
      swapBytesInPlace(
        new Uint8Array(array.buffer, array.byteOffset, array.byteLength),
        bytesPerSample,
      );
    }
    return result;
  }
  // The uncompressed decoder hands back the caller's bytes, which a block cache
  // may share, so swap a copy rather than the input.
  const buffer = result === bytes ? result.slice(0) : result;
  swapBytesInPlace(new Uint8Array(buffer), bytesPerSample);
  if ((predictor as number) === PREDICTOR_HORIZONTAL) undoHorizontalPredictor(buffer, metadata);
  else if ((predictor as number) !== PREDICTOR_NONE)
    throw new Error(`Unsupported predictor: ${predictor}`);
  return { layout: 'pixel-interleaved', data: toTypedArray(buffer, metadata) };
}

/** A decoder-pool stand-in that decodes big-endian tiles correctly. */
const bigEndianPool = { decode: decodeBigEndian } as unknown as DecoderPool;

/**
 * The decoder pool to pass to `fetchTile`/`fetchTiles` for an image.
 *
 * @param image - A loaded GeoTIFF or one of its overviews
 * @returns A byte-order-aware pool for a big-endian file, otherwise undefined
 *   (the library's default decode path)
 */
export function decoderPoolFor(image: GeoTIFF | Overview): DecoderPool | undefined {
  return isBigEndian(image) ? bigEndianPool : undefined;
}
