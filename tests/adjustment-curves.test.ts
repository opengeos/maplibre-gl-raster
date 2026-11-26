import { describe, expect, it } from 'vitest';
import {
  applyAdjustments,
  applyStretch,
  invertAdjustments,
  invertStretch,
  LOG_STRETCH_STRENGTH,
} from '../src/lib/raster/adjustment-curves';
import { LogStretch } from '../src/lib/raster/shader-modules';
import type { RasterStretch } from '../src/lib/core/types';

const STRETCHES: RasterStretch[] = ['linear', 'sqrt', 'log'];
const SAMPLES = [0, 0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 1];

describe('adjustment curves', () => {
  it('matches the shader curves at known points', () => {
    expect(applyStretch(0.25, 'sqrt')).toBeCloseTo(0.5, 12);
    expect(applyStretch(0.5, 'log')).toBeCloseTo(
      Math.log(50.5) / Math.log(100),
      12,
    );
    expect(applyStretch(0.5, 'linear')).toBe(0.5);
    // Gamma runs after the stretch, as pow(x, 1 / gamma).
    expect(applyAdjustments(0.25, { stretch: 'sqrt', gamma: 2 })).toBeCloseTo(
      Math.pow(0.5, 0.5),
      12,
    );
  });

  it('keeps the log strength the pipeline hands the shader module', () => {
    expect(LOG_STRETCH_STRENGTH).toBe(99);
    const defaults = (
      LogStretch as unknown as {
        getUniforms: (props: Record<string, unknown>) => { strength: number };
      }
    ).getUniforms({});
    expect(defaults.strength).toBe(LOG_STRETCH_STRENGTH);
  });

  it('inverts every stretch and gamma combination', () => {
    for (const stretch of STRETCHES) {
      for (const gamma of [0.5, 1, 2.2]) {
        for (const x of SAMPLES) {
          const t = applyAdjustments(x, { stretch, gamma });
          expect(invertAdjustments(t, { stretch, gamma })).toBeCloseTo(x, 9);
        }
      }
      for (const x of SAMPLES) {
        expect(invertStretch(applyStretch(x, stretch), stretch)).toBeCloseTo(
          x,
          9,
        );
      }
    }
  });

  it('clamps inputs to [0, 1]', () => {
    expect(applyStretch(-1, 'sqrt')).toBe(0);
    expect(applyStretch(2, 'log')).toBeCloseTo(1, 12);
    expect(invertAdjustments(1.5, { gamma: 2 })).toBe(1);
  });
});
