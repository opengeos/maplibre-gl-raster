import {
  COLORMAP_OPTIONS,
  COLORMAP_ROW_COUNT,
  colormapsPngUrl,
} from '../raster/colormaps';
import { el, select } from './dom';

const PREVIEW_HEIGHT = 14;

/**
 * Colormap dropdown + sprite-strip preview of the active selection.
 *
 * The sprite (`colormapsPngUrl`) is a vertical strip with one row per
 * colormap, in the order given by `COLORMAP_INDEX`. The chosen row is
 * rendered as a background image, sized so a single row fills the preview's
 * height.
 */
export class ColormapPicker {
  /** Root element to insert into the panel. */
  readonly el: HTMLElement;
  private _select: HTMLSelectElement;
  private _preview: HTMLElement;

  /**
   * Creates the picker.
   *
   * @param value - Initially selected colormap name
   * @param onChange - Called with the new colormap name
   */
  constructor(value: string, onChange: (next: string) => void) {
    this._select = select(
      COLORMAP_OPTIONS.map((o) => ({ value: o.name, label: o.label })),
      value,
      (next) => {
        this._updatePreview(next);
        onChange(next);
      },
      'colormap',
    );

    // Each sprite row is one preview-height tall once the strip is scaled to
    // `100% x (rowCount * previewHeight)`; shifting background-position-y by
    // -rowIndex * previewHeight brings the active row into view.
    this._preview = el('div', { className: 'mlr-colormap-preview' });
    this._preview.style.height = `${PREVIEW_HEIGHT}px`;
    this._preview.style.backgroundImage = `url(${colormapsPngUrl})`;
    this._preview.style.backgroundRepeat = 'no-repeat';
    this._preview.style.backgroundSize = `100% ${PREVIEW_HEIGHT * COLORMAP_ROW_COUNT}px`;

    this.el = el(
      'div',
      { className: 'mlr-colormap-picker' },
      this._select,
      this._preview,
    );
    this._updatePreview(value);
  }

  /**
   * Sets the displayed colormap.
   *
   * @param value - Colormap name
   */
  update(value: string): void {
    this._select.value = value;
    this._updatePreview(value);
  }

  private _updatePreview(value: string): void {
    const active = COLORMAP_OPTIONS.find((o) => o.name === value);
    if (!active) return;
    this._preview.style.backgroundPosition = `0 ${-active.rowIndex * PREVIEW_HEIGHT}px`;
    this._preview.style.transform = active.reversed ? 'scaleX(-1)' : '';
  }
}
