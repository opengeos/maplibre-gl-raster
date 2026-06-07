import type { LayerManager } from '../state/LayerManager';
import { AddDataSection } from './AddDataSection';
import { el } from './dom';
import { LayerList } from './LayerList';
import { SettingsSection, type InspectHooks } from './SettingsSection';

/**
 * Composes the panel content: Add data, Layers, and Settings sections.
 * Subscribes to LayerManager events to keep the sections in sync, and
 * delegates user actions back to the manager.
 */
export class PanelUI {
  private _manager: LayerManager;
  private _root: HTMLElement;
  private _layerList: LayerList;
  private _settings: SettingsSection;
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
    options?: { defaultUrl?: string; inspect?: InspectHooks },
  ) {
    this._manager = manager;

    const addData = new AddDataSection({
      initialUrl: options?.defaultUrl,
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
        const index = this._manager
          .getLayers()
          .findIndex((l) => l.id === id);
        if (index === -1) return;
        this._manager.reorder(id, index + direction);
      },
      onRemove: (id) => this._manager.removeRaster(id),
    });

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
      addData.el,
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

  /** Detaches event handlers and removes the UI from the DOM. */
  destroy(): void {
    for (const off of this._unsubscribe) off();
    this._unsubscribe = [];
    this._root.parentNode?.removeChild(this._root);
  }

  private _renderList(): void {
    this._layerList.update(this._manager.getLayers(), this._manager.selectedId);
  }
}
