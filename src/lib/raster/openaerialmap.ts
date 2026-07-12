/**
 * OpenAerialMap (OAM) catalog client.
 *
 * OAM exposes a public metadata API at https://api.openaerialmap.org/meta that
 * returns openly-licensed aerial/satellite imagery matching a bounding box.
 * Each result carries three URLs we care about:
 *
 * - `uuid` — the source Cloud-Optimized GeoTIFF on S3. It supports HTTP range
 *   requests but is not CORS-enabled for arbitrary origins, so it cannot feed a
 *   browser-side COG reader; it is, however, directly *downloadable*, and it is
 *   the input to the tile server used for visualization (see below).
 * - `properties.thumbnail` — a small PNG preview shown in the results list.
 *
 * To *visualize* an image we build an XYZ tile template pointing straight at
 * OAM's dynamic tiler (titiler.hotosm.org), which reads the COG server-side and
 * returns web-mercator PNG tiles with permissive CORS. The per-image
 * `properties.tms` URL (on tiles.openaerialmap.org) is deliberately *not* used:
 * it 302-redirects to the same tiler but the redirect response carries no CORS
 * header, so a browser blocks the tile before the redirect is followed.
 *
 * The metadata endpoint itself is only CORS-enabled for the official OAM web
 * app origin, so a browser fetch from another origin may be blocked. The base
 * URL is therefore configurable (see {@link OpenAerialMapSearchOptions.endpoint})
 * so a host that needs it can point the client at a proxy.
 */

/** Default OpenAerialMap metadata API base URL. */
export const OAM_DEFAULT_ENDPOINT = 'https://api.openaerialmap.org';

/**
 * OAM's dynamic COG tiler. Building tile URLs against it directly (rather than
 * following the per-image `properties.tms` redirect) keeps the requests CORS-
 * enabled — see the module doc comment.
 */
const OAM_TILER_BASE = 'https://titiler.hotosm.org';

/**
 * Builds a web-mercator XYZ tile template that renders a COG through OAM's
 * tiler. The `{z}/{x}/{y}` tokens are filled in by MapLibre.
 *
 * @param cogUrl - Source Cloud-Optimized GeoTIFF URL
 * @returns An XYZ tile template, or null when no COG URL is available
 */
function tilerTemplate(cogUrl: string | null): string | null {
  if (!cogUrl) return null;
  return `${OAM_TILER_BASE}/cog/tiles/WebMercatorQuad/{z}/{x}/{y}@1x?url=${encodeURIComponent(
    cogUrl,
  )}`;
}

/** A single OpenAerialMap image, normalized from the raw `/meta` response. */
export interface OamImage {
  /** Stable OAM record id. */
  id: string;
  /** Human-readable title. */
  title: string;
  /** Data provider / source (e.g. "Maxar"). */
  provider: string;
  /** Capture platform (e.g. "satellite", "uav"). */
  platform: string;
  /** Ground sample distance in meters, when known. */
  gsd: number | null;
  /** Acquisition start timestamp (ISO 8601), when known. */
  acquisitionStart: string | null;
  /** Acquisition end timestamp (ISO 8601), when known. */
  acquisitionEnd: string | null;
  /** Preview thumbnail URL, when available. */
  thumbnailUrl: string | null;
  /** XYZ tile template ({z}/{x}/{y}) for visualization, when available. */
  tileUrl: string | null;
  /** Source COG URL, used for download. */
  cogUrl: string | null;
  /** WGS84 bounds [west, south, east, north], when available. */
  bbox: [number, number, number, number] | null;
}

/** A page of OpenAerialMap search results. */
export interface OamSearchResult {
  /** Normalized images for this page. */
  images: OamImage[];
  /** Total number of images matching the query across all pages. */
  found: number;
  /** 1-indexed page number this result represents. */
  page: number;
  /** Page size used for the query. */
  limit: number;
}

/** Options for {@link searchOpenAerialMap}. */
export interface OpenAerialMapSearchOptions {
  /** WGS84 bounding box [west, south, east, north] to search within. */
  bbox?: [number, number, number, number];
  /** Maximum results per page. @default 20 */
  limit?: number;
  /** 1-indexed page number. @default 1 */
  page?: number;
  /** Overrides the API base URL. @default {@link OAM_DEFAULT_ENDPOINT} */
  endpoint?: string;
  /** Aborts the request. */
  signal?: AbortSignal;
}

/** Reads a finite number from an unknown value, else null. */
function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Reads a non-empty string from an unknown value, else null. */
function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Reads a [w, s, e, n] tuple of finite numbers, else null. */
function asBbox(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length < 4) return null;
  const [w, s, e, n] = value;
  if (
    typeof w === 'number' &&
    typeof s === 'number' &&
    typeof e === 'number' &&
    typeof n === 'number' &&
    [w, s, e, n].every(Number.isFinite)
  ) {
    return [w, s, e, n];
  }
  return null;
}

/** Normalizes one raw `/meta` result record into an {@link OamImage}. */
function normalizeImage(raw: unknown): OamImage | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const props = (record.properties ?? {}) as Record<string, unknown>;
  const geojson = (record.geojson ?? {}) as Record<string, unknown>;

  const id = asString(record._id) ?? asString(record.uuid);
  if (!id) return null;

  const cogUrl = asString(record.uuid);

  return {
    id,
    title: asString(record.title) ?? 'Untitled image',
    provider: asString(record.provider) ?? 'Unknown',
    platform: asString(record.platform) ?? '',
    gsd: asNumber(record.gsd) ?? asNumber(props.gsd),
    acquisitionStart: asString(record.acquisition_start),
    acquisitionEnd: asString(record.acquisition_end),
    thumbnailUrl: asString(props.thumbnail),
    tileUrl: tilerTemplate(cogUrl),
    cogUrl,
    bbox: asBbox(record.bbox) ?? asBbox(geojson.bbox),
  };
}

/**
 * Searches the OpenAerialMap catalog for imagery.
 *
 * @param options - Bounding box, paging, endpoint, and abort signal
 * @returns A page of normalized images plus the total match count
 * @throws When the request fails (network, CORS, or a non-OK response)
 */
export async function searchOpenAerialMap(
  options: OpenAerialMapSearchOptions = {},
): Promise<OamSearchResult> {
  const endpoint = (options.endpoint ?? OAM_DEFAULT_ENDPOINT).replace(/\/$/, '');
  const limit = options.limit ?? 20;
  const page = options.page ?? 1;

  const params = new URLSearchParams({
    limit: String(limit),
    page: String(page),
    // Newest imagery first.
    order_by: 'acquisition_end',
    sort: 'desc',
  });
  if (options.bbox) {
    params.set('bbox', options.bbox.join(','));
  }

  const response = await fetch(`${endpoint}/meta?${params.toString()}`, {
    headers: { Accept: 'application/json' },
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`OpenAerialMap request failed (${response.status})`);
  }

  const body = (await response.json()) as {
    meta?: { found?: unknown };
    results?: unknown;
  };
  const results = Array.isArray(body.results) ? body.results : [];
  const images = results
    .map(normalizeImage)
    .filter((image): image is OamImage => image !== null);

  return {
    images,
    found: asNumber(body.meta?.found) ?? images.length,
    page,
    limit,
  };
}
