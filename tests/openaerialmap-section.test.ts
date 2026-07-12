import type { Map as MapLibreMap } from 'maplibre-gl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAerialMapSection } from '../src/lib/ui/OpenAerialMapSection';

/** A fake map recording the source/layer mutations the section performs. */
function makeFakeMap() {
  const sources = new Map<string, unknown>();
  const layers = new Map<string, unknown>();
  const map = {
    getBounds: () => ({
      getWest: () => -84.5,
      getSouth: () => 33.6,
      getEast: () => -84.2,
      getNorth: () => 33.9,
    }),
    getSource: (id: string) => sources.get(id),
    getLayer: (id: string) => layers.get(id),
    addSource: vi.fn((id: string, def: unknown) => sources.set(id, def)),
    addLayer: vi.fn((def: { id: string }) => layers.set(def.id, def)),
    removeLayer: vi.fn((id: string) => layers.delete(id)),
    removeSource: vi.fn((id: string) => sources.delete(id)),
    fitBounds: vi.fn(),
  };
  return { map: map as unknown as MapLibreMap, sources, layers, raw: map };
}

function stubFetch(body: unknown, init?: { ok?: boolean; status?: number }) {
  const fetchMock = vi.fn(async () => ({
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function image(id: string, extra: Record<string, unknown> = {}) {
  return {
    _id: id,
    title: `Scene ${id}`,
    provider: 'Maxar',
    platform: 'satellite',
    gsd: 0.3,
    acquisition_end: '2024-10-02T14:12:00.000Z',
    uuid: `https://oin.example.com/${id}.tif`,
    properties: {
      tms: `https://tiles.example.com/${id}/{z}/{x}/{y}`,
      thumbnail: `https://oin.example.com/${id}.png`,
    },
    bbox: [-84.5, 33.6, -84.2, 33.9],
    ...extra,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function mount(fetchBody: unknown, init?: { ok?: boolean; status?: number }) {
  const fetchMock = stubFetch(fetchBody, init);
  const fake = makeFakeMap();
  const section = new OpenAerialMapSection({ map: fake.map });
  document.body.appendChild(section.el);
  return { section, fetchMock, ...fake };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('OpenAerialMapSection', () => {
  it('shows a hint and a search button before any search', () => {
    const { section } = mount({ meta: { found: 0 }, results: [] });
    expect(
      section.el.querySelector('button[aria-label=search-openaerialmap]'),
    ).not.toBeNull();
    expect(section.el.querySelector('.mlr-oam-status')!.textContent).toMatch(
      /Search the current map view/,
    );
  });

  it('searches the current view bbox and renders a card per result', async () => {
    const { section, fetchMock } = mount({
      meta: { found: 1 },
      results: [image('a')],
    });

    section.el
      .querySelector<HTMLButtonElement>(
        'button[aria-label=search-openaerialmap]',
      )!
      .click();
    await tick();

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get('bbox')).toBe('-84.5,33.6,-84.2,33.9');
    expect(section.el.querySelectorAll('.mlr-oam-card')).toHaveLength(1);
    expect(section.el.querySelector('.mlr-oam-title')!.textContent).toBe(
      'Scene a',
    );
  });

  it('adds a raster source/layer on Add, then removes them on toggle', async () => {
    const { section, sources, layers, raw } = mount({
      meta: { found: 1 },
      results: [image('a')],
    });
    section.el
      .querySelector<HTMLButtonElement>(
        'button[aria-label=search-openaerialmap]',
      )!
      .click();
    await tick();

    const addBtn = section.el.querySelector<HTMLButtonElement>(
      '.mlr-oam-actions .mlr-oam-action',
    )!;
    expect(addBtn.textContent).toBe('Add');

    addBtn.click();
    expect(raw.addSource).toHaveBeenCalledWith(
      'oam-src-a',
      expect.objectContaining({
        type: 'raster',
        tiles: [
          'https://titiler.hotosm.org/cog/tiles/WebMercatorQuad/{z}/{x}/{y}@1x?url=' +
            encodeURIComponent('https://oin.example.com/a.tif'),
        ],
        tileSize: 256,
      }),
    );
    expect(raw.addLayer).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'oam-lyr-a', type: 'raster' }),
    );
    expect(raw.fitBounds).toHaveBeenCalled();
    expect(addBtn.textContent).toBe('Remove');
    expect(sources.has('oam-src-a')).toBe(true);
    expect(layers.has('oam-lyr-a')).toBe(true);

    addBtn.click();
    expect(addBtn.textContent).toBe('Add');
    expect(sources.has('oam-src-a')).toBe(false);
    expect(layers.has('oam-lyr-a')).toBe(false);
  });

  it('disables Add when an image has no source COG to tile', async () => {
    const { section } = mount({
      meta: { found: 1 },
      // No `uuid` → no COG → no tile template, so the image can't be visualized.
      results: [image('a', { uuid: undefined, properties: { thumbnail: 'x' } })],
    });
    section.el
      .querySelector<HTMLButtonElement>(
        'button[aria-label=search-openaerialmap]',
      )!
      .click();
    await tick();

    const addBtn = section.el.querySelector<HTMLButtonElement>(
      '.mlr-oam-actions .mlr-oam-action',
    )!;
    expect(addBtn.disabled).toBe(true);
  });

  it('downloads the source GeoTIFF via an anchor click', async () => {
    const { section } = mount({ meta: { found: 1 }, results: [image('a')] });
    section.el
      .querySelector<HTMLButtonElement>(
        'button[aria-label=search-openaerialmap]',
      )!
      .click();
    await tick();

    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    const downloadBtn = Array.from(
      section.el.querySelectorAll<HTMLButtonElement>('.mlr-oam-action'),
    ).find((b) => b.textContent === 'Download')!;
    downloadBtn.click();

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('reveals "Load more" only when more results remain', async () => {
    const { section } = mount({ meta: { found: 5 }, results: [image('a')] });
    section.el
      .querySelector<HTMLButtonElement>(
        'button[aria-label=search-openaerialmap]',
      )!
      .click();
    await tick();

    const more = section.el.querySelector<HTMLButtonElement>('.mlr-oam-more')!;
    expect(more.hidden).toBe(false);
  });

  it('surfaces an error status when the request fails', async () => {
    const { section } = mount({}, { ok: false, status: 503 });
    section.el
      .querySelector<HTMLButtonElement>(
        'button[aria-label=search-openaerialmap]',
      )!
      .click();
    await tick();

    const status = section.el.querySelector('.mlr-oam-status')!;
    expect(status.classList.contains('mlr-oam-error')).toBe(true);
    expect(status.textContent).toMatch(/Could not reach OpenAerialMap/);
  });

  it('removes visualized layers on destroy', async () => {
    const { section, layers, sources } = mount({
      meta: { found: 1 },
      results: [image('a')],
    });
    section.el
      .querySelector<HTMLButtonElement>(
        'button[aria-label=search-openaerialmap]',
      )!
      .click();
    await tick();
    section.el
      .querySelector<HTMLButtonElement>('.mlr-oam-actions .mlr-oam-action')!
      .click();
    expect(layers.has('oam-lyr-a')).toBe(true);

    section.destroy();
    expect(layers.has('oam-lyr-a')).toBe(false);
    expect(sources.has('oam-src-a')).toBe(false);
  });
});
