import { Popup, type Map as MapLibreMap, type MapMouseEvent } from 'maplibre-gl';
import type { GeoTIFF } from '@developmentseed/geotiff';
import { readPixelValues, type PixelReading } from '../raster/inspect';
import { el } from '../ui/dom';
import { assetsAt, imagesAt, type RasterLayer } from './RasterLayer';

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
  /** Opens (or reuses) a mosaic asset's GeoTIFF header, resolving null when it
   * cannot be read. Supplied by `RasterControl` from `LayerManager`, so a click
   * reuses the same cache the renderer fills instead of refetching headers. */
  openMosaicAsset: (url: string) => Promise<GeoTIFF | null>;
}

/** How many covering assets one click will open before giving up. Assets in a
 * mosaic barely overlap, so the first candidate almost always answers; the cap
 * just bounds the work when a click lands where many extents pile up. */
const MAX_MOSAIC_CANDIDATES = 4;

const DEFAULT_DEPS: PixelInspectorDeps = {
  readPixelValues,
  // No mosaic assets can be opened unless the owner supplies a real opener;
  // resolving null degrades to "No data at this location." rather than throwing.
  openMosaicAsset: async () => null,
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
 * Whether `layer` has loaded enough to answer a read.
 *
 * A plain or VRT layer needs its GeoTIFF open. A mosaic manifest layer never
 * opens one — its assets are opened lazily per viewport — so it is ready as
 * soon as the manifest has been parsed into assets.
 */
function isReadable(layer: RasterLayer): boolean {
  if (layer.loading || layer.error) return false;
  return layer.mosaicAssets ? layer.mosaicAssets.length > 0 : !!layer.geotiff;
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

  /**
   * Read one raster layer at a WGS84 coordinate without changing inspect mode.
   *
   * Hosts use this to include raster values in their own identify UI. Mosaic
   * members and assets follow the same topmost-first selection as the built-in
   * click inspector.
   *
   * @param target - Raster layer to read
   * @param lngLat - WGS84 longitude and latitude
   * @param signal - Optional cancellation signal
   * @returns The pixel reading, or null when the layer is unavailable or the
   *   coordinate falls outside its data
   */
  async read(
    target: RasterLayer | null,
    lngLat: [number, number],
    signal?: AbortSignal,
  ): Promise<PixelReading | null> {
    if (!target || !isReadable(target) || signal?.aborted) return null;

    const assets = target.mosaicAssets ? assetsAt(target, lngLat) : null;
    const images = assets ? [] : imagesAt(target, lngLat);
    if ((assets ?? images).length === 0) return null;

    const readSignal = signal ?? new AbortController().signal;
    return assets
      ? this._readFirstAsset(assets, lngLat, readSignal, target.bandNames)
      : this._readFirst(images, lngLat, readSignal, target.bandNames);
  }

  private _onClick = (e: MapMouseEvent): void => {
    const lngLat: [number, number] = [e.lngLat.lng, e.lngLat.lat];
    // Cancel any read still in flight from a previous click.
    this._abort?.abort();
    this._abort = null;

    const target = this._getTarget();
    if (!target || !isReadable(target)) {
      this._show(lngLat, this._messageContent(messageFor(target)));
      return;
    }

    const controller = new AbortController();
    this._abort = controller;
    this._show(lngLat, this._messageContent('Reading…'));

    this.read(target, lngLat, controller.signal)
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

  /**
   * Reads `lngLat` from a mosaic layer by opening its covering assets in turn.
   *
   * The manifest's bboxes only bound each asset's extent, so as in
   * {@link _readFirst} the first candidate that actually covers the point wins.
   * Assets are opened one at a time rather than in parallel: a hit on the first
   * (the common case, since mosaic assets barely overlap) then costs a single
   * header fetch. An asset that cannot be opened resolves null and is skipped,
   * so one unreadable COG does not sink the whole read.
   *
   * @returns The first reading found, or null when no candidate covers the point
   */
  private async _readFirstAsset(
    urls: string[],
    lngLat: [number, number],
    signal: AbortSignal,
    bandNames: Map<number, string> | null,
  ): Promise<PixelReading | null> {
    for (const url of urls.slice(0, MAX_MOSAIC_CANDIDATES)) {
      const image = await this._deps.openMosaicAsset(url);
      if (signal.aborted) return null;
      if (!image) continue;
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
