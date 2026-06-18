import type {
  ProjectionFunction,
  RasterTilesetDescriptor,
} from '@developmentseed/deck.gl-raster';
import type { GeoTIFF } from '@developmentseed/geotiff';
import { describe, expect, it } from 'vitest';
import { WebMercatorCOGLayer } from '../src/lib/raster/web-mercator-cog-layer';

// A non-identity stand-in for the proj4-backed source→3857 transform
// deck.gl-geotiff builds. The fix replaces exactly this with the identity.
const proj4Like: ProjectionFunction = (x, y) => [x + 1, y + 1];

function makeDescriptor(): RasterTilesetDescriptor {
  return {
    levels: [],
    projectedBounds: [0, 0, 0, 0],
    projectTo3857: proj4Like,
    projectFrom3857: proj4Like,
    projectTo4326: proj4Like,
    projectFrom4326: proj4Like,
  };
}

/**
 * Drive the protected `_tilesetDescriptor` override without standing up a full
 * deck.gl layer: a prototype-backed instance with a stubbed `state` is enough,
 * since the base `_tilesetDescriptor` only reads `this.state.tilesetDescriptor`.
 */
function invokeWithCrs(
  crs: GeoTIFF['crs'] | undefined,
): RasterTilesetDescriptor | undefined {
  const descriptor = makeDescriptor();
  const layer = Object.create(
    WebMercatorCOGLayer.prototype,
  ) as WebMercatorCOGLayer & {
    state: { geotiff?: { crs: GeoTIFF['crs'] }; tilesetDescriptor: unknown };
    _tilesetDescriptor: () => RasterTilesetDescriptor | undefined;
  };
  layer.state = {
    geotiff: crs === undefined ? undefined : { crs },
    tilesetDescriptor: descriptor,
  };
  return layer._tilesetDescriptor();
}

describe('WebMercatorCOGLayer', () => {
  it('substitutes identity source→3857 transforms for an EPSG:3857 source', () => {
    const descriptor = invokeWithCrs(3857)!;
    // No wrap, no proj4 offset: a point round-trips unchanged.
    expect(descriptor.projectTo3857(20038000, -20049000)).toEqual([
      20038000, -20049000,
    ]);
    expect(descriptor.projectFrom3857(-20037016, 7)).toEqual([-20037016, 7]);
  });

  for (const code of [3785, 900913, 102100, 102113]) {
    it(`treats Web Mercator alias code ${code} as identity`, () => {
      const descriptor = invokeWithCrs(code)!;
      expect(descriptor.projectTo3857(123, 456)).toEqual([123, 456]);
      expect(descriptor.projectFrom3857(123, 456)).toEqual([123, 456]);
    });
  }

  it('leaves the 4326 transforms untouched (still real inverse mercator)', () => {
    const descriptor = invokeWithCrs(3857)!;
    expect(descriptor.projectTo4326).toBe(proj4Like);
    expect(descriptor.projectFrom4326).toBe(proj4Like);
  });

  it('does not patch a non-Web-Mercator source (e.g. EPSG:32633)', () => {
    const descriptor = invokeWithCrs(32633)!;
    expect(descriptor.projectTo3857).toBe(proj4Like);
    expect(descriptor.projectFrom3857).toBe(proj4Like);
  });

  it('does not patch a user-defined (WKT object) CRS', () => {
    const descriptor = invokeWithCrs({ name: 'User-defined' })!;
    expect(descriptor.projectTo3857).toBe(proj4Like);
  });

  it('returns undefined before the descriptor is built', () => {
    const layer = Object.create(
      WebMercatorCOGLayer.prototype,
    ) as WebMercatorCOGLayer & {
      state: { geotiff?: { crs: number }; tilesetDescriptor: undefined };
      _tilesetDescriptor: () => RasterTilesetDescriptor | undefined;
    };
    layer.state = { geotiff: { crs: 3857 }, tilesetDescriptor: undefined };
    expect(layer._tilesetDescriptor()).toBeUndefined();
  });

  it('reuses one stable identity function across calls (mesh-cache safe)', () => {
    const descriptor = makeDescriptor();
    const layer = Object.create(
      WebMercatorCOGLayer.prototype,
    ) as WebMercatorCOGLayer & {
      state: { geotiff: { crs: number }; tilesetDescriptor: unknown };
      _tilesetDescriptor: () => RasterTilesetDescriptor | undefined;
    };
    layer.state = { geotiff: { crs: 3857 }, tilesetDescriptor: descriptor };
    const first = layer._tilesetDescriptor()!.projectTo3857;
    const second = layer._tilesetDescriptor()!.projectTo3857;
    expect(second).toBe(first);
  });
});

describe('WebMercatorCOGLayer geographic (EPSG:4326) sources', () => {
  // Web-Mercator forward of ±180° longitude, the seam a global COG's padding
  // overhangs (3857 X half-extent = 6378137·π ≈ 20037508 m).
  const MERIDIAN_X = 6378137 * Math.PI;

  it('substitutes a wrap-free mercator forward for an EPSG:4326 source', () => {
    const { projectTo3857 } = invokeWithCrs(4326)!;
    // Exactly 180° lands on the seam; in-range lon/lat use the standard
    // spherical-mercator math (here lon 0 → x 0, the equator → y 0).
    expect(projectTo3857(180, 0)[0]).toBeCloseTo(MERIDIAN_X, 3);
    const [x0, y0] = projectTo3857(0, 0);
    expect(x0).toBeCloseTo(0, 6);
    expect(y0).toBeCloseTo(0, 6);
  });

  it('does not fold padding columns past the antimeridian (issue #444)', () => {
    // The bug: proj4 wraps lon 180.5° back to −179.5°, so the X coordinate
    // jumps from ≈ +20.04e6 to ≈ −19.9e6 — a ~40,000 km mesh edge. The fix
    // keeps X continuous and monotonic just past the seam.
    const { projectTo3857 } = invokeWithCrs(4326)!;
    const justPast = projectTo3857(180.5, 0)[0];
    expect(justPast).toBeGreaterThan(MERIDIAN_X);
    expect(justPast - MERIDIAN_X).toBeLessThan(1e6); // a small step, not a wrap
  });

  it('round-trips lon/lat through forward then inverse', () => {
    const { projectTo3857, projectFrom3857 } = invokeWithCrs(4326)!;
    for (const [lon, lat] of [
      [-179.95, 49.95],
      [12.5, -33.3],
      [180, 0],
    ]) {
      const [x, y] = projectTo3857(lon, lat);
      const [lon2, lat2] = projectFrom3857(x, y);
      expect(lon2).toBeCloseTo(lon, 6);
      expect(lat2).toBeCloseTo(lat, 6);
    }
  });

  it('reuses one stable forward function across calls (mesh-cache safe)', () => {
    const descriptor = makeDescriptor();
    const layer = Object.create(
      WebMercatorCOGLayer.prototype,
    ) as WebMercatorCOGLayer & {
      state: { geotiff: { crs: number }; tilesetDescriptor: unknown };
      _tilesetDescriptor: () => RasterTilesetDescriptor | undefined;
    };
    layer.state = { geotiff: { crs: 4326 }, tilesetDescriptor: descriptor };
    const first = layer._tilesetDescriptor()!.projectTo3857;
    expect(layer._tilesetDescriptor()!.projectTo3857).toBe(first);
  });

  it('leaves the 4326 bounds transforms untouched', () => {
    const descriptor = invokeWithCrs(4326)!;
    expect(descriptor.projectTo4326).toBe(proj4Like);
    expect(descriptor.projectFrom4326).toBe(proj4Like);
  });

  it('does not patch other geographic datums (e.g. NAD83/EPSG:4269)', () => {
    // Only WGS84 lon/lat maps to 3857 without a datum shift, so 4269 keeps the
    // proj4-backed transform that performs one.
    const descriptor = invokeWithCrs(4269)!;
    expect(descriptor.projectTo3857).toBe(proj4Like);
    expect(descriptor.projectFrom3857).toBe(proj4Like);
  });
});
