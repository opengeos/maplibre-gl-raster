/**
 * Normalized-difference spectral index presets for the raster "index" render
 * mode. Every preset computes the same GPU formula
 *
 *   index = (A - B) / (A + B)
 *
 * on two bands the user maps to the roles `A` and `B` (e.g. NDVI = (NIR - Red)
 * / (NIR + Red)). Presets only pre-fill sensible role labels and a default
 * diverging colormap; the math is identical, so a single GPU shader
 * ({@link import('./shader-modules').NormalizedDifference}) serves them all.
 *
 * Band roles cannot be resolved to band numbers automatically for an arbitrary
 * COG (band order is sensor-specific and rarely carried in metadata), so the
 * settings UI lets the user assign each role to a band, seeding a best guess
 * from GDAL band names when present.
 */

/**
 * A normalized-difference index preset.
 */
export interface NormalizedDifferenceIndex {
  /** Stable id stored in {@link import('../core/types').RasterLayerState.index}. */
  id: string;
  /** Short display label (e.g. "NDVI"). */
  label: string;
  /** Full name shown as help text. */
  name: string;
  /** Role of band A, the minuend (e.g. "NIR"). Matched against band names to
   * seed a default band. */
  roleA: string;
  /** Role of band B, the subtrahend (e.g. "Red"). */
  roleB: string;
  /** Default colormap applied when the preset is selected. */
  colormap: string;
}

/** The `id` used for a free-form normalized difference (generic Band A / Band
 * B, no role hints). */
export const CUSTOM_INDEX_ID = 'custom';

/**
 * Built-in normalized-difference index presets, in menu order. Each maps two
 * band roles onto the shared `(A - B) / (A + B)` formula.
 */
export const NORMALIZED_DIFFERENCE_INDICES: readonly NormalizedDifferenceIndex[] = [
  {
    id: 'ndvi',
    label: 'NDVI',
    name: 'Normalized Difference Vegetation Index — (NIR - Red) / (NIR + Red)',
    roleA: 'NIR',
    roleB: 'Red',
    colormap: 'rdylgn',
  },
  {
    id: 'ndwi',
    label: 'NDWI',
    name: 'Normalized Difference Water Index — (Green - NIR) / (Green + NIR)',
    roleA: 'Green',
    roleB: 'NIR',
    colormap: 'blues',
  },
  {
    id: 'ndmi',
    label: 'NDMI',
    name: 'Normalized Difference Moisture Index — (NIR - SWIR1) / (NIR + SWIR1)',
    roleA: 'NIR',
    roleB: 'SWIR1',
    colormap: 'brbg',
  },
  {
    id: 'nbr',
    label: 'NBR',
    name: 'Normalized Burn Ratio — (NIR - SWIR2) / (NIR + SWIR2)',
    roleA: 'NIR',
    roleB: 'SWIR2',
    colormap: 'rdylgn',
  },
  {
    id: 'ndbi',
    label: 'NDBI',
    name: 'Normalized Difference Built-up Index — (SWIR1 - NIR) / (SWIR1 + NIR)',
    roleA: 'SWIR1',
    roleB: 'NIR',
    colormap: 'inferno',
  },
  {
    id: 'ndsi',
    label: 'NDSI',
    name: 'Normalized Difference Snow Index — (Green - SWIR1) / (Green + SWIR1)',
    roleA: 'Green',
    roleB: 'SWIR1',
    colormap: 'blues',
  },
] as const;

/** The generic "custom" preset: two unlabeled bands and a neutral diverging
 * ramp. Kept separate from the named presets so callers can list it last. */
export const CUSTOM_NORMALIZED_DIFFERENCE: NormalizedDifferenceIndex = {
  id: CUSTOM_INDEX_ID,
  label: 'Custom',
  name: 'Custom normalized difference — (Band A - Band B) / (Band A + Band B)',
  roleA: 'Band A',
  roleB: 'Band B',
  colormap: 'rdylgn',
};

/** Look up a preset by id (including the custom preset), or null. */
export function indexById(id: string | undefined): NormalizedDifferenceIndex | null {
  if (!id) return null;
  if (id === CUSTOM_INDEX_ID) return CUSTOM_NORMALIZED_DIFFERENCE;
  return NORMALIZED_DIFFERENCE_INDICES.find((i) => i.id === id) ?? null;
}

/**
 * Guess the 1-based band number that plays a spectral role (e.g. "NIR") for a
 * raster, matching the role against GDAL band names. Common Sentinel-2 /
 * Landsat aliases are recognized. Returns null when no band name matches.
 *
 * @param role - The role label from a preset (e.g. "Red", "NIR", "SWIR1").
 * @param bandNames - 1-indexed band-number → name map, when the COG carries one.
 */
export function guessBandForRole(
  role: string,
  bandNames: Map<number, string> | null,
): number | null {
  if (!bandNames || bandNames.size === 0) return null;
  const aliases = ROLE_ALIASES[role.toLowerCase()] ?? [role.toLowerCase()];
  for (const [band, rawName] of bandNames) {
    const name = rawName.toLowerCase();
    if (aliases.some((alias) => name.includes(alias))) return band;
  }
  return null;
}

/** Substrings that identify a spectral role inside a GDAL band name. */
const ROLE_ALIASES: Record<string, string[]> = {
  red: ['red', 'b04', 'b4'],
  green: ['green', 'b03', 'b3'],
  blue: ['blue', 'b02', 'b2'],
  nir: ['nir', 'near infrared', 'b08', 'b8', 'b8a'],
  swir1: ['swir1', 'swir 1', 'swir_1', 'b11'],
  swir2: ['swir2', 'swir 2', 'swir_2', 'b12'],
};
