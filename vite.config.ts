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
      ],
      output: {
        assetFileNames: (assetInfo) => {
          if (assetInfo.name === "style.css")
            return "maplibre-gl-raster.css";
          return assetInfo.name || "";
        },
      },
    },
    cssCodeSplit: false,
    sourcemap: true,
    minify: false,
  },
});
