import type { RasterStretch } from '../core/types';

/**
 * Steepness `k` of the `'log'` stretch: `x -> log(1 + k*x) / log(1 + k)`.
 * The render pipeline passes it to the log-stretch shader module.
 */
export const LOG_STRETCH_STRENGTH = 99;

/** Smallest gamma the gamma shader module divides by. */
const MIN_GAMMA = 0.0001;

/** The value adjustments the render pipeline applies after rescaling. */
export interface RasterAdjustments {
  /** Stretch curve; defaults to `'linear'`. */
  stretch?: RasterStretch;
  /** Gamma exponent; defaults to 1 (no change). */
  gamma?: number;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Applies the stretch curve to a rescaled value, as the shader does.
 *
 * @param x - Rescaled value in [0, 1] (clamped)
 * @param stretch - Stretch curve
 * @returns The stretched value in [0, 1]
 */
export function applyStretch(
  x: number,
  stretch: RasterStretch = 'linear',
): number {
  const v = clamp01(x);
  if (stretch === 'sqrt') return Math.sqrt(v);
  if (stretch === 'log') {
    return (
      Math.log(1 + LOG_STRETCH_STRENGTH * v) /
      Math.log(1 + LOG_STRETCH_STRENGTH)
    );
  }
  return v;
}

/**
 * Inverse of {@link applyStretch}: maps a stretched value back to the rescaled
 * value that produces it.
 *
 * @param t - Stretched value in [0, 1] (clamped)
 * @param stretch - Stretch curve
 * @returns The rescaled value in [0, 1]
 */
export function invertStretch(
  t: number,
  stretch: RasterStretch = 'linear',
): number {
  const v = clamp01(t);
  if (stretch === 'sqrt') return v * v;
  if (stretch === 'log') {
    return (Math.pow(1 + LOG_STRETCH_STRENGTH, v) - 1) / LOG_STRETCH_STRENGTH;
  }
  return v;
}

/**
 * Applies the render pipeline's value adjustments to a rescaled value, in the
 * pipeline's order: stretch curve, then gamma (`pow(x, 1 / gamma)`). The
 * result is the position at which the colormap texture is sampled.
 *
 * @param x - Rescaled value in [0, 1] (clamped)
 * @param adjustments - Stretch and gamma
 * @returns The colormap position in [0, 1]
 */
export function applyAdjustments(
  x: number,
  adjustments: RasterAdjustments = {},
): number {
  const gamma = adjustments.gamma ?? 1;
  const stretched = applyStretch(x, adjustments.stretch);
  return gamma === 1
    ? stretched
    : Math.pow(stretched, 1 / Math.max(gamma, MIN_GAMMA));
}

/**
 * Inverse of {@link applyAdjustments}: maps a colormap position back to the
 * rescaled value that lands there, undoing gamma first and then the stretch.
 * Useful for a host that paints its own data into a colormap texture (for
 * example per-value opacity) and needs to know which value each texture column
 * represents.
 *
 * @param t - Colormap position in [0, 1] (clamped)
 * @param adjustments - Stretch and gamma
 * @returns The rescaled value in [0, 1]
 */
export function invertAdjustments(
  t: number,
  adjustments: RasterAdjustments = {},
): number {
  const gamma = adjustments.gamma ?? 1;
  const v = clamp01(t);
  const unGamma = gamma === 1 ? v : Math.pow(v, Math.max(gamma, MIN_GAMMA));
  return invertStretch(unGamma, adjustments.stretch);
}
