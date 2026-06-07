# Pixel Inspector Design

## Summary

Add an **Inspector** toggle button to the control panel that lets the user
read the raw source pixel values of the currently selected raster layer by
clicking on the map. Results are shown in a MapLibre popup anchored at the
clicked location.

## Goals

- A toggle button in the panel that enables/disables "inspect mode".
- While enabled, clicking the map reads the **raw source values of all bands**
  of the **currently selected layer** at that geographic location.
- Show the coordinates and per-band values in a MapLibre popup at the point.
- Work for COGs in any CRS (not just EPSG:4326), mirroring the reprojection
  pipeline the existing COGLayer uses.

## Non-goals

- Live hover readout (click-only for v1).
- Pinned/multiple simultaneous readings (the popup moves to the latest click).
- Reading the rendered display color (we report source data values, not the
  post-colormap RGB).
- Applying GDAL scale/offset to reported values (we report raw stored values,
  consistent with how stats/rescale treat the data).

## Behavior

1. The Settings section header shows an **Inspect** toggle button next to the
   `Settings — <layer>` title. It is disabled when no layer is selected.
2. Toggling it on activates inspect mode: the map canvas cursor becomes a
   crosshair.
3. Clicking the map reads the pixel under the click for the selected layer:
   - A popup appears at the clicked point showing the longitude/latitude and a
     per-band list: `Band N (name): value`, with nodata pixels flagged.
   - Clicking elsewhere moves the popup to the new reading.
   - Clicks outside the layer's pixel grid show an "outside layer" message
     (no band values).
4. Closing the popup (its × button) just dismisses the popup; inspect mode
   stays on and the next click reads again. Toggling inspect mode off dismisses
   the popup and restores the default cursor.
5. Inspect mode remains active across panel collapse/expand; it is torn down
   when the control is removed from the map.

## Core logic: reading a pixel value

Reuses the same machinery the COGLayer uses, so any CRS is handled correctly.

1. Resolve the source projection from the GeoTIFF's CRS:
   `typeof crs === 'number' ? epsgResolver(crs) : parseWkt(crs)`
   (both from `@developmentseed/proj`).
2. Convert the WGS84 click to the COG's CRS:
   `proj4('EPSG:4326', sourceProjection).forward([lng, lat])` → `(x, y)`.
3. Invert the GeoTIFF's affine `transform` (`[a, b, c, d, e, f]`, mapping
   `(col, row)` → `(x, y)`) to recover fractional `(col, row)`:
   ```
   det = a*e - b*d
   col = ( e*(x - c) - b*(y - f)) / det
   row = (-d*(x - c) + a*(y - f)) / det
   ```
   Floor to integer pixel indices. Reject when outside
   `[0, width) × [0, height)`.
4. Compute the tile containing the pixel:
   `tileX = floor(col / tileWidth)`, `tileY = floor(row / tileHeight)`, then
   `geotiff.fetchTile(tileX, tileY, { signal })` (one HTTP range request at
   native resolution).
5. Read each band at the local offset
   `(row % tileHeight, col % tileWidth)` from the returned `RasterArray`,
   handling both `band-separate` (`arr.bands[b][localRow*arr.width + localCol]`)
   and pixel-interleaved
   (`arr.data[(localRow*arr.width + localCol)*arr.count + b]`) layouts.
   Compare each value against `arr.nodata` to flag nodata.

The affine inverse is computed inline; no new affine dependency is needed.

## Components

### `src/lib/raster/inspect.ts` (new, pure)

```ts
export interface BandReading {
  index: number;          // 1-based band index
  name: string | null;    // from layer.bandNames, when present
  value: number;
  isNodata: boolean;
}

export interface PixelReading {
  lngLat: [number, number];
  col: number;
  row: number;
  bands: BandReading[];
}

export async function readPixelValues(
  geotiff: GeoTIFF,
  lngLat: [number, number],
  options?: { signal?: AbortSignal; bandNames?: Map<number, string> | null },
): Promise<PixelReading | null>; // null when the click is outside the grid
```

- Holds a `WeakMap<GeoTIFF, Converter>` cache so the proj4 converter and
  resolved source projection are built once per layer, not per click.
- No DOM, no map, no WebGL: directly unit-testable.

### `src/lib/state/PixelInspector.ts` (new, controller)

```ts
export interface PixelInspectorDeps {
  readPixelValues: typeof readPixelValues;
  createPopup: () => PopupLike; // defaults to new maplibregl.Popup(...)
}

export class PixelInspector {
  constructor(
    map: MapLibreMap,
    getTarget: () => RasterLayer | null,
    deps?: Partial<PixelInspectorDeps>,
  );
  get enabled(): boolean;
  enable(): void;
  disable(): void;
  toggle(): void;
  destroy(): void;
}
```

- Owns: enabled flag, the map `click` listener, crosshair cursor toggling, an
  `AbortController` per click (cancels a stale read when a new click arrives),
  and one reusable popup.
- On click: resolves the target layer; if none/loading/errored, shows an
  appropriate popup message. Otherwise shows a "Reading…" popup immediately,
  then updates it with the values (or "outside layer") when the read resolves.
- Renders popup HTML via the existing `el()` DOM helpers and `fmtNumber()` for
  values (with a fallback for large integers).
- Dependency injection on `readPixelValues` and `createPopup` makes it testable
  with a fake map and fake popup.

### Panel button (in `SettingsSection`)

- The `SettingsSection` header gains an **Inspect** toggle button beside the
  title. It calls a callback supplied by `PanelUI` and reflects active state via
  an `aria-pressed` attribute and an `mlr-*` active class.
- Wired through `PanelUI` constructor options:
  `{ onToggleInspect: () => void, isInspectActive: () => boolean }`, plus a way
  for the inspector to notify the section to refresh the button state.

### Wiring (`RasterControl`)

- `onAdd`: after creating the `LayerManager` and `PanelUI`, create
  `this._inspector = new PixelInspector(map, () =>
  this._layerManager.getLayer(this._layerManager.selectedId ?? '') ?? null)`.
  Pass `onToggleInspect`/`isInspectActive` into `PanelUI`.
- When the selected layer changes or is removed, the section re-renders and the
  button disables itself if there is no selection. Inspect mode does not need to
  be force-disabled on selection change (it simply targets the new selection).
- `onRemove`: `this._inspector.destroy()` before clearing references.

## Styling

- Add a small `.mlr-inspect-toggle` style (and active state) in
  `src/lib/styles/raster-control.css`, namespaced under `mlr-` like the rest.
- Popup uses MapLibre's default popup chrome plus a small `.mlr-inspect-popup`
  content class for the value list, with dark-mode parity matching existing
  panel styles.

## Dependencies

- Promote `proj4` and `@developmentseed/proj` from transitive to **direct**
  dependencies in `package.json` (they are already installed at compatible
  versions via `@developmentseed/deck.gl-geotiff`). Match the existing version
  ranges resolved in `package-lock.json`.

## Testing

Following the existing `tests/layer-manager.test.ts` dependency-injection
pattern:

- `tests/inspect.test.ts` — `readPixelValues`:
  - EPSG:4326 COG: a known click maps to the expected `(col, row)` and band
    values, with a fake `geotiff` providing `crs`, `transform`, `width/height`,
    `tileWidth/tileHeight`, and `fetchTile` returning a crafted `RasterArray`.
  - A projected CRS (e.g. EPSG:3857) to exercise the proj4 path.
  - Pixel-interleaved vs band-separate layouts.
  - nodata flagging.
  - Click outside the grid returns `null`.
- `tests/pixel-inspector.test.ts` — `PixelInspector` with a fake map and fake
  popup:
  - `enable`/`disable`/`toggle` attach/detach the click listener and set/clear
    the crosshair cursor.
  - A click calls `readPixelValues` with the target layer's geotiff and shows
    the popup.
  - A second click aborts the first read's `AbortController`.
  - No target layer → message popup, no `readPixelValues` call.
  - `destroy` removes listeners and the popup.

## Out-of-scope follow-ups (not in this work)

- Live hover readout and pinned multi-point comparison.
- Copy-to-clipboard of the reading.
- Surfacing the reading through the public event/API surface.
