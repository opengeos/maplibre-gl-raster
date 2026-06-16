import type { ControlPosition, IControl } from 'maplibre-gl';
import { sampleColormapStops } from '../raster/colormap-sampler';
import { el, fmtNumber } from '../ui/dom';

/** Layout direction of the colorbar bar and its tick labels. */
export type ColorbarOrientation = 'horizontal' | 'vertical';

/**
 * Configuration for a {@link Colorbar} legend. All fields are optional; the
 * resolved defaults are listed per field.
 */
export interface ColorbarOptions {
  /** Named colormap to sample (case-insensitive), e.g. 'viridis'. Sampled
   * from the same sprite the renderer uses, so it matches the map exactly.
   * Ignored when {@link colors} supplies a custom ramp. @default 'viridis' */
  colormap?: string;
  /** Custom anchor colors (any CSS color). When two or more are given they
   * define the ramp directly and {@link colormap} is ignored. */
  colors?: string[];
  /** Sample the ramp back-to-front (matches a reversed raster render).
   * @default false */
  reversed?: boolean;
  /** Value at the start of the ramp. @default 0 */
  min?: number;
  /** Value at the end of the ramp. @default 1 */
  max?: number;
  /** Title shown above the bar. @default '' */
  title?: string;
  /** Horizontal alignment of the title. @default 'left' */
  titleAlign?: 'left' | 'center' | 'right';
  /** Unit suffix appended to every tick label (e.g. 'm', '°C'). @default '' */
  units?: string;
  /** Bar/label layout. @default 'horizontal' */
  orientation?: ColorbarOrientation;
  /** Map corner to dock in (MapLibre control position). @default 'bottom-right' */
  position?: ControlPosition;
  /** Number of evenly spaced tick labels (>= 2). Ignored when
   * {@link tickValues} is set. @default 5 */
  ticks?: number;
  /** Explicit tick values, overriding {@link ticks}. */
  tickValues?: number[];
  /** Length of the bar along its main axis, in px. @default 180 */
  barLength?: number;
  /** Thickness of the bar across its main axis, in px. @default 12 */
  barThickness?: number;
  /** Extra class added to the root element. */
  className?: string;
}

type ResolvedOptions = Required<Omit<ColorbarOptions, 'tickValues' | 'className'>> &
  Pick<ColorbarOptions, 'tickValues' | 'className'>;

const DEFAULTS: ResolvedOptions = {
  colormap: 'viridis',
  colors: [],
  reversed: false,
  min: 0,
  max: 1,
  title: '',
  titleAlign: 'left',
  units: '',
  orientation: 'horizontal',
  position: 'bottom-right',
  ticks: 5,
  tickValues: undefined,
  barLength: 180,
  barThickness: 12,
  className: undefined,
};

// Enough stops to read as a smooth gradient when sampled from the 256-texel
// sprite, without bloating the inline background string.
const GRADIENT_STOP_COUNT = 24;

/**
 * Resolves the ordered stop colors for a custom ramp, or null when the ramp
 * must instead be sampled from a named colormap (fewer than two colors).
 *
 * @param colors - The custom anchor colors.
 * @param reversed - Whether to reverse the order.
 * @returns The ordered colors, or null to defer to colormap sampling.
 */
export function customColorbarStops(
  colors: string[] | undefined,
  reversed: boolean,
): string[] | null {
  if (!colors || colors.length < 2) return null;
  return reversed ? [...colors].reverse() : colors;
}

/**
 * Builds the CSS `linear-gradient(...)` for a colorbar bar from ordered stops.
 *
 * @param stops - Ordered CSS colors (start to end of the ramp).
 * @param orientation - Bar orientation (sets the gradient direction).
 * @returns A `linear-gradient(...)` value, or '' when there are no stops.
 */
export function colorbarGradientCss(
  stops: string[],
  orientation: ColorbarOrientation,
): string {
  if (stops.length === 0) return '';
  const direction = orientation === 'vertical' ? 'to top' : 'to right';
  const css = stops
    .map((color, i) => `${color} ${(i / Math.max(1, stops.length - 1)) * 100}%`)
    .join(', ');
  return `linear-gradient(${direction}, ${css})`;
}

/**
 * A standalone colorbar legend rendered on the map as a MapLibre `IControl`.
 *
 * The ramp is sampled from the library's own colormap sprite (so named
 * colormaps and the `reversed` flag match the rendered raster exactly), or
 * built from a custom list of colors. Add it with
 * `map.addControl(new Colorbar({ colormap, min, max, ... }))` and reconfigure
 * live with {@link update} (e.g. from a `rasterchange` handler).
 */
export class Colorbar implements IControl {
  private _opts: ResolvedOptions;
  private _root: HTMLElement | null = null;
  private _bar: HTMLElement | null = null;
  // Guards async sprite sampling against out-of-order completion across
  // overlapping update() calls.
  private _colorToken = 0;

  /**
   * @param options - Initial colorbar configuration.
   */
  constructor(options: ColorbarOptions = {}) {
    this._opts = { ...DEFAULTS, ...options };
  }

  /** @returns The configured map corner. */
  getDefaultPosition(): ControlPosition {
    return this._opts.position;
  }

  /**
   * MapLibre `IControl` hook: builds and returns the legend element.
   *
   * @returns The root element MapLibre docks into its corner container.
   */
  onAdd(): HTMLElement {
    this._root = el('div', { className: 'maplibregl-ctrl mlr-colorbar' });
    this._render();
    return this._root;
  }

  /** MapLibre `IControl` hook: detaches the legend. */
  onRemove(): void {
    this._root?.parentNode?.removeChild(this._root);
    this._root = null;
    this._bar = null;
  }

  /**
   * Merges a partial configuration and re-renders. `position` changes only
   * take effect on the next add (MapLibre fixes a control's corner at
   * `addControl` time).
   *
   * @param options - Fields to change.
   */
  update(options: Partial<ColorbarOptions>): void {
    this._opts = { ...this._opts, ...options };
    if (this._root) this._render();
  }

  /** @returns A copy of the resolved options. */
  getOptions(): ColorbarOptions {
    return { ...this._opts };
  }

  /** Resolves the tick values shown along the bar. */
  private _tickValues(): number[] {
    if (this._opts.tickValues && this._opts.tickValues.length > 0) {
      return this._opts.tickValues;
    }
    const count = Math.max(2, Math.round(this._opts.ticks));
    const { min, max } = this._opts;
    return Array.from(
      { length: count },
      (_, i) => min + ((max - min) * i) / (count - 1),
    );
  }

  /** Formats a tick value with the configured units suffix. */
  private _formatTick(value: number): string {
    const text = String(fmtNumber(value));
    return this._opts.units ? `${text} ${this._opts.units}` : text;
  }

  private _render(): void {
    const root = this._root;
    if (!root) return;
    const vertical = this._opts.orientation === 'vertical';

    root.className = ['maplibregl-ctrl', 'mlr-colorbar', this._opts.className]
      .filter(Boolean)
      .join(' ');
    root.classList.add(vertical ? 'mlr-colorbar-vertical' : 'mlr-colorbar-horizontal');
    root.replaceChildren();

    if (this._opts.title) {
      const title = el('div', {
        className: 'mlr-colorbar-title',
        text: this._opts.title,
      });
      title.style.textAlign = this._opts.titleAlign;
      root.appendChild(title);
    }

    // The bar and the tick strip share the same main-axis length so labels
    // line up with the ramp ends.
    const bar = el('div', { className: 'mlr-colorbar-bar' });
    if (vertical) {
      bar.style.width = `${this._opts.barThickness}px`;
      bar.style.height = `${this._opts.barLength}px`;
    } else {
      bar.style.width = `${this._opts.barLength}px`;
      bar.style.height = `${this._opts.barThickness}px`;
    }
    this._bar = bar;

    const ticks = el('div', { className: 'mlr-colorbar-ticks' });
    if (vertical) {
      ticks.style.height = `${this._opts.barLength}px`;
    } else {
      ticks.style.width = `${this._opts.barLength}px`;
    }
    // Render high-to-low for a vertical bar so the max sits at the top, next
    // to the top of the ramp; horizontal stays low-to-high (left-to-right).
    const values = this._tickValues();
    const ordered = vertical ? [...values].reverse() : values;
    for (const value of ordered) {
      ticks.appendChild(
        el('span', { className: 'mlr-colorbar-tick', text: this._formatTick(value) }),
      );
    }

    const bardiv = el('div', { className: 'mlr-colorbar-track' }, bar, ticks);
    root.appendChild(bardiv);

    void this._applyColors();
  }

  /** Sets the bar gradient, sampling the sprite for named colormaps. */
  private async _applyColors(): Promise<void> {
    const token = ++this._colorToken;
    const bar = this._bar;
    if (!bar) return;

    let stops = customColorbarStops(this._opts.colors, this._opts.reversed);
    if (!stops) {
      stops = await sampleColormapStops(
        this._opts.colormap,
        GRADIENT_STOP_COUNT,
        this._opts.reversed,
      );
      if (token !== this._colorToken || !this._bar) return;
      if (stops.length === 0) {
        // Sprite unavailable (e.g. headless) or unknown name: a neutral
        // grayscale ramp keeps the legend readable rather than blank.
        stops = this._opts.reversed ? ['#ffffff', '#000000'] : ['#000000', '#ffffff'];
      }
    }

    bar.style.background = colorbarGradientCss(stops, this._opts.orientation);
  }
}
