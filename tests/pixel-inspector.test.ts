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
    getCanvasContainer: () => canvas,
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

  describe('on a mosaic VRT layer', () => {
    const bounds = (west: number, east: number) => ({
      west,
      south: 0,
      east,
      north: 10,
    });

    /** A two-member mosaic layer split at lng 0. */
    function makeMosaicTarget() {
      const west = { url: 'a.tif' } as unknown as RasterLayer['geotiff'];
      const east = { url: 'b.tif' } as unknown as RasterLayer['geotiff'];
      const target = makeTarget({
        geotiff: west,
        members: [
          { url: 'a.tif', geotiff: west!, bounds: bounds(-10, 0) },
          { url: 'b.tif', geotiff: east!, bounds: bounds(0, 10) },
        ],
      });
      return { target, west, east };
    }

    it('reads the member whose extent covers the click', async () => {
      const { map, emit } = makeFakeMap();
      const { target, east } = makeMosaicTarget();
      const readPixelValues = vi.fn(async () => reading);
      const insp = new PixelInspector(map, () => target, {
        readPixelValues,
        createPopup: makePopup,
      });

      insp.enable();
      emit('click', click(5, 5));
      await flush();

      // Only the covering member is fetched — not every member of the mosaic.
      expect(readPixelValues).toHaveBeenCalledTimes(1);
      expect(readPixelValues).toHaveBeenCalledWith(east, [5, 5], expect.anything());
    });

    it('falls through to the next candidate when a member misses its grid', async () => {
      // Bounds only bound a member's extent; the point can still fall outside
      // its pixel grid, which readPixelValues reports as null.
      const { map, emit } = makeFakeMap();
      const { target, west, east } = makeMosaicTarget();
      // Not yet reported → stays a candidate rather than being skipped.
      target.members![0].bounds = null;
      const readPixelValues = vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(reading);
      const insp = new PixelInspector(map, () => target, {
        readPixelValues,
        createPopup: makePopup,
      });

      insp.enable();
      emit('click', click(5, 5));
      await flush();

      // Topmost first: the later member is tried before the earlier one.
      expect(readPixelValues).toHaveBeenCalledTimes(2);
      expect(readPixelValues.mock.calls[0][0]).toBe(east);
      expect(readPixelValues.mock.calls[1][0]).toBe(west);
    });

    it('reports the topmost member where two overlap', async () => {
      // parseVrt rejects repositioning, not overlap — two sources at their
      // natural positions can still cover the same point (adjacent scenes
      // commonly do). LayerManager draws members in order, so the LAST one is
      // what the user sees, and it is what the inspector must report.
      const { map, emit } = makeFakeMap();
      const under = { id: 'under' } as unknown as RasterLayer['geotiff'];
      const over = { id: 'over' } as unknown as RasterLayer['geotiff'];
      const target = makeTarget({
        geotiff: under,
        members: [
          { url: 'under.tif', geotiff: under!, bounds: bounds(-10, 10) },
          { url: 'over.tif', geotiff: over!, bounds: bounds(-10, 10) },
        ],
      });
      const readPixelValues = vi.fn(async () => reading);
      const insp = new PixelInspector(map, () => target, {
        readPixelValues,
        createPopup: makePopup,
      });

      insp.enable();
      emit('click', click(5, 5));
      await flush();

      expect(readPixelValues).toHaveBeenCalledTimes(1);
      expect(readPixelValues.mock.calls[0][0]).toBe(over);
    });

    it('reads nothing when the click falls outside every member', async () => {
      const { map, emit } = makeFakeMap();
      const { target } = makeMosaicTarget();
      const readPixelValues = vi.fn();
      const popup = makePopup();
      const insp = new PixelInspector(map, () => target, {
        readPixelValues,
        createPopup: () => popup,
      });

      insp.enable();
      emit('click', click(80, 5));
      await flush();

      expect(readPixelValues).not.toHaveBeenCalled();
      expect(popup.addTo).toHaveBeenCalledWith(map);
    });
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
