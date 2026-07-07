/**
 * Custom luma.gl shader modules that fill in capabilities not shipped by
 * `@developmentseed/deck.gl-raster/gpu-modules`. They follow the same
 * `{ name, fs, inject, uniformTypes, getUniforms }` shape as the upstream
 * modules so they slot into a `RasterModule[]` render pipeline directly.
 *
 * GLSL is injected at deck.gl's `DECKGL_FILTER_COLOR` extension point, which
 * runs after the upstream `CompositeBands` (or `CreateTexture`) has populated
 * `color`. Order matters: rescale → gamma → sigmoidal contrast is the
 * standard rio-color / marblecutter chain.
 */

type RescaleProps = { rescaleMin: [number, number, number]; rescaleMax: [number, number, number] };
type GammaProps = { gamma: number };
type LogStretchProps = { strength: number };

/** Discards pixels whose red channel is NaN. Float32 COGs commonly use
 * NaN as the nodata sentinel, but the upstream `FilterNoDataVal` does an
 * `==` comparison which IEEE 754 says is always false for NaN. Use this
 * module instead when the COG's declared nodata value is NaN. */
export const FilterNaN = {
  name: 'filterNaN',
  inject: {
    'fs:DECKGL_FILTER_COLOR': `
  if (isnan(color.r)) {
    discard;
  }
`,
  },
} as const;

/** Normalized-difference index: replaces the color with `(A - B) / (A + B)`
 * broadcast across RGB, where `A` is the red channel and `B` the green channel
 * populated by a preceding `CompositeBands` (r → band A, g → band B). The
 * result lies in [-1, 1] and is scale-invariant, so it can run on the raw
 * sampled band values regardless of the texture's sample scale — a downstream
 * `PerBandLinearRescale` maps the chosen window (default [-1, 1]) into [0, 1]
 * for the colormap. A zero denominator yields 0 rather than a NaN/Inf. Runs
 * before rescale / gamma / colormap. */
export const NormalizedDifference = {
  name: 'normalizedDifference',
  inject: {
    'fs:DECKGL_FILTER_COLOR': `
  {
    float ndA = color.r;
    float ndB = color.g;
    float ndDenom = ndA + ndB;
    float nd = abs(ndDenom) < 1e-12 ? 0.0 : (ndA - ndB) / ndDenom;
    color.rgb = vec3(nd);
  }
`,
  },
} as const;

/** Per-channel `LinearRescale`. Same idea as the shipped `LinearRescale`,
 * but min/max are vec3 so each band gets its own range. */
export const PerBandLinearRescale = {
  name: 'perBandRescale',
  fs: `uniform perBandRescaleUniforms {
  vec3 rescaleMin;
  vec3 rescaleMax;
} perBandRescale;
`,
  inject: {
    'fs:DECKGL_FILTER_COLOR': `
  color.rgb = clamp(
    (color.rgb - perBandRescale.rescaleMin) /
      max(perBandRescale.rescaleMax - perBandRescale.rescaleMin, vec3(1e-9)),
    0.0, 1.0);
`,
  },
  uniformTypes: {
    rescaleMin: 'vec3<f32>',
    rescaleMax: 'vec3<f32>',
  },
  getUniforms: (props: Partial<RescaleProps>) => ({
    rescaleMin: props.rescaleMin ?? [0, 0, 0],
    rescaleMax: props.rescaleMax ?? [1, 1, 1],
  }),
} as const;

/** Power-law gamma correction. `gamma > 1` lifts shadows; `< 1` deepens them.
 * Apply post-rescale (input expected in 0..1). */
export const Gamma = {
  name: 'gammaModule',
  fs: `uniform gammaModuleUniforms {
  float gammaValue;
} gammaModule;
`,
  inject: {
    'fs:DECKGL_FILTER_COLOR': `
  color.rgb = pow(clamp(color.rgb, 0.0, 1.0), vec3(1.0 / max(gammaModule.gammaValue, 0.0001)));
`,
  },
  uniformTypes: {
    gammaValue: 'f32',
  },
  getUniforms: (props: Partial<GammaProps>) => ({
    gammaValue: props.gamma ?? 1.0,
  }),
} as const;

/** Square-root stretch on rescaled [0, 1] values. Expands the lower half
 * of the range into more colormap area; gentler than `LogStretch`. Apply
 * post-rescale, before gamma/sigmoidal. */
export const SqrtStretch = {
  name: 'sqrtStretch',
  inject: {
    'fs:DECKGL_FILTER_COLOR': `
  color.rgb = sqrt(clamp(color.rgb, 0.0, 1.0));
`,
  },
} as const;

/** Logarithmic stretch on rescaled [0, 1] values. Maps `x → log(1 + k*x) /
 * log(1 + k)` so 0 stays at 0 and 1 stays at 1. `k` controls steepness:
 * higher k → more aggressive expansion of low values. k=99 is a strong
 * but stable default that handles heavy positive skew. */
export const LogStretch = {
  name: 'logStretch',
  fs: `uniform logStretchUniforms {
  float strength;
} logStretch;
`,
  inject: {
    'fs:DECKGL_FILTER_COLOR': `
  {
    float k = max(logStretch.strength, 0.0001);
    vec3 x = clamp(color.rgb, 0.0, 1.0);
    color.rgb = log(1.0 + k * x) / log(1.0 + k);
  }
`,
  },
  uniformTypes: {
    strength: 'f32',
  },
  getUniforms: (props: Partial<LogStretchProps>) => ({
    strength: props.strength ?? 99,
  }),
} as const;
