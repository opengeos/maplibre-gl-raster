import type { Map as MapLibreMap } from 'maplibre-gl';
import type { RasterSampleDataset } from '../core/types';
import type { LayerManager } from '../state/LayerManager';
import { AddDataSection } from './AddDataSection';
import { el } from './dom';
import { EngineSection } from './EngineSection';
import { LayerList } from './LayerList';
import { OpenAerialMapSection } from './OpenAerialMapSection';
import { SettingsSection, type InspectHooks } from './SettingsSection';

/**
 * Composes the panel content: Add data, Layers, and Settings sections.
 * Subscribes to LayerManager events to keep the sections in sync, and
 * delegates user actions back to the manager.
 */
export class PanelUI {
  private _manager: LayerManager;
  private _root: HTMLElement;
  private _engine: EngineSection;
  private _layerList: LayerList;
  private _settings: SettingsSection;
  private _openAerialMap?: OpenAerialMapSection;
  private _unsubscribe: (() => void)[] = [];

  /**
   * Builds the UI into a panel content container.
   *
   * @param container - The panel's content element
   * @param manager - The layer manager to drive
   * @param options - UI options (e.g. a URL to prefill the Add data input)
   */
  constructor(
    container: HTMLElement,
    manager: LayerManager,
    options?: {
      defaultUrl?: string;
      sampleData?: RasterSampleDataset[];
      sampleDataLabel?: string;
      inspect?: InspectHooks;
      /** Map handle enabling the OpenAerialMap search section. */
      map?: MapLibreMap;
      /** Overrides the OpenAerialMap API base URL. */
      openAerialMapEndpoint?: string;
    },
  ) {
    this._manager = manager;

    const engine = new EngineSection({
      value: manager.engine,
      onChange: (next) => {
        manager.setEngine(next);
        // Reflect the change in case the manager normalized it.
        engine.setValue(manager.engine);
      },
    });
    this._engine = engine;

    const addData = new AddDataSection({
      initialUrl: options?.defaultUrl,
      sampleData: options?.sampleData,
      sampleDataLabel: options?.sampleDataLabel,
      onAddUrl: (url, beforeId) => {
        // Errors surface via the manager's 'error' event and the layer row.
        void this._manager.addRaster(url, { beforeId }).catch(() => {});
      },
      onAddFile: (file, beforeId) => {
        void this._manager.addRaster(file, { beforeId }).catch(() => {});
      },
    });

    this._layerList = new LayerList({
      // Clicking a layer selects it for editing and brings it into view.
      onSelect: (id) => {
        this._manager.select(id);
        this._manager.zoomTo(id);
      },
      onToggleVisible: (id, visible) => this._manager.setVisible(id, visible),
      onZoomTo: (id) => this._manager.zoomTo(id),
      onMove: (id, direction) => {
        const index = this._manager.getLayers().findIndex((l) => l.id === id);
        if (index === -1) return;
        this._manager.reorder(id, index + direction);
      },
      onRemove: (id) => this._manager.removeRaster(id),
    });

    // OpenAerialMap discovery: search openly-licensed aerial imagery covering
    // the current view, then visualize or download it. Requires a map handle.
    if (options?.map) {
      this._openAerialMap = new OpenAerialMapSection({
        map: options.map,
        endpoint: options.openAerialMapEndpoint,
      });
    }

    this._settings = new SettingsSection(
      () => {
        const id = this._manager.selectedId;
        return id ? (this._manager.getLayer(id) ?? null) : null;
      },
      (patch) => {
        const id = this._manager.selectedId;
        if (id) this._manager.setState(id, patch);
      },
      options?.inspect,
    );

    this._root = el(
      'div',
      { className: 'mlr-panel' },
      engine.el,
      addData.el,
      ...(this._openAerialMap ? [this._openAerialMap.el] : []),
      this._layerList.el,
      this._settings.el,
    );
    container.appendChild(this._root);

    const onListChange = () => this._renderList();
    const onStructure = () => {
      this._renderList();
      this._settings.render();
    };
    const onChange = () => {
      // A programmatic setEngine() emits rasterchange; keep the selector synced.
      this._engine.setValue(this._manager.engine);
      this._renderList();
      this._settings.notifyChange();
    };
    manager.on('rasteradd', onStructure);
    manager.on('rasterremove', onStructure);
    manager.on('rasterselect', onStructure);
    manager.on('rasterchange', onChange);
    manager.on('error', onListChange);
    this._unsubscribe = [
      () => manager.off('rasteradd', onStructure),
      () => manager.off('rasterremove', onStructure),
      () => manager.off('rasterselect', onStructure),
      () => manager.off('rasterchange', onChange),
      () => manager.off('error', onListChange),
    ];

    this._renderList();
    this._settings.render();
  }

  /** Reflects an externally-toggled inspect mode on the Settings inspect button. */
  syncInspect(): void {
    this._settings.syncInspect();
  }

  /** Detaches event handlers and removes the UI from the DOM. */
  destroy(): void {
    for (const off of this._unsubscribe) off();
    this._unsubscribe = [];
    this._openAerialMap?.destroy();
    this._openAerialMap = undefined;
    this._root.parentNode?.removeChild(this._root);
  }

  private _renderList(): void {
    this._layerList.update(this._manager.getLayers(), this._manager.selectedId);
  }
}
