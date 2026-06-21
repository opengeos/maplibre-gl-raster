import { describe, it, expect, vi } from 'vitest';
import { AddDataSection } from '../src/lib/ui/AddDataSection';

function createSection(
  overrides: Partial<Parameters<typeof AddDataSection.prototype.constructor>[0]> = {},
) {
  const onAddUrl = vi.fn();
  const onAddFile = vi.fn();
  const section = new AddDataSection({ onAddUrl, onAddFile, ...overrides });
  document.body.appendChild(section.el);
  return { section, onAddUrl, onAddFile };
}

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
    expect(trigger.querySelector('.mlr-sample-trigger-label')!.textContent).toBe(
      'Load sample data...',
    );
    const menu = section.el.querySelector<HTMLElement>('.mlr-sample-menu')!;
    expect(menu.hidden).toBe(true);
    const options = Array.from(section.el.querySelectorAll('.mlr-sample-option'));
    expect(options.map((o) => o.textContent)).toEqual(['Land cover', 'Elevation']);

    const input = section.el.querySelector<HTMLInputElement>('input[aria-label=raster-url]')!;
    expect(input.value).toBe('');
  });

  it('uses a custom placeholder when provided', () => {
    const { section } = createSection({
      sampleDataLabel: 'Try a COG...',
      sampleData: [{ label: 'Land cover', url: 'https://example.com/landcover.tif' }],
    });
    expect(
      section.el.querySelector('.mlr-sample-trigger-label')!.textContent,
    ).toBe('Try a COG...');
  });

  it('opens the menu when the trigger is clicked', () => {
    const { section } = createSection({
      sampleData: [{ label: 'Land cover', url: 'https://example.com/landcover.tif' }],
    });
    const trigger = section.el.querySelector<HTMLButtonElement>('.mlr-sample-trigger')!;
    const menu = section.el.querySelector<HTMLElement>('.mlr-sample-menu')!;

    trigger.click();
    expect(menu.hidden).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    trigger.click();
    expect(menu.hidden).toBe(true);
  });

  it('fills the URL input (and enables Load) when an option is picked, without loading', () => {
    const { section, onAddUrl } = createSection({
      sampleData: [{ label: 'Land cover', url: 'https://example.com/landcover.tif' }],
    });
    section.el.querySelector<HTMLButtonElement>('.mlr-sample-trigger')!.click();
    section.el.querySelector<HTMLButtonElement>('.mlr-sample-option')!.click();

    const input = section.el.querySelector<HTMLInputElement>('input[aria-label=raster-url]')!;
    const loadBtn = section.el.querySelector<HTMLButtonElement>('button[aria-label=load-url]')!;
    expect(input.value).toBe('https://example.com/landcover.tif');
    expect(loadBtn.disabled).toBe(false);
    // Picking a sample only fills the input; it does not load.
    expect(onAddUrl).not.toHaveBeenCalled();
    expect(section.el.querySelector<HTMLElement>('.mlr-sample-menu')!.hidden).toBe(true);
  });
});
