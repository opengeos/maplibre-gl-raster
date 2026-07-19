import {
  COLORMAP_SPRITE_WIDTH as SPRITE_WIDTH,
  loadColormapSprite as loadSprite,
} from '../raster/colormap-sampler';
import { colormapDisplayName, COLORMAP_OPTIONS } from '../raster/colormaps';
import type { BandStats } from '../raster/stats';
import { el, select } from './dom';

const PREVIEW_HEIGHT = 14;

/** Sentinel colormap name for the image's embedded color table. */
export const PALETTE_COLORMAP = 'palette';

export type ColormapPickerOptions = {
  /** Active colormap name (or {@link PALETTE_COLORMAP}). */
  value: string;
  onChange: (next: string) => void;
  /** The image's embedded color table; when present, an "Image palette"
   * option is offered (and previewed from this data). */
  palette?: ImageData | null;
  /** Sampled stats for the displayed band. When available, the palette
   * preview is restricted to index values that actually occur in the data
   * (land-cover palettes typically use a handful of the 256 entries). */
  stats?: BandStats | null;
  /** Colormap names the active rendering engine can draw. When set, the list is
   * narrowed to these so the user cannot pick a ramp the engine would not
   * render. Null/omitted offers every colormap. See
   * {@link import('../state/LayerManager').LayerManager.supportedColormaps}. */
  allowed?: ReadonlySet<string> | null;
};

/**
 * Derives the palette indices that occur in the sampled data: every integer
 * covered by a non-empty histogram bin, excluding fully transparent (nodata)
 * palette entries. Returns null when stats are unavailable or nothing
 * matches, in which case the full palette is shown.
 */
function usedPaletteIndices(
  palette: ImageData,
  stats: BandStats | null | undefined,
): number[] | null {
  if (!stats || stats.max < stats.min) return null;
  const bins = stats.histogram;
  if (!bins.some((c) => c > 0)) return null;
  const binWidth = (stats.max - stats.min) / bins.length || 1;
  const used = new Set<number>();
  for (let i = 0; i < bins.length; i++) {
    if (bins[i] <= 0) continue;
    const lo = Math.ceil(stats.min + i * binWidth);
    // Closed upper edge for the last bin so stats.max itself is included.
    const hi = Math.floor(
      i === bins.length - 1
        ? stats.max
        : stats.min + (i + 1) * binWidth - 1e-9,
    );
    for (let v = lo; v <= hi; v++) {
      if (v < 0 || v >= palette.width) continue;
      if (palette.data[v * 4 + 3] === 0) continue; // nodata entry
      used.add(v);
    }
  }
  return used.size > 0 ? [...used].sort((a, b) => a - b) : null;
}

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
  private _stats: BandStats | null;
  /** Guards async sprite draws against out-of-order completion. */
  private _drawToken = 0;

  /**
   * Creates the picker.
   *
   * @param options - Active value, change callback, optional embedded palette
   */
  constructor(options: ColormapPickerOptions) {
    this._palette = options.palette ?? null;
    this._stats = options.stats ?? null;

    const allowed = options.allowed;
    const named = COLORMAP_OPTIONS.filter(
      (o) => !allowed || allowed.has(o.name),
    ).map((o) => ({ value: o.name, label: o.label }));
    // Keep the active colormap listed even when the engine cannot draw it (a
    // layer styled on another engine, then switched), flagged so the reason the
    // map looks wrong is visible rather than the select silently snapping to
    // some other entry.
    const unsupported =
      allowed &&
      options.value &&
      options.value !== PALETTE_COLORMAP &&
      !allowed.has(options.value)
        ? [
            {
              value: options.value,
              label: `${colormapDisplayName(options.value)} (not supported by this engine)`,
            },
          ]
        : [];
    const selectOptions = [
      ...(this._palette
        ? [{ value: PALETTE_COLORMAP, label: 'Image palette (default)' }]
        : []),
      ...unsupported,
      ...named,
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
      const indices = usedPaletteIndices(this._palette, this._stats);
      if (indices) {
        // Discrete swatches: one texel per value present in the data,
        // pixelated so class boundaries stay crisp when stretched.
        this._canvas.width = indices.length;
        this._canvas.style.imageRendering = 'pixelated';
        const data = this._palette.data;
        const strip = ctx.createImageData(indices.length, 1);
        indices.forEach((v, i) => {
          strip.data.set(data.subarray(v * 4, v * 4 + 4), i * 4);
        });
        ctx.putImageData(strip, 0, 0);
      } else {
        this._canvas.width = this._palette.width;
        this._canvas.style.imageRendering = '';
        ctx.putImageData(this._palette, 0, 0);
      }
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
      this._canvas.width = SPRITE_WIDTH;
      this._canvas.style.imageRendering = '';
      ctx.clearRect(0, 0, SPRITE_WIDTH, 1);
      ctx.drawImage(sprite, 0, active.rowIndex, SPRITE_WIDTH, 1, 0, 0, SPRITE_WIDTH, 1);
    } catch {
      // Preview is cosmetic; the GPU colormap still applies.
    }
  }
}
