import { COLORMAP_INDEX } from '@developmentseed/deck.gl-raster/gpu-modules';
import colormapsPngUrl from '@developmentseed/deck.gl-raster/gpu-modules/colormaps.png';

/** URL (or, in library builds, an inlined data URI) of the colormap sprite:
 * a 256px-wide vertical strip with one row per named colormap, in the order
 * given by `COLORMAP_INDEX`. */
export { colormapsPngUrl };

export type ColormapOption = {
  name: string;
  label: string;
  rowIndex: number;
  reversed?: boolean;
};

/** Alphabetical list of the named colormaps shipped in the sprite. */
export const COLORMAP_NAMES = Object.keys(COLORMAP_INDEX).sort();

/** Number of rows in the colormap sprite. */
export const COLORMAP_ROW_COUNT = Object.keys(COLORMAP_INDEX).length;

/**
 * Canonical display casing for colormaps whose matplotlib name is mixed-case.
 * The sprite keys are lowercased, so the value sent to the renderer stays
 * lowercase (see {@link ColormapOption.name}); only the label is restored to
 * the familiar matplotlib spelling (e.g. "ylorbr" → "YlOrBr", "rdbu" → "RdBu").
 * Names not listed here are lowercase in matplotlib too (viridis, jet, …) and
 * are shown as-is.
 */
export const COLORMAP_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  // Sequential
  greys: 'Greys',
  purples: 'Purples',
  blues: 'Blues',
  greens: 'Greens',
  oranges: 'Oranges',
  reds: 'Reds',
  ylorbr: 'YlOrBr',
  ylorrd: 'YlOrRd',
  orrd: 'OrRd',
  purd: 'PuRd',
  rdpu: 'RdPu',
  bupu: 'BuPu',
  gnbu: 'GnBu',
  pubu: 'PuBu',
  ylgnbu: 'YlGnBu',
  pubugn: 'PuBuGn',
  bugn: 'BuGn',
  ylgn: 'YlGn',
  wistia: 'Wistia',
  // Diverging
  piyg: 'PiYG',
  prgn: 'PRGn',
  brbg: 'BrBG',
  puor: 'PuOr',
  rdgy: 'RdGy',
  rdbu: 'RdBu',
  rdylbu: 'RdYlBu',
  rdylgn: 'RdYlGn',
  spectral: 'Spectral',
  // Qualitative
  pastel1: 'Pastel1',
  pastel2: 'Pastel2',
  paired: 'Paired',
  accent: 'Accent',
  dark2: 'Dark2',
  set1: 'Set1',
  set2: 'Set2',
  set3: 'Set3',
  // Misc
  cmrmap: 'CMRmap',
};

/**
 * The matplotlib display label for a colormap key (its canonical casing when
 * known, otherwise the key itself).
 *
 * @param name - The lowercase colormap key.
 * @returns The display label.
 */
export function colormapDisplayName(name: string): string {
  return COLORMAP_DISPLAY_NAMES[name] ?? name;
}

/** Picker-ready options: name (renderer value), display label, and the sprite
 * row to preview. */
export const COLORMAP_OPTIONS: ColormapOption[] = COLORMAP_NAMES.map(
  (name) => ({
    name,
    label: colormapDisplayName(name),
    rowIndex: (COLORMAP_INDEX as Record<string, number>)[name],
  }),
);
