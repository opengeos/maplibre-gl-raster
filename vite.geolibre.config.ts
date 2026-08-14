import { defineConfig } from "vite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // This bundle is self-contained and is served from a plugin directory, never
  // from the site root. The default root `base` would emit the GeoTIFF decode
  // worker that `DecoderPool` creates as a root-absolute
  // `/assets/worker-<hash>.js`, which resolves to the HOST app's origin root
  // rather than the plugin's own folder: the request comes back as the host's
  // SPA fallback HTML instead of a module and every tile fails to decode. "./"
  // emits it relative to the chunk that loads it, which is where the packaging
  // script actually ships it (it zips every file under dist/, assets included).
  base: "./",
  worker: { format: "es" },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  build: {
    lib: {
      entry: resolve(__dirname, "src/geolibre.ts"),
      formats: ["es"],
      fileName: () => "index.js",
    },
    outDir: "geolibre-plugin/dist",
    emptyOutDir: true,
    rollupOptions: {
      external: [],
      output: {
        assetFileNames: () => "style.css",
      },
    },
    cssCodeSplit: false,
    sourcemap: false,
    minify: false,
  },
});
