import { SourceError } from "@chunkd/source";
import { SourceHttp } from "@chunkd/source-http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CorsSafeSourceHttp,
  loadGeoTIFF,
} from "../src/lib/raster/load-geotiff";

const WIDTH = 256;
const HEIGHT = 234;

/**
 * Builds a plain (non-COG) GeoTIFF the way GDAL lays one out: an 8-byte
 * header, the pixels as one uncompressed uint8 strip, and the IFD *after*
 * them, georeferenced in UTM 17N. With 256x234 pixels the IFD starts at byte
 * 59912 and the file ends before the next 32 KiB chunk boundary (65536), so
 * the header read around the IFD runs into a chunk that starts past EOF.
 */
function plainGeoTiff(): Uint8Array {
  const SHORT = 3;
  const LONG = 4;
  const DOUBLE = 12;
  const size = { [SHORT]: 2, [LONG]: 4, [DOUBLE]: 8 } as Record<number, number>;
  const pixels = WIDTH * HEIGHT;
  const ifdOffset = 8 + pixels;
  const tags: [number, number, number[]][] = [
    [256, SHORT, [WIDTH]],
    [257, SHORT, [HEIGHT]],
    [258, SHORT, [8]],
    [259, SHORT, [1]], // no compression
    [262, SHORT, [1]], // BlackIsZero
    [273, LONG, [8]], // StripOffsets
    [277, SHORT, [1]],
    [278, SHORT, [HEIGHT]], // RowsPerStrip
    [279, LONG, [pixels]], // StripByteCounts
    [284, SHORT, [1]],
    [33550, DOUBLE, [30, 30, 0]], // ModelPixelScale
    [33922, DOUBLE, [0, 0, 0, 500000, 4000000, 0]], // ModelTiepoint
    // GeoKeyDirectory: projected, pixel-is-area, EPSG:32617.
    [
      34735,
      SHORT,
      [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 32617],
    ],
  ];
  const entriesEnd = ifdOffset + 2 + tags.length * 12 + 4;
  let extra = entriesEnd;
  const outOfLine = tags.map(([, type, values]) => {
    const bytes = values.length * size[type];
    if (bytes <= 4) return -1;
    const at = extra;
    extra += bytes;
    return at;
  });
  const buffer = new ArrayBuffer(extra);
  const view = new DataView(buffer);
  const out = new Uint8Array(buffer);
  out[0] = 0x49; // "II": little-endian
  out[1] = 0x49;
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdOffset, true);
  for (let i = 0; i < pixels; i += 1) out[8 + i] = i % 251;
  const write = (type: number, values: number[], at: number) =>
    values.forEach((value, i) => {
      const offset = at + i * size[type];
      if (type === SHORT) view.setUint16(offset, value, true);
      else if (type === LONG) view.setUint32(offset, value, true);
      else view.setFloat64(offset, value, true);
    });
  view.setUint16(ifdOffset, tags.length, true);
  tags.forEach(([code, type, values], i) => {
    const entry = ifdOffset + 2 + i * 12;
    view.setUint16(entry, code, true);
    view.setUint16(entry + 2, type, true);
    view.setUint32(entry + 4, values.length, true);
    if (outOfLine[i] < 0) write(type, values, entry + 8);
    else {
      view.setUint32(entry + 8, outOfLine[i], true);
      write(type, values, outOfLine[i]);
    }
  });
  view.setUint32(ifdOffset + 2 + tags.length * 12, 0, true); // no next IFD
  return out;
}

const FIXTURE = plainGeoTiff();
const URL_ = "https://data.example.com/plain.tif";

/**
 * A static file server like S3 behind a CORS config that does not expose
 * Content-Range: ranges are honored and truncated at end of file, a range
 * starting at or past the end is 416, and Content-Range is invisible to JS.
 */
function fakeServer(bytes: Uint8Array) {
  const requests: string[] = [];
  const fetch = async (
    _url: URL | string,
    init?: RequestInit,
  ): Promise<Response> => {
    const range = new Headers(init?.headers).get("range") ?? "";
    requests.push(range);
    const match = /bytes=(\d+)-(\d*)/.exec(range);
    if (!match) return new Response(bytes, { status: 200 });
    const start = Number(match[1]);
    const end = match[2]
      ? Math.min(Number(match[2]), bytes.length - 1)
      : bytes.length - 1;
    if (start >= bytes.length) return new Response(null, { status: 416 });
    return new Response(bytes.slice(start, end + 1), { status: 206 });
  };
  return { fetch, requests };
}

describe("loadGeoTIFF range reads at end of file", () => {
  const original = SourceHttp.fetch;
  let server: ReturnType<typeof fakeServer>;

  beforeEach(() => {
    server = fakeServer(FIXTURE);
    SourceHttp.fetch = server.fetch as typeof SourceHttp.fetch;
  });
  afterEach(() => {
    SourceHttp.fetch = original;
  });

  it("opens a plain GeoTIFF whose directory sits after the pixel data", async () => {
    const tiff = await loadGeoTIFF(URL_);
    expect(tiff.width).toBe(WIDTH);
    expect(tiff.height).toBe(HEIGHT);
    // The chunked header read did ask past the end of the file, and got a 416.
    expect(
      server.requests.some(
        (range) => Number(/bytes=(\d+)/.exec(range)?.[1]) >= FIXTURE.length,
      ),
    ).toBe(true);
  });

  it("reads a range starting past the end as empty", async () => {
    const source = new CorsSafeSourceHttp(URL_, {});
    const bytes = await source.fetch(FIXTURE.length + 100, 32768);
    expect(bytes.byteLength).toBe(0);
  });

  it("still throws other HTTP errors", async () => {
    SourceHttp.fetch = (async () =>
      new Response(null, { status: 404 })) as typeof SourceHttp.fetch;
    const source = new CorsSafeSourceHttp(URL_, {});
    const error = await source.fetch(0, 32768).catch((e: unknown) => e);
    expect(SourceError.is(error) && error.code).toBe(404);
  });
});
