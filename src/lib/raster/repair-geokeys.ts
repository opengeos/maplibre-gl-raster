import type { GeoTIFF } from '@developmentseed/geotiff';

/**
 * Repair GeoTIFFs whose projected CRS is tagged with a "user-defined" model
 * type so {@link import('@developmentseed/geotiff').Overview.crs} can build it.
 *
 * `crsFromGeoKeys` only accepts `GTModelTypeGeoKey` of 1 (projected) or 2
 * (geographic) and throws `Unsupported GeoTIFF model type: 32767` for anything
 * else. Some exporters (notably ArcGIS, which writes an ESRI PE string for the
 * `WGS_1984_Web_Mercator` / "Popular Visualisation CRS" auxiliary-sphere
 * Mercator) emit a fully specified projected CRS via the projection geo keys
 * but leave `GTModelTypeGeoKey` and `ProjectedCSTypeGeoKey` as user-defined
 * (32767). COGLayer then fails to resolve the CRS and the raster never draws,
 * even though the projection is completely described by the keys already
 * present. See GeoLibre issue #393.
 *
 * When a projection coordinate-transformation method is present
 * (`ProjMethodGeoKey`, exposed as `gkd.projMethod`), the CRS is unambiguously
 * projected, so we set `modelType` to projected. `crsFromGeoKeys` then takes
 * the projected path and builds a PROJJSON CRS from the projection keys (or
 * returns the EPSG code when `ProjectedCSTypeGeoKey` carries one). Files with a
 * valid model type, or user-defined geographic CRSes with no projection method,
 * are left untouched.
 *
 * Must run before any `Overview.crs` access, which caches its result; callers
 * invoke it immediately after opening the GeoTIFF and before handing it to
 * COGLayer.
 *
 * @param tiff - The opened GeoTIFF to repair in place.
 */
export function repairUserDefinedProjectedCrs(tiff: GeoTIFF): void {
  const MODEL_TYPE_PROJECTED = 1;
  const MODEL_TYPE_USER_DEFINED = 32767;

  for (const overview of tiff.overviews) {
    // `gkd` is typed readonly, but it is a plain parsed object we own once the
    // GeoTIFF is open; narrow to the two keys this repair touches.
    const gkd = overview.gkd as {
      modelType: number | null;
      projMethod: number | null;
    };
    const modelTypeIsUserDefined =
      gkd.modelType === null || gkd.modelType === MODEL_TYPE_USER_DEFINED;
    if (modelTypeIsUserDefined && gkd.projMethod !== null) {
      gkd.modelType = MODEL_TYPE_PROJECTED;
    }
  }
}
