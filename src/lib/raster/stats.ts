import { TiffTag } from '@cogeotiff/core';
import type {
  GeoTIFF,
  Overview,
  RasterArray,
} from '@developmentseed/geotiff';

/**
 * Parse band descriptions from the GDAL_METADATA XML tag. Looks for
 * `<Item name="DESCRIPTION" sample="N">name</Item>` (and a few common
 * aliases) and returns a 1-indexed band → name map. The geotiff package
 * surfaces statistics from this XML but not descriptions, so we re-parse.
 */
export function readBandNames(tiff: GeoTIFF): Map<number, string> | null {
  const xml = tiff.image.value(TiffTag.GdalMetadata);
  if (typeof xml !== 'string' || xml.length === 0) return null;
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const out = new Map<number, string>();
  for (const item of Array.from(doc.querySelectorAll('Item'))) {
    const name = item.getAttribute('name');
    const sample = item.getAttribute('sample');
    if (sample === null) continue;
    if (name !== 'DESCRIPTION' && name !== 'BAND_NAME') continue;
    const text = item.textContent?.trim() ?? '';
    if (!text) continue;
    const idx = parseInt(sample, 10) + 1;
    if (Number.isFinite(idx) && idx > 0) out.set(idx, text);
  }
  return out.size > 0 ? out : null;
}

const HISTOGRAM_BINS = 128;

export type BandStats = {
  min: number;
  max: number;
  /** Bin counts evenly distributed over [min, max]. Length = HISTOGRAM_BINS. */
  histogram: number[];
};

export type AutoStats = {
  /** 1-indexed band → stats map. Null when stats are unknown. */
  perBand: Map<number, BandStats> | null;
  /** A reasonable global stats block to fall back on (averaged min/max,
   * summed histogram bins). */
  global: BandStats | null;
};

const NULL_STATS: AutoStats = { perBand: null, global: null };

function averageStats(stats: BandStats[]): BandStats {
  let lo = 0;
  let hi = 0;
  const summedHistogram = new Array<number>(HISTOGRAM_BINS).fill(0);
  for (const s of stats) {
    lo += s.min;
    hi += s.max;
    for (let i = 0; i < HISTOGRAM_BINS; i++) {
      summedHistogram[i] += s.histogram[i] ?? 0;
    }
  }
  return {
    min: lo / stats.length,
    max: hi / stats.length,
    histogram: summedHistogram,
  };
}

/**
 * Redistributes one image's histogram onto a wider [min, max] range,
 * accumulating into `target`.
 *
 * Each source bin's counts are credited to the target bin its *center* value
 * falls in. That is an approximation — it collapses each bin to a point — but
 * the error is bounded by one source bin width, which is what a histogram
 * already quantizes away. It is what makes histograms computed over different
 * ranges addable at all.
 */
function rebinInto(
  target: number[],
  stats: BandStats,
  min: number,
  max: number,
): void {
  const targetSpan = max - min;
  const sourceSpan = stats.max - stats.min;
  for (let i = 0; i < HISTOGRAM_BINS; i++) {
    const count = stats.histogram[i] ?? 0;
    if (count === 0) continue;
    const center =
      sourceSpan === 0
        ? stats.min
        : stats.min + ((i + 0.5) / HISTOGRAM_BINS) * sourceSpan;
    const bin =
      targetSpan === 0
        ? 0
        : Math.floor(((center - min) / targetSpan) * HISTOGRAM_BINS);
    target[Math.min(HISTOGRAM_BINS - 1, Math.max(0, bin))] += count;
  }
}

/**
 * Merges stats sampled from several images of one dataset into a single block
 * spanning all of them.
 *
 * Unlike {@link averageStats} — which sums bins across the *bands* of one image
 * and averages their ranges — this unions the ranges and rebins each histogram
 * onto the result, so percentiles taken from it describe the whole collection.
 * Used for a mosaic VRT, whose members are separate files that must still share
 * one rescale window.
 *
 * @param stats - Per-image stats for the same band
 * @returns Merged stats, or null when none carry a usable range
 */
export function mergeBandStats(stats: BandStats[]): BandStats | null {
  const usable = stats.filter(
    (s) => Number.isFinite(s.min) && Number.isFinite(s.max) && s.max >= s.min,
  );
  if (usable.length === 0) return null;
  if (usable.length === 1) return usable[0];

  const min = Math.min(...usable.map((s) => s.min));
  const max = Math.max(...usable.map((s) => s.max));
  const histogram = new Array<number>(HISTOGRAM_BINS).fill(0);
  for (const s of usable) rebinInto(histogram, s, min, max);
  return { min, max, histogram };
}

/**
 * Merges per-image {@link AutoStats} into one block covering every image.
 *
 * @param stats - One entry per image (e.g. per VRT member)
 * @returns Stats whose per-band ranges span every image, or null stats when
 *   no image produced any
 */
export function mergeAutoStats(stats: AutoStats[]): AutoStats {
  const withBands = stats.filter((s) => s.perBand);
  if (withBands.length === 0) return NULL_STATS;

  const bandNumbers = new Set<number>();
  for (const s of withBands) {
    for (const band of s.perBand!.keys()) bandNumbers.add(band);
  }

  const perBand = new Map<number, BandStats>();
  for (const band of [...bandNumbers].sort((a, b) => a - b)) {
    const merged = mergeBandStats(
      withBands.flatMap((s) => {
        const bandStats = s.perBand!.get(band);
        return bandStats ? [bandStats] : [];
      }),
    );
    if (merged) perBand.set(band, merged);
  }

  return {
    perBand: perBand.size > 0 ? perBand : null,
    global: mergeBandStats(stats.flatMap((s) => (s.global ? [s.global] : []))),
  };
}

/**
 * Linear-interpolated percentile from a histogram. `p` is in [0, 1]. Used
 * to derive default rescale ranges (typically [0.02, 0.98]) without storing
 * raw samples.
 */
export function percentileFromHistogram(stats: BandStats, p: number): number {
  const total = stats.histogram.reduce((a, b) => a + b, 0);
  if (total === 0) return p < 0.5 ? stats.min : stats.max;
  const target = total * p;
  let acc = 0;
  const range = stats.max - stats.min;
  if (range <= 0) return stats.min;
  const binWidth = range / stats.histogram.length;
  for (let i = 0; i < stats.histogram.length; i++) {
    const count = stats.histogram[i];
    if (acc + count >= target) {
      const fraction = count > 0 ? (target - acc) / count : 0;
      return stats.min + (i + fraction) * binWidth;
    }
    acc += count;
  }
  return stats.max;
}

/** Bin a single band's values into a histogram with `min` / `max` as edges. */
function buildHistogram(
  iter: Iterable<number>,
  min: number,
  max: number,
  nodata: number | null,
): number[] {
  const bins = new Array<number>(HISTOGRAM_BINS).fill(0);
  if (max <= min) return bins;
  const scale = HISTOGRAM_BINS / (max - min);
  for (const v of iter) {
    if (nodata !== null && v === nodata) continue;
    if (!Number.isFinite(v)) continue;
    let idx = Math.floor((v - min) * scale);
    if (idx < 0) idx = 0;
    if (idx >= HISTOGRAM_BINS) idx = HISTOGRAM_BINS - 1;
    bins[idx]++;
  }
  return bins;
}

/** Read per-band min/max from GDAL_METADATA tags if the COG carries them.
 * GDAL stats don't include histograms, so this returns stats with
 * empty bin arrays — the coarsest-overview pass populates them. */
function fromGdalMetadata(tiff: GeoTIFF): AutoStats {
  const stored = tiff.storedStats;
  if (!stored) return NULL_STATS;
  const perBand = new Map<number, BandStats>();
  for (const [band, stats] of stored) {
    if (stats.min !== null && stats.max !== null) {
      perBand.set(band, {
        min: stats.min,
        max: stats.max,
        histogram: new Array<number>(HISTOGRAM_BINS).fill(0),
      });
    }
  }
  if (perBand.size === 0) return NULL_STATS;
  return { perBand, global: averageStats([...perBand.values()]) };
}

/** Upper bound on tiles read from the coarsest IFD during auto-stats. For
 * properly-pyramided COGs the coarsest level is just a few tiles and the
 * cap never trips. For COGs without a deep overview pyramid (so the
 * coarsest is the primary at full size), the cap keeps layer-load from
 * trying to download the entire image. */
export const MAX_SAMPLE_TILES = 64;

function* iterBand(arr: RasterArray, b: number): Generator<number> {
  if (arr.layout === 'band-separate') {
    const data = arr.bands[b];
    for (let i = 0; i < data.length; i++) yield data[i] as number;
  } else {
    const data = arr.data;
    for (let i = b; i < data.length; i += arr.count) yield data[i] as number;
  }
}

/** Pick which tiles of the coarsest IFD to read. Below the cap we read all
 * of them for an exact min/max; above the cap we fall back to a 3×3
 * spatial sample (corners + edge midpoints + center, deduplicated). */
export function pickSampleCoords(grid: {
  x: number;
  y: number;
}): Array<[number, number]> {
  if (grid.x <= 0 || grid.y <= 0) return [];
  if (grid.x * grid.y <= MAX_SAMPLE_TILES) {
    const out: Array<[number, number]> = [];
    for (let y = 0; y < grid.y; y++) {
      for (let x = 0; x < grid.x; x++) {
        out.push([x, y]);
      }
    }
    return out;
  }
  const xs = Array.from(
    new Set([0, Math.floor(grid.x / 2), grid.x - 1]),
  ).filter((n) => n >= 0 && n < grid.x);
  const ys = Array.from(
    new Set([0, Math.floor(grid.y / 2), grid.y - 1]),
  ).filter((n) => n >= 0 && n < grid.y);
  const out: Array<[number, number]> = [];
  for (const y of ys) {
    for (const x of xs) {
      out.push([x, y]);
    }
  }
  return out;
}

/** Read author-supplied per-band min/max from GDAL_METADATA. Returns
 * null when the tag is absent or contains no usable ranges. Used to
 * anchor histogram bin edges in {@link fromSampledTiles} so we trust
 * the author's range instead of deriving it from a sample. */
function readGdalRanges(
  tiff: GeoTIFF,
): Map<number, { min: number; max: number }> | null {
  const stored = tiff.storedStats;
  if (!stored) return null;
  const out = new Map<number, { min: number; max: number }>();
  for (const [band, stats] of stored) {
    if (stats.min !== null && stats.max !== null && stats.min < stats.max) {
      out.set(band, { min: stats.min, max: stats.max });
    }
  }
  return out.size > 0 ? out : null;
}

/** Snapshot the in-progress per-band stats so observers see fresh refs
 * and re-render. Cheap: HISTOGRAM_BINS numbers per band, ~handful of
 * bands. */
function snapshotStats(perBand: Map<number, BandStats>): AutoStats {
  const out = new Map<number, BandStats>();
  for (const [k, v] of perBand) {
    out.set(k, { min: v.min, max: v.max, histogram: [...v.histogram] });
  }
  return { perBand: out, global: averageStats([...out.values()]) };
}

/** Streaming variant: known bin edges from GDAL priors mean we can bin
 * each tile as it arrives, drop the tile's array immediately, and emit
 * a partial AutoStats so the histogram chart fills in tile-by-tile.
 * Bands not present in `priors` are omitted from the stats. */
async function streamingFromTiles(
  source: GeoTIFF | Overview,
  coords: Array<[number, number]>,
  priors: ReadonlyMap<number, { min: number; max: number }>,
  signal: AbortSignal,
  onProgress: ((partial: AutoStats) => void) | undefined,
): Promise<AutoStats> {
  const perBand = new Map<number, BandStats>();
  let initialized = false;

  for (const [x, y] of coords) {
    if (signal.aborted) return NULL_STATS;
    const tile = await source.fetchTile(x, y, { signal, boundless: false });
    const arr = tile.array;

    if (!initialized) {
      for (let b = 0; b < arr.count; b++) {
        const prior = priors.get(b + 1);
        if (!prior) continue;
        perBand.set(b + 1, {
          min: prior.min,
          max: prior.max,
          histogram: new Array<number>(HISTOGRAM_BINS).fill(0),
        });
      }
      initialized = true;
      if (perBand.size === 0) return NULL_STATS;
    }

    for (const [band, stats] of perBand) {
      const b = band - 1;
      if (b < 0 || b >= arr.count) continue;
      const range = stats.max - stats.min;
      if (range <= 0) continue;
      const scale = HISTOGRAM_BINS / range;
      for (const v of iterBand(arr, b)) {
        if (arr.nodata !== null && v === arr.nodata) continue;
        if (!Number.isFinite(v)) continue;
        let idx = Math.floor((v - stats.min) * scale);
        if (idx < 0) idx = 0;
        if (idx >= HISTOGRAM_BINS) idx = HISTOGRAM_BINS - 1;
        stats.histogram[idx]++;
      }
    }

    if (onProgress && !signal.aborted) onProgress(snapshotStats(perBand));
  }

  if (perBand.size === 0) return NULL_STATS;
  return snapshotStats(perBand);
}

/** Batch variant: no priors → unknown bin edges → must hold all tile
 * arrays in memory, run min/max scan (pass 1) then histogram bin (pass
 * 2). Cannot emit progressive snapshots because bin edges aren't stable
 * until pass 1 finishes. */
async function batchFromTiles(
  source: GeoTIFF | Overview,
  coords: Array<[number, number]>,
  signal: AbortSignal,
): Promise<AutoStats> {
  const tiles: RasterArray[] = [];
  for (const [x, y] of coords) {
    if (signal.aborted) return NULL_STATS;
    const tile = await source.fetchTile(x, y, { signal, boundless: false });
    tiles.push(tile.array);
  }
  if (signal.aborted || tiles.length === 0) return NULL_STATS;

  const bandCount = tiles[0].count;
  const perBand = new Map<number, BandStats>();
  for (let b = 0; b < bandCount; b++) {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let any = false;
    for (const arr of tiles) {
      for (const v of iterBand(arr, b)) {
        if (arr.nodata !== null && v === arr.nodata) continue;
        if (!Number.isFinite(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
        any = true;
      }
    }
    if (!any || !(min < max)) continue;

    const histogram = buildHistogram(
      (function* () {
        for (const arr of tiles) {
          for (const v of iterBand(arr, b)) {
            if (arr.nodata !== null && v === arr.nodata) continue;
            if (!Number.isFinite(v)) continue;
            yield v;
          }
        }
      })(),
      min,
      max,
      null,
    );
    perBand.set(b + 1, { min, max, histogram });
  }
  if (perBand.size === 0) return NULL_STATS;
  return { perBand, global: averageStats([...perBand.values()]) };
}

/** Sample tiles from the coarsest IFD to compute per-band min/max and a
 * 128-bin histogram per band. Reads every tile of the coarsest level
 * (which is, by definition, the smallest), capped at
 * {@link MAX_SAMPLE_TILES}; degrades to a 3×3 spatial sample beyond the
 * cap so a COG without a proper overview pyramid doesn't trigger a full
 * download. Falls back to the primary image when the COG has no overviews
 * at all (e.g. a single-tile slice from a pre-sliced pyramid like
 * EOxCloudless's `/z/x/y.tif` outputs).
 *
 * Dispatches to streaming (priors known) or batch (priors unknown).
 * Streaming emits partial AutoStats via `onProgress` after each tile so
 * the histogram UI fills in incrementally. */
async function fromSampledTiles(
  tiff: GeoTIFF,
  signal: AbortSignal,
  priors: ReadonlyMap<number, { min: number; max: number }> | null,
  onProgress: ((partial: AutoStats) => void) | undefined,
): Promise<AutoStats> {
  const ovs = tiff.overviews;
  const source: GeoTIFF | Overview =
    ovs.length > 0 ? ovs[ovs.length - 1] : tiff;
  const coords = pickSampleCoords(source.tileCount);
  if (coords.length === 0) return NULL_STATS;

  if (priors) {
    return streamingFromTiles(source, coords, priors, signal, onProgress);
  }
  return batchFromTiles(source, coords, signal);
}

/** Compute auto-stats for a GeoTIFF. Prefers author-supplied min/max
 * from GDAL_METADATA when present (cheap, exact, anchors the rescale
 * window to whatever the author intended) and uses sampled tiles to
 * populate the histogram bins around that range. Without GDAL stats,
 * derives min/max from the same samples in a two-pass scan. Falls back
 * to GDAL min/max with empty histograms only if sampling fails entirely.
 *
 * When `onProgress` is supplied AND GDAL priors are present, the
 * histogram fills in tile-by-tile and `onProgress` fires with a partial
 * AutoStats snapshot after each tile is binned. Without priors, the
 * callback never fires (bin edges aren't stable until both passes
 * finish); the caller still receives the final stats via the resolved
 * Promise. Caller guards against stale results. */
export async function computeAutoStats(
  tiff: GeoTIFF,
  signal: AbortSignal,
  onProgress?: (partial: AutoStats) => void,
): Promise<AutoStats> {
  const priors = readGdalRanges(tiff);
  const sampled = await fromSampledTiles(tiff, signal, priors, onProgress);
  if (sampled.perBand) return sampled;
  // Last-resort fallback: GDAL stats without histograms.
  return fromGdalMetadata(tiff);
}
