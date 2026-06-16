import type { IControl, Map as MapLibreMap } from 'maplibre-gl';
import { createResilientEpsgResolver } from '../raster/epsg-resolver';
import { autoRangeFor, statsForBand } from '../raster/render-pipeline';
import { LayerManager } from '../state/LayerManager';
import { PixelInspector } from '../state/PixelInspector';
import { type RasterLayer, toLayerInfo } from '../state/RasterLayer';
import { PanelUI } from '../ui/PanelUI';
import { Colorbar, type ColorbarOptions } from './Colorbar';
import type {
  AddRasterOptions,
  RasterControlEvent,
  RasterControlEventHandler,
  RasterControlOptions,
  RasterControlState,
  RasterLayerInfo,
  RasterLayerState,
} from './types';

/**
 * Default options for the RasterControl
 */
const DEFAULT_OPTIONS: Required<RasterControlOptions> = {
  collapsed: true,
  position: 'top-right',
  title: 'Raster',
  panelWidth: 360,
  className: '',
  interleaved: true,
  defaultUrl: '',
  autoLoad: false,
  epsgResolver: createResilientEpsgResolver(),
};

/** Smallest user-resized panel footprint. */
const PANEL_MIN_WIDTH = 260;
const PANEL_MIN_HEIGHT = 180;
/** Breathing room kept between a resized panel and the map edges. */
const PANEL_EDGE_MARGIN = 12;

/**
 * Event handlers map type
 */
type EventHandlersMap = globalThis.Map<RasterControlEvent, Set<RasterControlEventHandler>>;

/**
 * A MapLibre GL control for visualizing local and remote raster datasets
 * (GeoTIFF / Cloud Optimized GeoTIFF). A collapsible button expands into a
 * panel with an "Add data" section (URL or local file), a layer list, and
 * per-layer rendering settings (bands, rescale histograms, colormaps,
 * nodata, stretch, gamma, opacity). Rendering uses a deck.gl COGLayer
 * pipeline on a shared MapboxOverlay.
 *
 * @example
 * ```typescript
 * const control = new RasterControl({ collapsed: false });
 * map.addControl(control, 'top-right');
 * await control.addRaster('https://example.com/data/cog.tif');
 * ```
 */
export class RasterControl implements IControl {
  private _map?: MapLibreMap;
  private _mapContainer?: HTMLElement;
  private _container?: HTMLElement;
  private _panel?: HTMLElement;
  private _options: Required<RasterControlOptions>;
  private _state: RasterControlState;
  private _eventHandlers: EventHandlersMap = new globalThis.Map();
  private _layerManager?: LayerManager;
  private _panelUI?: PanelUI;
  private _inspector?: PixelInspector;
  private _onReady: (() => void)[] = [];
  /** On-map colorbar legends, one per layer whose `state.colorbar.visible`. */
  private _colorbars = new globalThis.Map<string, Colorbar>();
  /** User-chosen panel size from the resize handle, re-applied on reposition. */
  private _userPanelSize: { width: number; height: number } | null = null;
  /** Repositions the resize handle to the panel's inward corner. */
  private _placeResizeHandle: (() => void) | null = null;

  // Panel positioning handlers
  private _resizeHandler: (() => void) | null = null;
  private _mapResizeHandler: (() => void) | null = null;
  private _clickOutsideHandler: ((e: MouseEvent) => void) | null = null;

  /**
   * Creates a new RasterControl instance.
   *
   * @param options - Configuration options for the control
   */
  constructor(options?: Partial<RasterControlOptions>) {
    this._options = { ...DEFAULT_OPTIONS, ...options };
    this._state = {
      collapsed: this._options.collapsed,
      panelWidth: this._options.panelWidth,
      data: {},
    };
  }

  /**
   * Called when the control is added to the map.
   * Implements the IControl interface.
   *
   * @param map - The MapLibre GL map instance
   * @returns The control's container element
   */
  onAdd(map: MapLibreMap): HTMLElement {
    this._map = map;
    this._mapContainer = map.getContainer();
    this._container = this._createContainer();
    this._panel = this._createPanel();

    // Append panel to map container for independent positioning (avoids overlap with other controls)
    this._mapContainer.appendChild(this._panel);

    // Wire the raster machinery: one LayerManager (owning the deck.gl
    // overlay) plus the panel UI bound to it.
    this._layerManager = new LayerManager(
      map,
      { interleaved: this._options.interleaved },
      { epsgResolver: this._options.epsgResolver },
    );
    this._forwardLayerManagerEvents(this._layerManager);

    // Pixel inspector: reads source values of the selected layer on map click.
    const manager = this._layerManager;
    this._inspector = new PixelInspector(map, () => {
      const id = manager.selectedId;
      return id ? (manager.getLayer(id) ?? null) : null;
    });

    const content = this._panel.querySelector<HTMLElement>(
      '.mlr-control-content',
    );
    const autoLoading = this._options.autoLoad && !!this._options.defaultUrl;
    if (content) {
      this._panelUI = new PanelUI(content, this._layerManager, {
        // When auto-loading, leave the input empty — the raster is already
        // on its way, and a prefilled Load button would just add a duplicate.
        defaultUrl: autoLoading ? '' : this._options.defaultUrl,
        inspect: {
          onToggle: () => this._inspector?.toggle(),
          isActive: () => this._inspector?.enabled ?? false,
        },
      });
    }
    if (autoLoading) {
      // Errors surface via the 'error' event and the layer row.
      void this._layerManager.addRaster(this._options.defaultUrl).catch(() => {});
    }

    // Flush addRaster calls made before the control was added to a map.
    const ready = this._onReady;
    this._onReady = [];
    for (const resolve of ready) resolve();

    // Setup event listeners for panel positioning and click-outside
    this._setupEventListeners();

    // Set initial panel state
    if (!this._state.collapsed) {
      this._panel.classList.add('expanded');
      // Update position after control is added to DOM
      requestAnimationFrame(() => {
        this._updatePanelPosition();
      });
    }

    return this._container;
  }

  /**
   * Called when the control is removed from the map.
   * Implements the IControl interface.
   */
  onRemove(): void {
    // Tear down the raster machinery first (removes the deck.gl overlay,
    // aborts in-flight loads, revokes blob URLs).
    this._removeAllColorbars();
    this._panelUI?.destroy();
    this._panelUI = undefined;
    this._inspector?.destroy();
    this._inspector = undefined;
    this._layerManager?.destroy();
    this._layerManager = undefined;

    // Remove event listeners
    if (this._resizeHandler) {
      window.removeEventListener('resize', this._resizeHandler);
      this._resizeHandler = null;
    }
    if (this._mapResizeHandler && this._map) {
      this._map.off('resize', this._mapResizeHandler);
      this._mapResizeHandler = null;
    }
    if (this._clickOutsideHandler) {
      document.removeEventListener('click', this._clickOutsideHandler);
      this._clickOutsideHandler = null;
    }

    // Remove panel from map container
    this._panel?.parentNode?.removeChild(this._panel);

    // Remove button container from control stack
    this._container?.parentNode?.removeChild(this._container);

    this._map = undefined;
    this._mapContainer = undefined;
    this._container = undefined;
    this._panel = undefined;
    this._eventHandlers.clear();
  }

  /**
   * Gets the current state of the control.
   *
   * @returns The current plugin state
   */
  getState(): RasterControlState {
    return { ...this._state };
  }

  /**
   * Updates the control state.
   *
   * @param newState - Partial state to merge with current state
   */
  setState(newState: Partial<RasterControlState>): void {
    this._state = { ...this._state, ...newState };
    this._emit('statechange');
  }

  /**
   * Toggles the collapsed state of the control panel.
   */
  toggle(): void {
    this._state.collapsed = !this._state.collapsed;

    if (this._panel) {
      if (this._state.collapsed) {
        this._panel.classList.remove('expanded');
        this._emit('collapse');
      } else {
        this._panel.classList.add('expanded');
        this._updatePanelPosition();
        this._emit('expand');
      }
    }

    this._emit('statechange');
  }

  /**
   * Expands the control panel.
   */
  expand(): void {
    if (this._state.collapsed) {
      this.toggle();
    }
  }

  /**
   * Collapses the control panel.
   */
  collapse(): void {
    if (!this._state.collapsed) {
      this.toggle();
    }
  }

  /**
   * Registers an event handler.
   *
   * @param event - The event type to listen for
   * @param handler - The callback function
   */
  on(event: RasterControlEvent, handler: RasterControlEventHandler): void {
    if (!this._eventHandlers.has(event)) {
      this._eventHandlers.set(event, new Set());
    }
    this._eventHandlers.get(event)!.add(handler);
  }

  /**
   * Removes an event handler.
   *
   * @param event - The event type
   * @param handler - The callback function to remove
   */
  off(event: RasterControlEvent, handler: RasterControlEventHandler): void {
    this._eventHandlers.get(event)?.delete(handler);
  }

  /**
   * Gets the map instance.
   *
   * @returns The MapLibre GL map instance or undefined if not added to a map
   */
  getMap(): MapLibreMap | undefined {
    return this._map;
  }

  /**
   * Gets the control container element.
   *
   * @returns The container element or undefined if not added to a map
   */
  getContainer(): HTMLElement | undefined {
    return this._container;
  }

  /**
   * Adds a raster layer from a remote COG URL or a local GeoTIFF File.
   *
   * The returned promise resolves with the layer id once the GeoTIFF header
   * loads (waiting for the control to be added to a map first, if needed)
   * and rejects when loading fails.
   *
   * @param source - COG URL or a local GeoTIFF File
   * @param options - Id/name/state overrides and zoom behavior
   * @returns The new layer's id
   */
  async addRaster(
    source: string | File,
    options?: AddRasterOptions,
  ): Promise<string> {
    if (!this._layerManager) {
      await new Promise<void>((resolve) => this._onReady.push(resolve));
    }
    return this._layerManager!.addRaster(source, options);
  }

  /**
   * Removes a raster layer.
   *
   * @param id - The layer id
   */
  removeRaster(id: string): void {
    this._layerManager?.removeRaster(id);
  }

  /**
   * Gets a snapshot of one raster layer.
   *
   * @param id - The layer id
   * @returns Layer info, or undefined when unknown
   */
  getRaster(id: string): RasterLayerInfo | undefined {
    const layer = this._layerManager?.getLayer(id);
    return layer ? toLayerInfo(layer) : undefined;
  }

  /**
   * Gets snapshots of all raster layers in draw order (first = bottom).
   *
   * @returns Layer info array
   */
  getRasters(): RasterLayerInfo[] {
    return this._layerManager?.getLayers().map(toLayerInfo) ?? [];
  }

  /**
   * Merges a partial visualization state into a layer (bands, rescale,
   * colormap, nodata, opacity, gamma, stretch, visible).
   *
   * @param id - The layer id
   * @param patch - State fields to update
   */
  setRasterState(id: string, patch: Partial<RasterLayerState>): void {
    this._layerManager?.setState(id, patch);
  }

  /**
   * Shows or hides a raster layer.
   *
   * @param id - The layer id
   * @param visible - Whether the layer should render
   */
  setVisible(id: string, visible: boolean): void {
    this._layerManager?.setVisible(id, visible);
  }

  /**
   * Selects the layer whose settings the panel edits.
   *
   * @param id - The layer id, or null to clear the selection
   */
  selectRaster(id: string | null): void {
    this._layerManager?.select(id);
  }

  /**
   * Fits the map view to a layer's bounds.
   *
   * @param id - The layer id
   */
  zoomToRaster(id: string): void {
    this._layerManager?.zoomTo(id);
  }

  /**
   * Moves a layer to a new position in the draw order.
   *
   * @param id - The layer id
   * @param toIndex - Target index (0 = bottom)
   */
  reorderRaster(id: string, toIndex: number): void {
    this._layerManager?.reorder(id, toIndex);
  }

  /**
   * Sets the MapLibre layer a raster draws beneath (interleaved mode), so a host
   * can interleave rasters with its own vector layers. Pass null to draw the
   * raster on top. See {@link import('../state/LayerManager').LayerManager.setBeforeId}.
   *
   * @param id - The layer id
   * @param beforeId - The MapLibre style layer id to draw beneath, or null
   */
  setRasterBeforeId(id: string, beforeId: string | null): void {
    this._layerManager?.setBeforeId(id, beforeId);
  }

  /** Re-emits LayerManager events through the control's event system. */
  private _forwardLayerManagerEvents(manager: LayerManager): void {
    for (const type of [
      'rasteradd',
      'rasterremove',
      'rasterchange',
      'rasterselect',
      'error',
    ] as const) {
      manager.on(type, (e) => {
        // Reconcile on-map colorbars before re-emitting, so a host's handler
        // observing the event already sees the legend in sync.
        if (type !== 'error') this._syncColorbars();
        this._emit(type, { layerId: e.layerId, error: e.error });
      });
    }
  }

  /**
   * Reconciles the on-map colorbar legends with the layers' colorbar state:
   * adds/updates a {@link Colorbar} for each single-band layer whose
   * `state.colorbar.visible` is set, and removes the rest. Driven by
   * LayerManager change events, so the panel only has to write
   * `state.colorbar`.
   */
  private _syncColorbars(): void {
    const map = this._map;
    const manager = this._layerManager;
    if (!map || !manager) return;

    const seen = new Set<string>();
    for (const layer of manager.getLayers()) {
      const cb = layer.state.colorbar;
      // A legend only makes sense for a visible single-band named colormap
      // (palette entries are categorical, with no numeric range to label).
      if (
        !cb?.visible ||
        !layer.state.visible ||
        layer.state.mode !== 'single' ||
        layer.state.colormap === 'palette'
      ) {
        continue;
      }
      seen.add(layer.id);
      const options = this._colorbarOptionsFor(layer);
      const existing = this._colorbars.get(layer.id);
      if (!existing) {
        const bar = new Colorbar(options);
        this._colorbars.set(layer.id, bar);
        map.addControl(bar, options.position);
      } else if (existing.getOptions().position !== options.position) {
        // MapLibre fixes a control's corner at addControl time, so a position
        // change requires removing and re-adding the legend.
        map.removeControl(existing);
        const bar = new Colorbar(options);
        this._colorbars.set(layer.id, bar);
        map.addControl(bar, options.position);
      } else {
        existing.update(options);
      }
    }

    for (const [id, bar] of [...this._colorbars]) {
      if (!seen.has(id)) {
        map.removeControl(bar);
        this._colorbars.delete(id);
      }
    }
  }

  /** Builds colorbar options from a layer's colormap, reverse flag, and
   * effective rescale range (explicit window, else auto-stats percentile). */
  private _colorbarOptionsFor(layer: RasterLayer): ColorbarOptions {
    const band = layer.state.bands[0] ?? 1;
    const stats = statsForBand(layer.autoStats, band);
    const range: [number, number] =
      layer.state.rescale?.[0] ?? (stats ? autoRangeFor(stats) : [0, 1]);
    const cb = layer.state.colorbar;
    return {
      colormap: layer.state.colormap,
      reversed: layer.state.reversed,
      min: range[0],
      max: range[1],
      // Match the layer's stretch so the legend ticks line up with the data.
      stretch: layer.state.stretch,
      title: cb?.title?.trim() ? cb.title : layer.name,
      titleAlign: cb?.titleAlign ?? 'left',
      units: cb?.units ?? '',
      orientation: cb?.orientation ?? 'horizontal',
      position: cb?.position ?? 'bottom-right',
    };
  }

  /** Removes all on-map colorbar legends. */
  private _removeAllColorbars(): void {
    for (const bar of this._colorbars.values()) this._map?.removeControl(bar);
    this._colorbars.clear();
  }

  /**
   * Emits an event to all registered handlers.
   *
   * @param event - The event type to emit
   * @param extra - Optional layerId/error payload for raster events
   */
  private _emit(
    event: RasterControlEvent,
    extra?: { layerId?: string; error?: Error },
  ): void {
    const handlers = this._eventHandlers.get(event);
    if (handlers) {
      const eventData = { type: event, state: this.getState(), ...extra };
      handlers.forEach((handler) => handler(eventData));
    }
  }

  /**
   * Creates the main container element for the control.
   * Contains a toggle button (29x29) matching navigation control size.
   *
   * @returns The container element
   */
  private _createContainer(): HTMLElement {
    const container = document.createElement('div');
    container.className = `maplibregl-ctrl maplibregl-ctrl-group mlr-control${
      this._options.className ? ` ${this._options.className}` : ''
    }`;

    // Create toggle button (29x29 to match navigation control)
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'mlr-control-toggle';
    toggleBtn.type = 'button';
    toggleBtn.setAttribute('aria-label', this._options.title);
    toggleBtn.innerHTML = `
      <span class="mlr-control-icon">
        <svg viewBox="0 0 24 24" width="22" height="22" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <polyline points="21 15 16 10 5 21"/>
        </svg>
      </span>
    `;
    toggleBtn.addEventListener('click', () => this.toggle());

    container.appendChild(toggleBtn);

    return container;
  }

  /**
   * Creates the panel element with header and content areas.
   * Panel is positioned as a dropdown below the toggle button.
   *
   * @returns The panel element
   */
  private _createPanel(): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'mlr-control-panel';
    panel.style.width = `${this._options.panelWidth}px`;

    // Create header with title and close button
    const header = document.createElement('div');
    header.className = 'mlr-control-header';

    const title = document.createElement('span');
    title.className = 'mlr-control-title';
    title.textContent = this._options.title;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'mlr-control-close';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close panel');
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', () => this.collapse());

    header.appendChild(title);
    header.appendChild(closeBtn);

    // Content area — populated by PanelUI in onAdd.
    const content = document.createElement('div');
    content.className = 'mlr-control-content';

    panel.appendChild(header);
    panel.appendChild(content);
    this._addResizeHandle(panel);

    return panel;
  }

  /**
   * Adds a drag handle that resizes the panel in both dimensions. The panel is
   * absolutely positioned and anchored to its docking corner, so a custom
   * handle is used instead of CSS `resize` (which is unreliable in WebKitGTK):
   * it sits at the panel's inward corner and grows toward the map interior, in
   * any corner. The anchored edges stay fixed; only width/height change.
   *
   * @param panel - The panel element to make resizable.
   */
  private _addResizeHandle(panel: HTMLElement): void {
    const handle = document.createElement('div');
    handle.className = 'mlr-control-resize';
    handle.setAttribute('aria-hidden', 'true');
    panel.appendChild(handle);

    const placeHandle = (): void => {
      const pos = this._getControlPosition();
      const right = pos.endsWith('right');
      const bottom = pos.startsWith('bottom');
      handle.style.top = bottom ? '0' : 'auto';
      handle.style.bottom = bottom ? 'auto' : '0';
      handle.style.left = right ? '0' : 'auto';
      handle.style.right = right ? 'auto' : '0';
      handle.style.cursor = right === bottom ? 'nwse-resize' : 'nesw-resize';
    };
    placeHandle();
    this._placeResizeHandle = placeHandle;

    let right = false;
    let bottom = false;
    let startX = 0;
    let startY = 0;
    let startW = 0;
    let startH = 0;
    let maxW = Infinity;
    let maxH = Infinity;

    const onMove = (event: PointerEvent): void => {
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      const width = Math.min(maxW, Math.max(PANEL_MIN_WIDTH, right ? startW - dx : startW + dx));
      const height = Math.min(maxH, Math.max(PANEL_MIN_HEIGHT, bottom ? startH - dy : startH + dy));
      this._userPanelSize = { width, height };
      this._applyUserPanelSize();
    };
    const onUp = (event: PointerEvent): void => {
      handle.releasePointerCapture?.(event.pointerId);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
    };
    handle.addEventListener('pointerdown', (event) => {
      if (!this._panel || !this._mapContainer) return;
      event.preventDefault();
      event.stopPropagation();
      placeHandle();
      const pos = this._getControlPosition();
      right = pos.endsWith('right');
      bottom = pos.startsWith('bottom');
      const mapRect = this._mapContainer.getBoundingClientRect();
      const rect = this._panel.getBoundingClientRect();
      startX = event.clientX;
      startY = event.clientY;
      startW = rect.width;
      startH = rect.height;
      // The anchored edge is fixed, so the room to grow is constant for the
      // whole drag: from that edge to the opposite map edge, less a margin.
      maxW =
        (right ? rect.right - mapRect.left : mapRect.right - rect.left) -
        PANEL_EDGE_MARGIN;
      maxH =
        (bottom ? rect.bottom - mapRect.top : mapRect.bottom - rect.top) -
        PANEL_EDGE_MARGIN;
      handle.setPointerCapture?.(event.pointerId);
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    });
  }

  /**
   * Applies the user-chosen panel size, clamped to the room available from the
   * panel's anchored corner to the opposite map edge. Re-run on reposition so
   * the size survives expand / window-resize (which rewrite the panel's
   * positioning) and stays within the map.
   */
  private _applyUserPanelSize(): void {
    if (!this._panel || !this._userPanelSize || !this._mapContainer) return;
    const mapRect = this._mapContainer.getBoundingClientRect();
    const pos = this._getControlPosition();
    const right = pos.endsWith('right');
    const bottom = pos.startsWith('bottom');
    const rect = this._panel.getBoundingClientRect();
    const maxW =
      (right ? rect.right - mapRect.left : mapRect.right - rect.left) -
      PANEL_EDGE_MARGIN;
    const maxH =
      (bottom ? rect.bottom - mapRect.top : mapRect.bottom - rect.top) -
      PANEL_EDGE_MARGIN;
    const width = Math.min(this._userPanelSize.width, Math.max(PANEL_MIN_WIDTH, maxW));
    const height = Math.min(this._userPanelSize.height, Math.max(PANEL_MIN_HEIGHT, maxH));
    this._panel.style.boxSizing = 'border-box';
    this._panel.style.maxWidth = 'none';
    this._panel.style.maxHeight = 'none';
    this._panel.style.width = `${width}px`;
    this._panel.style.height = `${height}px`;
  }

  /**
   * Setup event listeners for panel positioning and click-outside behavior.
   */
  private _setupEventListeners(): void {
    // Click outside to close (check both container and panel since they're now separate)
    this._clickOutsideHandler = (e: MouseEvent) => {
      const target = e.target as Node;
      // Ignore clicks whose target was detached mid-event (e.g. a panel
      // button whose click handler re-rendered the settings UI) — contains()
      // would report false and wrongly collapse the panel.
      if (!target.isConnected) return;
      // While inspecting, a map click is the inspect gesture, not a request to
      // dismiss the panel — keep the panel open so the toggle stays reachable.
      if (this._inspector?.enabled) return;
      if (
        this._container &&
        this._panel &&
        !this._container.contains(target) &&
        !this._panel.contains(target)
      ) {
        this.collapse();
      }
    };
    document.addEventListener('click', this._clickOutsideHandler);

    // Update panel position on window resize
    this._resizeHandler = () => {
      if (!this._state.collapsed) {
        this._updatePanelPosition();
      }
    };
    window.addEventListener('resize', this._resizeHandler);

    // Update panel position on map resize (e.g., sidebar toggle)
    this._mapResizeHandler = () => {
      if (!this._state.collapsed) {
        this._updatePanelPosition();
      }
    };
    this._map?.on('resize', this._mapResizeHandler);
  }

  /**
   * Detect which corner the control is positioned in.
   *
   * @returns The position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
   */
  private _getControlPosition(): 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' {
    const parent = this._container?.parentElement;
    if (!parent) return 'top-right'; // Default

    if (parent.classList.contains('maplibregl-ctrl-top-left')) return 'top-left';
    if (parent.classList.contains('maplibregl-ctrl-top-right')) return 'top-right';
    if (parent.classList.contains('maplibregl-ctrl-bottom-left')) return 'bottom-left';
    if (parent.classList.contains('maplibregl-ctrl-bottom-right')) return 'bottom-right';

    return 'top-right'; // Default
  }

  /**
   * Update the panel position based on button location and control corner.
   * Positions the panel next to the button, expanding in the appropriate direction.
   */
  private _updatePanelPosition(): void {
    if (!this._container || !this._panel || !this._mapContainer) return;

    // Get the toggle button (first child of container)
    const button = this._container.querySelector('.mlr-control-toggle');
    if (!button) return;

    const buttonRect = button.getBoundingClientRect();
    const mapRect = this._mapContainer.getBoundingClientRect();
    const position = this._getControlPosition();

    // Calculate button position relative to map container
    const buttonTop = buttonRect.top - mapRect.top;
    const buttonBottom = mapRect.bottom - buttonRect.bottom;
    const buttonLeft = buttonRect.left - mapRect.left;
    const buttonRight = mapRect.right - buttonRect.right;

    const panelGap = 5; // Gap between button and panel
    const edgeMargin = 10; // Breathing room between the panel and the map edge

    // Reset all positioning
    this._panel.style.top = '';
    this._panel.style.bottom = '';
    this._panel.style.left = '';
    this._panel.style.right = '';

    // Offset of the panel's anchored edge from the same edge of the map
    // container (top edge for top-* positions, bottom edge for bottom-*).
    const anchorOffset =
      (position === 'top-left' || position === 'top-right'
        ? buttonTop
        : buttonBottom) +
      buttonRect.height +
      panelGap;

    switch (position) {
      case 'top-left':
        // Panel expands down and to the right
        this._panel.style.top = `${anchorOffset}px`;
        this._panel.style.left = `${buttonLeft}px`;
        break;

      case 'top-right':
        // Panel expands down and to the left
        this._panel.style.top = `${anchorOffset}px`;
        this._panel.style.right = `${buttonRight}px`;
        break;

      case 'bottom-left':
        // Panel expands up and to the right
        this._panel.style.bottom = `${anchorOffset}px`;
        this._panel.style.left = `${buttonLeft}px`;
        break;

      case 'bottom-right':
        // Panel expands up and to the left
        this._panel.style.bottom = `${anchorOffset}px`;
        this._panel.style.right = `${buttonRight}px`;
        break;
    }

    // The stylesheet caps the panel at min(80vh, 720px), but those units do
    // not know the panel is offset inside the map container. On a short map
    // the panel would extend past the container and get clipped (maps
    // commonly have overflow: hidden) before its own scrollbar engages, so
    // also cap it to the space left between the anchor and the opposite map
    // edge. The 160px floor keeps the panel usable when the map is tiny;
    // overflow-y: auto then scrolls the content.
    const available = Math.max(
      160,
      mapRect.height - anchorOffset - edgeMargin,
    );
    this._panel.style.maxHeight = `min(80vh, 720px, ${available}px)`;

    // Keep the resize handle on the (possibly changed) inward corner, and
    // re-assert a user-chosen size against the new anchor / map bounds.
    this._placeResizeHandle?.();
    this._applyUserPanelSize();
  }
}
