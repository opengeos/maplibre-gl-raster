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
