import { COGLayer } from '@developmentseed/deck.gl-geotiff';
import type {
  MinimalTileData,
  ProjectionFunction,
  RasterTilesetDescriptor,
} from '@developmentseed/deck.gl-raster';
import type { GeoTIFF } from '@developmentseed/geotiff';

// EPSG (and ESRI) codes equivalent to spherical Web Mercator. Mirrors
// WEB_MERCATOR_ALIASES in repair-geokeys.ts: the alias codes are normalised to
// 3857 there before the CRS is read, but a COG can legitimately declare any of
// them, so accept the whole family here too.
const WEB_MERCATOR_CODES = new Set([3857, 3785, 900913, 102100, 102113]);

// Geographic WGS84 lon/lat. A 4326 source→3857 transform is just the spherical
// mercator forward, which we can supply wrap-free (see geographicTo3857). Only
// 4326 qualifies: other geographic datums (e.g. NAD83/4269) would need a datum
// shift that the plain mercator math below does not perform.
const GEOGRAPHIC_WGS84 = 4326;

// Spherical-mercator constants. EPSG:3857 is defined on a sphere of this
// radius, so these reproduce proj4's "EPSG:3857" math exactly — minus the
// longitude wrap (see below).
const EARTH_RADIUS = 6378137;
const DEG2RAD = Math.PI / 180;

// Stable identity so the source→3857 reprojection functions keep referential
// equality across renders. RasterTileLayer caches each tile's reprojection mesh
// by `reprojectionFns` identity, so a fresh closure per render would rebuild
// every mesh on every frame.
const identity: ProjectionFunction = (x, y) => [x, y];

// Wrap-free spherical-mercator forward (lon°, lat° → 3857 metres). proj4's
// mercator forward runs `adjust_lon`, which wraps longitudes outside ±180°
// back into range — so the full-tile padding columns that overhang a global
// COG's antimeridian edge jump to the opposite hemisphere, producing
// ~40,000 km mesh edges that Delatin can never refine (GeoLibre issue #444).
// Omitting the wrap keeps the mesh continuous; for in-range longitudes the
// result is identical to proj4. Module-scope for stable referential equality.
const geographicTo3857: ProjectionFunction = (lon, lat) => [
  EARTH_RADIUS * lon * DEG2RAD,
  EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + (lat * DEG2RAD) / 2)),
];

// Inverse of geographicTo3857 (3857 metres → lon°, lat°).
const geographicFrom3857: ProjectionFunction = (x, y) => [
  x / EARTH_RADIUS / DEG2RAD,
  (2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2) / DEG2RAD,
];

function isWebMercatorCrs(crs: GeoTIFF['crs'] | undefined): boolean {
  return typeof crs === 'number' && WEB_MERCATOR_CODES.has(crs);
}

function isGeographicWgs84Crs(crs: GeoTIFF['crs'] | undefined): boolean {
  return crs === GEOGRAPHIC_WGS84;
}

/**
 * {@link COGLayer} that reprojects a Web-Mercator source with the identity
 * transform instead of a proj4 round-trip.
 *
 * `@developmentseed/deck.gl-geotiff` builds its source→EPSG:3857 projection
 * functions via `proj4(sourceProjection, "EPSG:3857")` even when the source CRS
 * is already EPSG:3857. proj4 has no identity short-circuit: it inverts the
 * source to lon/lat and re-projects, and the mercator inverse/forward normalise
 * longitude into (−180°, 180°]. A COG whose extent reaches or crosses the
 * antimeridian — common for global rasters, e.g. a world COG with X bounds of
 * ±20038000 m, just past the valid ±20037508.342789244 m — therefore has its
 * edge wrapped to the opposite hemisphere. Worse, every partial edge tile is
 * padded to a full tile, so the padding columns past the image always overhang
 * the antimeridian and wrap regardless of the declared extent. The per-tile
 * reprojection mesh then has vertices ~40,000 km apart, so Delatin refinement
 * never converges ("RasterReprojector: mesh refinement did not converge after
 * … iterations") and the tile renders as garbage. See GeoLibre issue #444.
 *
 * For a source already in EPSG:3857 the source→3857 transform *is* the
 * identity, so we substitute it directly: exact (no precision loss), wrap-free,
 * and cheaper than proj4. For a geographic EPSG:4326 source — equally common
 * for global rasters, e.g. the CHIRPS precipitation COG — the source→3857
 * transform is the spherical mercator forward, which we substitute with a
 * wrap-free implementation (`geographicTo3857`) so the antimeridian padding
 * columns no longer fold to the other hemisphere. Both substitutions only
 * touch the source↔3857 transforms; the 4326 bounds transforms are left
 * untouched — they back the geographic bounds and the globe view.
 *
 * The fix lives here rather than upstream because deck.gl-geotiff hard-codes the
 * projection setup inside `_parseGeoTIFF` and exposes no hook for it;
 * `_tilesetDescriptor()` is the one seam through which the built descriptor
 * flows to both tile traversal and per-tile rendering. Remove this once
 * deck.gl-geotiff short-circuits same-CRS reprojection and clamps the
 * antimeridian overhang itself.
 */
export class WebMercatorCOGLayer<
  DataT extends MinimalTileData = MinimalTileData,
> extends COGLayer<DataT> {
  static layerName = 'WebMercatorCOGLayer';

  protected _tilesetDescriptor(): RasterTilesetDescriptor | undefined {
    const descriptor = super._tilesetDescriptor();
    if (!descriptor) return descriptor;
    const crs = this.state.geotiff?.crs;
    // Mutate in place (the descriptor is rebuilt whenever the GeoTIFF changes)
    // and guard on referential equality so each branch runs once.
    if (descriptor.projectTo3857 !== identity && isWebMercatorCrs(crs)) {
      descriptor.projectTo3857 = identity;
      descriptor.projectFrom3857 = identity;
    } else if (
      descriptor.projectTo3857 !== geographicTo3857 &&
      isGeographicWgs84Crs(crs)
    ) {
      descriptor.projectTo3857 = geographicTo3857;
      descriptor.projectFrom3857 = geographicFrom3857;
    }
    return descriptor;
  }
}
