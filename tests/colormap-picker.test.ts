import { describe, expect, it, vi } from 'vitest';
import { ColormapPicker } from '../src/lib/ui/ColormapPicker';
import { COLORMAP_NAMES } from '../src/lib/raster/colormaps';

/** The colormap `<select>` the picker renders. */
function optionsOf(picker: ColormapPicker): string[] {
  const select = picker.el.querySelector<HTMLSelectElement>('select')!;
  return Array.from(select.options, (o) => o.value);
}

describe('ColormapPicker allowed set', () => {
  it('offers every colormap when no allowed set is given', () => {
    const picker = new ColormapPicker({ value: 'viridis', onChange: vi.fn() });
    expect(optionsOf(picker)).toHaveLength(COLORMAP_NAMES.length);
  });

  it('narrows the list to the engine-supported colormaps', () => {
    // Mirrors the cog-tiler-wasm engine, which renders a tile black for any
    // colormap it does not know — so the picker must not offer those.
    const allowed = new Set(['viridis', 'turbo', 'gray']);
    const picker = new ColormapPicker({
      value: 'turbo',
      onChange: vi.fn(),
      allowed,
    });
    const options = optionsOf(picker);
    expect(options.sort()).toEqual(['gray', 'turbo', 'viridis']);
    // A colormap outside the set is not offered.
    expect(options).not.toContain('jet');
  });

  it('keeps an unsupported active colormap listed, flagged', () => {
    // A layer styled on another engine keeps its colormap; the select must
    // still reflect it rather than silently snapping to another entry.
    const allowed = new Set(['viridis', 'turbo']);
    const picker = new ColormapPicker({
      value: 'jet',
      onChange: vi.fn(),
      allowed,
    });
    const select = picker.el.querySelector<HTMLSelectElement>('select')!;
    expect(select.value).toBe('jet');
    const flagged = Array.from(select.options).find((o) => o.value === 'jet')!;
    expect(flagged.label.toLowerCase()).toContain('not supported');
  });

  it('still offers the embedded palette alongside a narrowed set', () => {
    // jsdom has no ImageData constructor; the picker only reads these fields.
    const palette = {
      data: new Uint8ClampedArray(256 * 4),
      width: 256,
      height: 1,
      colorSpace: 'srgb',
    } as unknown as ImageData;
    const picker = new ColormapPicker({
      value: 'palette',
      onChange: vi.fn(),
      palette,
      allowed: new Set(['viridis']),
    });
    expect(optionsOf(picker)).toEqual(['palette', 'viridis']);
  });
});
