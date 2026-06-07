import { describe, expect, it } from 'vitest';
import { SettingsSection } from '../src/lib/ui/SettingsSection';
import type { RasterLayer } from '../src/lib/state/RasterLayer';

/** A minimal still-loading layer: render() shows the header (with the inspect
 * button) and a "Loading…" body without building the full settings UI. */
function loadingLayer(): RasterLayer {
  return {
    name: 'cog.tif',
    loading: true,
    error: null,
  } as RasterLayer;
}

const findToggle = (section: SettingsSection) =>
  section.el.querySelector<HTMLButtonElement>('[aria-label="inspect-toggle"]');

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
