import { describe, expect, it, vi } from 'vitest';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { PixelInspector, type PopupLike } from '../src/lib/state/PixelInspector';
import type { RasterLayer } from '../src/lib/state/RasterLayer';
import type { PixelReading } from '../src/lib/raster/inspect';

/** Flush pending microtasks so an async click handler settles. */
const flush = () => new Promise((r) => setTimeout(r, 0));

function makeFakeMap() {
  const handlers: Record<string, Array<(e: unknown) => void>> = {};
  const canvas = { style: {} as CSSStyleDeclaration };
  const map = {
    on: vi.fn((ev: string, h: (e: unknown) => void) => {
      (handlers[ev] ??= []).push(h);
    }),
    off: vi.fn((ev: string, h: (e: unknown) => void) => {
      handlers[ev] = (handlers[ev] ?? []).filter((x) => x !== h);
    }),
    getCanvas: () => canvas,
  };
  return {
    map: map as unknown as MapLibreMap,
    canvas,
    emit: (ev: string, payload: unknown) =>
      (handlers[ev] ?? []).forEach((h) => h(payload)),
    handlerCount: (ev: string) => (handlers[ev] ?? []).length,
  };
}

function makePopup() {
  const popup = {
    setLngLat: vi.fn().mockReturnThis(),
    setDOMContent: vi.fn().mockReturnThis(),
    addTo: vi.fn().mockReturnThis(),
    remove: vi.fn().mockReturnThis(),
  };
  return popup as unknown as PopupLike & typeof popup;
}

function makeTarget(overrides: Partial<RasterLayer> = {}): RasterLayer {
  return {
    id: 'l1',
    name: 'cog.tif',
    geotiff: {} as RasterLayer['geotiff'],
    bandNames: null,
    loading: false,
    error: null,
    ...overrides,
  } as RasterLayer;
}

const click = (lng: number, lat: number) => ({ lngLat: { lng, lat } });

const reading: PixelReading = {
  lngLat: [3.5, 47.5],
  col: 3,
  row: 2,
  bands: [{ index: 1, name: null, value: 11, isNodata: false }],
};

describe('PixelInspector', () => {
  it('enable attaches a click listener and sets the crosshair cursor', () => {
    const { map, canvas } = makeFakeMap();
    const insp = new PixelInspector(map, () => makeTarget(), {
      readPixelValues: vi.fn(),
      createPopup: makePopup,
    });

    expect(insp.enabled).toBe(false);
    insp.enable();

    expect(insp.enabled).toBe(true);
    expect(map.on).toHaveBeenCalledWith('click', expect.any(Function));
    expect(canvas.style.cursor).toBe('crosshair');
  });

  it('disable detaches the listener, clears the cursor, and removes the popup', () => {
    const { map, canvas } = makeFakeMap();
    const popup = makePopup();
    const insp = new PixelInspector(map, () => makeTarget(), {
      readPixelValues: vi.fn(),
      createPopup: () => popup,
    });

    insp.enable();
    insp.disable();

    expect(insp.enabled).toBe(false);
    expect(map.off).toHaveBeenCalledWith('click', expect.any(Function));
    expect(canvas.style.cursor).toBe('');
    expect(popup.remove).toHaveBeenCalled();
  });

  it('toggle flips the enabled state', () => {
    const { map } = makeFakeMap();
    const insp = new PixelInspector(map, () => makeTarget(), {
      readPixelValues: vi.fn(),
      createPopup: makePopup,
    });

    insp.toggle();
    expect(insp.enabled).toBe(true);
    insp.toggle();
    expect(insp.enabled).toBe(false);
  });

  it('reads the target layer and shows a popup on click', async () => {
    const { map, emit } = makeFakeMap();
    const popup = makePopup();
    const target = makeTarget();
    const readPixelValues = vi.fn().mockResolvedValue(reading);
    const insp = new PixelInspector(map, () => target, {
      readPixelValues,
      createPopup: () => popup,
    });

    insp.enable();
    emit('click', click(3.5, 47.5));
    await flush();

    expect(readPixelValues).toHaveBeenCalledWith(
      target.geotiff,
      [3.5, 47.5],
      expect.objectContaining({ bandNames: null }),
    );
    expect(popup.setLngLat).toHaveBeenCalledWith([3.5, 47.5]);
    expect(popup.addTo).toHaveBeenCalledWith(map);
  });

  it('aborts an in-flight read when a new click arrives', async () => {
    const { map, emit } = makeFakeMap();
    const signals: AbortSignal[] = [];
    const readPixelValues = vi.fn(
      (_t: unknown, _ll: unknown, opts: { signal?: AbortSignal }) => {
        if (opts.signal) signals.push(opts.signal);
        return new Promise<PixelReading | null>(() => {});
      },
    );
    const insp = new PixelInspector(map, () => makeTarget(), {
      readPixelValues: readPixelValues as never,
      createPopup: makePopup,
    });

    insp.enable();
    emit('click', click(1, 1));
    emit('click', click(2, 2));

    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
  });

  it('does not read when there is no inspectable target', async () => {
    const { map, emit } = makeFakeMap();
    const popup = makePopup();
    const readPixelValues = vi.fn();
    const insp = new PixelInspector(map, () => null, {
      readPixelValues,
      createPopup: () => popup,
    });

    insp.enable();
    emit('click', click(3.5, 47.5));
    await flush();

    expect(readPixelValues).not.toHaveBeenCalled();
    // A message popup still appears to explain why nothing was read.
    expect(popup.addTo).toHaveBeenCalledWith(map);
  });

  it('destroy detaches the listener and removes the popup', () => {
    const { map } = makeFakeMap();
    const popup = makePopup();
    const insp = new PixelInspector(map, () => makeTarget(), {
      readPixelValues: vi.fn(),
      createPopup: () => popup,
    });

    insp.enable();
    insp.destroy();

    expect(map.off).toHaveBeenCalledWith('click', expect.any(Function));
    expect(popup.remove).toHaveBeenCalled();
  });
});
