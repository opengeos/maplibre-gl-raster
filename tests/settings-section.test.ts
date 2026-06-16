import { describe, expect, it } from 'vitest';
import { SettingsSection } from '../src/lib/ui/SettingsSection';
import { createLayerState, type RasterLayer } from '../src/lib/state/RasterLayer';
import type { RasterLayerState } from '../src/lib/core/types';

/** A minimal still-loading layer: render() shows the header (with the inspect
 * button) and a "Loading…" body without building the full settings UI. */
function loadingLayer(): RasterLayer {
  return {
    name: 'cog.tif',
    loading: true,
    error: null,
  } as RasterLayer;
}

/** A loaded single-band layer, enough for render() to build the full panel. */
function loadedSingleLayer(
  overrides: Partial<RasterLayerState> = {},
): RasterLayer {
  return {
    name: 'cog.tif',
    loading: false,
    error: null,
    bandCount: 1,
    bandNames: null,
    palette: null,
    autoStats: null,
    state: createLayerState({
      mode: 'single',
      bands: [1],
      colormap: 'viridis',
      ...overrides,
    }),
  } as RasterLayer;
}

const findToggle = (section: SettingsSection) =>
  section.el.querySelector<HTMLButtonElement>('[aria-label="inspect-toggle"]');

const findReverse = (section: SettingsSection) =>
  section.el.querySelector<HTMLInputElement>('[aria-label="Reverse colormap"]');

describe('SettingsSection inspect toggle', () => {
  it('renders an inspect toggle when inspect hooks are provided', () => {
    const section = new SettingsSection(loadingLayer, () => {}, {
      onToggle: () => {},
      isActive: () => false,
    });
    expect(findToggle(section)).not.toBeNull();
  });

  it('omits the toggle when no inspect hooks are provided', () => {
    const section = new SettingsSection(loadingLayer, () => {});
    expect(findToggle(section)).toBeNull();
  });

  it('calls onToggle and reflects active state when clicked', () => {
    let active = false;
    const section = new SettingsSection(loadingLayer, () => {}, {
      onToggle: () => {
        active = !active;
      },
      isActive: () => active,
    });
    const btn = findToggle(section)!;

    expect(btn.getAttribute('aria-pressed')).toBe('false');
    btn.click();
    expect(active).toBe(true);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });

  it('reflects active state on render', () => {
    let active = true;
    const section = new SettingsSection(loadingLayer, () => {}, {
      onToggle: () => {},
      isActive: () => active,
    });
    expect(findToggle(section)!.getAttribute('aria-pressed')).toBe('true');

    active = false;
    section.render();
    expect(findToggle(section)!.getAttribute('aria-pressed')).toBe('false');
  });
});

describe('SettingsSection reverse colormap', () => {
  it('renders an unchecked reverse box for a single-band layer', () => {
    const layer = loadedSingleLayer({ reversed: false });
    const section = new SettingsSection(() => layer, () => {});
    section.render();
    const box = findReverse(section);
    expect(box).not.toBeNull();
    expect(box!.checked).toBe(false);
  });

  it('reflects state.reversed and patches it on toggle', () => {
    const patches: Partial<RasterLayerState>[] = [];
    const layer = loadedSingleLayer({ reversed: true });
    const section = new SettingsSection(() => layer, (p) => patches.push(p));
    section.render();
    const box = findReverse(section)!;
    expect(box.checked).toBe(true);

    box.checked = false;
    box.dispatchEvent(new Event('change'));
    expect(patches).toContainEqual({ reversed: false });
  });

  it('omits the reverse box in RGB mode', () => {
    const layer = loadedSingleLayer({ mode: 'rgb', bands: [1, 2, 3] });
    const section = new SettingsSection(() => layer, () => {});
    section.render();
    expect(findReverse(section)).toBeNull();
  });
});

const findColorbar = (section: SettingsSection) =>
  section.el.querySelector<HTMLInputElement>('[aria-label="Show colorbar"]');

describe('SettingsSection colorbar', () => {
  it('renders an unchecked colorbar toggle for a single-band layer', () => {
    const layer = loadedSingleLayer();
    const section = new SettingsSection(() => layer, () => {});
    section.render();
    const box = findColorbar(section);
    expect(box).not.toBeNull();
    expect(box!.checked).toBe(false);
    // The sub-controls are hidden until the legend is enabled.
    expect(
      section.el.querySelector('[aria-label="colorbar-position"]'),
    ).toBeNull();
  });

  it('enables the legend on toggle', () => {
    const patches: Partial<RasterLayerState>[] = [];
    const layer = loadedSingleLayer();
    const section = new SettingsSection(() => layer, (p) => patches.push(p));
    section.render();
    const box = findColorbar(section)!;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    expect(patches).toContainEqual({ colorbar: { visible: true } });
  });

  it('shows title/units/orientation/position when visible', () => {
    const layer = loadedSingleLayer({ colorbar: { visible: true } });
    const section = new SettingsSection(() => layer, () => {});
    section.render();
    expect(findColorbar(section)!.checked).toBe(true);
    expect(section.el.querySelector('[aria-label="colorbar-title"]')).not.toBeNull();
    expect(section.el.querySelector('[aria-label="colorbar-units"]')).not.toBeNull();
    expect(
      section.el.querySelector('[aria-label="colorbar-orientation"]'),
    ).not.toBeNull();
    expect(
      section.el.querySelector('[aria-label="colorbar-position"]'),
    ).not.toBeNull();
  });

  it('patches a field while preserving visibility', () => {
    const patches: Partial<RasterLayerState>[] = [];
    const layer = loadedSingleLayer({ colorbar: { visible: true } });
    const section = new SettingsSection(() => layer, (p) => patches.push(p));
    section.render();
    const pos = section.el.querySelector<HTMLSelectElement>(
      '[aria-label="colorbar-position"]',
    )!;
    pos.value = 'top-right';
    pos.dispatchEvent(new Event('change'));
    expect(patches).toContainEqual({
      colorbar: { visible: true, position: 'top-right' },
    });
  });

  it('omits the colorbar controls in RGB mode', () => {
    const layer = loadedSingleLayer({ mode: 'rgb', bands: [1, 2, 3] });
    const section = new SettingsSection(() => layer, () => {});
    section.render();
    expect(findColorbar(section)).toBeNull();
  });
});
