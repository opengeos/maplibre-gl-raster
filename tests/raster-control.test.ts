import { describe, expect, it, vi } from 'vitest';
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
    getZoom: () => 0,
    setLayerZoomRange: () => undefined,
    // Native raster-layer surface touched by the cog-tiler-wasm engine.
    isStyleLoaded: () => true,
    getSource: () => undefined,
    getLayer: () => undefined,
    addSource: () => undefined,
    addLayer: () => undefined,
    removeLayer: () => undefined,
    removeSource: () => undefined,
    setPaintProperty: () => undefined,
    moveLayer: () => undefined,
    once: () => undefined,
  } as unknown as MapLibreMap;
}

describe('RasterControl panel sizing', () => {
  it('caps the panel max-height to the space inside the map container', () => {
    const control = new RasterControl();
    const map = makeFakeMap();
    const element = control.onAdd(map);
    map.getContainer().appendChild(element);

    control.expand();

    const panel = (control as unknown as { _panel?: HTMLElement })._panel;
    expect(panel).toBeDefined();
    // jsdom reports zero-sized rects, so the available space resolves to the
    // 160px floor; the stylesheet caps stay in the min() so a real layout
    // can never exceed them either.
    expect(panel!.style.maxHeight).toBe('min(80vh, 720px, 160px)');

    control.onRemove();
  });
});

describe('RasterControl rendering engine', () => {
  it('defaults to the maplibre-gl-raster engine', () => {
    const control = new RasterControl();
    expect(control.getEngine()).toBe('maplibre-gl-raster');
  });

  it('honors the configured initial engine', () => {
    const control = new RasterControl({ engine: 'cog-tiler-wasm' });
    expect(control.getEngine()).toBe('cog-tiler-wasm');
    const map = makeFakeMap();
    map.getContainer().appendChild(control.onAdd(map));
    expect(control.getEngine()).toBe('cog-tiler-wasm');
    control.onRemove();
  });

  it('renders an engine selector reflecting the active engine', () => {
    const control = new RasterControl({ collapsed: false });
    const map = makeFakeMap();
    map.getContainer().appendChild(control.onAdd(map));

    const panel = (control as unknown as { _panel?: HTMLElement })._panel!;
    const selector = panel.querySelector<HTMLSelectElement>(
      'select[aria-label="render-engine"]',
    );
    expect(selector).not.toBeNull();
    expect(selector!.value).toBe('maplibre-gl-raster');
    expect(
      panel.querySelector('button[aria-label="Rendering engine help"]'),
    ).not.toBeNull();

    control.onRemove();
  });

  it('shows rendering engine help when the info button is clicked', () => {
    const control = new RasterControl({ collapsed: false });
    const map = makeFakeMap();
    map.getContainer().appendChild(control.onAdd(map));
    const panel = (control as unknown as { _panel?: HTMLElement })._panel!;
    const helpButton = panel.querySelector<HTMLButtonElement>(
      'button[aria-label="Rendering engine help"]',
    )!;
    const tooltip = panel.querySelector<HTMLElement>('.mlr-tooltip')!;

    expect(tooltip.hidden).toBe(true);
    helpButton.click();
    expect(tooltip.hidden).toBe(false);
    expect(tooltip.textContent).toContain('deck.gl GPU pipeline');
    expect(helpButton.getAttribute('aria-expanded')).toBe('true');

    control.onRemove();
  });

  it('switches engines via the selector and the public API in sync', () => {
    const control = new RasterControl({ collapsed: false });
    const map = makeFakeMap();
    map.getContainer().appendChild(control.onAdd(map));
    const selector = (
      control as unknown as { _panel?: HTMLElement }
    )._panel!.querySelector<HTMLSelectElement>(
      'select[aria-label="render-engine"]',
    )!;

    // User-driven change through the <select>.
    selector.value = 'cog-tiler-wasm';
    selector.dispatchEvent(new Event('change'));
    expect(control.getEngine()).toBe('cog-tiler-wasm');

    // Programmatic change reflects back onto the selector.
    control.setEngine('maplibre-gl-raster');
    expect(control.getEngine()).toBe('maplibre-gl-raster');
    expect(selector.value).toBe('maplibre-gl-raster');

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

  it('toggles inspect mode through the public API', () => {
    const control = new RasterControl({ collapsed: false });
    const map = makeFakeMap();
    map.getContainer().appendChild(control.onAdd(map));

    expect(control.isInspecting()).toBe(false);

    control.setInspect(true);
    expect(control.isInspecting()).toBe(true);
    expect((control as unknown as Internals)._inspector!.enabled).toBe(true);

    // Idempotent: enabling again stays enabled.
    control.setInspect(true);
    expect(control.isInspecting()).toBe(true);

    control.setInspect(false);
    expect(control.isInspecting()).toBe(false);

    control.onRemove();
  });

  it('reflects programmatic inspect toggling on the panel button', () => {
    const control = new RasterControl({ collapsed: false });
    const map = makeFakeMap();
    map.getContainer().appendChild(control.onAdd(map));
    const panel = (control as unknown as { _panel?: HTMLElement })._panel!;
    const button = panel.querySelector<HTMLButtonElement>(
      'button[aria-label="inspect-toggle"]',
    )!;
    expect(button).not.toBeNull();
    expect(button.getAttribute('aria-pressed')).toBe('false');

    control.setInspect(true);
    expect(button.classList.contains('active')).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('true');

    control.setInspect(false);
    expect(button.classList.contains('active')).toBe(false);
    expect(button.getAttribute('aria-pressed')).toBe('false');

    control.onRemove();
  });

  it('reads a managed layer through the public API', async () => {
    const control = new RasterControl();
    const layer = { id: 'raster-1' };
    const reading = {
      lngLat: [-84, 35] as [number, number],
      col: 3,
      row: 4,
      bands: [{ index: 1, name: null, value: 12, isNodata: false }],
    };
    const read = vi.fn(async (target: typeof layer | null) =>
      target ? reading : null,
    );
    const internals = control as unknown as {
      _layerManager: { getLayer: (id: string) => typeof layer | null };
      _inspector: { read: typeof read };
    };
    internals._layerManager = {
      getLayer: (id) => (id === layer.id ? layer : null),
    };
    internals._inspector = { read };

    await expect(control.readRasterPixel(layer.id, [-84, 35])).resolves.toEqual(
      reading,
    );
    expect(read).toHaveBeenCalledWith(layer, [-84, 35], undefined);
    await expect(
      control.readRasterPixel('missing', [-84, 35]),
    ).resolves.toBeNull();
  });
});
