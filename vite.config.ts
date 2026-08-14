import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import dts from "vite-plugin-dts";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    // Emit declarations to dist/types (matching the package.json "exports"
    // map). CSS side-effect imports are stripped automatically. bundleTypes
    // rolls each entry into a single self-contained .d.ts so consumers under
    // Node16 module resolution have no unresolved relative imports.
    dts({
      tsconfigPath: resolve(__dirname, "tsconfig.build.json"),
      entryRoot: resolve(__dirname, "src"),
      bundleTypes: true,
      outDirs: ["dist/types"],
    }),
  ],
  worker: { format: "es" },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, "src/index.ts"),
        react: resolve(__dirname, "src/react.ts"),
      },
      name: "MaplibreGLRaster",
      // ESM-only: the bundled @developmentseed geotiff stack uses top-level
      // await, which cannot be emitted as CJS.
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.mjs`,
    },
    rollupOptions: {
      // Peer dependencies stay external; bundling a second copy of
      // deck.gl/luma.gl would break luma Device sharing with the host app.
      external: [
        /^react($|\/)/,
        /^react-dom($|\/)/,
        /^maplibre-gl($|\/)/,
        /^@deck\.gl\//,
        /^@luma\.gl\//,
        // Optional peer dependency for the cog-tiler-wasm engine, imported
        // lazily; never bundled.
        /^cog-tiler-wasm($|\/)/,
        // `@developmentseed/geotiff` must NOT be bundled here. Its
        // `DecoderPool` creates the decode worker with
        // `new Worker(new URL("./worker.js", import.meta.url))`. Bundling it
        // makes Vite emit that worker as one of OUR assets and rewrite the
        // reference to a root-absolute `/assets/worker-<hash>.js`, wrapped in
        // `/* @vite-ignore */` so no downstream bundler can touch it. That path
        // only resolves if a consumer happens to serve this package's own
        // `dist/assets/` at their site root, which no consumer does: the app
        // requests `/assets/worker-<hash>.js`, gets its SPA fallback HTML back
        // instead of a module, and every tile then fails to decode.
        //
        // Left external, the consumer's own bundler sees the original relative
        // `new URL("./worker.js", import.meta.url)` inside node_modules and
        // emits + rewrites the worker itself, which is the one thing that
        // works in both a dev server and a production build. It is a real
        // `dependency`, so consumers already install it.
        //
        // Scoped to this one package on purpose. Externalizing the whole
        // `@developmentseed/*` scope also exposes
        // `@developmentseed/deck.gl-raster/gpu-modules/colormaps.png` as a bare
        // import, which a bundler resolves to an asset URL but plain Node
        // cannot load at all — it parses the PNG as JavaScript and dies with
        // `SyntaxError: Invalid or unexpected token`. That breaks every
        // consumer test that runs under `node --test`/vitest in a node
        // environment. Bundled, the PNG stays a `data:` URL as it always was.
        /^@developmentseed\/geotiff($|\/)/,
      ],
      output: {
        assetFileNames: (assetInfo) => {
          if (assetInfo.name === "style.css") return "maplibre-gl-raster.css";
          return assetInfo.name || "";
        },
      },
    },
    cssCodeSplit: false,
    sourcemap: true,
    minify: false,
  },
});
