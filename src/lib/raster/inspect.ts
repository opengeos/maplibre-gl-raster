import type {
  GeoTIFF,
  RasterArray,
  RasterTypedArray,
} from '@developmentseed/geotiff';
import type { RasterWindowOptions, RasterWindowReading } from '../core/types';
import { epsgResolver, parseWkt } from '@developmentseed/proj';
import proj4 from 'proj4';

/** A single band's value at an inspected pixel. */
export interface BandReading {
  /** 1-based band index. */
  index: number;
  /** Band name from GDAL_METADATA, when known. */
  name: string | null;
  /** Raw stored sample value (no scale/offset applied). */
  value: number;
  /** Whether the value equals the layer's nodata. */
  isNodata: boolean;
}

/** The result of inspecting one pixel. */
export interface PixelReading {
  /** The clicked location, [lng, lat] in WGS84. */
  lngLat: [number, number];
  /** Column index in the full-resolution image. */
  col: number;
  /** Row index in the full-resolution image. */
  row: number;
  /** One entry per band, in band order. */
  bands: BandReading[];
}

/** Forward converter: WGS84 [lng, lat] -> source CRS [x, y]. */
type Reproject = (lng: number, lat: number) => [number, number];

/**
 * Build a forward converter from WGS84 to the GeoTIFF's CRS. EPSG:4326 is an
 * identity (the click is already in that CRS); EPSG:3857 uses proj4's built-in
 * definition; other EPSG codes are resolved via epsg.io (cached by
 * `@developmentseed/proj`); user-defined CRSes are parsed from their geo keys.
 * This mirrors the resolution COGLayer performs for rendering so inspected
 * coordinates line up with what is drawn.
 */
async function buildReproject(crs: number | object): Promise<Reproject> {
  if (crs === 4326) return (lng, lat) => [lng, lat];
  const source =
    typeof crs === 'number'
      ? crs === 3857
        ? 'EPSG:3857'
        : await epsgResolver(crs)
      : parseWkt(crs as Parameters<typeof parseWkt>[0]);
  // proj4's bundled types don't model wkt-parser / projection-definition
  // objects as a valid first argument, though the runtime accepts them.
  const converter = proj4(
    'EPSG:4326',
    source as unknown as string,
  );
  return (lng, lat) => converter.forward([lng, lat]) as [number, number];
}

/** Per-GeoTIFF reprojection cache so the proj definition and converter are
 * built once per layer instead of on every click. */
const reprojectCache = new WeakMap<GeoTIFF, Promise<Reproject>>();

function getReproject(tiff: GeoTIFF): Promise<Reproject> {
  let cached = reprojectCache.get(tiff);
  if (!cached) {
    cached = buildReproject(tiff.crs);
    reprojectCache.set(tiff, cached);
  }
  return cached;
}

/**
 * Invert the affine `transform` (which maps (col, row) -> (x, y) as
 * `x = a*col + b*row + c`, `y = d*col + e*row + f`) to recover the fractional
 * pixel column/row for a CRS coordinate.
 */
function crsToPixel(
  transform: readonly number[],
  x: number,
  y: number,
): [number, number] {
  const [a, b, c, d, e, f] = transform;
  const det = a * e - b * d;
  const dx = x - c;
  const dy = y - f;
  const col = (e * dx - b * dy) / det;
  const row = (-d * dx + a * dy) / det;
  return [col, row];
}

/** Read band `b` (0-based) at local pixel index `i` from a decoded tile. */
function sampleAt(array: RasterArray, b: number, i: number): number {
  if (array.layout === 'band-separate') {
    const band = array.bands[b] as RasterTypedArray;
    return band[i] as number;
  }
  const data = array.data as RasterTypedArray;
  return data[i * array.count + b] as number;
}

/**
 * Read the raw source values of every band at a clicked map location for a
 * loaded GeoTIFF. Reprojects the WGS84 click into the COG's CRS, inverts the
 * georeferencing transform to a pixel, fetches the single full-resolution tile
 * that contains it, and reads each band's sample.
 *
 * @param tiff - The loaded GeoTIFF to read from
 * @param lngLat - The clicked location, [lng, lat] in WGS84
 * @param options - Optional band names and an abort signal
 * @returns A {@link PixelReading}, or null when the click falls outside the
 *   image's pixel grid
 */
export async function readPixelValues(
  tiff: GeoTIFF,
  lngLat: [number, number],
  options?: {
    signal?: AbortSignal;
    bandNames?: Map<number, string> | null;
  },
): Promise<PixelReading | null> {
  const reproject = await getReproject(tiff);
  const [x, y] = reproject(lngLat[0], lngLat[1]);
  const [colF, rowF] = crsToPixel(tiff.transform as readonly number[], x, y);
  const col = Math.floor(colF);
  const row = Math.floor(rowF);
  if (col < 0 || col >= tiff.width || row < 0 || row >= tiff.height) {
    return null;
  }

  const tileX = Math.floor(col / tiff.tileWidth);
  const tileY = Math.floor(row / tiff.tileHeight);
  const tile = await tiff.fetchTile(tileX, tileY, {
    signal: options?.signal,
    boundless: false,
  });
  const array = tile.array;
  const localCol = col - tileX * tiff.tileWidth;
  const localRow = row - tileY * tiff.tileHeight;
  const index = localRow * array.width + localCol;

  const names = options?.bandNames ?? null;
  const nodata = array.nodata;
  const bands: BandReading[] = [];
  for (let b = 0; b < array.count; b++) {
    const value = sampleAt(array, b, index);
    bands.push({
      index: b + 1,
      name: names?.get(b + 1) ?? null,
      value,
      isNodata:
        nodata !== null &&
        (Number.isNaN(nodata) ? Number.isNaN(value) : value === nodata),
    });
  }

  return { lngLat, col, row, bands };
}

/**
 * Read one band from a WGS84 viewport in one batched tile operation. The
 * coarsest suitable GeoTIFF overview is selected before fetching tiles, so
 * viewport statistics do not need one network/decode operation per pixel.
 */
export async function readRasterWindow(
  tiff: GeoTIFF,
  options: RasterWindowOptions,
): Promise<RasterWindowReading> {
  const width = requireInteger('width', options.width ?? 32, 2, MAX_RASTER_WINDOW_DIMENSION);
  const height = requireInteger('height', options.height ?? 32, 2, MAX_RASTER_WINDOW_DIMENSION);
  const band = requireInteger('band', options.band ?? 1, 1, tiff.count);
  const reproject = await getReproject(tiff);
  const [west, south, east, north] = options.bounds;
  const corners = [
    reproject(west, south), reproject(west, north),
    reproject(east, south), reproject(east, north),
  ];
  const images = [tiff, ...tiff.overviews];
  let selected = tiff as GeoTIFF | (typeof tiff.overviews)[number];
  let window = pixelWindow(selected, corners);
  const targetPixels = Math.max(width, height) * 4;
  for (let index = 1; index < images.length; index += 1) {
    const candidate = images[index];
    const candidateWindow = pixelWindow(candidate, corners);
    selected = candidate;
    window = candidateWindow;
    if (
      candidateWindow[2] - candidateWindow[0] <= targetPixels &&
      candidateWindow[3] - candidateWindow[1] <= targetPixels
    ) break;
  }

  const x1 = Math.max(0, Math.floor(window[0]));
  const y1 = Math.max(0, Math.floor(window[1]));
  const x2 = Math.min(selected.width, Math.ceil(window[2]));
  const y2 = Math.min(selected.height, Math.ceil(window[3]));
  const nodata = selected.nodata;
  const overviewLevel = images.indexOf(selected);
  if (x2 <= x1 || y2 <= y1) {
    return { values: [], width, height, band, nodata, overviewLevel };
  }
  const tileX1 = Math.floor(x1 / selected.tileWidth);
  const tileY1 = Math.floor(y1 / selected.tileHeight);
  const tileX2 = Math.floor(Math.max(x1, x2 - 1) / selected.tileWidth);
  const tileY2 = Math.floor(Math.max(y1, y2 - 1) / selected.tileHeight);
  const coordinates: Array<[number, number]> = [];
  for (let y = tileY1; y <= tileY2; y += 1) {
    for (let x = tileX1; x <= tileX2; x += 1) coordinates.push([x, y]);
  }
  const tiles = await selected.fetchTiles(coordinates, { signal: options.signal, boundless: false });
  const tileMap = new Map(coordinates.map((coordinate, index) => [coordinate.join(","), tiles[index]]));
  const values: number[] = [];
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const sourceX = x1 + ((col + 0.5) / width) * (x2 - x1);
      const sourceY = y1 + ((row + 0.5) / height) * (y2 - y1);
      const tileX = Math.floor(sourceX / selected.tileWidth);
      const tileY = Math.floor(sourceY / selected.tileHeight);
      const tile = tileMap.get(`${tileX},${tileY}`);
      if (!tile?.array) {
        values.push(NaN);
        continue;
      }
      const offsetX = Math.min(tile.array.width - 1, Math.floor(sourceX) - tileX * selected.tileWidth);
      const offsetY = Math.min(tile.array.height - 1, Math.floor(sourceY) - tileY * selected.tileHeight);
      values.push(sampleAt(tile.array, band - 1, offsetY * tile.array.width + offsetX));
    }
  }
  return { values, width, height, band, nodata, overviewLevel };
}

/** Largest output sample width/height accepted by {@link readRasterWindow}. */
export const MAX_RASTER_WINDOW_DIMENSION = 1024;

/**
 * Round `value` to an integer and check it lies within `[min, max]`. Throws a
 * `RangeError` for non-finite or out-of-range input so a bad option cannot
 * produce an unbounded sampling loop or an invalid band lookup.
 */
function requireInteger(name: string, value: number, min: number, max: number): number {
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded) || rounded < min || rounded > max) {
    throw new RangeError(
      `readRasterWindow: ${name} must be an integer between ${min} and ${max}, got ${value}`,
    );
  }
  return rounded;
}

function pixelWindow(
  image: { transform: readonly number[]; width: number; height: number },
  points: [number, number][],
): [number, number, number, number] {
  const pixels = points.map(([x, y]) => crsToPixel(image.transform, x, y));
  return [
    Math.min(...pixels.map(([x]) => x)), Math.min(...pixels.map(([, y]) => y)),
    Math.max(...pixels.map(([x]) => x)), Math.max(...pixels.map(([, y]) => y)),
  ];
}
