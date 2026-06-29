import type { RasterSampleDataset } from '../core/types';
import { el } from './dom';

export type AddDataSectionOptions = {
  /** Prefills the URL input. */
  initialUrl?: string;
  /** Sample datasets offered as a "Load sample data" dropdown below the direct
   * URL/file inputs; picking one loads it immediately. Omit/empty to hide the
   * dropdown. */
  sampleData?: RasterSampleDataset[];
  /** Placeholder for the sample-data dropdown. */
  sampleDataLabel?: string;
  /** Called with a remote COG URL and the optional before-layer id. */
  onAddUrl: (url: string, beforeId?: string) => void;
  /** Called with a locally selected or dropped GeoTIFF file and the
   * optional before-layer id. */
  onAddFile: (file: File, beforeId?: string) => void;
};

/**
 * "Add data" section: URL input + Load button, plus a drop zone that accepts
 * `.tif` / `.tiff` files via click-to-browse or drag-and-drop. Ported from
 * cog-viewer's EmptyState.
 */
export class AddDataSection {
  /** Root element to insert into the panel. */
  readonly el: HTMLElement;

  /**
   * Creates the section.
   *
   * @param options - URL / file callbacks
   */
  constructor(options: AddDataSectionOptions) {
    // The accept attribute is advisory (and drag-drop bypasses it entirely),
    // so filter by extension before handing files to the raster loader.
    const isTiff = (file: File): boolean => /\.tiff?$/i.test(file.name);
    const input = el('input', {
      className: 'mlr-input',
      type: 'text',
      placeholder: 'https://…/cog.tif',
      value: options.initialUrl ?? '',
      ariaLabel: 'raster-url',
    });
    const loadBtn = el('button', {
      className: 'mlr-button',
      type: 'button',
      text: 'Load',
      disabled: input.value.trim().length === 0,
      ariaLabel: 'load-url',
    });
    input.addEventListener('input', () => {
      loadBtn.disabled = input.value.trim().length === 0;
    });

    // Optional: insert the raster beneath an existing style layer (e.g. a
    // symbol layer) so labels stay readable.
    const beforeIdInput = el('input', {
      className: 'mlr-input',
      type: 'text',
      placeholder: 'Before layer id (optional)',
      ariaLabel: 'before-id',
      title:
        'Id of an existing map layer to insert the raster beneath (e.g. a label layer). Leave empty to draw on top.',
    });
    const currentBeforeId = () => beforeIdInput.value.trim() || undefined;

    const submitUrl = () => {
      const url = input.value.trim();
      if (!url) return;
      // Keep the URL in the input after loading so the user can edit it or load
      // it again (e.g. after switching the rendering engine).
      options.onAddUrl(url, currentBeforeId());
    };
    loadBtn.addEventListener('click', submitUrl);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitUrl();
    });

    const urlRow = el('div', { className: 'mlr-row' }, input, loadBtn);

    // Optional "Load sample data" dropdown. A custom (not native <select>)
    // dropdown so the menu stays fully themeable in dark mode. Picking an
    // entry fills the URL input; the input stays empty otherwise (no
    // prefilled sample). Hidden when no samples are supplied.
    const samples = options.sampleData ?? [];
    let sampleRow: HTMLElement | undefined;
    if (samples.length > 0) {
      const placeholder = options.sampleDataLabel ?? 'Load sample data...';
      const triggerLabel = el('span', {
        className: 'mlr-sample-trigger-label',
        text: placeholder,
      });
      const trigger = el(
        'button',
        {
          className: 'mlr-sample-trigger',
          type: 'button',
          ariaLabel: placeholder,
          attrs: { 'aria-haspopup': 'listbox', 'aria-expanded': 'false' },
        },
        triggerLabel,
        el('span', { className: 'mlr-sample-caret', text: '▾' }),
      );
      const menu = el('div', {
        className: 'mlr-sample-menu',
        attrs: { role: 'listbox' },
      });
      menu.hidden = true;

      let menuOpen = false;
      const setMenuOpen = (open: boolean): void => {
        menuOpen = open;
        menu.hidden = !open;
        trigger.setAttribute('aria-expanded', String(open));
        trigger.classList.toggle('open', open);
        if (open) (menu.firstElementChild as HTMLElement | null)?.focus();
      };

      for (const sample of samples) {
        const option = el('button', {
          className: 'mlr-sample-option',
          type: 'button',
          text: sample.label,
          title: sample.url,
          attrs: { role: 'option' },
        });
        option.addEventListener('click', () => {
          setMenuOpen(false);
          trigger.focus();
          input.value = sample.url;
          loadBtn.disabled = input.value.trim().length === 0;
          submitUrl();
        });
        menu.appendChild(option);
      }

      trigger.addEventListener('click', () => setMenuOpen(!menuOpen));
      sampleRow = el('div', { className: 'mlr-sample-row' }, trigger, menu);
      // Close on Escape or when focus leaves the dropdown (avoids a
      // document-level listener that would need explicit teardown).
      sampleRow.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Escape' && menuOpen) {
          setMenuOpen(false);
          trigger.focus();
        }
      });
      sampleRow.addEventListener('focusout', (e) => {
        const next = (e as FocusEvent).relatedTarget as Node | null;
        if (!next || !sampleRow!.contains(next)) setMenuOpen(false);
      });
    }

    const fileInput = el('input', {
      type: 'file',
      ariaLabel: 'raster-file',
      attrs: { accept: '.tif,.tiff' },
    });
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', () => {
      const f = fileInput.files?.[0];
      if (f && isTiff(f)) options.onAddFile(f, currentBeforeId());
      fileInput.value = '';
    });

    const dropZone = el(
      'div',
      {
        className: 'mlr-drop-zone',
        text: 'Drop a .tif file here, or click to browse',
        attrs: { role: 'button', tabindex: '0' },
      },
      fileInput,
    );
    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fileInput.click();
      }
    });
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });
    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('dragover');
    });
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      const f = e.dataTransfer?.files[0];
      if (f && isTiff(f)) options.onAddFile(f, currentBeforeId());
    });

    this.el = el(
      'div',
      { className: 'mlr-section mlr-add-data' },
      el('div', { className: 'mlr-section-title', text: 'Add data' }),
      urlRow,
      dropZone,
      beforeIdInput,
      ...(sampleRow ? [sampleRow] : []),
    );
  }
}
