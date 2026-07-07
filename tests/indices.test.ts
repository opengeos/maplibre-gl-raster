import { describe, expect, it } from 'vitest';
import {
  CUSTOM_INDEX_ID,
  CUSTOM_NORMALIZED_DIFFERENCE,
  guessBandForRole,
  indexById,
  NORMALIZED_DIFFERENCE_INDICES,
} from '../src/lib/raster/indices';

describe('indexById', () => {
  it('resolves a named preset', () => {
    expect(indexById('ndvi')?.label).toBe('NDVI');
  });

  it('resolves the custom preset', () => {
    expect(indexById(CUSTOM_INDEX_ID)).toBe(CUSTOM_NORMALIZED_DIFFERENCE);
  });

  it('returns null for unknown / missing ids', () => {
    expect(indexById('nope')).toBeNull();
    expect(indexById(undefined)).toBeNull();
  });

  it('every preset uses an id that round-trips', () => {
    for (const preset of NORMALIZED_DIFFERENCE_INDICES) {
      expect(indexById(preset.id)).toBe(preset);
    }
  });
});

describe('guessBandForRole', () => {
  const names = new Map<number, string>([
    [1, 'Blue'],
    [2, 'Green'],
    [3, 'Red'],
    [4, 'NIR'],
    [5, 'SWIR1'],
    [6, 'SWIR2'],
  ]);

  it('matches a role by name, case-insensitively', () => {
    expect(guessBandForRole('NIR', names)).toBe(4);
    expect(guessBandForRole('Red', names)).toBe(3);
    expect(guessBandForRole('SWIR1', names)).toBe(5);
  });

  it('recognizes Sentinel-2 band-number aliases', () => {
    const s2 = new Map<number, string>([
      [1, 'B04'],
      [2, 'B08'],
    ]);
    expect(guessBandForRole('Red', s2)).toBe(1);
    expect(guessBandForRole('NIR', s2)).toBe(2);
  });

  it('returns null when no name matches or names are absent', () => {
    expect(guessBandForRole('SWIR1', new Map([[1, 'Panchromatic']]))).toBeNull();
    expect(guessBandForRole('NIR', null)).toBeNull();
  });
});
