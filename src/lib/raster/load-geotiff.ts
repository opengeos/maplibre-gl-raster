import { SourceCache, SourceChunk } from '@chunkd/middleware';
import { SourceView } from '@chunkd/source';
import { SourceHttp } from '@chunkd/source-http';
import { GeoTIFF } from '@developmentseed/geotiff';

/**
 * COG access pattern is hundreds of distinct Range requests against the
 * same URL. Chrome's HTTP cache serializes lookups on a single I/O thread
 * and evaluates `If-Range`/`If-None-Match` validators per request, which
 * shows up as multi-hundred-millisecond "Stalled" time per chunk in the
 * Network panel — frequently *longer* than the actual network round-trip.
 *
 * `cache: "no-store"` skips both reads and writes against that machinery.
 * We don't lose anything: the @chunkd `SourceCache` middleware caches
 * header chunks in memory, deck.gl's tile cache holds decoded tile data
 * in JS heap, so the browser's disk cache was only ever helping on full
 * page reloads — and even then, partial-content (206) responses cache
 * poorly against subsequent Range requests for *different* byte ranges
 * of the same URL.
 *
 * `SourceHttp.fetch` is the upstream's documented override hook for
 * customising the fetcher; defaults to `(a, b) => fetch(a, b)`. Setting
 * it once at module load applies to every SourceHttp / CorsSafeSourceHttp
 * instance.
 */
SourceHttp.fetch = (url, opts) =>
  fetch(url as URL | string, { ...opts, cache: 'no-store' });

/**
 * SourceHttp variant that resists the bogus `metadata.size` value the upstream
 * class records when the HTTP server returns 206 Partial Content but doesn't
 * expose `Content-Range` via CORS.
 *
 * Background. `getMetadataFromResponse` reads `content-length` first, then
 * overrides with `content-range` if present. `Content-Length` is a CORS-
 * safelisted response header (always readable from JS); `Content-Range` is
 * not. Many S3 buckets (and others) don't include
 * `Access-Control-Expose-Headers: Content-Range` in their CORS config, so
 * `response.headers.get("content-range")` returns null and `metadata.size`
 * gets stuck at `Content-Length` of the 206 — which is the chunk size, not
 * the file size.
 *
 * Downstream, `getMaxLength(offset, length)` clamps to `size - offset`. When
 * the IFD chain points past the assumed file end, that returns a NEGATIVE
 * length that propagates into a malformed `bytes=START-END` Range header
 * (end < start). S3 ignores the bad range and serves the entire file with
 * status 200. For a large COG that's a full-file download per page load.
 *
 * We can't repair `Content-Range` from the browser (CORS forbids it) and
 * some buckets also block HEAD preflight. The least invasive fix: after each
 * fetch, if `metadata.size` was just initialised to a value equal to the
 * length we requested, treat it as bogus and clear it. With `size` unset,
 * `getMaxLength` returns the requested length unchanged and the chunk
 * middleware computes valid Range headers.
 *
 * Remove this once @developmentseed/geotiff (or @chunkd/source-http) lands a
 * fix for the underlying behavior.
 */
class CorsSafeSourceHttp extends SourceHttp {
  async fetch(
    offset: number,
    length?: number,
    options?: { signal: AbortSignal },
  ): Promise<ArrayBuffer> {
    const wasMetadata = this.metadata;
    const result = await super.fetch(offset, length, options);
    if (
      wasMetadata == null &&
      this.metadata != null &&
      length != null &&
      this.metadata.size === length
    ) {
      // Overwrite the in-place mutation done by the parent class. Cast away
      // the readonly-ish nature of metadata; we own this instance.
      (this.metadata as { size?: number }).size = undefined;
    }
    return result;
  }
}

// Match @developmentseed/geotiff's `GeoTIFF.fromUrl` defaults so we don't
// over-fetch on first byte. The CorsSafeSourceHttp patch above handles the
// upstream `metadata.size` bug, so a small initial chunk is safe.
const CHUNK_SIZE = 32 * 1024;
const CACHE_SIZE = 1024 * 1024;

const inflight = new Map<string, Promise<GeoTIFF>>();

/**
 * Open a GeoTIFF from a URL (http(s) or blob:). Equivalent to
 * `GeoTIFF.fromUrl(url)` plus the CORS workaround above. Dedupes concurrent
 * requests for the same URL so double-invoked effects don't kick off two
 * parallel reads; entries are dropped once settled so the map stays bounded.
 */
export function loadGeoTIFF(url: string): Promise<GeoTIFF> {
  const existing = inflight.get(url);
  if (existing) return existing;

  const promise = (async () => {
    const source = new CorsSafeSourceHttp(url, {});
    const view = new SourceView(source, [
      new SourceChunk({ size: CHUNK_SIZE }),
      new SourceCache({ size: CACHE_SIZE }),
    ]);
    return await GeoTIFF.open({
      dataSource: source,
      headerSource: view,
    });
  })();

  inflight.set(url, promise);
  promise.finally(() => inflight.delete(url)).catch(() => {});
  return promise;
}
