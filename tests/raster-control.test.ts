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
