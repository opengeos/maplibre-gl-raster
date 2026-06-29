import type { RenderEngine } from '../core/types';
import { el, select } from './dom';

export interface EngineSectionOptions {
  /** Currently active engine. */
  value: RenderEngine;
  /** Called when the user picks a different engine. */
  onChange: (engine: RenderEngine) => void;
}

const HELP =
  'Rendering backend. "maplibre-gl-raster" uses the deck.gl GPU pipeline (default). ' +
  '"cog-tiler-wasm" renders tiles on the CPU with a serverless WebAssembly tiler, ' +
  'loaded on demand. The choice applies to every layer.';

/**
 * Panel section letting the user choose the global rendering engine. It is a
 * thin wrapper over a `<select>`; the host wires {@link EngineSectionOptions.onChange}
 * to {@link import('../state/LayerManager').LayerManager.setEngine}.
 */
export class EngineSection {
  /** Root element to insert into the panel. */
  readonly el: HTMLElement;
  private _select: HTMLSelectElement;
  private _help: HTMLElement;

  constructor(options: EngineSectionOptions) {
    this._select = select(
      [
        { value: 'maplibre-gl-raster', label: 'maplibre-gl-raster (GPU)' },
        { value: 'cog-tiler-wasm', label: 'cog-tiler-wasm (WASM)' },
      ],
      options.value,
      (next) => options.onChange(next as RenderEngine),
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
    this.el = el(
      'div',
      { className: 'mlr-section mlr-engine' },
      el('div', { className: 'mlr-section-title-row' }, title, helpButton),
      this._help,
      this._select,
    );
  }

  /** Reflects the active engine on the select (e.g. after a programmatic
   * change). */
  setValue(value: RenderEngine): void {
    this._select.value = value;
  }
}
