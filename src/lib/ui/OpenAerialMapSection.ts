import type { Map as MapLibreMap } from 'maplibre-gl';
import {
  type OamImage,
  searchOpenAerialMap,
} from '../raster/openaerialmap';
import { clearEl, el } from './dom';

/** Options for {@link OpenAerialMapSection}. */
export interface OpenAerialMapSectionOptions {
  /** The map, used to read the search bbox and host visualized tile layers. */
  map: MapLibreMap;
  /** Overrides the OpenAerialMap API base URL (e.g. to route through a proxy). */
  endpoint?: string;
  /** Results fetched per page / "Load more" click. @default 20 */
  pageSize?: number;
}

/** Tracks a visualized OAM image's MapLibre source and layer ids. */
interface AddedLayer {
  sourceId: string;
  layerId: string;
}

/**
 * "OpenAerialMap" section: searches the OpenAerialMap catalog for imagery
 * covering the current map view, lists the matches with thumbnails, and lets
 * the user visualize an image (as a native MapLibre raster tile layer), zoom to
 * it, or download the source GeoTIFF.
 *
 * OAM images are visualized via their XYZ tile endpoint rather than the COG
 * rendering pipeline, because the source GeoTIFFs on S3 are not CORS-enabled
 * for browser reads while the tile server is.
 */
export class OpenAerialMapSection {
  /** Root element to insert into the panel. */
  readonly el: HTMLElement;

  private readonly _map: MapLibreMap;
  private readonly _endpoint?: string;
  private readonly _pageSize: number;

  private readonly _statusEl: HTMLElement;
  private readonly _resultsEl: HTMLElement;
  private readonly _moreBtn: HTMLButtonElement;
  private readonly _searchBtn: HTMLButtonElement;

  /** Images accumulated across pages for the active query. */
  private _images: OamImage[] = [];
  /** Total matches reported by the API for the active query. */
  private _found = 0;
  /** Next page to request for the active query. */
  private _page = 1;
  /** Bbox captured when the active query started; reused for "Load more". */
  private _bbox: [number, number, number, number] | null = null;
  /** Aborts an in-flight search when a new one starts or on teardown. */
  private _abort: AbortController | null = null;
  /** Visualized images, keyed by image id, for toggle / teardown. */
  private readonly _added = new globalThis.Map<string, AddedLayer>();

  /**
   * Creates the section.
   *
   * @param options - Map handle and search configuration
   */
  constructor(options: OpenAerialMapSectionOptions) {
    this._map = options.map;
    this._endpoint = options.endpoint;
    this._pageSize = options.pageSize ?? 20;

    this._searchBtn = el('button', {
      className: 'mlr-button',
      type: 'button',
      text: 'Search this view',
      ariaLabel: 'search-openaerialmap',
    });
    this._searchBtn.addEventListener('click', () => void this._search(true));

    this._statusEl = el('div', {
      className: 'mlr-oam-status',
      text: 'Search the current map view for OpenAerialMap imagery.',
    });

    this._resultsEl = el('div', { className: 'mlr-oam-results' });

    this._moreBtn = el('button', {
      className: 'mlr-button mlr-oam-more',
      type: 'button',
      text: 'Load more',
      ariaLabel: 'load-more-openaerialmap',
    });
    this._moreBtn.hidden = true;
    this._moreBtn.addEventListener('click', () => void this._search(false));

    this.el = el(
      'div',
      { className: 'mlr-section mlr-oam' },
      el('div', { className: 'mlr-section-title', text: 'OpenAerialMap' }),
      el('div', { className: 'mlr-row' }, this._searchBtn),
      this._statusEl,
      this._resultsEl,
      this._moreBtn,
    );
  }

  /** Removes every visualized OAM layer and aborts any in-flight search. */
  destroy(): void {
    this._abort?.abort();
    this._abort = null;
    for (const image of [...this._added.keys()]) {
      this._removeFromMap(image);
    }
    this.el.parentNode?.removeChild(this.el);
  }

  /**
   * Runs a search. When `reset` is true, captures a fresh bbox from the current
   * view and replaces the results; otherwise fetches the next page and appends.
   */
  private async _search(reset: boolean): Promise<void> {
    if (reset) {
      this._bbox = this._currentBbox();
      this._page = 1;
      this._images = [];
      this._found = 0;
    }
    if (!this._bbox) return;

    this._abort?.abort();
    const abort = new AbortController();
    this._abort = abort;

    this._searchBtn.disabled = true;
    this._moreBtn.disabled = true;
    this._setStatus(reset ? 'Searching…' : 'Loading more…');

    try {
      const result = await searchOpenAerialMap({
        bbox: this._bbox,
        page: this._page,
        limit: this._pageSize,
        endpoint: this._endpoint,
        signal: abort.signal,
      });
      if (abort.signal.aborted) return;

      this._images = this._images.concat(result.images);
      this._found = result.found;
      this._page += 1;
      this._render();
    } catch (error) {
      if (abort.signal.aborted) return;
      const message =
        error instanceof Error ? error.message : 'Search failed';
      this._setStatus(
        `Could not reach OpenAerialMap: ${message}. The catalog API may be blocked by CORS in this environment.`,
        true,
      );
      this._resultsEl.replaceChildren();
      this._moreBtn.hidden = true;
    } finally {
      if (this._abort === abort) this._abort = null;
      this._searchBtn.disabled = false;
      this._moreBtn.disabled = false;
    }
  }

  /** Rebuilds the results list and status/"Load more" affordances. */
  private _render(): void {
    if (this._images.length === 0) {
      this._setStatus('No imagery found in this view.');
      this._resultsEl.replaceChildren();
      this._moreBtn.hidden = true;
      return;
    }

    this._setStatus(`Showing ${this._images.length} of ${this._found} images.`);
    clearEl(this._resultsEl);
    for (const image of this._images) {
      this._resultsEl.appendChild(this._card(image));
    }
    this._moreBtn.hidden = this._images.length >= this._found;
  }

  /** Builds one result card. */
  private _card(image: OamImage): HTMLElement {
    const media = el('div', { className: 'mlr-oam-thumb' });
    if (image.thumbnailUrl) {
      const img = el('img', {
        attrs: {
          src: image.thumbnailUrl,
          alt: image.title,
          loading: 'lazy',
        },
      });
      // Drop the thumbnail frame if the preview fails to load.
      img.addEventListener('error', () => media.classList.add('empty'));
      media.appendChild(img);
    } else {
      media.classList.add('empty');
    }

    const meta = el(
      'div',
      { className: 'mlr-oam-meta' },
      el('div', { className: 'mlr-oam-title', text: image.title, title: image.title }),
      el('div', { className: 'mlr-oam-sub', text: this._subtitle(image) }),
    );

    const added = this._added.has(image.id);
    const addBtn = el('button', {
      className: `mlr-oam-action${added ? ' active' : ''}`,
      type: 'button',
      text: added ? 'Remove' : 'Add',
      disabled: !image.tileUrl,
      title: image.tileUrl
        ? 'Add this image to the map'
        : 'No tile service available for this image',
    });
    addBtn.addEventListener('click', () => {
      this._toggle(image);
      const nowAdded = this._added.has(image.id);
      addBtn.textContent = nowAdded ? 'Remove' : 'Add';
      addBtn.classList.toggle('active', nowAdded);
    });

    const zoomBtn = el('button', {
      className: 'mlr-oam-action',
      type: 'button',
      text: 'Zoom',
      disabled: !image.bbox,
      title: 'Zoom to this image',
    });
    zoomBtn.addEventListener('click', () => this._zoomTo(image));

    const downloadBtn = el('button', {
      className: 'mlr-oam-action',
      type: 'button',
      text: 'Download',
      disabled: !image.cogUrl,
      title: 'Download the source GeoTIFF',
    });
    downloadBtn.addEventListener('click', () => this._download(image));

    const actions = el(
      'div',
      { className: 'mlr-oam-actions' },
      addBtn,
      zoomBtn,
      downloadBtn,
    );

    return el(
      'div',
      { className: 'mlr-oam-card' },
      media,
      el('div', { className: 'mlr-oam-body' }, meta, actions),
    );
  }

  /** Composes the "provider · date · resolution" subtitle line. */
  private _subtitle(image: OamImage): string {
    const parts: string[] = [];
    if (image.provider) parts.push(image.provider);
    const date = (image.acquisitionEnd ?? image.acquisitionStart)?.slice(0, 10);
    if (date) parts.push(date);
    if (image.gsd != null) {
      parts.push(
        image.gsd < 1
          ? `${(image.gsd * 100).toFixed(1)} cm/px`
          : `${image.gsd.toFixed(2)} m/px`,
      );
    }
    return parts.join(' · ');
  }

  /** Adds the image to the map, or removes it if already shown. */
  private _toggle(image: OamImage): void {
    if (this._added.has(image.id)) {
      this._removeFromMap(image.id);
    } else {
      this._addToMap(image);
    }
  }

  /** Adds a native MapLibre raster layer from the image's tile endpoint. */
  private _addToMap(image: OamImage): void {
    if (!image.tileUrl || this._added.has(image.id)) return;
    const sourceId = `oam-src-${image.id}`;
    const layerId = `oam-lyr-${image.id}`;

    if (!this._map.getSource(sourceId)) {
      this._map.addSource(sourceId, {
        type: 'raster',
        tiles: [image.tileUrl],
        tileSize: 256,
        attribution:
          '<a href="https://openaerialmap.org/" target="_blank" rel="noopener">OpenAerialMap</a>',
      });
    }
    if (!this._map.getLayer(layerId)) {
      this._map.addLayer({
        id: layerId,
        type: 'raster',
        source: sourceId,
        paint: { 'raster-opacity': 1 },
      });
    }
    this._added.set(image.id, { sourceId, layerId });
    this._zoomTo(image);
  }

  /** Removes a visualized image's layer and source from the map. */
  private _removeFromMap(imageId: string): void {
    const entry = this._added.get(imageId);
    if (!entry) return;
    if (this._map.getLayer(entry.layerId)) this._map.removeLayer(entry.layerId);
    if (this._map.getSource(entry.sourceId)) {
      this._map.removeSource(entry.sourceId);
    }
    this._added.delete(imageId);
  }

  /** Fits the map view to the image footprint. */
  private _zoomTo(image: OamImage): void {
    if (!image.bbox) return;
    const [west, south, east, north] = image.bbox;
    this._map.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      { padding: 40, duration: 600 },
    );
  }

  /** Triggers a browser download of the source GeoTIFF. */
  private _download(image: OamImage): void {
    if (!image.cogUrl) return;
    const link = el('a', {
      attrs: {
        href: image.cogUrl,
        download: image.cogUrl.split('/').pop() ?? 'openaerialmap.tif',
        target: '_blank',
        rel: 'noopener',
      },
    });
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  /** Reads the current map view as a clamped [w, s, e, n] bbox. */
  private _currentBbox(): [number, number, number, number] {
    const bounds = this._map.getBounds();
    const clampLon = (n: number): number => Math.max(-180, Math.min(180, n));
    const clampLat = (n: number): number => Math.max(-90, Math.min(90, n));
    return [
      clampLon(bounds.getWest()),
      clampLat(bounds.getSouth()),
      clampLon(bounds.getEast()),
      clampLat(bounds.getNorth()),
    ];
  }

  /** Sets the status line text, optionally flagged as an error. */
  private _setStatus(text: string, isError = false): void {
    this._statusEl.textContent = text;
    this._statusEl.classList.toggle('mlr-oam-error', isError);
  }
}
