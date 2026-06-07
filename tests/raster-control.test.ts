import { describe, expect, it } from 'vitest';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { RasterControl } from '../src/lib/core/RasterControl';

function makeFakeMap(): MapLibreMap {
  const container = document.createElement('div');
  document.body.appendChild(container);
  return {
    getContainer: () => container,
    addControl: () => undefined,
    removeControl: () => undefined,
    on: () => undefined,
    off: () => undefined,
  } as unknown as MapLibreMap;
}

describe('RasterControl panel sizing', () => {
  it('caps the panel max-height to the space inside the map container', () => {
    const control = new RasterControl();
    const map = makeFakeMap();
    const element = control.onAdd(map);
    map.getContainer().appendChild(element);

    control.expand();

    const panel = (
      control as unknown as { _panel?: HTMLElement }
    )._panel;
    expect(panel).toBeDefined();
    // jsdom reports zero-sized rects, so the available space resolves to the
    // 160px floor; the stylesheet caps stay in the min() so a real layout
    // can never exceed them either.
    expect(panel!.style.maxHeight).toBe('min(80vh, 720px, 160px)');

    control.onRemove();
  });
});

describe('RasterControl pixel inspector wiring', () => {
  type Internals = {
    _inspector?: { enable: () => void; enabled: boolean };
    _state: { collapsed: boolean };
  };

  it('creates a pixel inspector when added to the map', () => {
    const control = new RasterControl({ collapsed: false });
    const map = makeFakeMap();
    map.getContainer().appendChild(control.onAdd(map));

    expect((control as unknown as Internals)._inspector).toBeDefined();

    control.onRemove();
  });

  it('collapses on an outside click when not inspecting', () => {
    const control = new RasterControl({ collapsed: false });
    const map = makeFakeMap();
    map.getContainer().appendChild(control.onAdd(map));
    control.expand();

    document.body.click();

    expect((control as unknown as Internals)._state.collapsed).toBe(true);
    control.onRemove();
  });

  it('stays open on an outside click while inspecting', () => {
    const control = new RasterControl({ collapsed: false });
    const map = makeFakeMap();
    map.getContainer().appendChild(control.onAdd(map));
    control.expand();
    (control as unknown as Internals)._inspector!.enable();

    document.body.click();

    expect((control as unknown as Internals)._state.collapsed).toBe(false);
    control.onRemove();
  });
});
