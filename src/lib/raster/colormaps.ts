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

/** Picker-ready options: name, display label, and the sprite row to
 * preview. */
export const COLORMAP_OPTIONS: ColormapOption[] = COLORMAP_NAMES.map(
  (name) => ({
    name,
    label: name,
    rowIndex: (COLORMAP_INDEX as Record<string, number>)[name],
  }),
);
