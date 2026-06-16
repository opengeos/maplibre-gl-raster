import type { ControlPosition } from 'maplibre-gl';
import type { ColorbarOrientation } from '../core/Colorbar';
import type {
  RasterColorbarState,
  RasterLayerState,
  RasterMode,
  RasterStretch,
} from '../core/types';
import {
  autoRangeFor,
  statsForBand,
} from '../raster/render-pipeline';
import type { AutoStats, BandStats } from '../raster/stats';
import { MAX_BAND_SLOTS } from '../raster/tile-loader';
import type { RasterLayer } from '../state/RasterLayer';
import { BandHistogram } from './BandHistogram';
import { ColormapPicker, PALETTE_COLORMAP } from './ColormapPicker';
import { clearEl, el, field, fmtNumber, select } from './dom';

const RGB_CHANNELS = [
  { label: 'R', color: '#d63838' },
  { label: 'G', color: '#2c8a2c' },
  { label: 'B', color: '#2a6db8' },
] as const;

const HELP = {
  mode: 'RGB / composite picks one band per output channel for true- or false-color images. Single band sends one band through a colormap.',
  bandsRgb:
    'Pick which band feeds each output channel. Native order is usually 1=red, 2=green, 3=blue; reorder to make false-color composites.',
  bandSingle: "Which band's pixel values feed the colormap.",
  rescale:
    'Maps a window of source values to the colormap input. Drag the histogram handles, type values, or pick a preset.',
  colormap:
    'Color lookup applied to the rescaled value (after the curve, before nodata).',
  reversed:
    'Sample the colormap from end to start, equivalent to a reversed variant of the ramp.',
  colorbar:
    "Show a legend on the map for this layer's colormap and value range.",
  nodata:
    "Auto reads the nodata value from the COG's GDAL_NODATA tag (NaN counts as nodata for float data); Value lets you specify one in source units; Off renders every pixel.",
  curve:
    'How values inside the rescale window are distributed across the colormap. Log and Sqrt expand the lower part of the window.',
  gamma:
    'Power-law correction applied after the curve. Gamma > 1 lifts shadows; gamma < 1 deepens them. 1.0 disables it. Double-click to reset.',
  opacity: 'Layer transparency, 0 (invisible) to 1 (fully opaque).',
  preset2to98:
    '2nd-98th percentile of pixel values. Ignores extreme outliers (the QGIS / rio-tiler default).',
  presetMinMax: 'Map the full pixel-value extent of the band.',
} as const;

const PRESET_EPSILON = 1e-6;
const rangesMatch = (a: [number, number], b: [number, number]) =>
  Math.abs(a[0] - b[0]) < PRESET_EPSILON &&
  Math.abs(a[1] - b[1]) < PRESET_EPSILON;

type Preset = 'percentile' | 'minmax' | 'custom';

/** Hooks wiring the Settings header's inspect toggle to a PixelInspector. */
export interface InspectHooks {
  /** Flip inspect mode on/off. */
  onToggle: () => void;
  /** Whether inspect mode is currently active. */
  isActive: () => boolean;
}

const INSPECT_HELP =
  'Inspect mode: click the map to read the raw pixel values of this layer at that location.';

function bandLabel(idx: number, names: Map<number, string> | null): string {
  const name = names?.get(idx);
  return name ? `${idx} — ${name}` : String(idx);
}

/** One histogram + min/max numeric inputs for a band's rescale range. */
class RescaleRow {
  readonly el: HTMLElement;
  private _hist: BandHistogram;
  private _histSlot: HTMLElement;
  private _minInput: HTMLInputElement;
  private _maxInput: HTMLInputElement;
  private _value: [number, number] = [0, 1];

  constructor(opts: {
    color: string;
    label?: string;
    ariaPrefix: string;
    onChange: (next: [number, number]) => void;
    onDragStart?: () => void;
    onDragEnd?: () => void;
  }) {
    this._hist = new BandHistogram({
      color: opts.color,
      label: opts.label,
      onChange: (next) => {
        this._value = next;
        this._syncInputs();
        opts.onChange(next);
      },
      onDragStart: opts.onDragStart,
      onDragEnd: opts.onDragEnd,
    });
    this._histSlot = el('div');

    this._minInput = el('input', {
      className: 'mlr-input',
      type: 'number',
      ariaLabel: `${opts.ariaPrefix}-min`,
      attrs: { step: 'any' },
    });
    this._maxInput = el('input', {
      className: 'mlr-input',
      type: 'number',
      ariaLabel: `${opts.ariaPrefix}-max`,
      attrs: { step: 'any' },
    });
    const onInput = () => {
      const next: [number, number] = [
        Number(this._minInput.value),
        Number(this._maxInput.value),
      ];
      this._value = next;
      this._hist.setValue(next);
      opts.onChange(next);
    };
    this._minInput.addEventListener('change', onInput);
    this._maxInput.addEventListener('change', onInput);

    const inputs = el(
      'div',
      { className: 'mlr-row' },
      this._minInput,
      this._maxInput,
    );
    this.el = el(
      'div',
      { className: 'mlr-rescale-row' },
      this._histSlot,
      inputs,
    );
  }

  update(stats: BandStats | null, value: [number, number]): void {
    this._value = value;
    if (stats) {
      if (!this._histSlot.contains(this._hist.el)) {
        this._histSlot.appendChild(this._hist.el);
      }
      this._hist.update(stats, value);
    } else if (this._hist.el.parentNode === this._histSlot) {
      this._histSlot.removeChild(this._hist.el);
    }
    this._syncInputs();
  }

  private _syncInputs(): void {
    this._minInput.value = String(fmtNumber(this._value[0]));
    this._maxInput.value = String(fmtNumber(this._value[1]));
  }
}

/**
 * Per-layer settings UI: mode, band selection, rescale (histogram +
 * presets), colormap, nodata, stretch curve, gamma, and opacity. A vanilla
 * DOM port of cog-viewer's ControlsPanel scoped to the selected layer.
 *
 * Re-render strategy: the section fully rebuilds on selection / structural
 * changes; continuous controls (sliders, histogram drags) update state with
 * a self-apply guard so the host can skip re-rendering mid-interaction.
 */
export class SettingsSection {
  /** Root element to insert into the panel. */
  readonly el: HTMLElement;
  private _body: HTMLElement;
  private _title: HTMLElement;
  private _inspect: InspectHooks | null;
  private _inspectBtn: HTMLButtonElement | null = null;
  private _getLayer: () => RasterLayer | null;
  private _setState: (patch: Partial<RasterLayerState>) => void;
  private _applying = false;
  private _dragCount = 0;
  private _dirty = false;
  /** Collapsed/expanded state of the Rescale section, preserved across the
   * full re-renders this section performs on every structural change. */
  private _rescaleOpen = true;

  /**
   * Creates the section.
   *
   * @param getLayer - Returns the currently selected layer (or null)
   * @param setState - Applies a state patch to the selected layer
   */
  constructor(
    getLayer: () => RasterLayer | null,
    setState: (patch: Partial<RasterLayerState>) => void,
    inspect?: InspectHooks,
  ) {
    this._getLayer = getLayer;
    this._inspect = inspect ?? null;
    this._setState = (patch) => {
      this._applying = true;
      try {
        setState(patch);
      } finally {
        this._applying = false;
      }
    };
    this._title = el('span', { className: 'mlr-section-title', text: 'Settings' });
    const header = el('div', { className: 'mlr-settings-header' }, this._title);
    if (this._inspect) {
      this._inspectBtn = el('button', {
        className: 'mlr-inspect-toggle',
        type: 'button',
        text: 'Inspect',
        title: INSPECT_HELP,
        ariaLabel: 'inspect-toggle',
      });
      this._inspectBtn.addEventListener('click', () => {
        this._inspect!.onToggle();
        this._syncInspectButton();
      });
      header.appendChild(this._inspectBtn);
    }
    this._body = el('div', { className: 'mlr-settings-body' });
    this.el = el(
      'div',
      { className: 'mlr-section mlr-settings' },
      header,
      this._body,
    );
    this.render();
  }

  /** Reflects the inspector's active state on the toggle button. */
  private _syncInspectButton(): void {
    if (!this._inspectBtn || !this._inspect) return;
    const active = this._inspect.isActive();
    this._inspectBtn.classList.toggle('active', active);
    this._inspectBtn.setAttribute('aria-pressed', String(active));
  }

  /** Reacts to a LayerManager change event: rebuilds unless the change came
   * from this UI or a histogram drag is active (deferred until drag end). */
  notifyChange(): void {
    if (this._applying) return;
    if (this._dragCount > 0) {
      this._dirty = true;
      return;
    }
    this.render();
  }

  /** Fully rebuilds the section from the selected layer. */
  render(): void {
    const layer = this._getLayer();
    clearEl(this._body);
    this._dirty = false;
    this._syncInspectButton();

    if (!layer) {
      this.el.style.display = 'none';
      return;
    }
    this.el.style.display = '';
    this._title.textContent = `Settings — ${layer.name}`;

    if (layer.loading) {
      this._body.appendChild(
        el('div', { className: 'mlr-empty', text: 'Loading…' }),
      );
      return;
    }
    if (layer.error) {
      this._body.appendChild(
        el('div', {
          className: 'mlr-error',
          text: `Failed to load: ${layer.error.message}`,
        }),
      );
      return;
    }

    const state = layer.state;
    const mode: RasterMode = state.mode;
    const bandOptions = Array.from(
      { length: Math.min(layer.bandCount ?? MAX_BAND_SLOTS, MAX_BAND_SLOTS) },
      (_, i) => i + 1,
    );

    // The embedded color table maps raw index values directly to colors, so
    // rescale / curve / gamma have no effect while it is active.
    const paletteActive =
      mode === 'single' &&
      state.colormap === PALETTE_COLORMAP &&
      layer.palette !== null;

    this._body.appendChild(this._buildModeField(state, mode, bandOptions));
    this._body.appendChild(
      this._buildBandsField(layer, state, mode, bandOptions),
    );
    if (!paletteActive) {
      this._body.appendChild(this._buildRescaleField(layer, state, mode));
    }
    if (mode === 'single') {
      const picker = new ColormapPicker({
        value: state.colormap,
        palette: layer.palette,
        stats: statsForBand(layer.autoStats, state.bands[0] ?? 1),
        onChange: (name) => {
          this._setState({ colormap: name });
          // Switching to/from the palette shows/hides rescale-curve-gamma.
          this.render();
        },
      });
      this._body.appendChild(field('Colormap', picker.el, HELP.colormap));
      // Reversing a categorical embedded palette is meaningless, so the toggle
      // only shows for named colormaps. The colorbar legend likewise needs a
      // continuous range, so it is offered for named colormaps too.
      if (!paletteActive) {
        this._body.appendChild(this._buildReverseField(state));
        this._body.appendChild(this._buildColorbarField(state));
      }
    }
    this._body.appendChild(this._buildNodataField(state));
    if (!paletteActive) {
      this._body.appendChild(this._buildCurveField(state));
      this._body.appendChild(this._buildGammaField(state));
    }
    this._body.appendChild(this._buildOpacityField(state));
  }

  private _buildModeField(
    state: RasterLayerState,
    mode: RasterMode,
    bandOptions: number[],
  ): HTMLElement {
    // Clamp the RGB default to the bands that actually exist so 1- or
    // 2-band rasters don't get invalid indices written into state.
    const maxBand = bandOptions[bandOptions.length - 1] ?? 1;
    const rgbDefault = [1, 2, 3].map((b) => Math.min(b, maxBand));
    const modeSelect = select(
      [
        { value: 'rgb', label: 'RGB / composite' },
        { value: 'single', label: 'Single band + colormap' },
      ],
      mode,
      (next) => {
        this._setState({
          mode: next as RasterMode,
          bands: next === 'single' ? [state.bands[0] ?? 1] : rgbDefault,
          rescale: null,
        });
        this.render();
      },
      'mode',
    );
    return field('Mode', modeSelect, HELP.mode);
  }

  private _buildBandsField(
    layer: RasterLayer,
    state: RasterLayerState,
    mode: RasterMode,
    bandOptions: number[],
  ): HTMLElement {
    const options = bandOptions.map((n) => ({
      value: String(n),
      label: bandLabel(n, layer.bandNames),
    }));
    if (mode === 'single') {
      const bandSelect = select(
        options,
        String(state.bands[0] ?? 1),
        (next) => {
          this._setState({ bands: [Number(next)] });
          this.render();
        },
        'band',
      );
      return field('Band', bandSelect, HELP.bandSingle);
    }
    const row = el('div', { className: 'mlr-band-grid' });
    RGB_CHANNELS.forEach(({ label }, i) => {
      row.appendChild(
        select(
          options,
          String(state.bands[i] ?? bandOptions[0] ?? 1),
          (next) => {
            const bands = [...state.bands];
            bands[i] = Number(next);
            this._setState({ bands });
            this.render();
          },
          `band-${label.toLowerCase()}`,
        ),
      );
    });
    return field('Bands (R, G, B)', row, HELP.bandsRgb);
  }

  private _buildRescaleField(
    layer: RasterLayer,
    state: RasterLayerState,
    mode: RasterMode,
  ): HTMLElement {
    const autoStats: AutoStats | null = layer.autoStats;
    const channelCount = mode === 'single' ? 1 : 3;
    const bands = state.bands;

    const perBandStats: (BandStats | null)[] = Array.from(
      { length: channelCount },
      (_, i) => statsForBand(autoStats, bands[i] ?? bands[0] ?? 1),
    );
    const perBandPercentile: ([number, number] | null)[] = perBandStats.map(
      (s) => (s ? autoRangeFor(s) : null),
    );
    const perBandMinMax: ([number, number] | null)[] = perBandStats.map((s) =>
      s ? [s.min, s.max] : null,
    );
    const values: [number, number][] = Array.from(
      { length: channelCount },
      (_, i) => state.rescale?.[i] ?? perBandPercentile[i] ?? [0, 1],
    );

    const setChannel = (i: number, next: [number, number]) => {
      const out = values.map((v) => [...v] as [number, number]);
      out[i] = next;
      out.forEach((v, j) => {
        values[j] = v;
      });
      this._setState({ rescale: out });
    };

    const wrap = el('div', { className: 'mlr-rescale' });
    const rows: RescaleRow[] = [];
    for (let i = 0; i < channelCount; i++) {
      const channel = mode === 'single' ? null : RGB_CHANNELS[i];
      const row = new RescaleRow({
        color: channel?.color ?? 'var(--mlr-histogram-neutral)',
        label: channel?.label,
        ariaPrefix:
          mode === 'single'
            ? 'rescale'
            : `rescale-${channel!.label.toLowerCase()}`,
        onChange: (next) => setChannel(i, next),
        onDragStart: () => {
          this._dragCount++;
        },
        onDragEnd: () => {
          this._dragCount = Math.max(0, this._dragCount - 1);
          if (this._dirty) this.render();
        },
      });
      row.update(perBandStats[i], values[i]);
      rows.push(row);
      wrap.appendChild(row.el);
    }

    // Preset buttons (only when stats exist to derive them from).
    if (perBandStats.some((s) => s !== null)) {
      const isAuto = state.rescale === null;
      const current: ([number, number] | null)[] = state.rescale
        ? Array.from({ length: channelCount }, (_, i) => state.rescale![i] ?? null)
        : new Array(channelCount).fill(null);
      const matches = (preset: ([number, number] | null)[]) =>
        current.every((c, i) => {
          const p = preset[i];
          if (!c || !p) return false;
          return rangesMatch(c, p);
        });
      const active: Preset = isAuto
        ? 'percentile'
        : matches(perBandPercentile)
          ? 'percentile'
          : matches(perBandMinMax)
            ? 'minmax'
            : 'custom';

      const presetRow = el('div', { className: 'mlr-preset-row' });
      presetRow.appendChild(
        this._presetButton('2–98%', active === 'percentile', HELP.preset2to98, () => {
          this._setState({ rescale: null });
          this.render();
        }),
      );
      presetRow.appendChild(
        this._presetButton('Min/Max', active === 'minmax', HELP.presetMinMax, () => {
          this._setState({
            rescale: perBandMinMax.map<[number, number]>(
              (m, i) => m ?? values[i],
            ),
          });
          this.render();
        }),
      );
      wrap.appendChild(presetRow);
    }

    // Collapsible: histograms are tall, and users often only need them while
    // tuning. The open state persists across re-renders.
    const details = el('details', { className: 'mlr-field mlr-collapsible' });
    const summary = el('summary', {
      className: 'mlr-field-label',
      text: 'Rescale',
      title: HELP.rescale,
    });
    details.append(summary, wrap);
    details.open = this._rescaleOpen;
    details.addEventListener('toggle', () => {
      this._rescaleOpen = details.open;
    });
    return details;
  }

  private _buildNodataField(state: RasterLayerState): HTMLElement {
    const wrap = el('div', { className: 'mlr-row' });
    const modeValue =
      state.nodata === 'off'
        ? 'off'
        : state.nodata === 'auto'
          ? 'auto'
          : 'value';
    wrap.appendChild(
      select(
        [
          { value: 'auto', label: 'Auto (from COG)' },
          { value: 'value', label: 'Value' },
          { value: 'off', label: 'Off' },
        ],
        modeValue,
        (next) => {
          if (next === 'auto') this._setState({ nodata: 'auto' });
          else if (next === 'off') this._setState({ nodata: 'off' });
          else this._setState({ nodata: 0 });
          this.render();
        },
        'nodata-mode',
      ),
    );
    if (typeof state.nodata === 'number') {
      const input = el('input', {
        className: 'mlr-input',
        type: 'number',
        value: String(state.nodata),
        ariaLabel: 'nodata-value',
        attrs: { step: 'any' },
      });
      input.addEventListener('change', () =>
        this._setState({ nodata: Number(input.value) }),
      );
      wrap.appendChild(input);
    }
    return field('Nodata', wrap, HELP.nodata);
  }

  private _buildReverseField(state: RasterLayerState): HTMLElement {
    const input = el('input', {
      type: 'checkbox',
      ariaLabel: 'Reverse colormap',
    }) as HTMLInputElement;
    input.checked = state.reversed ?? false;
    input.addEventListener('change', () => {
      this._setState({ reversed: input.checked });
    });
    // A lone checkbox reads better inline with its label than stacked under a
    // field caption, so this row skips the field() label/content layout.
    const row = el(
      'label',
      { className: 'mlr-check', title: HELP.reversed },
      input,
      el('span', { text: 'Reverse colormap' }),
    );
    return el('div', { className: 'mlr-field' }, row);
  }

  private _buildColorbarField(state: RasterLayerState): HTMLElement {
    // Read the live colorbar state on each edit (not this render's snapshot) so
    // editing one field never clobbers another set since the last render.
    const patch = (next: Partial<RasterColorbarState>): void => {
      const current = this._getLayer()?.state.colorbar;
      this._setState({ colorbar: { visible: true, ...current, ...next } });
    };

    const toggle = el('input', {
      type: 'checkbox',
      ariaLabel: 'Show colorbar',
    }) as HTMLInputElement;
    const visible = state.colorbar?.visible ?? false;
    toggle.checked = visible;
    toggle.addEventListener('change', () => {
      const current = this._getLayer()?.state.colorbar;
      this._setState({ colorbar: { ...current, visible: toggle.checked } });
      // Reveal / hide the title / orientation / position controls.
      this.render();
    });
    const wrap = el(
      'div',
      { className: 'mlr-field' },
      el(
        'label',
        { className: 'mlr-check', title: HELP.colorbar },
        toggle,
        el('span', { text: 'Show colorbar' }),
      ),
    );
    if (!visible) return wrap;

    const title = el('input', {
      className: 'mlr-input',
      type: 'text',
      ariaLabel: 'colorbar-title',
      placeholder: 'Layer name',
      value: state.colorbar?.title ?? '',
    }) as HTMLInputElement;
    title.addEventListener('change', () => patch({ title: title.value }));
    wrap.appendChild(field('Legend title', title));

    const units = el('input', {
      className: 'mlr-input',
      type: 'text',
      ariaLabel: 'colorbar-units',
      placeholder: 'e.g. m',
      value: state.colorbar?.units ?? '',
    }) as HTMLInputElement;
    units.addEventListener('change', () => patch({ units: units.value }));
    wrap.appendChild(field('Units', units));

    wrap.appendChild(
      field(
        'Orientation',
        select(
          [
            { value: 'horizontal', label: 'Horizontal' },
            { value: 'vertical', label: 'Vertical' },
          ],
          state.colorbar?.orientation ?? 'horizontal',
          (next) => patch({ orientation: next as ColorbarOrientation }),
          'colorbar-orientation',
        ),
      ),
    );

    wrap.appendChild(
      field(
        'Position',
        select(
          [
            { value: 'top-left', label: 'Top left' },
            { value: 'top-right', label: 'Top right' },
            { value: 'bottom-left', label: 'Bottom left' },
            { value: 'bottom-right', label: 'Bottom right' },
          ],
          state.colorbar?.position ?? 'bottom-right',
          (next) => patch({ position: next as ControlPosition }),
          'colorbar-position',
        ),
      ),
    );

    return wrap;
  }

  private _buildCurveField(state: RasterLayerState): HTMLElement {
    const wrap = el('div', { className: 'mlr-preset-row' });
    const options: { value: RasterStretch; label: string }[] = [
      { value: 'linear', label: 'Linear' },
      { value: 'sqrt', label: 'Sqrt' },
      { value: 'log', label: 'Log' },
    ];
    for (const o of options) {
      wrap.appendChild(
        this._presetButton(o.label, state.stretch === o.value, undefined, () => {
          this._setState({ stretch: o.value });
          this.render();
        }),
      );
    }
    return field('Curve', wrap, HELP.curve);
  }

  private _buildGammaField(state: RasterLayerState): HTMLElement {
    const label = el('span', {
      className: 'mlr-field-label',
      text: `Gamma (${state.gamma.toFixed(2)})`,
      title: HELP.gamma,
    });
    const input = el('input', {
      type: 'range',
      className: 'mlr-slider',
      ariaLabel: 'gamma',
      attrs: { min: '0.1', max: '3', step: '0.05' },
      value: String(state.gamma),
    });
    input.addEventListener('input', () => {
      const gamma = Number(input.value);
      label.textContent = `Gamma (${gamma.toFixed(2)})`;
      this._setState({ gamma });
    });
    input.addEventListener('dblclick', () => {
      input.value = '1';
      label.textContent = 'Gamma (1.00)';
      this._setState({ gamma: 1 });
    });
    return el('div', { className: 'mlr-field' }, label, input);
  }

  private _buildOpacityField(state: RasterLayerState): HTMLElement {
    const label = el('span', {
      className: 'mlr-field-label',
      text: `Opacity (${state.opacity.toFixed(2)})`,
      title: HELP.opacity,
    });
    const input = el('input', {
      type: 'range',
      className: 'mlr-slider',
      ariaLabel: 'opacity',
      attrs: { min: '0', max: '1', step: '0.01' },
      value: String(state.opacity),
    });
    input.addEventListener('input', () => {
      const opacity = Number(input.value);
      label.textContent = `Opacity (${opacity.toFixed(2)})`;
      this._setState({ opacity });
    });
    return el('div', { className: 'mlr-field' }, label, input);
  }

  private _presetButton(
    label: string,
    active: boolean,
    help: string | undefined,
    onClick: () => void,
  ): HTMLButtonElement {
    const btn = el('button', {
      className: `mlr-preset-button${active ? ' active' : ''}`,
      type: 'button',
      text: label,
      title: help,
      attrs: { 'aria-pressed': String(active) },
    });
    btn.addEventListener('click', onClick);
    return btn;
  }
}
