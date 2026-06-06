import { COLORMAP_OPTIONS, colormapsPngUrl } from '../raster/colormaps';
import { el, select } from './dom';

const PREVIEW_HEIGHT = 14;
const SPRITE_WIDTH = 256;

/** Sentinel colormap name for the image's embedded color table. */
export const PALETTE_COLORMAP = 'palette';

// The colormap sprite has one 1px-tall row per colormap. Decode it once;
// previews blit a single source row so neighboring rows can never bleed in
// (CSS background scaling interpolates across rows, producing artifacts).
let spritePromise: Promise<HTMLImageElement> | null = null;
function loadSprite(): Promise<HTMLImageElement> {
  if (!spritePromise) {
    spritePromise = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to load colormap sprite'));
      img.src = colormapsPngUrl;
    });
  }
  return spritePromise;
}

export type ColormapPickerOptions = {
  /** Active colormap name (or {@link PALETTE_COLORMAP}). */
  value: string;
  onChange: (next: string) => void;
  /** The image's embedded color table; when present, an "Image palette"
   * option is offered (and previewed from this data). */
  palette?: ImageData | null;
};

/**
 * Colormap dropdown + canvas preview of the active selection.
 *
 * The preview is a 256x1 canvas stretched via CSS: exactly one sprite row
 * (or the layer's embedded palette) is drawn into it, so the upscale only
 * smooths horizontally and adjacent colormaps cannot bleed into the strip.
 */
export class ColormapPicker {
  /** Root element to insert into the panel. */
  readonly el: HTMLElement;
  private _select: HTMLSelectElement;
  private _canvas: HTMLCanvasElement;
  private _palette: ImageData | null;
  /** Guards async sprite draws against out-of-order completion. */
  private _drawToken = 0;

  /**
   * Creates the picker.
   *
   * @param options - Active value, change callback, optional embedded palette
   */
  constructor(options: ColormapPickerOptions) {
    this._palette = options.palette ?? null;

    const selectOptions = [
      ...(this._palette
        ? [{ value: PALETTE_COLORMAP, label: 'Image palette (default)' }]
        : []),
      ...COLORMAP_OPTIONS.map((o) => ({ value: o.name, label: o.label })),
    ];
    this._select = select(
      selectOptions,
      options.value,
      (next) => {
        void this._updatePreview(next);
        options.onChange(next);
      },
      'colormap',
    );

    this._canvas = el('canvas', { className: 'mlr-colormap-preview' });
    this._canvas.width = SPRITE_WIDTH;
    this._canvas.height = 1;
    this._canvas.style.height = `${PREVIEW_HEIGHT}px`;

    this.el = el(
      'div',
      { className: 'mlr-colormap-picker' },
      this._select,
      this._canvas,
    );
    void this._updatePreview(options.value);
  }

  /**
   * Sets the displayed colormap.
   *
   * @param value - Colormap name (or {@link PALETTE_COLORMAP})
   */
  update(value: string): void {
    void this._updatePreview(value);
  }

  private async _updatePreview(value: string): Promise<void> {
    const token = ++this._drawToken;
    const ctx = this._canvas.getContext('2d');
    if (!ctx) return;

    if (value === PALETTE_COLORMAP && this._palette) {
      this._select.value = PALETTE_COLORMAP;
      ctx.putImageData(this._palette, 0, 0);
      return;
    }

    // Unknown names fall back to the first option so the select and the
    // preview never go stale or out of sync.
    const active =
      COLORMAP_OPTIONS.find((o) => o.name === value) ?? COLORMAP_OPTIONS[0];
    this._select.value = active.name;
    try {
      const sprite = await loadSprite();
      if (token !== this._drawToken) return; // superseded by a newer draw
      ctx.clearRect(0, 0, SPRITE_WIDTH, 1);
      ctx.drawImage(sprite, 0, active.rowIndex, SPRITE_WIDTH, 1, 0, 0, SPRITE_WIDTH, 1);
    } catch {
      // Preview is cosmetic; the GPU colormap still applies.
    }
  }
}
