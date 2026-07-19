# maplibre-gl-raster

A MapLibre GL JS plugin for visualizing local and remote raster datasets (GeoTIFF / Cloud Optimized GeoTIFF) directly in the browser. No tile server required: COGs are read with HTTP range requests and rendered on the GPU through a deck.gl pipeline.

[![npm version](https://img.shields.io/npm/v/maplibre-gl-raster.svg)](https://www.npmjs.com/package/maplibre-gl-raster)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Open in CodeSandbox](https://img.shields.io/badge/Open%20in-CodeSandbox-blue?logo=codesandbox)](https://codesandbox.io/p/github/opengeos/maplibre-gl-raster)
[![Open in StackBlitz](https://img.shields.io/badge/Open%20in-StackBlitz-blue?logo=stackblitz)](https://stackblitz.com/github/opengeos/maplibre-gl-raster)

## Features

- **Local and remote rasters** - Load Cloud Optimized GeoTIFFs from any CORS-enabled URL, or drag-and-drop local GeoTIFF files
- **Mosaic VRTs** - Load a `.vrt` that mosaics COGs; its sources are rendered as one layer with a single shared stretch ([details and limits](#mosaic-vrt-support))
- **Three rendering backends** - Switch at runtime between the deck.gl GPU pipeline (default), a serverless WASM tiler, and a remote [TiTiler](https://developmentseed.org/titiler/) server; TiTiler additionally renders [MosaicJSON](https://developmentseed.org/titiler/examples/notebooks/Working_with_MosaicJSON) ([details](#rendering-engines))
- **Multiple layers** - Layer list with visibility toggles, reordering, zoom-to, and per-layer settings
- **GPU rendering pipeline** - Band compositing, per-band rescale, 90+ colormaps, nodata filtering, linear/sqrt/log stretch, and gamma correction as deck.gl shader modules; parameter changes re-render without re-fetching tiles
- **Auto statistics** - Per-band min/max and histograms sampled from COG overviews (or GDAL metadata), with draggable histogram handles for the rescale range
- **Pixel inspector** - Toggle inspect mode and click the map to read the raw source values of every band of the selected layer at that location, shown in a popup (works for COGs in any CRS)
- **Colorbar legend** - A standalone `Colorbar` control: gradient + tick labels for a named colormap (or custom colors), with configurable min/max, title, units, orientation, and position
- **Collapsible control** - A compact 29x29 map button that expands into a floating panel
- **TypeScript + React** - Full type definitions, a React wrapper component, and hooks
- **GeoLibre bundle output** - Builds a zip with root `plugin.json`, bundled ESM, and CSS for GeoLibre Desktop

## Installation

```bash
npm install maplibre-gl-raster
```

The plugin declares `maplibre-gl`, `@deck.gl/*`, and `@luma.gl/*` as peer dependencies (npm 7+ installs them automatically). This package is ESM-only.

## Quick Start

### Vanilla JavaScript/TypeScript

```typescript
import maplibregl from "maplibre-gl";
import { RasterControl } from "maplibre-gl-raster";
import "maplibre-gl-raster/style.css";

const map = new maplibregl.Map({
  container: "map",
  style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
  center: [0, 0],
  zoom: 2,
});

map.on("load", () => {
  const control = new RasterControl({ collapsed: false });
  map.addControl(control, "top-right");

  // Optionally add a raster programmatically (users can also paste a URL
  // or drop a local GeoTIFF file in the panel).
  control.addRaster("https://example.com/data/cog.tif");
});
```

### React

```tsx
import { useEffect, useRef, useState } from "react";
import maplibregl, { Map } from "maplibre-gl";
import { RasterControlReact, useRasterState } from "maplibre-gl-raster/react";
import "maplibre-gl-raster/style.css";

function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<Map | null>(null);
  const { state, toggle } = useRasterState();

  useEffect(() => {
    if (!mapContainer.current) return;

    const mapInstance = new maplibregl.Map({
      container: mapContainer.current,
      style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
      center: [0, 0],
      zoom: 2,
    });

    mapInstance.on("load", () => setMap(mapInstance));

    return () => mapInstance.remove();
  }, []);

  return (
    <div style={{ width: "100%", height: "100vh" }}>
      <div ref={mapContainer} style={{ width: "100%", height: "100%" }} />
      {map && (
        <RasterControlReact
          map={map}
          collapsed={state.collapsed}
          onReady={(control) => control.addRaster("https://example.com/cog.tif")}
        />
      )}
    </div>
  );
}
```

## API

### RasterControl

The main control class implementing MapLibre's `IControl` interface.

#### Constructor Options

| Option        | Type      | Default       | Description                                                               |
| ------------- | --------- | ------------- | ------------------------------------------------------------------------- |
| `collapsed`   | `boolean` | `true`        | Whether the panel starts collapsed (showing only the 29x29 toggle button) |
| `position`    | `string`  | `'top-right'` | Control position on the map                                               |
| `title`       | `string`  | `'Raster'`    | Title displayed in the header                                             |
| `panelWidth`  | `number`  | `360`         | Width of the dropdown panel in pixels                                     |
| `className`   | `string`  | `''`          | Custom CSS class name                                                     |
| `interleaved` | `boolean` | `true`        | Render the deck.gl overlay interleaved with the basemap layers            |
| `defaultUrl`  | `string`  | `''`          | Prefills the Add data URL input (not loaded until the user clicks Load)  |
| `autoLoad`    | `boolean` | `false`       | Load `defaultUrl` automatically when the control is added to the map     |
| `sampleData`  | `RasterSampleDataset[]` | - | Sample COGs offered as a "Load sample data" dropdown above the URL input; picking one fills the input (hidden when empty) |
| `sampleDataLabel` | `string` | `'Load sample data...'` | Placeholder shown in the sample-data dropdown |
| `closeOnOutsideClick` | `boolean` | `true` | Collapse the panel when clicking outside it; set `false` to close only via the header button |
| `engine`      | `RenderEngine` | `'maplibre-gl-raster'` | Initial rendering backend; switchable at runtime from the panel    |
| `titilerEndpoint` | `string` | `'https://titiler.d2s.org'` | TiTiler instance used by the `'titiler'` engine (COG + MosaicJSON) |

#### Raster Methods

- `addRaster(source, options?)` - Add a raster from a COG, [mosaic `.vrt`](#mosaic-vrt-support), or [MosaicJSON](#rendering-engines) `.json` URL (`string`), or a local GeoTIFF / `.vrt` `File` (a local `.vrt` must name its sources as absolute URLs); resolves with the layer id. A MosaicJSON URL renders through the [`titiler`](#rendering-engines) engine (selected automatically)
- `removeRaster(id)` - Remove a raster layer
- `getRaster(id)` / `getRasters()` - Get layer snapshots (`RasterLayerInfo`); for a mosaic VRT, `memberUrls` lists the COGs it expanded to
- `setRasterState(id, patch)` - Update visualization state (mode, bands, rescale, colormap, reversed, nodata, opacity, gamma, stretch, visible)
- `setVisible(id, visible)` - Show / hide a layer
- `selectRaster(id | null)` - Choose which layer the panel's settings edit
- `zoomToRaster(id)` - Fit the map to a layer's bounds
- `reorderRaster(id, toIndex)` - Move a layer in the draw order (0 = bottom)
- `getEngine()` / `setEngine(engine)` - Read / switch the rendering backend (see [Rendering engines](#rendering-engines))

`addRaster` options (`AddRasterOptions`): `id`, `name`, `state` (initial `Partial<RasterLayerState>` overrides), `zoomTo` (default `true`), and `beforeId` (insert the raster beneath an existing style layer, e.g. a label layer; also available as an input in the panel's Add data section).

#### Panel Methods

- `toggle()` / `expand()` / `collapse()` - Control the panel
- `getState()` / `setState(state)` - Control-level state (collapsed, panelWidth)
- `on(event, handler)` / `off(event, handler)` - Event handlers
- `getMap()` / `getContainer()` - Access the map / container

#### Events

- `collapse` / `expand` / `statechange` - Panel state events
- `rasteradd` / `rasterremove` / `rasterchange` / `rasterselect` - Layer lifecycle events (payload includes `layerId`)
- `error` - Loading or rendering errors (payload includes `error`)

### Rendering engines

The panel has a **Rendering engine** selector (and a matching `engine` option /
`getEngine()` / `setEngine()` API) that switches the backend used for every
layer:

- **`maplibre-gl-raster`** (default) - the GPU pipeline described above: a
  deck.gl `COGLayer` on a shared `MapboxOverlay`. Parameter changes re-render
  without re-fetching tiles.
- **`cog-tiler-wasm`** - a serverless CPU/WASM XYZ tiler
  ([cog-tiler-wasm](https://github.com/opengeos/cog-tiler-wasm)) wired to a
  MapLibre custom protocol. Tiles are rendered on the CPU and served as native
  MapLibre raster layers. The panel's settings (bands, rescale, colormap,
  curve, gamma, nodata, opacity) map directly onto its render parameters.
- **`titiler`** - a server-side dynamic tiler
  ([TiTiler](https://developmentseed.org/titiler/)). Tiles are rendered by a
  remote TiTiler instance and drawn as native MapLibre raster layers, so
  nothing is decoded in the browser. It is the **only engine that can render a
  [MosaicJSON](https://developmentseed.org/titiler/examples/notebooks/Working_with_MosaicJSON)**
  (a `.json` manifest of many COGs) - just paste the manifest URL and it loads
  through TiTiler's `/mosaicjson` router; adding one selects this engine
  automatically. Bands, rescale, colormap, and a numeric nodata map onto
  TiTiler's tile parameters (index mode uses a server-side band-math
  `expression`, so the real normalized-difference index is rendered). The
  `stretch` and `gamma` controls have no standard TiTiler parameter and are
  ignored. Only remote sources work (TiTiler reads over HTTP), so local files
  and `.vrt` mosaics render on the other engines.

  The default instance is `https://titiler.d2s.org`; point it at your own
  deployment with the `titilerEndpoint` option, the `setTitilerEndpoint()` API,
  or the **TiTiler server** input the panel shows while the `titiler` engine is
  selected (clearing it restores the default):

  ```typescript
  const control = new RasterControl({
    engine: "titiler",
    titilerEndpoint: "https://titiler.example.com",
  });
  // Render a COG, or a MosaicJSON (auto-selects the titiler engine):
  await control.addRaster("https://example.com/mosaic.json");
  // Switch the server at runtime (the panel input stays in sync):
  control.setTitilerEndpoint("https://titiler.xyz");
  ```

  > The TiTiler server must be able to read the source. A MosaicJSON whose
  > assets are `s3://…` paths only renders on a TiTiler configured for that
  > bucket (e.g. `AWS_NO_SIGN_REQUEST=YES` for public data); the public
  > `titiler.xyz` handles many such buckets. Because TiTiler is a *dynamic*
  > tiler, the plugin does not cap the MapLibre source at the mosaic's
  > advertised `minzoom` (that would leave a small, high-resolution source
  > blank until you zoomed in) - instead the initial fit is floored to that
  > zoom so the view lands where tiles exist.

`cog-tiler-wasm` is an **optional peer dependency**, loaded lazily the first
time the engine is selected, so it never enters the default bundle. To use it,
install it alongside its own peers:

```bash
npm install cog-tiler-wasm whitebox-wasm proj4 "geotiff@^2.1" geotiff-geokeys-to-proj4
```

> Pin `geotiff` to the `2.x` line. `cog-tiler-wasm` reads a GeoTIFF's embedded
> color table from `fileDirectory.ColorMap`, which `geotiff@3` resolves lazily
> (so paletted rasters like NLCD would otherwise render through a continuous
> colormap instead of their categorical colors).

```typescript
// Start on the WASM engine, or switch at runtime:
const control = new RasterControl({ engine: "cog-tiler-wasm" });
// ...
control.setEngine("maplibre-gl-raster");
```

If the package is not installed, selecting the engine surfaces a load error via
the `error` event; the default engine keeps working.

### RasterLayerState

Per-layer visualization state, editable via the panel or `setRasterState`:

```typescript
interface RasterLayerState {
  mode: "rgb" | "single" | "index"; // RGB composite, single band + colormap, or normalized-difference index
  bands: number[]; // 1-indexed band selection ([A, B] in index mode)
  index?: string; // normalized-difference preset id (index mode), e.g. "ndvi"
  rescale: [number, number][] | null; // per-channel min/max; null = auto (2-98%, or [-1, 1] for index)
  colormap: string; // colormap name; "palette" = embedded color table
  reversed: boolean; // sample the named colormap back-to-front
  nodata: number | "off" | "auto"; // nodata handling
  opacity: number; // 0..1
  gamma: number; // power-law correction (1 = off)
  stretch: "linear" | "log" | "sqrt"; // curve applied after rescale
  visible: boolean;
  colorbar?: {
    // optional on-map legend for this single-band layer
    visible: boolean;
    title?: string;
    units?: string;
    orientation?: "horizontal" | "vertical";
    position?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  };
}
```

When a raster loads, the mode and bands are picked automatically (3+ bands → RGB `[1, 2, 3]`; otherwise single-band), and the rescale range defaults to the 2-98% percentile of sampled statistics. Single-band rasters use the image's embedded color table when it carries one (`colormap: "palette"`) and grayscale otherwise. The first four bands are fetched as GPU textures, so band combinations among them re-render instantly without re-downloading tiles.

**Index mode** computes a normalized-difference index `(A - B) / (A + B)` of two bands entirely on the GPU (no server or download), then colors the `[-1, 1]` result with a colormap. Presets (`NORMALIZED_DIFFERENCE_INDICES`) pre-fill the band roles and a default ramp for NDVI, NDWI, NDMI, NBR, NDBI, and NDSI, and a "Custom" option lets you pick any two bands; the settings panel seeds the operand bands from the file's band names when present. Index mode requires the default `maplibre-gl-raster` engine (the `cog-tiler-wasm` engine has no band-math endpoint and falls back to a colormapped view of the first operand).

### RasterControlReact

React wrapper component for `RasterControl`.

#### Props

All `RasterControl` options plus:

| Prop            | Type       | Description                                            |
| --------------- | ---------- | ------------------------------------------------------ |
| `map`           | `Map`      | MapLibre GL map instance (required)                    |
| `onStateChange` | `function` | Callback fired when the control state changes          |
| `onReady`       | `function` | Receives the `RasterControl` instance after map attach |

### useRasterState

Custom React hook for managing control state.

```typescript
const {
  state, // Current state
  setState, // Update entire state
  setCollapsed, // Set collapsed state
  setPanelWidth, // Set panel width
  setData, // Set custom data
  reset, // Reset to initial state
  toggle, // Toggle collapsed state
} = useRasterState(initialState);
```

### Colorbar

The settings panel has a **"Show colorbar"** toggle for single-band layers
(with title, units, orientation, and position controls). Enabling it shows a
legend on the map driven by that layer's colormap, `reversed` flag, and
effective value range, and it follows rescale / colormap changes live. This is
persisted per layer in `RasterLayerState.colorbar`.

You can also use the legend directly as a standalone control. Add it like any
MapLibre control; it docks into a map corner and renders a gradient with tick
labels. The ramp is sampled from the same colormap sprite the renderer uses, so
a named colormap (and the `reversed` flag) matches the map exactly — or supply
your own `colors`.

```typescript
import { Colorbar } from "maplibre-gl-raster";

const colorbar = new Colorbar({
  colormap: "viridis", // or colors: ["#000", "#f00", "#ff0"]
  min: 0,
  max: 3000,
  title: "Elevation",
  units: "m",
  orientation: "horizontal", // or "vertical"
  position: "bottom-right",
  ticks: 5,
});
map.addControl(colorbar);
```

Keep it in sync with a single-band raster by updating it from the control's
`rasterchange` event:

```typescript
control.on("rasterchange", ({ layerId }) => {
  const info = layerId ? control.getRaster(layerId) : undefined;
  const range = info?.state.rescale?.[0]; // [min, max] when set explicitly
  // 'palette' uses the image's embedded table, not a named colormap.
  if (info && range && info.state.colormap !== "palette") {
    colorbar.update({
      colormap: info.state.colormap,
      reversed: info.state.reversed,
      min: range[0],
      max: range[1],
    });
  }
});
```

`ColorbarOptions`: `colormap?` (default `"viridis"`), `colors?` (custom ramp,
overrides `colormap`), `reversed?`, `min?` / `max?` (default `0` / `1`),
`title?`, `titleAlign?` (`"left"` | `"center"` | `"right"`), `units?`,
`stretch?` (`"linear"` | `"log"` | `"sqrt"` — spaces tick values to match the
layer's stretch), `orientation?` (`"horizontal"` | `"vertical"`, default
`"horizontal"`), `position?` (map corner, default `"bottom-right"`), `ticks?`
(count, default `5`), `tickValues?` (explicit ticks), `decimals?` (fixed
decimal places; omit for a compact auto format), `barLength?` /
`barThickness?` (px), `className?`. Reconfigure live with
`colorbar.update(partial)`.

### Utilities

The package also exports lower-level building blocks for advanced use:

- `loadGeoTIFF(url)` - Open a (CORS-safe) GeoTIFF from a URL or blob URL
- `parseVrt(xml, vrtUrl)` / `loadVrt(url, signal?)` - Parse a [mosaic VRT](#mosaic-vrt-support) into its member COG URLs; throws `VrtUnsupportedError` for a VRT that needs GDAL
- `isVrtUrl(url)` / `isVrtFile(file)` - Detect a `.vrt` by name
- `computeAutoStats(tiff, signal, onProgress?)` - Per-band min/max + histograms
- `mergeAutoStats(perImage)` / `mergeBandStats(perImage)` - Merge stats sampled from several images onto one range (how a mosaic VRT gets a shared stretch)
- `summarizeGeoTIFF(tiff)` - Image / CRS / band / GDAL metadata summary
- `readBandNames(tiff)` / `percentileFromHistogram(stats, p)`
- `COLORMAP_NAMES` / `COLORMAP_OPTIONS` / `colormapsPngUrl`
- `sampleColormapStops(name, steps, reversed?)` / `loadColormapSprite()` / `isKnownColormap(name)` - sample a colormap's colors in plain JS
- `autoRangeFor(stats)` / `statsForBand(autoStats, band)` - resolve a band's effective rescale range
- `clamp`, `formatNumericValue`, `generateId`, `debounce`, `throttle`, `classNames`

## Mosaic VRT support

A `.vrt` is not raster data: it is a GDAL XML manifest describing how to assemble other files. GDAL is not available in the browser, so only the subset that can be honoured without it is supported — **a VRT that mosaics COGs**, which is what `gdalbuildvrt` emits:

```bash
gdalbuildvrt mosaic.vrt tile_*.tif   # then load mosaic.vrt by URL
```

Each source is loaded as its own COG and rendered as its own tiled layer, georeferenced by its own headers. They appear as **one layer** in the panel: one set of settings, one rescale window, one colorbar. Auto statistics are sampled from every member and merged, so the shared stretch describes the whole mosaic rather than whichever tile happened to be first.

Sources may be relative to the `.vrt`, absolute `https://` URLs, or `/vsicurl/https://…`. Every one must be a CORS-enabled COG. Relative sources always resolve against the `.vrt`'s own location: a browser has no working directory, so GDAL's `relativeToVRT="0"` ("relative to the process working directory") has no meaning here.

Nodata comes from the sources' `<NODATA>` when they declare one, falling back to the band's `<NoDataValue>`. A source's `<NODATA>` describes values in the member's own pixels — which is what actually gets drawn — while `<NoDataValue>` describes the VRT's output; `gdalbuildvrt` writes both and they usually agree, but `-srcnodata X -vrtnodata Y` makes them differ.

### What is not supported

Anything that needs GDAL's pixel machinery is **rejected with an actionable error** rather than rendered approximately — a mis-placed or silently rescaled raster is worse than a clear failure:

| Rejected | Because |
| --- | --- |
| Warped VRTs (`subClass="VRTWarpedDataset"`, i.e. `gdalwarp -of VRT`) | Reprojects/resamples on the fly |
| Pixel functions (`VRTDerivedRasterBand`) | Runs inside GDAL |
| `<LUT>`, `<ScaleRatio>`, `<ScaleOffset>`, `<Exponent>` | Rescales sample values |
| `<KernelFilteredSource>`, `<AveragedSource>` | Composites pixels |
| `<UseMaskBand>` (sources with an internal mask band) | GDAL applies each source's mask while compositing; drawn separately, masked-out pixels would render as data |
| Sources declaring different `<NODATA>` values | Members share one nodata setting |
| Cropped (`<SrcRect>` sub-window) or rescaled (`<DstRect>` ≠ `<SrcRect>`) sources | Members are drawn from their own georeferencing, so the VRT's placement cannot be honoured |
| Band remapping (`<SourceBand>` ≠ band number) | Band N is read from band N of each member |
| Bands built from different file sets | Cannot collapse to one layer per file |
| `/vsis3/`, `/vsizip/`, … (any handler but `/vsicurl/`) | Needs GDAL driver config the browser cannot reconstruct |
| Local absolute paths, or relative paths in a **dropped** `.vrt` | A local `.vrt` has no readable directory in the browser, so its siblings on disk cannot be found. Load it from a URL, or use absolute URLs |
| More than 32 sources | Each becomes its own tiled layer with its own tile cache; a large mosaic would exhaust the browser |

For any of these, materialize the VRT first and load the result:

```bash
gdal_translate mosaic.vrt mosaic.tif -of COG   # or gdalwarp, for a warped VRT
```

## CORS requirements for remote COGs

Remote COGs must be served with CORS enabled (`Access-Control-Allow-Origin`). The loader includes a workaround for buckets that do not expose `Content-Range` via `Access-Control-Expose-Headers`, so most public S3/R2 buckets work out of the box.

A mosaic VRT multiplies the number of concurrent range requests by its member count. Hosts that throttle or intermittently fail under that load return error responses without CORS headers, which the browser reports as CORS failures and which show up as missing tiles.

## Build a GeoLibre plugin zip

GeoLibre Desktop loads external plugins from an app data `plugins/` directory. The zip must contain `plugin.json` at the root, plus a bundled ESM entry and optional CSS file.

```bash
npm install
npm run package:geolibre
```

This creates:

```text
geolibre-plugin/maplibre-gl-raster-0.1.0.zip
```

The generated zip contains:

```text
plugin.json
dist/index.js
dist/style.css
```

Copy the zip into GeoLibre Desktop's app data `plugins/` directory and restart GeoLibre. On Linux with the default app identifier, that directory is usually:

```text
~/.local/share/org.geolibre.desktop/plugins/
```

For the GeoLibre web app, serve the unpacked plugin with CORS enabled:

```bash
npm run package:geolibre
npm run serve:geolibre -- 8000
```

Then add this manifest URL in GeoLibre Settings > Plugins:

```text
http://localhost:8000/plugin.json
```

Using `python -m http.server` for this cross-origin web app case is not enough
because it does not send `Access-Control-Allow-Origin`.

## Development

### Setup

```bash
# Clone the repository
git clone https://github.com/opengeos/maplibre-gl-raster.git
cd maplibre-gl-raster

# Install dependencies
npm install

# Start development server
npm run dev
```

### Scripts

| Script                     | Description                              |
| -------------------------- | ---------------------------------------- |
| `npm run dev`              | Start development server                 |
| `npm run build`            | Build the library and GeoLibre bundle    |
| `npm run build:lib`        | Build the standalone MapLibre library    |
| `npm run build:geolibre`   | Build the GeoLibre ESM and CSS bundle    |
| `npm run package:geolibre` | Build and zip the GeoLibre plugin bundle |
| `npm run build:examples`   | Build examples for deployment            |
| `npm run test`             | Run tests                                |
| `npm run test:ui`          | Run tests with UI                        |
| `npm run test:coverage`    | Run tests with coverage                  |
| `npm run lint`             | Lint the code                            |
| `npm run format`           | Format the code                          |

### Project Structure

```text
maplibre-gl-raster/
├── geolibre-plugin/
│   └── plugin.json          # GeoLibre external plugin manifest
├── scripts/
│   └── package-geolibre-plugin.mjs
├── src/
│   ├── index.ts              # Main entry point
│   ├── geolibre.ts           # GeoLibre plugin wrapper entry point
│   ├── react.ts              # React entry point
│   ├── index.css             # Root styles
│   └── lib/
│       ├── core/             # RasterControl, React wrapper, types
│       ├── raster/           # GeoTIFF loading, stats, GPU render pipeline
│       ├── state/            # RasterLayer model + LayerManager
│       ├── ui/               # Vanilla DOM panel components
│       ├── hooks/            # React hooks
│       ├── utils/            # Utility functions
│       └── styles/           # Component styles
├── tests/                    # Test files
├── examples/                 # Example applications
│   ├── basic/               # Vanilla JS example
│   └── react/               # React example
└── .github/workflows/        # CI/CD workflows
```

## Docker

The examples can be run using Docker. The image is automatically built and published to GitHub Container Registry.

### Pull and Run

```bash
# Pull the latest image
docker pull ghcr.io/opengeos/maplibre-gl-raster:latest

# Run the container
docker run -p 8080:80 ghcr.io/opengeos/maplibre-gl-raster:latest
```

Then open http://localhost:8080/maplibre-gl-raster/ in your browser to view the examples.

### Build Locally

```bash
# Build the image
docker build -t maplibre-gl-raster .

# Run the container
docker run -p 8080:80 maplibre-gl-raster
```

### Available Tags

| Tag      | Description                      |
| -------- | -------------------------------- |
| `latest` | Latest release                   |
| `x.y.z`  | Specific version (e.g., `1.0.0`) |
| `x.y`    | Minor version (e.g., `1.0`)      |

### Publish to npm

```bash
npm login
npm whoami
npm publish --access public
```

Set up Trusted Publisher on npmjs.com

## Credits

The rendering pipeline, GeoTIFF loading strategy, statistics sampling, and much of the visualization UX are ported from Source Cooperative's [cog-viewer](https://github.com/source-cooperative/cog-viewer), built on their excellent [@developmentseed/deck.gl-geotiff](https://github.com/developmentseed/deck.gl-raster) and [@developmentseed/deck.gl-raster](https://github.com/developmentseed/deck.gl-raster) libraries.

## License

MIT License - see [LICENSE](LICENSE) for details.
