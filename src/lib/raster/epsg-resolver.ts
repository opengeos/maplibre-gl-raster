import {
  epsgResolver as upstreamEpsgResolver,
  parseWkt,
  type EpsgResolver,
  type ProjectionDefinition,
  type ProjJson,
} from '@developmentseed/proj';

/**
 * CRS resolution for COG rendering.
 *
 * `@developmentseed/deck.gl-geotiff`'s COGLayer resolves a GeoTIFF's numeric
 * EPSG code to a projection definition by fetching `https://epsg.io/<code>.json`
 * at render time (its default {@link EpsgResolver}). When that request fails
 * (offline, epsg.io down or rate-limited, or a code epsg.io does not serve) the
 * layer renders nothing and, because COGLayer does not surface the rejection,
 * the failure is silent: the layer appears to load but never draws. See
 * GeoLibre issue #376.
 *
 * {@link createResilientEpsgResolver} addresses the first part: it answers the
 * most common geographic CRS (EPSG:4326) from a built-in definition so no
 * network call is made, delegates everything else to a fallback resolver
 * (epsg.io by default, or a fully offline resolver supplied by the host app),
 * and wraps failures in a clear, actionable message. The LayerManager pairs it
 * with error surfacing so a resolution failure becomes a visible layer error
 * instead of an invisible layer.
 */

// WGS84 as PROJJSON, parsed once. EPSG:4326 is by far the most common CRS for
// scanned/warped maps and web data, so resolving it offline removes the most
// frequent epsg.io round-trip. (EPSG:3857 never reaches the resolver: COGLayer
// special-cases it to proj4's built-in definition.)
const WGS84_PROJJSON: ProjJson = {
  type: 'GeographicCRS',
  name: 'WGS 84',
  datum: {
    type: 'GeodeticReferenceFrame',
    name: 'World Geodetic System 1984',
    ellipsoid: {
      name: 'WGS 84',
      semi_major_axis: 6378137,
      inverse_flattening: 298.257223563,
    },
  },
  coordinate_system: {
    subtype: 'ellipsoidal',
    axis: [
      {
        name: 'Geodetic latitude',
        abbreviation: 'Lat',
        direction: 'north',
        unit: 'degree',
      },
      {
        name: 'Geodetic longitude',
        abbreviation: 'Lon',
        direction: 'east',
        unit: 'degree',
      },
    ],
  },
};

const OFFLINE_DEFS = new Map<number, ProjectionDefinition>([
  [4326, parseWkt(WGS84_PROJJSON)],
]);

export interface ResilientEpsgResolverOptions {
  /**
   * Resolver used for EPSG codes without a built-in offline definition.
   * Defaults to the upstream epsg.io-backed resolver. Supply a fully offline
   * resolver (e.g. one backed by a local EPSG database) to remove the network
   * dependency entirely.
   */
  fallback?: EpsgResolver;
}

/**
 * Builds an {@link EpsgResolver} that resolves common CRS offline, delegates
 * the rest to {@link ResilientEpsgResolverOptions.fallback} (epsg.io by
 * default), and rethrows failures with a clear, actionable message.
 *
 * @param options - Optional fallback resolver override.
 * @returns A resolver suitable for the COGLayer `epsgResolver` prop.
 */
export function createResilientEpsgResolver(
  options: ResilientEpsgResolverOptions = {},
): EpsgResolver {
  const fallback = options.fallback ?? upstreamEpsgResolver;
  return async (epsg: number): Promise<ProjectionDefinition> => {
    const offline = OFFLINE_DEFS.get(epsg);
    if (offline) return offline;
    try {
      return await fallback(epsg);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      const error = new Error(
        `Could not resolve coordinate system EPSG:${epsg}. ` +
          'Coordinate systems are looked up from epsg.io; check your network ' +
          `connection or that the code is valid, then re-add the layer. (${detail})`,
      );
      // Preserve the underlying cause without relying on the ErrorOptions
      // constructor argument (not in this project's TS lib target).
      if (cause instanceof Error) (error as { cause?: unknown }).cause = cause;
      throw error;
    }
  };
}
