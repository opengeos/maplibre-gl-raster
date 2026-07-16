import { Popup, type Map as MapLibreMap, type MapMouseEvent } from 'maplibre-gl';
import type { GeoTIFF } from '@developmentseed/geotiff';
import { readPixelValues, type PixelReading } from '../raster/inspect';
import { el } from '../ui/dom';
import { imagesAt, type RasterLayer } from './RasterLayer';

/** The slice of maplibre-gl's Popup the inspector drives. Lets tests inject a
 * lightweight fake instead of a real popup. */
export interface PopupLike {
  setLngLat(lngLat: [number, number]): PopupLike;
  setDOMContent(node: Node): PopupLike;
  addTo(map: MapLibreMap): PopupLike;
  remove(): PopupLike;
}

/** Injectable collaborators, overridable in unit tests. */
export interface PixelInspectorDeps {
  readPixelValues: typeof readPixelValues;
  createPopup: () => PopupLike;
}

const DEFAULT_DEPS: PixelInspectorDeps = {
  readPixelValues,
  createPopup: () =>
    new Popup({
      closeButton: true,
      closeOnClick: false,
      className: 'mlr-inspect-popup',
      maxWidth: '280px',
    }) as unknown as PopupLike,
};

/** Format a coordinate component to a compact fixed precision. */
function fmtCoord(n: number): string {
  return n.toFixed(5);
}

/** Format a raw sample value: integers verbatim, floats to a few significant
 * digits, and NaN / Infinity passed through as-is. */
function formatValue(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v)) return String(v);
  return Math.abs(v) >= 1 ? Number(v.toFixed(3)).toString() : v.toPrecision(4);
}

/** Why a click could not be inspected, for the message popup. */
function messageFor(target: RasterLayer | null): string {
  if (!target) return 'Select a raster layer to inspect.';
  if (target.error) return 'Layer failed to load.';
  return 'Layer is still loading…';
}

/**
 * Drives "inspect mode": while enabled, clicking the map reads the raw source
 * values of every band of the target layer at that location and shows them in
 * a popup anchored at the click. The map and a target-layer selector are
 * supplied by the owner ({@link RasterControl}); the actual pixel read lives in
 * {@link readPixelValues}.
 */
export class PixelInspector {
  private _map: MapLibreMap;
  private _getTarget: () => RasterLayer | null;
  private _deps: PixelInspectorDeps;
  private _enabled = false;
  private _popup: PopupLike | null;
  private _abort: AbortController | null = null;

  /**
   * @param map - The MapLibre GL map to listen on
   * @param getTarget - Returns the layer to inspect (the current selection)
   * @param deps - Injectable collaborators for testing
   */
  constructor(
    map: MapLibreMap,
    getTarget: () => RasterLayer | null,
    deps?: Partial<PixelInspectorDeps>,
  ) {
    this._map = map;
    this._getTarget = getTarget;
    this._deps = { ...DEFAULT_DEPS, ...deps };
    // One reusable popup for the inspector's lifetime.
    this._popup = this._deps.createPopup();
  }

  /** Whether inspect mode is currently active. */
  get enabled(): boolean {
    return this._enabled;
  }

  /** Activates inspect mode: listens for map clicks and shows a crosshair. */
  enable(): void {
    if (this._enabled) return;
    this._enabled = true;
    this._map.on('click', this._onClick);
    this._setCursor('crosshair');
  }

  /** Deactivates inspect mode and dismisses the popup. */
  disable(): void {
    if (!this._enabled) return;
    this._enabled = false;
    this._map.off('click', this._onClick);
    this._setCursor('');
    this._abort?.abort();
    this._abort = null;
    this._popup?.remove();
  }

  /** Flips inspect mode on or off. */
  toggle(): void {
    if (this._enabled) this.disable();
    else this.enable();
  }

  /** Tears down listeners and the popup. */
  destroy(): void {
    this._map.off('click', this._onClick);
    this._setCursor('');
    this._abort?.abort();
    this._abort = null;
    this._popup?.remove();
    this._popup = null;
    this._enabled = false;
  }

  private _onClick = (e: MapMouseEvent): void => {
    const lngLat: [number, number] = [e.lngLat.lng, e.lngLat.lat];
    // Cancel any read still in flight from a previous click.
    this._abort?.abort();
    this._abort = null;

    const target = this._getTarget();
    if (!target || target.loading || !target.geotiff || target.error) {
      this._show(lngLat, this._messageContent(messageFor(target)));
      return;
    }

    // For a mosaic VRT layer this narrows to the member(s) covering the click;
    // an empty list means the point is outside the mosaic, which needs no read.
    const images = imagesAt(target, lngLat);
    if (images.length === 0) {
      this._show(lngLat, this._messageContent('No data at this location.'));
      return;
    }

    const controller = new AbortController();
    this._abort = controller;
    this._show(lngLat, this._messageContent('Reading…'));

    this._readFirst(images, lngLat, controller.signal, target.bandNames)
      .then((reading) => {
        if (controller.signal.aborted) return;
        this._show(
          lngLat,
          reading
            ? this._readingContent(reading, target)
            : this._messageContent('No data at this location.'),
        );
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        this._show(lngLat, this._messageContent('Could not read pixel value.'));
      });
  };

  /**
   * Reads `lngLat` from the first candidate image that actually covers it.
   *
   * `readPixelValues` resolves null when the point falls outside an image's
   * pixel grid, which is the authoritative test — a mosaic member's bounds only
   * bound its extent, and the point can still miss its grid (or land on a
   * member that has not reported bounds yet). So candidates are tried in order
   * and the first hit wins. {@link imagesAt} hands them over topmost first,
   * which is what makes that correct where members overlap: the reported value
   * is the one actually drawn at the click.
   *
   * @returns The topmost reading, or null when no candidate covers the point
   */
  private async _readFirst(
    images: GeoTIFF[],
    lngLat: [number, number],
    signal: AbortSignal,
    bandNames: Map<number, string> | null,
  ): Promise<PixelReading | null> {
    for (const image of images) {
      const reading = await this._deps.readPixelValues(image, lngLat, {
        signal,
        bandNames,
      });
      if (signal.aborted) return null;
      if (reading) return reading;
    }
    return null;
  }

  private _show(lngLat: [number, number], content: Node): void {
    this._popup?.setLngLat(lngLat).setDOMContent(content).addTo(this._map);
  }

  private _setCursor(value: string): void {
    // maplibre styles the cursor via CSS classes on the canvas container
    // (grab / grabbing). An inline cursor on that same container overrides
    // those rules, so the crosshair sticks even while panning. Fall back to
    // the canvas element when the container getter is unavailable.
    const target =
      this._map.getCanvasContainer?.() ?? this._map.getCanvas?.();
    if (target) target.style.cursor = value;
  }

  private _messageContent(text: string): Node {
    return el('div', { className: 'mlr-inspect-content' },
      el('div', { className: 'mlr-inspect-message', text }),
    );
  }

  private _readingContent(reading: PixelReading, target: RasterLayer): Node {
    const root = el('div', { className: 'mlr-inspect-content' });
    root.appendChild(
      el('div', { className: 'mlr-inspect-title', text: target.name }),
    );
    root.appendChild(
      el('div', {
        className: 'mlr-inspect-coord',
        text: `${fmtCoord(reading.lngLat[0])}, ${fmtCoord(reading.lngLat[1])}`,
      }),
    );
    const list = el('div', { className: 'mlr-inspect-bands' });
    for (const band of reading.bands) {
      const label = band.name
        ? `Band ${band.index} (${band.name})`
        : `Band ${band.index}`;
      const value = band.isNodata
        ? `${formatValue(band.value)} (nodata)`
        : formatValue(band.value);
      list.appendChild(
        el(
          'div',
          {
            className: band.isNodata
              ? 'mlr-inspect-band mlr-inspect-band-nodata'
              : 'mlr-inspect-band',
          },
          el('span', { className: 'mlr-inspect-band-label', text: label }),
          el('span', { className: 'mlr-inspect-band-value', text: value }),
        ),
      );
    }
    root.appendChild(list);
    return root;
  }
}
