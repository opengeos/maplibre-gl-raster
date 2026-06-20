import type { GeoTIFF } from '@developmentseed/geotiff';

const MODEL_TYPE_PROJECTED = 1;
const MODEL_TYPE_GEOGRAPHIC = 2;
const USER_DEFINED = 32767;
const EPSG_WEB_MERCATOR = 3857;

// Root keywords of the WKT/ESRI-PE-string flavours a GeoTIFF citation can carry.
// ArcGIS writes the full projection as `GTCitationGeoKey` / `PCSCitationGeoKey`
// (the latter prefixed with `ESRI PE String = `) when the numeric geo keys
// cannot express it. Match the first root so the `ESRI PE String = ` (or any
// other) prefix is stripped by slicing from the keyword.
const WKT_ROOT =
  /\b(?:PROJCS|PROJCRS|GEOGCS|GEOGCRS|GEOCCS|GEODCRS|BOUNDCRS|COMPD_CS|COMPOUNDCRS|VERT_CS|VERTCRS|LOCAL_CS|FITTED_CS)\s*\[/i;

// Legacy and ESRI codes that are all equivalent to EPSG:3857 (spherical Web
// Mercator): EPSG:3785 (deprecated), 900913 (Google), and ESRI 102100/102113.
// epsg.io and proj4 do not resolve the ESRI codes, so normalise them.
const WEB_MERCATOR_ALIASES = new Set([3785, 900913, 102100, 102113]);

// Citation fragments that identify the spherical Web Mercator. ESRI writes it as
// "WGS_1984_Web_Mercator" over the "Major Auxiliary Sphere"; EPSG:3785 was named
// "Popular Visualisation CRS / Mercator"; "Pseudo-Mercator" is the EPSG:3857 name.
const WEB_MERCATOR_CITATION =
  /web[ _]?mercator|pseudo[ _-]?mercator|popular[ _]?vis|auxiliary[ _]?sphere/i;

/** The subset of a parsed GeoKeyDirectory this repair reads and mutates. */
interface MutableGeoKeys {
  modelType: number | null;
  projMethod: number | null;
  projectedCRS: number | null;
  citation: string | null;
  projectedCitation: string | null;
  geodeticCitation: string | null;
}

function citationText(gkd: MutableGeoKeys): string {
  return [gkd.citation, gkd.projectedCitation, gkd.geodeticCitation]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
}

/**
 * Pull an embedded WKT (or ESRI PE string) definition out of a citation geo
 * key, if one is present. The projected citation is preferred because that is
 * where ArcGIS writes the full `PROJCS[...]` for an exotic projection; the
 * generic and geodetic citations are checked as fallbacks. Returns the WKT from
 * the first matching root keyword onward (dropping any `ESRI PE String = `
 * prefix), or `null` when no citation carries one.
 */
function wktFromCitation(gkd: MutableGeoKeys): string | null {
  for (const citation of [
    gkd.projectedCitation,
    gkd.citation,
    gkd.geodeticCitation,
  ]) {
    if (typeof citation !== 'string') continue;
    const match = WKT_ROOT.exec(citation);
    if (match) return citation.slice(match.index);
  }
  return null;
}

/**
 * Repair GeoTIFF CRS geo keys so {@link import('@developmentseed/geotiff').Overview.crs}
 * resolves them to the right projection, in place. Two problems are fixed:
 *
 * 1. **User-defined model type for a projected CRS.** `crsFromGeoKeys` only
 *    accepts `GTModelTypeGeoKey` 1 (projected) or 2 (geographic) and throws
 *    `Unsupported GeoTIFF model type: 32767` otherwise, so the raster never
 *    draws. ArcGIS exports the ESRI Web Mercator with a fully specified
 *    projection but leaves `GTModelTypeGeoKey` (and `ProjectedCSTypeGeoKey`)
 *    user-defined. When a projection method is present (`ProjMethodGeoKey`, i.e.
 *    `gkd.projMethod`) the CRS is unambiguously projected, so the model type is
 *    set to projected and the CRS is built from the keys (or the EPSG code in
 *    `ProjectedCSTypeGeoKey`). This is projection-agnostic.
 *
 * 2. **Spherical Web Mercator written as an ellipsoidal CRS.** ESRI's "Web
 *    Mercator Auxiliary Sphere" (a.k.a. Popular Visualisation CRS, EPSG:3857)
 *    projects on a sphere of radius 6378137, but the geo keys can only declare
 *    the WGS84 ellipsoid (the sphere lives only in the citation). Building the
 *    CRS from those keys yields an *ellipsoidal* Mercator, which misplaces the
 *    raster by kilometres in latitude. When the projected CRS is a Web Mercator
 *    alias code, or is user-defined with a Web-Mercator citation, it is replaced
 *    with EPSG:3857 so proj4's correct spherical definition is used.
 *
 * Files with a valid model type and a non-Web-Mercator EPSG/projection are left
 * untouched. Must run before any `Overview.crs` access (which caches its
 * result), so callers invoke it immediately after opening the GeoTIFF.
 *
 * 3. **A projection the geo keys cannot express.** Some projections have no
 *    `ProjCoordTransGeoKey` (e.g. equal-area world CRSes such as ESRI:54009
 *    World Mollweide), so ArcGIS/GDAL leave the model type user-defined and the
 *    full definition only in the citation as an `ESRI PE String = PROJCS[...]`
 *    WKT. `crsFromGeoKeys` then throws `Unsupported GeoTIFF model type: 32767`.
 *    {@link recoverCrsFromWktCitation} seeds the cached CRS from that WKT so the
 *    consuming layer (which calls `parseWkt`/proj4) builds the projection from
 *    it. This is projection-agnostic: proj4 understands the ESRI/OGC names.
 *
 * @param tiff - The opened GeoTIFF to repair in place.
 */
export function repairUserDefinedProjectedCrs(tiff: GeoTIFF): void {
  for (const overview of tiff.overviews) {
    // `gkd` is typed readonly, but it is a plain parsed object we own once the
    // GeoTIFF is open.
    const gkd = overview.gkd as unknown as MutableGeoKeys;

    // Normalise Web Mercator to EPSG:3857: by alias code, or — for a
    // user-defined projected CRS with a projection method — by citation.
    const projectedIsUserDefined =
      gkd.projectedCRS === null || gkd.projectedCRS === USER_DEFINED;
    if (gkd.projectedCRS !== null && WEB_MERCATOR_ALIASES.has(gkd.projectedCRS)) {
      gkd.projectedCRS = EPSG_WEB_MERCATOR;
    } else if (
      projectedIsUserDefined &&
      gkd.projMethod !== null &&
      WEB_MERCATOR_CITATION.test(citationText(gkd))
    ) {
      gkd.projectedCRS = EPSG_WEB_MERCATOR;
    }

    // Promote a user-defined model type to projected when the keys describe a
    // projection, so the (now possibly EPSG-coded) CRS can be built.
    const modelTypeIsUserDefined =
      gkd.modelType === null || gkd.modelType === USER_DEFINED;
    if (modelTypeIsUserDefined && gkd.projMethod !== null) {
      gkd.modelType = MODEL_TYPE_PROJECTED;
    }
  }

  recoverCrsFromWktCitation(tiff);
}

/**
 * Seed the GeoTIFF's cached CRS from an embedded WKT citation when the geo keys
 * still cannot describe the projection after {@link repairUserDefinedProjectedCrs}
 * has run. `crsFromGeoKeys` only accepts model type 1 (projected) or 2
 * (geographic) and throws otherwise; when the model type is still user-defined
 * (no `ProjMethodGeoKey` to promote it) the only definition is the WKT in the
 * citation. Setting the (lazily computed, single-shot) `_crs` cache to that WKT
 * string makes the getter return it instead of throwing, and the consuming layer
 * resolves it through `parseWkt` (wkt-parser + proj4).
 *
 * No-ops when the model type is resolvable, when the CRS is already cached, or
 * when no citation carries a WKT (so the original, descriptive error still
 * surfaces).
 */
function recoverCrsFromWktCitation(tiff: GeoTIFF): void {
  // `gkd` is shared by reference with every overview and with the GeoTIFF
  // itself (whose `crs` getter reads it), so the first overview's keys reflect
  // the repairs applied above.
  const gkd = tiff.overviews[0]?.gkd as unknown as MutableGeoKeys | undefined;
  if (!gkd) return;

  // crsFromGeoKeys handles these two; leave them to the upstream getter.
  if (
    gkd.modelType === MODEL_TYPE_PROJECTED ||
    gkd.modelType === MODEL_TYPE_GEOGRAPHIC
  ) {
    return;
  }

  const wkt = wktFromCitation(gkd);
  if (!wkt) return;

  // `_crs` is the private cache the `crs` getter fills on first access; it is a
  // plain field on the instance we own. Only seed it if untouched so we never
  // clobber an already-resolved CRS.
  const cache = tiff as unknown as { _crs?: unknown };
  if (cache._crs === undefined) cache._crs = wkt;
}
