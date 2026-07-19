import type { RenderEngine } from '../core/types';
import { el, select } from './dom';

export interface EngineSectionOptions {
  /** Currently active engine. */
  value: RenderEngine;
  /** Called when the user picks a different engine. */
  onChange: (engine: RenderEngine) => void;
  /** Current TiTiler endpoint (shown in the endpoint input for the `titiler`
   * engine). */
  titilerEndpoint: string;
  /** Placeholder shown when the endpoint input is empty (the default URL). */
  titilerEndpointPlaceholder: string;
  /** Called when the user commits a new TiTiler endpoint. */
  onTitilerEndpointChange: (endpoint: string) => void;
}

const HELP =
  'Rendering backend. "maplibre-gl-raster" uses the deck.gl GPU pipeline (default) ' +
  'and renders a MosaicJSON or STAC mosaic client-side. "cog-tiler-wasm" renders ' +
  'tiles on the CPU with a serverless WebAssembly tiler, loaded on demand. ' +
  '"titiler" renders tiles (including a MosaicJSON) on a remote TiTiler server, ' +
  'reaching sources a browser cannot. The choice applies to every layer.';

/**
 * Panel section letting the user choose the global rendering engine, plus a
 * TiTiler endpoint input revealed while the `titiler` engine is active. The
 * host wires {@link EngineSectionOptions.onChange} to
 * {@link import('../state/LayerManager').LayerManager.setEngine} and
 * {@link EngineSectionOptions.onTitilerEndpointChange} to
 * {@link import('../state/LayerManager').LayerManager.setTitilerEndpoint}.
 */
export class EngineSection {
  /** Root element to insert into the panel. */
  readonly el: HTMLElement;
  private _select: HTMLSelectElement;
  private _help: HTMLElement;
  private _endpointRow: HTMLElement;
  private _endpointInput: HTMLInputElement;

  constructor(options: EngineSectionOptions) {
    this._select = select(
      [
        { value: 'maplibre-gl-raster', label: 'maplibre-gl-raster (GPU)' },
        { value: 'cog-tiler-wasm', label: 'cog-tiler-wasm (WASM)' },
        { value: 'titiler', label: 'titiler (server)' },
      ],
      options.value,
      (next) => {
        this._syncEndpointVisibility(next as RenderEngine);
        options.onChange(next as RenderEngine);
      },
      'render-engine',
    );
    const title = el('span', {
      className: 'mlr-section-title',
      text: 'Rendering engine',
    });
    const helpButton = el('button', {
      className: 'mlr-info-button',
      type: 'button',
      text: 'i',
      title: HELP,
      ariaLabel: 'Rendering engine help',
      attrs: { 'aria-expanded': 'false' },
    });
    this._help = el('div', {
      className: 'mlr-tooltip',
      text: HELP,
      attrs: { role: 'tooltip' },
    });
    this._help.hidden = true;
    const setHelpOpen = (open: boolean): void => {
      this._help.hidden = !open;
      helpButton.setAttribute('aria-expanded', String(open));
    };
    helpButton.addEventListener('click', () =>
      setHelpOpen(this._help.hidden === true),
    );
    helpButton.addEventListener('blur', () => setHelpOpen(false));

    // TiTiler endpoint input: shown only while the titiler engine is active. It
    // commits on Enter or blur so a mid-typing value never fires a reload.
    this._endpointInput = el('input', {
      className: 'mlr-input',
      type: 'text',
      value: options.titilerEndpoint,
      placeholder: options.titilerEndpointPlaceholder,
      ariaLabel: 'titiler-endpoint',
      title:
        'Base URL of the TiTiler server used to render tiles. Leave empty for the default.',
    }) as HTMLInputElement;
    const commit = (): void =>
      options.onTitilerEndpointChange(this._endpointInput.value.trim());
    this._endpointInput.addEventListener('change', commit);
    this._endpointInput.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') {
        this._endpointInput.blur();
      }
    });
    this._endpointRow = el(
      'div',
      { className: 'mlr-engine-endpoint' },
      el('span', {
        className: 'mlr-field-label',
        text: 'TiTiler server',
      }),
      this._endpointInput,
    );

    this.el = el(
      'div',
      { className: 'mlr-section mlr-engine' },
      el('div', { className: 'mlr-section-title-row' }, title, helpButton),
      this._help,
      this._select,
      this._endpointRow,
    );
    this._syncEndpointVisibility(options.value);
  }

  /** Reflects the active engine on the select (e.g. after a programmatic
   * change), keeping the endpoint input's visibility in sync. */
  setValue(value: RenderEngine): void {
    this._select.value = value;
    this._syncEndpointVisibility(value);
  }

  /** Reflects the active TiTiler endpoint on the input (e.g. after a
   * programmatic change or a normalized empty→default value). Leaves the input
   * untouched while it has focus so it never fights the user's typing. */
  setEndpoint(endpoint: string): void {
    if (document.activeElement === this._endpointInput) return;
    this._endpointInput.value = endpoint;
  }

  private _syncEndpointVisibility(engine: RenderEngine): void {
    this._endpointRow.hidden = engine !== 'titiler';
  }
}
