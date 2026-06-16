import { describe, expect, it } from 'vitest';
import {
  Colorbar,
  colorbarGradientCss,
  customColorbarStops,
  type ColorbarOptions,
} from '../src/lib/core/Colorbar';
import {
  isKnownColormap,
  sampleColormapStops,
} from '../src/lib/raster/colormap-sampler';

/** Mounts a colorbar and returns its rendered root element. */
function mount(opts: ColorbarOptions) {
  const colorbar = new Colorbar(opts);
  const root = colorbar.onAdd();
  return { colorbar, root };
}

const tickText = (root: HTMLElement) =>
  [...root.querySelectorAll('.mlr-colorbar-tick')].map((t) => t.textContent);

describe('customColorbarStops', () => {
  it('returns the colors as given, or reversed', () => {
    expect(customColorbarStops(['#000', '#fff'], false)).toEqual(['#000', '#fff']);
    expect(customColorbarStops(['#000', '#fff'], true)).toEqual(['#fff', '#000']);
  });

  it('defers to colormap sampling for fewer than two colors', () => {
    expect(customColorbarStops(undefined, false)).toBeNull();
    expect(customColorbarStops(['#000'], false)).toBeNull();
  });
});

describe('colorbarGradientCss', () => {
  it('spaces stops as percentages with a direction per orientation', () => {
    expect(colorbarGradientCss(['#000000', '#ffffff'], 'horizontal')).toBe(
      'linear-gradient(to right, #000000 0%, #ffffff 100%)',
    );
    expect(colorbarGradientCss(['#000000', '#888888', '#ffffff'], 'vertical')).toBe(
      'linear-gradient(to top, #000000 0%, #888888 50%, #ffffff 100%)',
    );
  });

  it('returns an empty string when there are no stops', () => {
    expect(colorbarGradientCss([], 'horizontal')).toBe('');
  });
});

describe('Colorbar DOM', () => {
  it('renders a horizontal bar with title and evenly spaced tick labels', () => {
    const { root } = mount({
      colors: ['#000000', '#ffffff'],
      min: 0,
      max: 100,
      title: 'Elevation',
      units: 'm',
      ticks: 5,
    });
    expect(root.classList.contains('mlr-colorbar-horizontal')).toBe(true);
    expect(root.querySelector('.mlr-colorbar-title')?.textContent).toBe('Elevation');
    expect(tickText(root)).toEqual(['0 m', '25 m', '50 m', '75 m', '100 m']);
    expect(root.querySelector('.mlr-colorbar-bar')).not.toBeNull();
  });

  it('aligns the title per titleAlign (default left)', () => {
    const left = mount({ colors: ['#000000', '#ffffff'], title: 'T' });
    expect(
      left.root.querySelector<HTMLElement>('.mlr-colorbar-title')!.style.textAlign,
    ).toBe('left');
    const centered = mount({
      colors: ['#000000', '#ffffff'],
      title: 'T',
      titleAlign: 'center',
    });
    expect(
      centered.root.querySelector<HTMLElement>('.mlr-colorbar-title')!.style
        .textAlign,
    ).toBe('center');
  });

  it('orients vertically and lists ticks max-first', () => {
    const { root } = mount({
      colors: ['#000000', '#ffffff'],
      min: 0,
      max: 10,
      orientation: 'vertical',
      ticks: 3,
    });
    expect(root.classList.contains('mlr-colorbar-vertical')).toBe(true);
    // Top-to-bottom reading order, so the max sits beside the top of the ramp.
    expect(tickText(root)).toEqual(['10', '5', '0']);
  });

  it('uses explicit tickValues over the tick count', () => {
    const { root } = mount({ colors: ['#000000', '#ffffff'], tickValues: [1, 2.5, 9] });
    expect(tickText(root)).toEqual(['1', '2.5', '9']);
  });

  it('exposes the configured corner and defaults to bottom-right', () => {
    expect(new Colorbar().getDefaultPosition()).toBe('bottom-right');
    expect(new Colorbar({ position: 'top-left' }).getDefaultPosition()).toBe('top-left');
  });

  it('merges options and re-renders on update()', () => {
    const { colorbar, root } = mount({ colors: ['#000000', '#ffffff'], title: 'A' });
    colorbar.update({ title: 'B', orientation: 'vertical' });
    expect(root.querySelector('.mlr-colorbar-title')?.textContent).toBe('B');
    expect(root.classList.contains('mlr-colorbar-vertical')).toBe(true);
  });
});

describe('colormap sampler guards', () => {
  it('knows its named colormaps', () => {
    expect(isKnownColormap('viridis')).toBe(true);
    expect(isKnownColormap('VIRIDIS')).toBe(true);
    expect(isKnownColormap('definitely-not-a-colormap')).toBe(false);
  });

  it('returns no stops for an unknown name or too few steps', async () => {
    expect(await sampleColormapStops('definitely-not-a-colormap', 8)).toEqual([]);
    expect(await sampleColormapStops('viridis', 1)).toEqual([]);
  });
});
