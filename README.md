# maplibre-gl-raster

A MapLibre GL JS plugin for visualizing local and remote raster datasets (GeoTIFF / Cloud Optimized GeoTIFF) directly in the browser. No tile server required: COGs are read with HTTP range requests and rendered on the GPU through a deck.gl pipeline.

[![npm version](https://img.shields.io/npm/v/maplibre-gl-raster.svg)](https://www.npmjs.com/package/maplibre-gl-raster)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Open in CodeSandbox](https://img.shields.io/badge/Open%20in-CodeSandbox-blue?logo=codesandbox)](https://codesandbox.io/p/github/opengeos/maplibre-gl-raster)
[![Open in StackBlitz](https://img.shields.io/badge/Open%20in-StackBlitz-blue?logo=stackblitz)](https://stackblitz.com/github/opengeos/maplibre-gl-raster)

## Features

- **Local and remote rasters** - Load Cloud Optimized GeoTIFFs from any CORS-enabled URL, or drag-and-drop local GeoTIFF files
- **Multiple layers** - Layer list with visibility toggles, reordering, zoom-to, and per-layer settings
- **GPU rendering pipeline** - Band compositing, per-band rescale, 90+ colormaps, nodata filtering, linear/sqrt/log stretch, and gamma correction as deck.gl shader modules; parameter changes re-render without re-fetching tiles
- **Auto statistics** - Per-band min/max and histograms sampled from COG overviews (or GDAL metadata), with draggable histogram handles for the rescale range
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
| `panelWidth`  | `number`  | `340`         | Width of the dropdown panel in pixels                                     |
| `className`   | `string`  | `''`          | Custom CSS class name                                                     |
| `interleaved` | `boolean` | `true`        | Render the deck.gl overlay interleaved with the basemap layers            |

#### Raster Methods

- `addRaster(source, options?)` - Add a raster from a COG URL (`string`) or a local GeoTIFF `File`; resolves with the layer id
- `removeRaster(id)` - Remove a raster layer
- `getRaster(id)` / `getRasters()` - Get layer snapshots (`RasterLayerInfo`)
- `setRasterState(id, patch)` - Update visualization state (mode, bands, rescale, colormap, nodata, opacity, gamma, stretch, visible)
- `setVisible(id, visible)` - Show / hide a layer
- `selectRaster(id | null)` - Choose which layer the panel's settings edit
- `zoomToRaster(id)` - Fit the map to a layer's bounds
- `reorderRaster(id, toIndex)` - Move a layer in the draw order (0 = bottom)

`addRaster` options (`AddRasterOptions`): `id`, `name`, `state` (initial `Partial<RasterLayerState>` overrides), `zoomTo` (default `true`).

#### Panel Methods

- `toggle()` / `expand()` / `collapse()` - Control the panel
- `getState()` / `setState(state)` - Control-level state (collapsed, panelWidth)
- `on(event, handler)` / `off(event, handler)` - Event handlers
- `getMap()` / `getContainer()` - Access the map / container

#### Events

- `collapse` / `expand` / `statechange` - Panel state events
- `rasteradd` / `rasterremove` / `rasterchange` / `rasterselect` - Layer lifecycle events (payload includes `layerId`)
- `error` - Loading or rendering errors (payload includes `error`)

### RasterLayerState

Per-layer visualization state, editable via the panel or `setRasterState`:

```typescript
interface RasterLayerState {
  mode: "rgb" | "single"; // RGB composite or single band + colormap
  bands: number[]; // 1-indexed band selection
  rescale: [number, number][] | null; // per-channel min/max; null = auto (2-98%)
  colormap: string; // colormap name (single-band mode)
  nodata: number | "off" | "auto"; // nodata handling
  opacity: number; // 0..1
  gamma: number; // power-law correction (1 = off)
  stretch: "linear" | "log" | "sqrt"; // curve applied after rescale
  visible: boolean;
}
```

When a raster loads, the mode and bands are picked automatically (3+ bands → RGB `[1, 2, 3]`; otherwise single-band), and the rescale range defaults to the 2-98% percentile of sampled statistics. The first four bands are fetched as GPU textures, so band combinations among them re-render instantly without re-downloading tiles.

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

### Utilities

The package also exports lower-level building blocks for advanced use:

- `loadGeoTIFF(url)` - Open a (CORS-safe) GeoTIFF from a URL or blob URL
- `computeAutoStats(tiff, signal, onProgress?)` - Per-band min/max + histograms
- `summarizeGeoTIFF(tiff)` - Image / CRS / band / GDAL metadata summary
- `readBandNames(tiff)` / `percentileFromHistogram(stats, p)`
- `COLORMAP_NAMES` / `COLORMAP_OPTIONS` / `colormapsPngUrl`
- `clamp`, `formatNumericValue`, `generateId`, `debounce`, `throttle`, `classNames`

## CORS requirements for remote COGs

Remote COGs must be served with CORS enabled (`Access-Control-Allow-Origin`). The loader includes a workaround for buckets that do not expose `Content-Range` via `Access-Control-Expose-Headers`, so most public S3/R2 buckets work out of the box.

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

The rendering pipeline, GeoTIFF loading strategy, statistics sampling, and much of the visualization UX are ported from [Development Seed](https://developmentseed.org/)'s [cog-viewer](https://github.com/developmentseed/cog-viewer), built on their excellent [@developmentseed/deck.gl-geotiff](https://github.com/developmentseed/deck.gl-raster) and [@developmentseed/deck.gl-raster](https://github.com/developmentseed/deck.gl-raster) libraries.

## License

MIT License - see [LICENSE](LICENSE) for details.
