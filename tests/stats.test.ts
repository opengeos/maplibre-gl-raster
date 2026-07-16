import { describe, expect, it } from 'vitest';
import {
  MAX_SAMPLE_TILES,
  mergeAutoStats,
  mergeBandStats,
  percentileFromHistogram,
  pickSampleCoords,
  type AutoStats,
  type BandStats,
} from '../src/lib/raster/stats';

describe('pickSampleCoords', () => {
  it('enumerates every tile when the grid fits under the cap', () => {
    const coords = pickSampleCoords({ x: 4, y: 3 });
    expect(coords).toHaveLength(12);
    expect(new Set(coords.map(([x, y]) => `${x},${y}`)).size).toBe(12);
  });

  it('falls back to a 3x3 spatial sample when the grid exceeds the cap', () => {
    const big = Math.ceil(Math.sqrt(MAX_SAMPLE_TILES)) + 4;
    const coords = pickSampleCoords({ x: big, y: big });
    expect(coords.length).toBeLessThanOrEqual(9);
    const mid = Math.floor(big / 2);
    const expected = new Set([
      `0,0`,
      `${mid},0`,
      `${big - 1},0`,
      `0,${mid}`,
      `${mid},${mid}`,
      `${big - 1},${mid}`,
      `0,${big - 1}`,
      `${mid},${big - 1}`,
      `${big - 1},${big - 1}`,
    ]);
    for (const [x, y] of coords) {
      expect(expected.has(`${x},${y}`)).toBe(true);
    }
  });

  it('dedupes when grid dimensions collapse the sample positions', () => {
    expect(pickSampleCoords({ x: 1, y: 1 })).toEqual([[0, 0]]);
  });

  it('returns no coordinates for an empty grid', () => {
    expect(pickSampleCoords({ x: 0, y: 5 })).toEqual([]);
    expect(pickSampleCoords({ x: 5, y: 0 })).toEqual([]);
  });
});

describe('percentileFromHistogram', () => {
  const uniform: BandStats = {
    min: 0,
    max: 128,
    histogram: new Array<number>(128).fill(1),
  };

  it('interpolates percentiles linearly across uniform bins', () => {
    expect(percentileFromHistogram(uniform, 0.5)).toBeCloseTo(64, 0);
    expect(percentileFromHistogram(uniform, 0.02)).toBeCloseTo(2.56, 1);
    expect(percentileFromHistogram(uniform, 0.98)).toBeCloseTo(125.44, 1);
  });

  it('falls back to min/max when the histogram is empty', () => {
    const empty: BandStats = {
      min: 5,
      max: 10,
      histogram: new Array<number>(128).fill(0),
    };
    expect(percentileFromHistogram(empty, 0.02)).toBe(5);
    expect(percentileFromHistogram(empty, 0.98)).toBe(10);
  });

  it('returns min for a degenerate range', () => {
    const flat: BandStats = {
      min: 7,
      max: 7,
      histogram: new Array<number>(128).fill(1),
    };
    expect(percentileFromHistogram(flat, 0.5)).toBe(7);
  });
});

/** Stats for a band whose values are spread evenly over [min, max]. */
function uniformStats(min: number, max: number, countPerBin = 10): BandStats {
  return {
    min,
    max,
    histogram: new Array<number>(128).fill(countPerBin),
  };
}

describe('mergeBandStats', () => {
  it('unions the ranges of several images', () => {
    const merged = mergeBandStats([uniformStats(0, 120), uniformStats(120, 255)])!;
    expect(merged.min).toBe(0);
    expect(merged.max).toBe(255);
  });

  it('preserves every sample when rebinning onto the wider range', () => {
    const total = (s: BandStats) => s.histogram.reduce((a, b) => a + b, 0);
    const a = uniformStats(0, 120);
    const b = uniformStats(120, 255);
    const merged = mergeBandStats([a, b])!;
    // Rebinning redistributes counts; it must never create or drop them.
    expect(total(merged)).toBe(total(a) + total(b));
  });

  it('yields percentiles spanning both images, not just the first', () => {
    // The case that matters: a mosaic whose members occupy disjoint ranges. A
    // window taken from member 1 alone would clip all of member 2.
    const merged = mergeBandStats([uniformStats(0, 120), uniformStats(120, 255)])!;
    expect(percentileFromHistogram(merged, 0.02)).toBeGreaterThan(0);
    expect(percentileFromHistogram(merged, 0.98)).toBeGreaterThan(120);
    expect(percentileFromHistogram(merged, 0.98)).toBeLessThanOrEqual(255);
  });

  it('keeps counts in the right half of the merged range', () => {
    // Member A occupies [0, 100], member B occupies [100, 200]: after merging
    // onto [0, 200] each should own its half of the bins.
    const merged = mergeBandStats([uniformStats(0, 100), uniformStats(100, 200)])!;
    const lower = merged.histogram.slice(0, 64).reduce((a, b) => a + b, 0);
    const upper = merged.histogram.slice(64).reduce((a, b) => a + b, 0);
    expect(lower).toBe(1280);
    expect(upper).toBe(1280);
  });

  it('passes a single image through untouched', () => {
    const only = uniformStats(3, 9);
    expect(mergeBandStats([only])).toBe(only);
  });

  it('ignores images with an unusable range', () => {
    const good = uniformStats(0, 10);
    const bad: BandStats = { min: NaN, max: NaN, histogram: [] };
    expect(mergeBandStats([bad, good])).toBe(good);
    expect(mergeBandStats([bad])).toBeNull();
    expect(mergeBandStats([])).toBeNull();
  });

  it('handles a degenerate (single-value) image', () => {
    const merged = mergeBandStats([uniformStats(5, 5), uniformStats(0, 10)])!;
    expect(merged.min).toBe(0);
    expect(merged.max).toBe(10);
  });
});

describe('mergeAutoStats', () => {
  const statsFor = (min: number, max: number): AutoStats => ({
    perBand: new Map([
      [1, uniformStats(min, max)],
      [2, uniformStats(min * 2, max * 2)],
    ]),
    global: uniformStats(min, max),
  });

  it('merges each band across images independently', () => {
    const merged = mergeAutoStats([statsFor(0, 100), statsFor(50, 200)]);
    expect(merged.perBand!.get(1)).toMatchObject({ min: 0, max: 200 });
    expect(merged.perBand!.get(2)).toMatchObject({ min: 0, max: 400 });
    expect(merged.global).toMatchObject({ min: 0, max: 200 });
  });

  it('keeps a band only some images carry', () => {
    const partial: AutoStats = {
      perBand: new Map([[3, uniformStats(1, 2)]]),
      global: uniformStats(1, 2),
    };
    const merged = mergeAutoStats([statsFor(0, 100), partial]);
    expect([...merged.perBand!.keys()]).toEqual([1, 2, 3]);
  });

  it('returns null stats when no image produced any', () => {
    const empty: AutoStats = { perBand: null, global: null };
    expect(mergeAutoStats([empty, empty])).toEqual({
      perBand: null,
      global: null,
    });
    expect(mergeAutoStats([])).toEqual({ perBand: null, global: null });
  });
});
