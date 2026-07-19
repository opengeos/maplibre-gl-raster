import { describe, it, expect, vi } from 'vitest';
import { AddDataSection } from '../src/lib/ui/AddDataSection';

function createSection(
  overrides: Partial<
    Parameters<typeof AddDataSection.prototype.constructor>[0]
  > = {},
) {
  const onAddUrl = vi.fn();
  const onAddFile = vi.fn();
  const section = new AddDataSection({ onAddUrl, onAddFile, ...overrides });
  document.body.appendChild(section.el);
  return { section, onAddUrl, onAddFile };
}

function tiff(name: string): File {
  return new File([new Uint8Array([0])], name, { type: 'image/tiff' });
}

describe('AddDataSection local files', () => {
  it('allows selecting multiple files at once', () => {
    const { section } = createSection();
    const input = section.el.querySelector<HTMLInputElement>(
      'input[aria-label=raster-file]',
    )!;
    expect(input.multiple).toBe(true);
  });

  it('adds raster and mosaic files (.tif/.vrt/.json), skipping other files', () => {
    const { section, onAddFile } = createSection();
    const input = section.el.querySelector<HTMLInputElement>(
      'input[aria-label=raster-file]',
    )!;

    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [
        tiff('a.tif'),
        tiff('b.tiff'),
        new File([''], 'mosaic.vrt'),
        new File([''], 'items.json'),
        new File([''], 'notes.txt'),
      ],
    });
    input.dispatchEvent(new Event('change'));

    // The .txt is skipped; the .tif/.tiff/.vrt/.json are all added in order.
    expect(onAddFile).toHaveBeenCalledTimes(4);
    expect(onAddFile.mock.calls.map((c) => (c[0] as File).name)).toEqual([
      'a.tif',
      'b.tiff',
      'mosaic.vrt',
      'items.json',
    ]);
    // The picker advertises the mosaic extensions too.
    expect(input.accept).toContain('.json');
    expect(input.accept).toContain('.vrt');
    // Selection is cleared so re-picking the same files fires again.
    expect(input.value).toBe('');
  });

  it('passes the before-layer id with each added file', () => {
    const { section, onAddFile } = createSection();
    const beforeId = section.el.querySelector<HTMLInputElement>(
      'input[aria-label=before-id]',
    )!;
    beforeId.value = 'labels';

    const input = section.el.querySelector<HTMLInputElement>(
      'input[aria-label=raster-file]',
    )!;
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [tiff('a.tif'), tiff('b.tif')],
    });
    input.dispatchEvent(new Event('change'));

    expect(onAddFile).toHaveBeenNthCalledWith(
      1,
      expect.any(File),
      'labels',
      undefined,
    );
    expect(onAddFile).toHaveBeenNthCalledWith(
      2,
      expect.any(File),
      'labels',
      undefined,
    );
  });

  it('passes the attribution with each added file', () => {
    const { section, onAddFile } = createSection();
    const attribution = section.el.querySelector<HTMLInputElement>(
      'input[aria-label=attribution]',
    )!;
    attribution.value = '© GEBCO';

    const input = section.el.querySelector<HTMLInputElement>(
      'input[aria-label=raster-file]',
    )!;
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [tiff('a.tif')],
    });
    input.dispatchEvent(new Event('change'));

    expect(onAddFile).toHaveBeenCalledWith(
      expect.any(File),
      undefined,
      '© GEBCO',
    );
  });

  it('passes the attribution when loading a URL, trimming blanks to undefined', () => {
    const { section, onAddUrl } = createSection();
    const url = section.el.querySelector<HTMLInputElement>(
      'input[aria-label=raster-url]',
    )!;
    const attribution = section.el.querySelector<HTMLInputElement>(
      'input[aria-label=attribution]',
    )!;
    const loadBtn = section.el.querySelector<HTMLButtonElement>(
      'button[aria-label=load-url]',
    )!;

    url.value = 'https://example.com/a.tif';
    url.dispatchEvent(new Event('input'));
    attribution.value = '  © NOAA  ';
    loadBtn.click();
    expect(onAddUrl).toHaveBeenCalledWith(
      'https://example.com/a.tif',
      undefined,
      '© NOAA',
    );

    attribution.value = '   ';
    loadBtn.click();
    expect(onAddUrl).toHaveBeenLastCalledWith(
      'https://example.com/a.tif',
      undefined,
      undefined,
    );
  });

  it('adds every dropped .tif file', () => {
    const { section, onAddFile } = createSection();
    const dropZone = section.el.querySelector<HTMLElement>('.mlr-drop-zone')!;

    const event = new Event('drop') as Event & { dataTransfer: unknown };
    Object.defineProperty(event, 'dataTransfer', {
      value: { files: [tiff('one.tif'), tiff('two.tif')] },
    });
    dropZone.dispatchEvent(event);

    expect(onAddFile).toHaveBeenCalledTimes(2);
    expect((onAddFile.mock.calls[0][0] as File).name).toBe('one.tif');
    expect((onAddFile.mock.calls[1][0] as File).name).toBe('two.tif');
  });
});

describe('AddDataSection sample dropdown', () => {
  it('renders no dropdown when no samples are given', () => {
    const { section } = createSection();
    expect(section.el.querySelector('.mlr-sample-row')).toBeNull();
  });

  it('renders no dropdown for an empty sample list', () => {
    const { section } = createSection({ sampleData: [] });
    expect(section.el.querySelector('.mlr-sample-row')).toBeNull();
  });

  it('renders a trigger plus one option per sample, with the input left empty', () => {
    const { section } = createSection({
      sampleData: [
        { label: 'Land cover', url: 'https://example.com/landcover.tif' },
        { label: 'Elevation', url: 'https://example.com/dem.tif' },
      ],
    });

    const trigger = section.el.querySelector('.mlr-sample-trigger')!;
    expect(
      trigger.querySelector('.mlr-sample-trigger-label')!.textContent,
    ).toBe('Load sample data...');
    const menu = section.el.querySelector<HTMLElement>('.mlr-sample-menu')!;
    expect(menu.hidden).toBe(true);
    const options = Array.from(
      section.el.querySelectorAll('.mlr-sample-option'),
    );
    expect(options.map((o) => o.textContent)).toEqual([
      'Land cover',
      'Elevation',
    ]);

    const input = section.el.querySelector<HTMLInputElement>(
      'input[aria-label=raster-url]',
    )!;
    expect(input.value).toBe('');
  });

  it('uses a custom placeholder when provided', () => {
    const { section } = createSection({
      sampleDataLabel: 'Try a COG...',
      sampleData: [
        { label: 'Land cover', url: 'https://example.com/landcover.tif' },
      ],
    });
    expect(
      section.el.querySelector('.mlr-sample-trigger-label')!.textContent,
    ).toBe('Try a COG...');
  });

  it('opens the menu when the trigger is clicked', () => {
    const { section } = createSection({
      sampleData: [
        { label: 'Land cover', url: 'https://example.com/landcover.tif' },
      ],
    });
    const trigger = section.el.querySelector<HTMLButtonElement>(
      '.mlr-sample-trigger',
    )!;
    const menu = section.el.querySelector<HTMLElement>('.mlr-sample-menu')!;

    trigger.click();
    expect(menu.hidden).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    trigger.click();
    expect(menu.hidden).toBe(true);
  });

  it('renders the sample dropdown after the direct URL, file, before-id, and attribution inputs', () => {
    const { section } = createSection({
      sampleData: [
        { label: 'Land cover', url: 'https://example.com/landcover.tif' },
      ],
    });

    const children = Array.from(section.el.children);
    const sampleIndex = children.findIndex((child) =>
      child.classList.contains('mlr-sample-row'),
    );
    const urlIndex = children.findIndex((child) =>
      child.classList.contains('mlr-row'),
    );
    const dropIndex = children.findIndex((child) =>
      child.classList.contains('mlr-drop-zone'),
    );
    const beforeIdIndex = children.findIndex(
      (child) => child.getAttribute('aria-label') === 'before-id',
    );
    const attributionIndex = children.findIndex(
      (child) => child.getAttribute('aria-label') === 'attribution',
    );

    expect(urlIndex).toBeGreaterThan(-1);
    expect(dropIndex).toBeGreaterThan(urlIndex);
    expect(beforeIdIndex).toBeGreaterThan(dropIndex);
    expect(attributionIndex).toBeGreaterThan(beforeIdIndex);
    expect(sampleIndex).toBeGreaterThan(attributionIndex);
  });

  it('fills the URL input, enables Load, and loads when an option is picked', () => {
    const { section, onAddUrl } = createSection({
      sampleData: [
        { label: 'Land cover', url: 'https://example.com/landcover.tif' },
      ],
    });
    section.el.querySelector<HTMLButtonElement>('.mlr-sample-trigger')!.click();
    section.el.querySelector<HTMLButtonElement>('.mlr-sample-option')!.click();

    const input = section.el.querySelector<HTMLInputElement>(
      'input[aria-label=raster-url]',
    )!;
    const loadBtn = section.el.querySelector<HTMLButtonElement>(
      'button[aria-label=load-url]',
    )!;
    expect(input.value).toBe('https://example.com/landcover.tif');
    expect(loadBtn.disabled).toBe(false);
    expect(onAddUrl).toHaveBeenCalledWith(
      'https://example.com/landcover.tif',
      undefined,
      undefined,
    );
    expect(
      section.el.querySelector<HTMLElement>('.mlr-sample-menu')!.hidden,
    ).toBe(true);
  });

  it("fills the attribution input from the sample and passes it through, leaving it untouched for samples without one", () => {
    const { section, onAddUrl } = createSection({
      sampleData: [
        {
          label: 'Land cover',
          url: 'https://example.com/landcover.tif',
          attribution: 'U.S. Geological Survey (USGS)',
        },
        { label: 'Elevation', url: 'https://example.com/dem.tif' },
      ],
    });
    const attribution = section.el.querySelector<HTMLInputElement>(
      'input[aria-label=attribution]',
    )!;
    const trigger = section.el.querySelector<HTMLButtonElement>(
      '.mlr-sample-trigger',
    )!;
    const options =
      section.el.querySelectorAll<HTMLButtonElement>('.mlr-sample-option');

    trigger.click();
    options[0].click();
    expect(attribution.value).toBe('U.S. Geological Survey (USGS)');
    expect(onAddUrl).toHaveBeenLastCalledWith(
      'https://example.com/landcover.tif',
      undefined,
      'U.S. Geological Survey (USGS)',
    );

    // A sample without an attribution keeps whatever the input holds.
    attribution.value = '© custom';
    trigger.click();
    options[1].click();
    expect(attribution.value).toBe('© custom');
    expect(onAddUrl).toHaveBeenLastCalledWith(
      'https://example.com/dem.tif',
      undefined,
      '© custom',
    );
  });
});
