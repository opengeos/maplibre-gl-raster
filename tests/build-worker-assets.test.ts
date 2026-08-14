import { describe, expect, it } from "vitest";
import libraryConfig from "../vite.config";
import geolibreConfig from "../vite.geolibre.config";

/**
 * Both builds have to keep the GeoTIFF decode worker reachable from wherever
 * the output is actually served.
 *
 * `@developmentseed/geotiff`'s `DecoderPool` creates its worker with
 * `new Worker(new URL("./worker.js", import.meta.url))`. Bundle that package
 * and Vite emits the worker as one of our assets and rewrites the reference to
 * a root-absolute `/assets/worker-<hash>.js`, wrapped in a `@vite-ignore`
 * comment so no downstream bundler can touch it. Nothing serves this package's
 * own `dist/assets/` at a site root, so the consuming app requests that path,
 * gets its SPA fallback HTML back instead of a module, and the pool loses every
 * worker: decoding silently drops to the main thread.
 *
 * Two different fixes, because the two outputs are consumed differently:
 *
 * - The **library** leaves that one package external, so the consumer's own
 *   bundler sees the original relative worker URL and emits it correctly.
 * - The **GeoLibre plugin** bundle is self-contained and is served from a
 *   plugin folder, so it keeps the worker but needs `base: "./"` to reference
 *   it relative to the chunk that loads it.
 *
 * The externalization has to stay scoped to `@developmentseed/geotiff`: taking
 * the whole scope out also exposes `deck.gl-raster`'s `colormaps.png` as a bare
 * import, which plain Node cannot load (it parses the PNG as JavaScript), so
 * every consumer test running in a node environment dies on import.
 *
 * These assert against the resolved config objects, and the externals case
 * against the specifiers Rollup will actually test, rather than against the
 * config source text. The failure they guard is invisible at build time and
 * only shows up as tiles that never decode inside someone else's app.
 */
function isExternal(specifier: string): boolean {
  const external = libraryConfig.build?.rollupOptions?.external;
  if (!Array.isArray(external))
    throw new Error("rollupOptions.external is not a list");
  return external.some((entry) =>
    entry instanceof RegExp ? entry.test(specifier) : entry === specifier,
  );
}

describe("worker asset resolution", () => {
  it("keeps the package that owns the worker external in the library build", () => {
    expect(isExternal("@developmentseed/geotiff")).toBe(true);
    expect(isExternal("@developmentseed/geotiff/pool")).toBe(true);
  });

  it("keeps the rest of the @developmentseed scope bundled", () => {
    // Especially the PNG: as a bare import it resolves to an asset URL under a
    // bundler but is unloadable in plain Node, which breaks consumers' tests.
    expect(
      isExternal("@developmentseed/deck.gl-raster/gpu-modules/colormaps.png"),
    ).toBe(false);
    expect(isExternal("@developmentseed/deck.gl-raster/gpu-modules")).toBe(
      false,
    );
    expect(isExternal("@developmentseed/deck.gl-geotiff")).toBe(false);
    expect(isExternal("@developmentseed/proj")).toBe(false);
  });

  it("still bundles everything else it always bundled", () => {
    expect(isExternal("proj4")).toBe(false);
    expect(isExternal("@cogeotiff/core")).toBe(false);
  });

  it("emits plugin-relative asset URLs in the GeoLibre plugin build", () => {
    expect(geolibreConfig.base).toBe("./");
  });
});
