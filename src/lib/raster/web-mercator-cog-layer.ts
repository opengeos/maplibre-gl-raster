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

// Stable identity so the source→3857 reprojection functions keep referential
// equality across renders. RasterTileLayer caches each tile's reprojection mesh
// by `reprojectionFns` identity, so a fresh closure per render would rebuild
// every mesh on every frame.
const identity: ProjectionFunction = (x, y) => [x, y];

function isWebMercatorCrs(crs: GeoTIFF['crs'] | undefined): boolean {
  return typeof crs === 'number' && WEB_MERCATOR_CODES.has(crs);
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
 * and cheaper than proj4. The 4326 transforms are deliberately left untouched —
 * they are a genuine inverse mercator and back the geographic bounds and the
 * globe view.
 *
 * The fix lives here rather than upstream because deck.gl-geotiff hard-codes the
 * projection setup inside `_parseGeoTIFF` and exposes no hook for it;
 * `_tilesetDescriptor()` is the one seam through which the built descriptor
 * flows to both tile traversal and per-tile rendering. Remove this once
 * deck.gl-geotiff short-circuits same-CRS reprojection itself.
 */
export class WebMercatorCOGLayer<
  DataT extends MinimalTileData = MinimalTileData,
> extends COGLayer<DataT> {
  static layerName = 'WebMercatorCOGLayer';

  protected _tilesetDescriptor(): RasterTilesetDescriptor | undefined {
    const descriptor = super._tilesetDescriptor();
    if (
      descriptor &&
      descriptor.projectTo3857 !== identity &&
      isWebMercatorCrs(this.state.geotiff?.crs)
    ) {
      // Mutate in place (the descriptor is rebuilt whenever the GeoTIFF
      // changes) and guard on the identity check above so this runs once.
      descriptor.projectTo3857 = identity;
      descriptor.projectFrom3857 = identity;
    }
    return descriptor;
  }
}
