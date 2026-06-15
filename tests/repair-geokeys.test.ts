import type { GeoTIFF } from '@developmentseed/geotiff';
import { describe, expect, it } from 'vitest';
import { repairUserDefinedProjectedCrs } from '../src/lib/raster/repair-geokeys';

/** Build a structural GeoTIFF stand-in with one gkd per overview. */
function fakeTiff(
  ...gkds: Array<{ modelType: number | null; projMethod: number | null }>
): GeoTIFF {
  return {
    overviews: gkds.map((gkd) => ({ gkd })),
  } as unknown as GeoTIFF;
}

const PROJECTED = 1;
const GEOGRAPHIC = 2;
const USER_DEFINED = 32767;

describe('repairUserDefinedProjectedCrs', () => {
  // Any projection method makes the CRS unambiguously projected; the repair is
  // projection-agnostic, so it flips the model type regardless of which one.
  // Transverse Mercator (1), Mercator (7), Lambert Conformal Conic (8).
  for (const projMethod of [1, 7, 8, 27]) {
    it(`flips a user-defined model type to projected (projMethod ${projMethod})`, () => {
      const tiff = fakeTiff({ modelType: USER_DEFINED, projMethod });
      repairUserDefinedProjectedCrs(tiff);
      expect(tiff.overviews[0].gkd.modelType).toBe(PROJECTED);
    });
  }

  it('treats a null model type with a projection method as projected', () => {
    const tiff = fakeTiff({ modelType: null, projMethod: 7 });
    repairUserDefinedProjectedCrs(tiff);
    expect(tiff.overviews[0].gkd.modelType).toBe(PROJECTED);
  });

  it('leaves a valid projected model type untouched', () => {
    const tiff = fakeTiff({ modelType: PROJECTED, projMethod: 7 });
    repairUserDefinedProjectedCrs(tiff);
    expect(tiff.overviews[0].gkd.modelType).toBe(PROJECTED);
  });

  it('leaves a geographic model type untouched', () => {
    const tiff = fakeTiff({ modelType: GEOGRAPHIC, projMethod: null });
    repairUserDefinedProjectedCrs(tiff);
    expect(tiff.overviews[0].gkd.modelType).toBe(GEOGRAPHIC);
  });

  it('leaves a user-defined model type with no projection method untouched', () => {
    // A user-defined geographic CRS has no projection method; not our case.
    const tiff = fakeTiff({ modelType: USER_DEFINED, projMethod: null });
    repairUserDefinedProjectedCrs(tiff);
    expect(tiff.overviews[0].gkd.modelType).toBe(USER_DEFINED);
  });

  it('repairs every overview', () => {
    const tiff = fakeTiff(
      { modelType: USER_DEFINED, projMethod: 7 },
      { modelType: USER_DEFINED, projMethod: 7 },
      { modelType: PROJECTED, projMethod: 7 },
    );
    repairUserDefinedProjectedCrs(tiff);
    expect(tiff.overviews.map((o) => o.gkd.modelType)).toEqual([
      PROJECTED,
      PROJECTED,
      PROJECTED,
    ]);
  });
});
