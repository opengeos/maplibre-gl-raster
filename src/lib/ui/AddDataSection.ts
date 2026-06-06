import { el } from './dom';

export type AddDataSectionOptions = {
  /** Called with a remote COG URL. */
  onAddUrl: (url: string) => void;
  /** Called with a locally selected or dropped GeoTIFF file. */
  onAddFile: (file: File) => void;
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
    const input = el('input', {
      className: 'mlr-input',
      type: 'text',
      placeholder: 'https://…/cog.tif',
      ariaLabel: 'raster-url',
    });
    const loadBtn = el('button', {
      className: 'mlr-button',
      type: 'button',
      text: 'Load',
      disabled: true,
      ariaLabel: 'load-url',
    });
    input.addEventListener('input', () => {
      loadBtn.disabled = input.value.trim().length === 0;
    });
    const submitUrl = () => {
      const url = input.value.trim();
      if (!url) return;
      input.value = '';
      loadBtn.disabled = true;
      options.onAddUrl(url);
    };
    loadBtn.addEventListener('click', submitUrl);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitUrl();
    });

    const urlRow = el('div', { className: 'mlr-row' }, input, loadBtn);

    const fileInput = el('input', {
      type: 'file',
      ariaLabel: 'raster-file',
      attrs: { accept: '.tif,.tiff' },
    });
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', () => {
      const f = fileInput.files?.[0];
      if (f) options.onAddFile(f);
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
      if (e.key === 'Enter' || e.key === ' ') fileInput.click();
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
      if (f) options.onAddFile(f);
    });

    this.el = el(
      'div',
      { className: 'mlr-section mlr-add-data' },
      el('div', { className: 'mlr-section-title', text: 'Add data' }),
      urlRow,
      dropZone,
    );
  }
}
