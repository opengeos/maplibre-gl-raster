import type { RasterLayer } from '../state/RasterLayer';
import { clearEl, el } from './dom';

export type LayerListOptions = {
  onSelect: (id: string) => void;
  onToggleVisible: (id: string, visible: boolean) => void;
  onZoomTo: (id: string) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onRemove: (id: string) => void;
};

/**
 * Layer list section: one row per raster layer with visibility checkbox,
 * selectable name, zoom-to, reorder (up/down), and remove actions. The list
 * is displayed top layer first (reverse of draw order) to match common GIS
 * layer-panel conventions.
 */
export class LayerList {
  /** Root element to insert into the panel. */
  readonly el: HTMLElement;
  private _list: HTMLElement;
  private _options: LayerListOptions;

  /**
   * Creates the list.
   *
   * @param options - Row action callbacks
   */
  constructor(options: LayerListOptions) {
    this._options = options;
    this._list = el('div', { className: 'mlr-layer-list' });
    this.el = el(
      'div',
      { className: 'mlr-section' },
      el('div', { className: 'mlr-section-title', text: 'Layers' }),
      this._list,
    );
  }

  /**
   * Re-renders all rows.
   *
   * @param layers - Layers in draw order (first = bottom)
   * @param selectedId - Currently selected layer id
   */
  update(layers: RasterLayer[], selectedId: string | null): void {
    clearEl(this._list);
    if (layers.length === 0) {
      this._list.appendChild(
        el('div', {
          className: 'mlr-empty',
          text: 'No layers yet. Add a COG URL or drop a GeoTIFF above.',
        }),
      );
      return;
    }
    // Top of the list = top of the draw order.
    for (let i = layers.length - 1; i >= 0; i--) {
      this._list.appendChild(this._buildRow(layers[i], i, layers.length, selectedId));
    }
  }

  private _buildRow(
    layer: RasterLayer,
    index: number,
    count: number,
    selectedId: string | null,
  ): HTMLElement {
    const { onSelect, onToggleVisible, onZoomTo, onMove, onRemove } =
      this._options;

    const visible = el('input', {
      type: 'checkbox',
      ariaLabel: `visible-${layer.name}`,
      title: 'Show / hide layer',
    });
    visible.checked = layer.state.visible;
    visible.addEventListener('change', () =>
      onToggleVisible(layer.id, visible.checked),
    );

    const status = layer.loading
      ? ' (loading…)'
      : layer.error
        ? ' (failed)'
        : '';
    const name = el('button', {
      className: 'mlr-layer-name',
      type: 'button',
      text: `${layer.name}${status}`,
      title: layer.error ? layer.error.message : layer.name,
    });
    name.addEventListener('click', () => onSelect(layer.id));

    const zoom = this._iconButton('⌖', 'Zoom to layer', () =>
      onZoomTo(layer.id),
    );
    zoom.disabled = !layer.bounds;
    const up = this._iconButton('↑', 'Move layer up', () =>
      onMove(layer.id, 1),
    );
    up.disabled = index >= count - 1;
    const down = this._iconButton('↓', 'Move layer down', () =>
      onMove(layer.id, -1),
    );
    down.disabled = index <= 0;
    const remove = this._iconButton('×', 'Remove layer', () =>
      onRemove(layer.id),
    );

    const row = el(
      'div',
      { className: 'mlr-layer-row' },
      visible,
      name,
      zoom,
      up,
      down,
      remove,
    );
    if (layer.id === selectedId) row.classList.add('selected');
    if (layer.error) row.classList.add('errored');
    return row;
  }

  private _iconButton(
    glyph: string,
    title: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const btn = el('button', {
      className: 'mlr-icon-button',
      type: 'button',
      text: glyph,
      title,
      ariaLabel: title,
    });
    btn.addEventListener('click', onClick);
    return btn;
  }
}
