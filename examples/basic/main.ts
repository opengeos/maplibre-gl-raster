import maplibregl from 'maplibre-gl';
import { RasterControl } from '../../src/index';
import '../../src/index.css';
import 'maplibre-gl/dist/maplibre-gl.css';

// A public Cloud Optimized GeoTIFF used as the demo layer.
const DEMO_COG =
  'https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/18/T/WL/2026/1/S2B_18TWL_20260101_0_L2A/TCI.tif';

// Create map
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  center: [0, 0],
  zoom: 2,
});

// Add navigation controls to top-right
map.addControl(new maplibregl.NavigationControl(), 'top-right');

// Add fullscreen control to top-right (after navigation)
map.addControl(new maplibregl.FullscreenControl(), 'top-right');

// Add the raster control when the map loads
map.on('load', () => {
  // Set collapsed: true to start with just the 29x29 button
  const rasterControl = new RasterControl({
    collapsed: false,
  });

  // Add control to the map
  map.addControl(rasterControl, 'top-right');

  // Listen for raster layer events
  rasterControl.on('rasteradd', (event) => {
    console.log('Raster added:', event.layerId);
  });

  rasterControl.on('rasterchange', (event) => {
    console.log('Raster changed:', event.layerId);
  });

  rasterControl.on('rasterremove', (event) => {
    console.log('Raster removed:', event.layerId);
  });

  rasterControl.on('error', (event) => {
    console.error('Raster error:', event.error);
  });

  // Load a demo COG. You can also paste any COG URL or drop a local
  // GeoTIFF file in the panel.
  rasterControl
    .addRaster(DEMO_COG, { name: 'Sentinel-2 True Color (New York)' })
    .then((id) => console.log('Demo raster loaded:', id))
    .catch((err) => console.error('Demo raster failed to load:', err));
});
