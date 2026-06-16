import { describe, expect, it } from 'vitest';
import {
  COLORMAP_OPTIONS,
  colormapDisplayName,
} from '../src/lib/raster/colormaps';

describe('colormapDisplayName', () => {
  it('restores matplotlib casing for mixed-case names', () => {
    expect(colormapDisplayName('ylorbr')).toBe('YlOrBr');
    expect(colormapDisplayName('rdbu')).toBe('RdBu');
    expect(colormapDisplayName('greys')).toBe('Greys');
    expect(colormapDisplayName('pubugn')).toBe('PuBuGn');
    expect(colormapDisplayName('cmrmap')).toBe('CMRmap');
  });

  it('leaves already-lowercase matplotlib names unchanged', () => {
    expect(colormapDisplayName('viridis')).toBe('viridis');
    expect(colormapDisplayName('jet')).toBe('jet');
    expect(colormapDisplayName('terrain')).toBe('terrain');
  });

  it('keeps the renderer value lowercase while labeling with display casing', () => {
    const rdbu = COLORMAP_OPTIONS.find((o) => o.name === 'rdbu');
    expect(rdbu).toBeDefined();
    expect(rdbu!.name).toBe('rdbu');
    expect(rdbu!.label).toBe('RdBu');
  });
});
