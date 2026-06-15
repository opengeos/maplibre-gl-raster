import type { IControl, Map as MapLibreMap } from 'maplibre-gl';
import { createResilientEpsgResolver } from '../raster/epsg-resolver';
import { LayerManager } from '../state/LayerManager';
import { PixelInspector } from '../state/PixelInspector';
import { toLayerInfo } from '../state/RasterLayer';
import { PanelUI } from '../ui/PanelUI';
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

  /** Re-emits LayerManager events through the control's event system. */
  private _forwardLayerManagerEvents(manager: LayerManager): void {
    for (const type of [
      'rasteradd',
      'rasterremove',
      'rasterchange',
      'rasterselect',
      'error',
    ] as const) {
      manager.on(type, (e) =>
        this._emit(type, { layerId: e.layerId, error: e.error }),
      );
    }
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

    return panel;
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
  }
}
