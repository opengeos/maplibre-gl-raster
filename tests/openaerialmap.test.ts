import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OAM_DEFAULT_ENDPOINT,
  searchOpenAerialMap,
} from '../src/lib/raster/openaerialmap';

/** A raw `/meta` result record, close to the real API shape. */
function rawResult(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'abc123',
    title: 'Sample scene',
    provider: 'Maxar',
    platform: 'satellite',
    gsd: 0.3,
    acquisition_start: '2024-10-02T14:11:00.000Z',
    acquisition_end: '2024-10-02T14:12:00.000Z',
    uuid: 'https://oin.example.com/abc123.tif',
    properties: {
      tms: 'https://tiles.openaerialmap.org/abc123/{z}/{x}/{y}',
      thumbnail: 'https://oin.example.com/abc123.png',
    },
    bbox: [-84.5, 33.6, -84.2, 33.9],
    ...overrides,
  };
}

/** Stubs global fetch with a JSON body and records the requested URL. */
function stubFetch(body: unknown, init?: { ok?: boolean; status?: number }) {
  const fetchMock = vi.fn(async () => ({
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('searchOpenAerialMap', () => {
  it('requests the meta endpoint with bbox, paging, and newest-first ordering', async () => {
    const fetchMock = stubFetch({ meta: { found: 0 }, results: [] });

    await searchOpenAerialMap({
      bbox: [-1, -2, 3, 4],
      limit: 5,
      page: 2,
    });

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe(`${OAM_DEFAULT_ENDPOINT}/meta`);
    expect(url.searchParams.get('bbox')).toBe('-1,-2,3,4');
    expect(url.searchParams.get('limit')).toBe('5');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('order_by')).toBe('acquisition_end');
    expect(url.searchParams.get('sort')).toBe('desc');
  });

  it('honors a custom endpoint (e.g. a proxy) and strips a trailing slash', async () => {
    const fetchMock = stubFetch({ meta: { found: 0 }, results: [] });

    await searchOpenAerialMap({ endpoint: 'https://proxy.example.com/oam/' });

    expect(fetchMock.mock.calls[0][0]).toMatch(
      /^https:\/\/proxy\.example\.com\/oam\/meta\?/,
    );
  });

  it('normalizes a result into tile, download, thumbnail, and bbox fields', async () => {
    stubFetch({ meta: { found: 1 }, results: [rawResult()] });

    const { images, found } = await searchOpenAerialMap();

    expect(found).toBe(1);
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      id: 'abc123',
      title: 'Sample scene',
      provider: 'Maxar',
      gsd: 0.3,
      cogUrl: 'https://oin.example.com/abc123.tif',
      thumbnailUrl: 'https://oin.example.com/abc123.png',
      bbox: [-84.5, 33.6, -84.2, 33.9],
    });
  });

  it('builds a CORS-enabled titiler tile template from the source COG', async () => {
    stubFetch({ meta: { found: 1 }, results: [rawResult()] });

    const { images } = await searchOpenAerialMap();

    // Rendered via titiler directly (not the un-CORS'd tiles.openaerialmap.org
    // redirect), with the COG URL encoded into the `url` query param.
    expect(images[0].tileUrl).toBe(
      'https://titiler.hotosm.org/cog/tiles/WebMercatorQuad/{z}/{x}/{y}@1x?url=' +
        encodeURIComponent('https://oin.example.com/abc123.tif'),
    );
  });

  it('falls back to geojson.bbox and property gsd when top-level fields are absent', async () => {
    stubFetch({
      meta: { found: 1 },
      results: [
        rawResult({
          gsd: undefined,
          bbox: undefined,
          properties: {
            tms: 'https://tiles.example.com/x/{z}/{x}/{y}',
            gsd: 0.05,
          },
          geojson: { bbox: [1, 2, 3, 4] },
        }),
      ],
    });

    const { images } = await searchOpenAerialMap();

    expect(images[0].gsd).toBe(0.05);
    expect(images[0].bbox).toEqual([1, 2, 3, 4]);
  });

  it('drops records without an id and tolerates missing optional fields', async () => {
    stubFetch({
      meta: { found: 2 },
      results: [
        { title: 'no id here' },
        { _id: 'only-id' },
      ],
    });

    const { images } = await searchOpenAerialMap();

    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      id: 'only-id',
      title: 'Untitled image',
      provider: 'Unknown',
      tileUrl: null,
      cogUrl: null,
      thumbnailUrl: null,
      bbox: null,
      gsd: null,
    });
  });

  it('throws a descriptive error on a non-OK response', async () => {
    stubFetch({}, { ok: false, status: 503 });

    await expect(searchOpenAerialMap()).rejects.toThrow(/503/);
  });

  it('defaults found to the returned count when meta is missing', async () => {
    stubFetch({ results: [rawResult()] });

    const { found } = await searchOpenAerialMap();

    expect(found).toBe(1);
  });
});
