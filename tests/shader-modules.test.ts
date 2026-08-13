import { describe, expect, it } from 'vitest';
import { FilterNaN } from '../src/lib/raster/shader-modules';

const filterNaNSource = FilterNaN.inject['fs:DECKGL_FILTER_COLOR'];

/** Pull the two IEEE-754 masks out of the shader text so the assertions below
 * exercise the constants the GPU actually runs, not a copy of them. */
function shaderMasks(): { exponent: number; mantissa: number } {
  // The exponent mask appears twice (once masking, once comparing), so keep
  // the distinct literals in first-seen order.
  const literals = [
    ...new Set(
      [...filterNaNSource.matchAll(/0x([0-9a-f]+)u/g)].map((m) =>
        Number.parseInt(m[1], 16),
      ),
    ),
  ];
  expect(literals).toHaveLength(2);
  return { exponent: literals[0], mantissa: literals[1] };
}

/** JS mirror of the shader's discard test, driven by the masks read out of the
 * GLSL: reinterpret the float32 bits, then require an all-ones exponent with a
 * non-zero mantissa. */
function discards(value: number): boolean {
  const { exponent, mantissa } = shaderMasks();
  const bits = new Uint32Array(new Float32Array([value]).buffer)[0];
  return (bits & exponent) === exponent && (bits & mantissa) !== 0;
}

describe('FilterNaN', () => {
  it('discards exactly the NaN values and nothing else', () => {
    const nanPayload = new Float32Array(
      new Uint32Array([0xffc00001]).buffer, // negative NaN with a low mantissa bit
    )[0];
    const cases: Array<[number, boolean]> = [
      [Number.NaN, true],
      [nanPayload, true],
      [0, false],
      [-0, false],
      [1.5, false],
      [-9999, false],
      [Number.POSITIVE_INFINITY, false],
      [Number.NEGATIVE_INFINITY, false],
      [3.4028234663852886e38, false], // FLT_MAX: exponent 0xfe, not all ones
      [1.401298464324817e-45, false], // smallest float32 denormal
    ];
    for (const [value, expected] of cases) {
      expect(discards(value), `value ${value}`).toBe(expected);
    }
  });

  it('agrees with Number.isNaN across the float32 exponent range', () => {
    for (let exp = -40; exp <= 40; exp++) {
      const value = Math.fround(1.2345 * 10 ** exp);
      expect(discards(value)).toBe(Number.isNaN(value));
    }
  });

  // `isnan()` folds to a constant `false` under the HLSL compiler's fast-math
  // assumptions on ANGLE's Direct3D 11 backend, which is what left NaN nodata
  // opaque on Windows (opengeos/maplibre-gl-raster#64). `x != x` is dropped by
  // the same passes. Guard against either creeping back in.
  it('avoids the float-comparison NaN idioms that D3D optimizes away', () => {
    expect(filterNaNSource).not.toMatch(/\bisnan\s*\(/);
    expect(filterNaNSource).not.toMatch(/color\.r\s*!=\s*color\.r/);
    expect(filterNaNSource).toContain('floatBitsToUint(color.r)');
    expect(filterNaNSource).toContain('discard;');
  });

  it('scopes its locals so repeated injection cannot redeclare them', () => {
    expect(filterNaNSource.trim().startsWith('{')).toBe(true);
    expect(filterNaNSource.trim().endsWith('}')).toBe(true);
  });
});
