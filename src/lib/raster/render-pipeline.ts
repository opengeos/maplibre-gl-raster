import type {
  RasterModule,
  RenderTileResult,
} from '@developmentseed/deck.gl-raster';
import {
  buildCompositeBandsProps,
  COLORMAP_INDEX,
  Colormap,
  CompositeBands,
  FilterNoDataVal,
  MaskTexture,
} from '@developmentseed/deck.gl-raster/gpu-modules';
import type { Texture } from '@luma.gl/core';
import type { RasterLayerState } from '../core/types';
import {
  percentileFromHistogram,
  type AutoStats,
  type BandStats,
} from './stats';
import {
  FilterNaN,
  Gamma,
  LogStretch,
  NormalizedDifference,
  PerBandLinearRescale,
  SqrtStretch,
} from './shader-modules';
import type { MultiBandTileData } from './tile-loader';

type Range = [number, number];
type Vec3 = [number, number, number];

const RESCALE_EPSILON = 1e-9;
export const DEFAULT_PERCENTILE_LO = 0.02;
export const DEFAULT_PERCENTILE_HI = 0.98;

const safeRange = ([lo, hi]: Range): Range =>
  lo === hi ? [lo, lo + RESCALE_EPSILON] : [lo, hi];

/** 2–98% percentile range from a band's histogram. Falls back to [min, max]
 * if the histogram is empty (e.g. GDAL_METADATA-only stats with no overview
 * sample). Mirrors the displayed default in the settings UI. */
export function autoRangeFor(stats: BandStats): Range {
  const hasBins = stats.histogram.some((b) => b > 0);
  if (!hasBins) return [stats.min, stats.max];
  return [
    percentileFromHistogram(stats, DEFAULT_PERCENTILE_LO),
    percentileFromHistogram(stats, DEFAULT_PERCENTILE_HI),
  ];
}

export function statsForBand(
  autoStats: AutoStats | null,
  band: number,
): BandStats | null {
  if (!autoStats?.perBand) return autoStats?.global ?? null;
  return autoStats.perBand.get(band) ?? autoStats.global ?? null;
}

/** Resolve a per-channel rescale window broadcast across 3 GPU channels.
 * For single-band rendering all three channels carry the same band value
 * (see `pickMapping`), so passing vec3(v,v,v) to `PerBandLinearRescale`
 * gives mathematically identical output to the scalar `LinearRescale`.
 *
 * Override precedence: `state.rescale` (broadcast its first pair if it
 * has fewer pairs than channels), then per-band auto-stats percentile,
 * then [0, 1]. Returns null only when `state.rescale` is unset AND
 * autoStats can't supply any band — caller should skip the module. */
function effectiveRescale(
  state: RasterLayerState,
  autoStats: AutoStats | null,
  bands: number[],
): { mins: Vec3; maxs: Vec3 } | null {
  const pickAuto = (i: number): Range => {
    const band = bands[i] ?? bands[bands.length - 1] ?? 1;
    const stats = statsForBand(autoStats, band);
    return stats ? safeRange(autoRangeFor(stats)) : [0, 1];
  };
  const overrides = state.rescale;
  const pickOverride = (i: number): Range =>
    safeRange(overrides![i < overrides!.length ? i : 0]);

  let r: Range, g: Range, b: Range;
  if (overrides && overrides.length > 0) {
    r = pickOverride(0);
    g = pickOverride(1);
    b = pickOverride(2);
  } else {
    if (!autoStats?.perBand && !autoStats?.global) return null;
    r = pickAuto(0);
    g = pickAuto(1);
    b = pickAuto(2);
  }
  return {
    mins: [r[0], g[0], b[0]],
    maxs: [r[1], g[1], b[1]],
  };
}

/** Push the optional adjustments common to RGB and single-band modes,
 * in canonical order: stretch curve → gamma. Both expect input clamped
 * to 0..1, which the preceding rescale module guarantees. */
function pushAdjustments(state: RasterLayerState, pipeline: RasterModule[]): void {
  if (state.stretch === 'log') {
    pipeline.push({ module: LogStretch, props: { strength: 99 } });
  } else if (state.stretch === 'sqrt') {
    pipeline.push({ module: SqrtStretch });
  }
  if (state.gamma !== 1) {
    pipeline.push({ module: Gamma, props: { gamma: state.gamma } });
  }
}

function effectiveNodata(
  state: RasterLayerState,
  perTileNodata: number | null,
): number | null {
  if (state.nodata === 'off') return null;
  if (typeof state.nodata === 'number') return state.nodata;
  // 'auto' → use the value the COG declares for this tile.
  return perTileNodata;
}

/** Build the nodata-discard module appropriate for the chosen value.
 * Float32 COGs frequently use NaN as the nodata sentinel; FilterNoDataVal's
 * `color.r == nodata` comparison is always false for NaN per IEEE 754, so
 * we route NaN nodata through the custom bit-pattern FilterNaN shader
 * instead. */
function nodataModule(
  nodata: number,
  sampleScale: number,
): RasterModule | null {
  if (Number.isNaN(nodata)) {
    return { module: FilterNaN };
  }
  if (!Number.isFinite(nodata)) return null;
  return {
    module: FilterNoDataVal,
    props: { value: nodata / sampleScale },
  };
}

/** Pick an existing band name from `data.bands`, falling back to the first
 * cached band (or null if none). Used to clamp user-selected indexes to
 * what was actually fetched. */
function pickBand(
  data: MultiBandTileData,
  preferred: number | undefined,
): string | null {
  if (preferred != null) {
    const key = String(preferred);
    if (data.bands.has(key)) return key;
  }
  const first = data.bands.keys().next();
  return first.done ? null : first.value;
}

type RenderTileMode =
  | { kind: 'rgb' }
  | { kind: 'single'; colormapTexture: Texture; colormapIndex: number }
  | { kind: 'palette'; colormapTexture: Texture };

/** Resolve the CompositeBands {r,g,b} mapping. RGB picks each requested
 * band independently (g/b optional — falls back to r); single-band
 * broadcasts one band into all three channels so the colormap can
 * sample `color.r`. Returns null when the required first band isn't
 * available (caller should bail with an empty pipeline). */
function pickMapping(
  data: MultiBandTileData,
  requested: number[],
  mode: RenderTileMode['kind'],
): { r: string; g?: string; b?: string } | null {
  if (mode === 'single' || mode === 'palette') {
    const band = pickBand(data, requested[0]);
    return band ? { r: band, g: band, b: band } : null;
  }
  const r = pickBand(data, requested[0]);
  if (!r) return null;
  const mapping: { r: string; g?: string; b?: string } = { r };
  const g = pickBand(data, requested[1]);
  if (g) mapping.g = g;
  const b = pickBand(data, requested[2]);
  if (b) mapping.b = b;
  return mapping;
}

/** Push the nodata-discard modules for a tile, in the correct order. Filters
 * nodata BEFORE any rescale / gamma / colormap so the comparison happens
 * against the texture's native sample value. NaN nodata uses the custom
 * FilterNaN shader; everything else uses FilterNoDataVal with the value
 * normalized into the GPU's sample space (uint8 255 → 1.0 for r8unorm). Also
 * applies implicit NaN-as-nodata for float COGs — IEEE-754 NaN is invalid by
 * definition, and GDAL/QGIS treat it as transparent even when the file
 * declares no GDAL_NODATA tag (e.g. Sentinel-2 derivatives that mask
 * outside-swath pixels with NaN). Gated on float textures via sampleScale
 * (r8unorm uint8 textures can't carry NaN), and skipped when the user
 * explicitly set nodata to "off" or when FilterNaN is already in the pipeline
 * (state.nodata was numerically NaN). */
function pushNodataFilters(
  state: RasterLayerState,
  data: MultiBandTileData,
  pipeline: RasterModule[],
): void {
  const nodata = effectiveNodata(state, data.nodata);
  let explicitNodataModule: RasterModule | null = null;
  if (nodata !== null) {
    explicitNodataModule = nodataModule(nodata, data.sampleScale);
    if (explicitNodataModule) pipeline.push(explicitNodataModule);
  }
  const isFloatTexture = data.sampleScale === 1;
  const filterNaNAlreadyPushed = explicitNodataModule?.module === FilterNaN;
  if (isFloatTexture && state.nodata !== 'off' && !filterNaNAlreadyPushed) {
    pipeline.push({ module: FilterNaN });
  }
}

/** Push the internal-mask discard module when the tile carries a validity
 * mask from the COG's per-dataset mask IFD. Applied regardless of the scalar
 * `nodata` setting (including `nodata: 'off'`) — the mask is the authoritative
 * validity signal that GDAL/QGIS/titiler honour by default, and it is the only
 * way to hide the border of a lossy JPEG/YCbCr mosaic where no pixel value can
 * separate nodata from valid dark pixels. Discards fragments early, before
 * rescale / colormap, so masked pixels never contribute colour. */
function pushMaskFilter(
  data: MultiBandTileData,
  pipeline: RasterModule[],
): void {
  if (data.maskTexture) {
    pipeline.push({
      module: MaskTexture,
      props: { maskTexture: data.maskTexture },
    });
  }
}

/** Shared renderTile builder. Handles both RGB and single-band paths
 * via a discriminated `mode`. The two paths differ only in: (a) which
 * bands feed CompositeBands, (b) whether a Colormap module is appended
 * at the end. Rescale, nodata, stretch, gamma all flow through the
 * same code regardless of mode. */
function buildRenderTile(
  state: RasterLayerState,
  autoStats: AutoStats | null,
  mode: RenderTileMode,
) {
  return function renderTile(data: MultiBandTileData): RenderTileResult {
    if (data.bands.size === 0) return { renderPipeline: [] };
    const requested =
      mode.kind === 'rgb'
        ? (state.bands ?? [1, 2, 3])
        : [state.bands?.[0] ?? 1];
    const mapping = pickMapping(data, requested, mode.kind);
    if (!mapping) return { renderPipeline: [] };

    const compositeProps = buildCompositeBandsProps(mapping, data.bands);
    const pipeline: RasterModule[] = [
      { module: CompositeBands, props: compositeProps },
    ];

    pushMaskFilter(data, pipeline);
    pushNodataFilters(state, data, pipeline);

    if (mode.kind === 'palette') {
      // Palette indices are categorical: skip the user rescale / stretch /
      // gamma chain and map index 0..255 onto the 256-texel color table.
      // For r8unorm textures (sampleScale 255) this rescale is the identity;
      // for float-uploaded data it normalizes the raw index into [0, 1].
      const max = 255 / data.sampleScale;
      pipeline.push({
        module: PerBandLinearRescale,
        props: {
          rescaleMin: [0, 0, 0],
          rescaleMax: [max, max, max],
        },
      });
      pipeline.push({
        module: Colormap,
        props: {
          colormapTexture: mode.colormapTexture,
          colormapIndex: 0,
          // Palette entries are categorical index→color lookups, so reversing
          // them is meaningless; state.reversed only affects named colormaps.
          reversed: false,
        },
      });
      return { renderPipeline: pipeline };
    }

    const rescale = effectiveRescale(state, autoStats, requested);
    if (rescale) {
      pipeline.push({
        module: PerBandLinearRescale,
        props: {
          rescaleMin: [
            rescale.mins[0] / data.sampleScale,
            rescale.mins[1] / data.sampleScale,
            rescale.mins[2] / data.sampleScale,
          ],
          rescaleMax: [
            rescale.maxs[0] / data.sampleScale,
            rescale.maxs[1] / data.sampleScale,
            rescale.maxs[2] / data.sampleScale,
          ],
        },
      });
    }

    pushAdjustments(state, pipeline);

    if (mode.kind === 'single') {
      pipeline.push({
        module: Colormap,
        props: {
          colormapTexture: mode.colormapTexture,
          colormapIndex: mode.colormapIndex,
          reversed: state.reversed ?? false,
        },
      });
    }

    return { renderPipeline: pipeline };
  };
}

/** RGB renderTile: composes user-selected bands into RGB via
 * `CompositeBands`, then rescales and discards nodata. Re-renders without
 * a re-fetch when the selection changes (within the cached band set). */
export function buildRgbCompositeRenderTile(
  state: RasterLayerState,
  autoStats: AutoStats | null,
) {
  return buildRenderTile(state, autoStats, { kind: 'rgb' });
}

/** Single-band renderTile. Uses CompositeBands to broadcast one band into
 * all RGB output channels (so the colormap can sample `color.r`), then
 * rescales, colormaps, and discards nodata. */
export function buildSingleCompositeRenderTile(
  state: RasterLayerState,
  colormapTexture: Texture,
  autoStats: AutoStats | null,
) {
  const name = (state.colormap ?? 'gray').toLowerCase();
  const colormapIndex =
    (COLORMAP_INDEX as Record<string, number>)[name] ?? COLORMAP_INDEX.gray;
  return buildRenderTile(state, autoStats, {
    kind: 'single',
    colormapTexture,
    colormapIndex,
  });
}

/** Palette renderTile: looks the band's raw index values up in the image's
 * embedded color table (a 256x1 2D-array texture). Rescale / stretch / gamma
 * are skipped — palette indices are categorical. */
export function buildPaletteCompositeRenderTile(
  state: RasterLayerState,
  paletteTexture: Texture,
) {
  return buildRenderTile(state, null, {
    kind: 'palette',
    colormapTexture: paletteTexture,
  });
}

/** Default rescale window for a normalized-difference index: the full [-1, 1]
 * range the formula can produce. Used when `state.rescale` is unset. */
export const DEFAULT_INDEX_RANGE: Range = [-1, 1];

/** Index renderTile: computes a normalized difference `(A - B) / (A + B)` of
 * two bands on the GPU, then colormaps the [-1, 1] result. `CompositeBands`
 * loads band A into the red channel and band B into green; the
 * `NormalizedDifference` module collapses them to a single value broadcast
 * across RGB; `PerBandLinearRescale` maps the chosen window (default
 * {@link DEFAULT_INDEX_RANGE}) into [0, 1] for the colormap. The index is
 * scale-invariant, so — unlike the single/RGB paths — the rescale window is
 * NOT divided by `data.sampleScale`. Re-renders without a re-fetch when the
 * colormap / rescale change (within the cached band set). */
export function buildIndexCompositeRenderTile(
  state: RasterLayerState,
  colormapTexture: Texture,
) {
  const name = (state.colormap ?? 'rdylgn').toLowerCase();
  const colormapIndex =
    (COLORMAP_INDEX as Record<string, number>)[name] ?? COLORMAP_INDEX.rdylgn;
  return function renderTile(data: MultiBandTileData): RenderTileResult {
    if (data.bands.size === 0) return { renderPipeline: [] };
    const bandA = pickBand(data, state.bands?.[0] ?? 1);
    if (!bandA) return { renderPipeline: [] };
    // Fall back to band A when B wasn't fetched — yields a flat 0 index rather
    // than an empty tile, which reads as "same band" to the user.
    const bandB = pickBand(data, state.bands?.[1] ?? 2) ?? bandA;
    const compositeProps = buildCompositeBandsProps(
      { r: bandA, g: bandB },
      data.bands,
    );
    const pipeline: RasterModule[] = [
      { module: CompositeBands, props: compositeProps },
    ];

    // Discard nodata against the raw band values, before the index collapses
    // them (a masked pixel in either operand should not colour the output).
    pushMaskFilter(data, pipeline);
    pushNodataFilters(state, data, pipeline);

    pipeline.push({ module: NormalizedDifference });

    const [lo, hi] = safeRange(state.rescale?.[0] ?? DEFAULT_INDEX_RANGE);
    pipeline.push({
      module: PerBandLinearRescale,
      props: { rescaleMin: [lo, lo, lo], rescaleMax: [hi, hi, hi] },
    });

    pushAdjustments(state, pipeline);

    pipeline.push({
      module: Colormap,
      props: {
        colormapTexture,
        colormapIndex,
        reversed: state.reversed ?? false,
      },
    });

    return { renderPipeline: pipeline };
  };
}
