import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Both builds have to keep the GeoTIFF decode worker reachable from wherever
 * the output is actually served.
 *
 * `@developmentseed/geotiff`'s `DecoderPool` creates its worker with
 * `new Worker(new URL("./worker.js", import.meta.url))`. Bundle that package
 * and Vite emits the worker as one of our assets and rewrites the reference to
 * a root-absolute `/assets/worker-<hash>.js`, wrapped in a `@vite-ignore`
 * comment so no downstream bundler can touch it. Nothing serves this package's
 * own `dist/assets/` at a site root, so the consuming app requests that path, gets
 * its SPA fallback HTML back instead of a module, and the pool loses every
 * worker: decoding silently drops to the main thread.
 *
 * Two different fixes, because the two outputs are consumed differently:
 *
 * - The **library** leaves the stack external, so the consumer's own bundler
 *   sees the original relative worker URL and emits it correctly.
 * - The **GeoLibre plugin** bundle is self-contained and is served from a
 *   plugin folder, so it keeps the worker but needs `base: "./"` to reference
 *   it relative to the chunk that loads it.
 *
 * These read the configs rather than the build output so they run without a
 * build step; the failure they guard against is invisible at build time and
 * only shows up as tiles that never decode in someone else's app.
 */
function configSource(name: string): string {
  return readFileSync(join(process.cwd(), name), "utf8");
}

describe("worker asset resolution", () => {
  it("keeps the @developmentseed stack external in the library build", () => {
    expect(configSource("vite.config.ts")).toMatch(/\/\^@developmentseed\\\//);
  });

  it("emits plugin-relative asset URLs in the GeoLibre plugin build", () => {
    expect(configSource("vite.geolibre.config.ts")).toMatch(
      /base:\s*["']\.\/["']/,
    );
  });
});
