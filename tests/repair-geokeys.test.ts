import type { GeoTIFF } from '@developmentseed/geotiff';
import { describe, expect, it } from 'vitest';
import { repairUserDefinedProjectedCrs } from '../src/lib/raster/repair-geokeys';

interface GkdInput {
  modelType?: number | null;
  projMethod?: number | null;
  projectedCRS?: number | null;
  citation?: string | null;
  projectedCitation?: string | null;
  geodeticCitation?: string | null;
}

/** Build a structural GeoTIFF stand-in with one gkd per overview. */
function fakeTiff(...gkds: GkdInput[]): GeoTIFF {
  return {
    overviews: gkds.map((gkd) => ({
      gkd: {
        modelType: null,
        projMethod: null,
        projectedCRS: null,
        citation: null,
        projectedCitation: null,
        geodeticCitation: null,
        ...gkd,
      },
    })),
  } as unknown as GeoTIFF;
}

const PROJECTED = 1;
const GEOGRAPHIC = 2;
const USER_DEFINED = 32767;
const WEB_MERCATOR = 3857;

// A trimmed version of the ESRI PE string ArcGIS writes for Web Mercator.
const ESRI_WEB_MERCATOR_CITATION =
  'ESRI PE String = PROJCS["WGS_1984_Web_Mercator",' +
  'GEOGCS["GCS_WGS_1984_Major_Auxiliary_Sphere",...]';

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

  // ESRI's spherical Web Mercator is offset by kilometres if built from the geo
  // keys (which declare the WGS84 ellipsoid), so it is normalised to EPSG:3857.
  it('maps an ESRI Web Mercator auxiliary-sphere citation to EPSG:3857', () => {
    const tiff = fakeTiff({
      modelType: USER_DEFINED,
      projMethod: 7,
      projectedCRS: USER_DEFINED,
      projectedCitation: ESRI_WEB_MERCATOR_CITATION,
    });
    repairUserDefinedProjectedCrs(tiff);
    expect(tiff.overviews[0].gkd.projectedCRS).toBe(WEB_MERCATOR);
    expect(tiff.overviews[0].gkd.modelType).toBe(PROJECTED);
  });

  it('maps a "Popular Visualisation CRS" citation to EPSG:3857', () => {
    const tiff = fakeTiff({
      modelType: USER_DEFINED,
      projMethod: 7,
      projectedCRS: USER_DEFINED,
      citation: 'Popular Visualisation CRS / Mercator',
    });
    repairUserDefinedProjectedCrs(tiff);
    expect(tiff.overviews[0].gkd.projectedCRS).toBe(WEB_MERCATOR);
  });

  for (const code of [3785, 900913, 102100, 102113]) {
    it(`normalises Web Mercator alias code ${code} to EPSG:3857`, () => {
      const tiff = fakeTiff({
        modelType: PROJECTED,
        projMethod: 7,
        projectedCRS: code,
      });
      repairUserDefinedProjectedCrs(tiff);
      expect(tiff.overviews[0].gkd.projectedCRS).toBe(WEB_MERCATOR);
    });
  }

  it('keeps a real EPSG projected CRS code untouched', () => {
    // A user-defined model type still flips, but a valid EPSG code (UTM 17N) is
    // not a Web Mercator alias, so it must not be rewritten.
    const tiff = fakeTiff({
      modelType: USER_DEFINED,
      projMethod: 1,
      projectedCRS: 32617,
      projectedCitation: 'WGS 84 / UTM zone 17N',
    });
    repairUserDefinedProjectedCrs(tiff);
    expect(tiff.overviews[0].gkd.projectedCRS).toBe(32617);
    expect(tiff.overviews[0].gkd.modelType).toBe(PROJECTED);
  });

  it('does not map a non-Web-Mercator user-defined CRS to EPSG:3857', () => {
    const tiff = fakeTiff({
      modelType: USER_DEFINED,
      projMethod: 11,
      projectedCRS: USER_DEFINED,
      projectedCitation: 'Custom Albers Equal Area',
    });
    repairUserDefinedProjectedCrs(tiff);
    // Built from its own keys (still projected), not coerced to Web Mercator.
    expect(tiff.overviews[0].gkd.projectedCRS).toBe(USER_DEFINED);
    expect(tiff.overviews[0].gkd.modelType).toBe(PROJECTED);
  });

  describe('WKT-citation CRS recovery', () => {
    // ArcGIS exports an equal-area world CRS (no ProjCoordTransGeoKey) with a
    // user-defined model type and the full definition only in the PE string.
    const MOLLWEIDE_WKT =
      'PROJCS["World_Mollweide",GEOGCS["GCS_WGS_1984",' +
      'DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],' +
      'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],' +
      'PROJECTION["Mollweide"],PARAMETER["False_Easting",0.0],' +
      'PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",0.0],' +
      'UNIT["Meter",1.0]]';

    const crsCache = (tiff: GeoTIFF): unknown =>
      (tiff as unknown as { _crs?: unknown })._crs;

    it('seeds the cached CRS from an ESRI PE string when keys cannot express it', () => {
      const tiff = fakeTiff({
        modelType: USER_DEFINED,
        projMethod: null,
        projectedCitation: `ESRI PE String = ${MOLLWEIDE_WKT}`,
      });
      repairUserDefinedProjectedCrs(tiff);
      // No projection method to promote the model type, so it stays as-is...
      expect(tiff.overviews[0].gkd.modelType).toBe(USER_DEFINED);
      // ...but the WKT (with the `ESRI PE String = ` prefix dropped) is cached.
      expect(crsCache(tiff)).toBe(MOLLWEIDE_WKT);
    });

    it('falls back to the geodetic citation when the projected one is absent', () => {
      const tiff = fakeTiff({
        modelType: null,
        projMethod: null,
        geodeticCitation: MOLLWEIDE_WKT,
      });
      repairUserDefinedProjectedCrs(tiff);
      expect(crsCache(tiff)).toBe(MOLLWEIDE_WKT);
    });

    it('leaves the CRS unset when no citation carries a WKT', () => {
      const tiff = fakeTiff({
        modelType: USER_DEFINED,
        projMethod: null,
        citation: 'World_Mollweide',
      });
      repairUserDefinedProjectedCrs(tiff);
      // Just a name, no PROJCS[...] -> nothing to recover; the original
      // crsFromGeoKeys error is left to surface.
      expect(crsCache(tiff)).toBeUndefined();
    });

    it('does not seed the CRS for a resolvable (projected) model type', () => {
      const tiff = fakeTiff({
        modelType: USER_DEFINED,
        projMethod: 7, // promoted to projected -> resolvable from keys
        projectedCitation: `ESRI PE String = ${MOLLWEIDE_WKT}`,
      });
      repairUserDefinedProjectedCrs(tiff);
      expect(tiff.overviews[0].gkd.modelType).toBe(PROJECTED);
      expect(crsCache(tiff)).toBeUndefined();
    });

    it('does not seed the CRS for a geographic model type', () => {
      const tiff = fakeTiff({
        modelType: GEOGRAPHIC,
        projMethod: null,
        geodeticCitation: 'GEOGCS["GCS_WGS_1984",...]',
      });
      repairUserDefinedProjectedCrs(tiff);
      expect(crsCache(tiff)).toBeUndefined();
    });

    it('does not clobber an already-cached CRS', () => {
      const tiff = fakeTiff({
        modelType: USER_DEFINED,
        projMethod: null,
        projectedCitation: `ESRI PE String = ${MOLLWEIDE_WKT}`,
      });
      (tiff as unknown as { _crs?: unknown })._crs = 4326;
      repairUserDefinedProjectedCrs(tiff);
      expect(crsCache(tiff)).toBe(4326);
    });
  });
});
