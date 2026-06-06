import maplibregl from 'maplibre-gl';
import { RasterControl } from '../../src/index';
import '../../src/index.css';
import 'maplibre-gl/dist/maplibre-gl.css';

// A public Cloud Optimized GeoTIFF prefilled in the Add data input
// (not loaded until the user clicks Load).
const DEMO_COG = 'https://data.source.coop/giswqs/opengeos/nlcd_2021_land_cover_30m.tif';

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
    defaultUrl: DEMO_COG,
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
});
